import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Address, Cell, beginCell } from '@ton/core'

/**
 * A real HTTP server that speaks enough toncenter v3 for the tests: it records every request
 * and can be scripted to answer 429/500, hang, or return prepared payloads. Using a server
 * instead of a fetch mock keeps headers, query strings and timeouts honest.
 */

export interface RecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string | undefined>
  body: unknown
}

export type ScriptedResponse =
  | { kind: 'json'; status?: number; body: unknown }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'hang' }

export interface FakeToncenter {
  url: string
  requests: RecordedRequest[]
  /** Queue a response for the next matching call; falls back to the default handler. */
  enqueue: (path: string, response: ScriptedResponse) => void
  /** null makes get_wallet_address fail with a non-zero exit code. */
  setJettonWallet: (address: Address | null) => void
  setTransactions: (rows: unknown[]) => void
  setAccountState: (account: unknown) => void
  close: () => Promise<void>
}

/**
 * The real get_wallet_address returns a different wallet per owner. The fake derives one the
 * same way, so a caller that passes the wrong owner (or the master) gets a wrong answer
 * instead of the one address every test expects.
 */
export function fakeJettonWalletFor(owner: Address): Address {
  const [, hex = ''] = owner.toRawString().split(':')
  return Address.parseRaw(`0:99${hex.slice(2)}`)
}

/** Reads the owner address back out of a runGetMethod stack entry. */
function ownerFromStack(body: unknown): Address | null {
  const stack = (body as { stack?: { type?: string; value?: string }[] } | null)?.stack
  const value = stack?.[0]?.value
  if (typeof value !== 'string') return null
  try {
    return Cell.fromBase64(value).beginParse().loadAddress()
  } catch {
    return null
  }
}

export async function startFakeToncenter(): Promise<FakeToncenter> {
  const requests: RecordedRequest[] = []
  const queues = new Map<string, ScriptedResponse[]>()
  /** null = the get-method fails; otherwise the wallet is derived from the requested owner. */
  let jettonWalletEnabled = true
  let transactions: unknown[] = []
  let accountState: unknown = {
    address: `0:${'11'.repeat(32)}`,
    status: 'active',
    balance: '1000000000',
    last_transaction_lt: '100',
    last_transaction_hash: Buffer.alloc(32, 1).toString('base64'),
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const path = url.pathname
      const rawBody = Buffer.concat(chunks).toString()
      requests.push({
        method: req.method ?? 'GET',
        path,
        query: url.searchParams,
        headers: req.headers as Record<string, string | undefined>,
        body: rawBody ? (JSON.parse(rawBody) as unknown) : null,
      })

      const scripted = queues.get(path)?.shift()
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

      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }

      if (path === '/runGetMethod') {
        // Derived from the owner in the request, so passing the wrong owner gives a wrong answer.
        const owner = ownerFromStack(requests.at(-1)?.body)
        if (!jettonWalletEnabled || !owner) return json({ exit_code: 11, gas_used: 100, stack: [] })
        return json({
          gas_used: 3143,
          exit_code: 0,
          stack: [
            {
              type: 'cell',
              value: beginCell()
                .storeAddress(fakeJettonWalletFor(owner))
                .endCell()
                .toBoc()
                .toString('base64'),
            },
          ],
        })
      }
      if (path === '/transactions') return json({ transactions })
      if (path === '/accountStates') return json({ accounts: accountState ? [accountState] : [] })
      if (path === '/jetton/masters') {
        return json({
          jetton_masters: [{ address: `0:${'33'.repeat(32)}`, jetton_content: { decimals: '6' } }],
        })
      }
      return json({ error: 'not found' }, 404)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    enqueue: (path, response) => {
      const queue = queues.get(path) ?? []
      queue.push(response)
      queues.set(path, queue)
    },
    setJettonWallet: (address) => {
      jettonWalletEnabled = address !== null
    },
    setTransactions: (rows) => {
      transactions = rows
    },
    setAccountState: (account) => {
      accountState = account
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
