import { scanCursors, type Db } from '@tma/db'
import type { Address } from '@ton/core'
import type pino from 'pino'

import type { LoadedShopConfig } from '../config/shop'
import type { Env } from '../env'
import { toRawAddress } from '../ton/address'
import { normalizeHash } from '../ton/hash'
import type { ToncenterClient } from '../ton/toncenter'
import type { ClassifyContext } from './classify'
import type { ScanAccount } from './scanner'

/**
 * Preconditions checked once before the loop starts, so a misconfigured deployment fails
 * loudly instead of silently recording nothing:
 *
 * - The merchant wallet must be `active`: TonConnect messages are non-bounceable, so TON sent
 *   to an undeployed wallet would still arrive, but it would sit on an account nobody can spend
 *   from until the wallet is deployed; refusing to start is the cheapest way to surface that.
 * - The merchant jetton wallet is derived from the master (`get_wallet_address`) and may be
 *   pinned in the environment; a mismatch means a wrong master or a wrong merchant address.
 * - On-chain decimals, when the indexer knows them, must equal `config/shop.json`, or every
 *   USDT price would be off by orders of magnitude.
 * - Cursors are registered at the account head: history before the first start is not a
 *   payment for any order this deployment created, so it is never ingested.
 */

export class StartupError extends Error {
  /** Exit code the entrypoint maps this error to. */
  readonly exitCode = 2

  constructor(message: string) {
    super(message)
    this.name = 'StartupError'
  }
}

export interface StartupDeps {
  env: Env
  shop: LoadedShopConfig
  ton: ToncenterClient
  db: Db
  log: pino.Logger
  now: () => Date
}

export interface WorkerPlan {
  accounts: ScanAccount[]
  ctx: ClassifyContext
  merchantJettonWallet: Address | null
}

interface CursorSeed {
  account: string
  label: ScanAccount['label']
  /** Equal to `lastLt` at registration: the floor below which re-scans never look. */
  startLt: bigint
  lastLt: bigint
  lastHash: string | null
}

const ACCOUNT_STATUSES_WITHOUT_HISTORY = new Set(['nonexist', 'uninit'])

function decimalsOf(value: string | number | undefined): number | null {
  if (value === undefined) return null
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isInteger(n) ? n : null
}

async function headOf(
  ton: ToncenterClient,
  account: string,
): Promise<{ status: string | null; lastLt: bigint; lastHash: string | null }> {
  const state = await ton.getAccountState(account)
  if (!state || !state.status || ACCOUNT_STATUSES_WITHOUT_HISTORY.has(state.status)) {
    return { status: state?.status ?? null, lastLt: 0n, lastHash: null }
  }
  if (!state.last_transaction_lt || !state.last_transaction_hash) {
    // An account with state always has a last transaction; a cursor at 0 would ingest the
    // whole history, so refuse rather than guess.
    throw new StartupError(
      `account ${account} is ${state.status} but the indexer reports no last transaction; ` +
        'cannot place the scan cursor',
    )
  }
  return {
    status: state.status,
    lastLt: BigInt(state.last_transaction_lt),
    lastHash: normalizeHash(state.last_transaction_hash),
  }
}

export async function prepareWorker(deps: StartupDeps): Promise<WorkerPlan> {
  const { env, shop, ton, db, log } = deps

  const merchant = await headOf(ton, env.merchantRaw)
  if (merchant.status !== 'active') {
    throw new StartupError(
      `merchant wallet ${env.merchantRaw} is ${merchant.status ?? 'unknown'}, expected active: ` +
        'deploy it (one outgoing transfer) before starting the worker',
    )
  }
  const seeds: CursorSeed[] = [
    {
      account: env.merchantRaw,
      label: 'ton_wallet',
      startLt: merchant.lastLt,
      lastLt: merchant.lastLt,
      lastHash: merchant.lastHash,
    },
  ]

  let merchantJettonWallet: Address | null = null
  if (env.usdtMaster && env.usdtMasterRaw) {
    merchantJettonWallet = await ton.getJettonWalletAddress(
      env.usdtMaster.address,
      env.merchant.address,
    )
    const computedRaw = toRawAddress(merchantJettonWallet)
    if (env.merchantUsdtJettonWallet && env.merchantUsdtJettonWallet.raw !== computedRaw) {
      throw new StartupError(
        `MERCHANT_USDT_JETTON_WALLET ${env.merchantUsdtJettonWallet.raw} does not match the wallet ` +
          `derived from USDT_JETTON_MASTER for MERCHANT_WALLET (${computedRaw})`,
      )
    }

    const master = await ton.getJettonMaster(env.usdtMasterRaw)
    const onChainDecimals = decimalsOf(master?.jetton_content?.decimals)
    if (master && onChainDecimals !== null && onChainDecimals !== shop.usdtDecimals) {
      throw new StartupError(
        `USDT_JETTON_MASTER reports ${onChainDecimals} decimals, config/shop.json says ${shop.usdtDecimals}`,
      )
    }
    if (!master) {
      log.warn(
        { master: env.usdtMasterRaw },
        'startup: the indexer does not know the jetton master yet',
      )
    } else if (onChainDecimals === null) {
      log.warn(
        { master: env.usdtMasterRaw },
        'startup: jetton metadata carries no decimals; trusting config',
      )
    }

    const jettonHead = await headOf(ton, computedRaw)
    seeds.push({
      account: computedRaw,
      label: 'usdt_jetton_wallet',
      startLt: jettonHead.lastLt,
      lastLt: jettonHead.lastLt,
      lastHash: jettonHead.lastHash,
    })
    log.info(
      { jettonWallet: computedRaw, status: jettonHead.status ?? 'nonexist' },
      'startup: merchant jetton wallet resolved',
    )
  }

  const now = deps.now()
  // Only a brand-new account gets a cursor; an existing one keeps its position across restarts.
  await db
    .insert(scanCursors)
    .values(seeds.map((seed) => ({ ...seed, updatedAt: now })))
    .onConflictDoNothing({ target: scanCursors.account })

  return {
    accounts: seeds.map(({ account, label }) => ({ account, label })),
    ctx: {
      merchantRaw: env.merchantRaw,
      merchantJettonWalletRaw: merchantJettonWallet ? toRawAddress(merchantJettonWallet) : null,
      usdtMasterRaw: env.usdtMasterRaw,
      minRecordNano: env.WORKER_MIN_RECORD_NANO,
    },
    merchantJettonWallet,
  }
}
