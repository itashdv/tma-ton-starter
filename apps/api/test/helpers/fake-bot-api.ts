import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A real HTTP server that speaks enough Bot API for the tests: it records every request and can
 * be scripted per method to answer errors, hang, or return prepared payloads. A server instead
 * of a fetch mock keeps the URL layout (token, test DC segment) and timeouts honest.
 */

export interface RecordedBotRequest {
  method: string
  path: string
  body: unknown
}

export type ScriptedBotResponse =
  | { kind: 'json'; status?: number; body: unknown }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'hang' }

export interface FakeBotApi {
  url: string
  requests: RecordedBotRequest[]
  /** Queue a response for the next call of `method` (default sendMessage). */
  enqueue: (response: ScriptedBotResponse, method?: string) => void
  /**
   * Awaited before answering, while the client's request is in flight. The notifier test uses
   * it to look at the database from another connection mid-send.
   */
  onRequest?: (request: RecordedBotRequest) => Promise<void> | void
  close: () => Promise<void>
}

export function okResponse(messageId: number | bigint): ScriptedBotResponse {
  return {
    kind: 'json',
    status: 200,
    body: { ok: true, result: { message_id: Number(messageId) } },
  }
}

export function errorResponse(
  code: number,
  description: string,
  parameters?: Record<string, unknown>,
): ScriptedBotResponse {
  return {
    kind: 'json',
    status: code,
    body: {
      ok: false,
      error_code: code,
      description,
      ...(parameters ? { parameters } : {}),
    },
  }
}

/** Keeps a non-JSON body verbatim so a test can still see what was sent. */
function parseBody(raw: string): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/** `/bot<token>/sendMessage` or `/bot<token>/test/sendMessage` → `sendMessage`. */
function methodFromPath(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? ''
}

export async function startFakeBotApi(): Promise<FakeBotApi> {
  const requests: RecordedBotRequest[] = []
  const queues = new Map<string, ScriptedBotResponse[]>()
  let nextMessageId = 1

  const fake: FakeBotApi = {
    url: '',
    requests,
    enqueue: (response, method = 'sendMessage') => {
      const queue = queues.get(method) ?? []
      queue.push(response)
      queues.set(method, queue)
    },
    close: async () => {},
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fake').pathname
      const rawBody = Buffer.concat(chunks).toString()
      const recorded: RecordedBotRequest = {
        method: req.method ?? 'GET',
        path,
        body: parseBody(rawBody),
      }
      requests.push(recorded)

      const answer = () => {
        const scripted = queues.get(methodFromPath(path))?.shift()
        if (scripted) {
          if (scripted.kind === 'hang') return
          if (scripted.kind === 'status') {
            res.writeHead(scripted.status, { 'content-type': 'text/plain' })
            res.end(scripted.body ?? '')
            return
          }
          res.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(scripted.body))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }))
      }

      Promise.resolve(fake.onRequest?.(recorded)).then(answer, (error: unknown) => {
        // A failing hook must not hang the client; surface it as a server error instead.
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(`onRequest hook failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  fake.url = `http://127.0.0.1:${port}`
  fake.close = () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => (error ? reject(error) : resolve()))
    })
  return fake
}
