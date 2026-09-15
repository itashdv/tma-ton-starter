import cors from '@fastify/cors'
import type { Db } from '@tma/db'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { ZodError } from 'zod'

import type { LoadedShopConfig } from './config/shop'
import type { Env } from './env'
import { ApiError } from './errors'
import { healthRoutes } from './routes/health'

export interface AppDeps {
  env: Env
  db: Db
  shop: LoadedShopConfig
  /** Injectable clock for deterministic tests. */
  now?: () => Date
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger']
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Required<AppDeps>
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

function defaultLogger(env: Env): FastifyServerOptions['logger'] {
  const base = { level: env.LOG_LEVEL, redact: ['req.headers.authorization'] }
  if (env.NODE_ENV === 'development' && prettyLogsAvailable()) {
    return { ...base, transport: { target: 'pino-pretty', options: { colorize: true } } }
  }
  return base
}

export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? defaultLogger(deps.env),
    // Behind nginx: take client ip and protocol from X-Forwarded-* headers.
    trustProxy: true,
  })

  app.decorate('deps', { ...deps, now: deps.now ?? (() => new Date()) })

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

  app.register(healthRoutes)

  return app
}
