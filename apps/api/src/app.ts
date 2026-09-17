import cors from '@fastify/cors'
import type { Db } from '@tma/db'
import { generateOrderId } from '@tma/shared'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { ZodError } from 'zod'

import type { LoadedShopConfig } from './config/shop'
import type { Env } from './env'
import { ApiError } from './errors'
import { authPlugin } from './plugins/auth'
import { adminRoutes } from './routes/admin/index'
import { healthRoutes } from './routes/health'
import { meRoutes } from './routes/me'
import { orderRoutes } from './routes/orders'
import { productRoutes } from './routes/products'
import { createJettonWalletResolver, type JettonWalletResolver } from './ton/jetton-wallet'
import { createToncenterClient, type ToncenterClient } from './ton/toncenter'

export interface AppDeps {
  env: Env
  db: Db
  shop: LoadedShopConfig
  /** Injectable clock for deterministic tests. */
  now?: () => Date
  /** toncenter client used on the request path (short timeouts, few retries). */
  ton?: ToncenterClient
  jettonWallets?: JettonWalletResolver
  newOrderId?: () => string
  newQueryId?: () => bigint
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger']
  /** A ready-made pino instance; Fastify 5 takes it separately from logger options. */
  loggerInstance?: FastifyServerOptions['loggerInstance']
}

/** One registered route; the admin auth matrix test walks this list. */
export interface RouteListEntry {
  /** Upper-case HTTP method. */
  method: string
  url: string
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Required<AppDeps>
    routeList: readonly RouteListEntry[]
  }
}

interface HttpErrorShape {
  statusCode: number
  code: string
  message: string
}

/** Fastify's own errors (body too large, bad JSON, …) carry statusCode and code. */
function asHttpError(error: unknown): HttpErrorShape {
  const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>
  const statusCode = typeof e.statusCode === 'number' ? e.statusCode : 500
  const code = typeof e.code === 'string' ? e.code : 'request_error'
  const message = typeof e.message === 'string' ? e.message : 'request error'
  return { statusCode, code, message }
}

/** pino-pretty is a devDependency: use it only in an interactive dev shell where it is installed. */
function prettyLogsAvailable(): boolean {
  if (!process.stdout.isTTY) return false
  try {
    import.meta.resolve('pino-pretty')
    return true
  } catch {
    return false
  }
}

export function defaultLogger(env: Env): FastifyServerOptions['logger'] {
  const base = { level: env.LOG_LEVEL, redact: ['req.headers.authorization'] }
  if (env.NODE_ENV === 'development' && prettyLogsAvailable()) {
    return { ...base, transport: { target: 'pino-pretty', options: { colorize: true } } }
  }
  return base
}

export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    ...(options.loggerInstance
      ? { loggerInstance: options.loggerInstance }
      : { logger: options.logger ?? defaultLogger(deps.env) }),
    // Behind nginx: take client ip and protocol from X-Forwarded-* headers.
    trustProxy: true,
  })

  const ton =
    deps.ton ??
    createToncenterClient({
      baseUrl: deps.env.toncenterUrl,
      apiKey: deps.env.TONCENTER_API_KEY,
      policy: 'request',
    })
  // Recorded at registration time from every context, so tests can assert properties of the
  // whole route table instead of a hand-maintained list that drifts.
  const routeList: RouteListEntry[] = []
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) routeList.push({ method: method.toUpperCase(), url: route.url })
  })
  app.decorate('routeList', routeList)

  app.decorate('deps', {
    ...deps,
    now: deps.now ?? (() => new Date()),
    ton,
    jettonWallets: deps.jettonWallets ?? createJettonWalletResolver(ton),
    newOrderId: deps.newOrderId ?? generateOrderId,
    newQueryId:
      deps.newQueryId ??
      (() => BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`)),
  })

  const origins = deps.env.CORS_ORIGINS
  app.register(cors, {
    // In production CORS_ORIGINS is mandatory (checked in parseEnv); locally an empty list
    // reflects any origin so that a tunnel or another dev port just works.
    origin: origins.length > 0 ? origins : true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  })

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send({ error: { code: 'not_found', message: `${request.method} ${request.url} not found` } })
  })

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.statusCode).send(error.toBody())
      return
    }
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: 'validation_error',
          message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      })
      return
    }
    const known = asHttpError(error)
    if (known.statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error')
      reply
        .code(known.statusCode)
        .send({ error: { code: 'internal_error', message: 'internal error' } })
      return
    }
    reply.code(known.statusCode).send({ error: { code: known.code, message: known.message } })
  })

  app.register(authPlugin)
  app.register(healthRoutes)
  app.register(productRoutes)
  app.register(meRoutes)
  app.register(orderRoutes)
  app.register(adminRoutes, { prefix: '/admin' })

  return app
}
