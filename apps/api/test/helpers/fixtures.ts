import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  accountStatesResponseSchema,
  jettonMastersResponseSchema,
  transactionSchema,
  type ToncenterTransaction,
} from '../../src/ton/toncenter.schemas'

/**
 * Fixtures under test/fixtures/toncenter are live toncenter v3 responses recorded with
 * `pnpm --filter @tma/api tc:record-fixture`, wrapped in this envelope. They are never edited
 * by hand: the point is to test the listener against the real wire format.
 */
export interface FixtureEnvelope {
  recordedAt: string
  network: string
  /** Full request URL without any key. */
  source: string
  note: string
  response: unknown
}

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/toncenter', import.meta.url))

export function listFixtures(): string[] {
  let entries: string[]
  try {
    entries = readdirSync(FIXTURES_DIR)
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort()
}

export function loadFixture(name: string): FixtureEnvelope {
  const file = path.join(FIXTURES_DIR, `${name}.json`)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(
      `fixture "${name}" is missing (${error instanceof Error ? error.message : String(error)}); record it with tc:record-fixture`,
      { cause: error },
    )
  }
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('response' in parsed) ||
    typeof (parsed as { source?: unknown }).source !== 'string'
  ) {
    throw new Error(`fixture "${name}" is not a recorded envelope`)
  }
  return parsed as FixtureEnvelope
}

/** `response.transactions[0]` of a `/transactions?hash=` recording, validated. */
export function fixtureTransaction(name: string): ToncenterTransaction {
  const response = loadFixture(name).response as { transactions?: unknown[] } | null
  const row = response?.transactions?.[0]
  if (row === undefined) throw new Error(`fixture "${name}" has no transactions[0]`)
  return transactionSchema.parse(row)
}

export function fixtureAccountState(name = 'account-state-active') {
  const account = accountStatesResponseSchema.parse(loadFixture(name).response).accounts[0]
  if (!account) throw new Error(`fixture "${name}" has no accounts[0]`)
  return account
}

export function fixtureJettonMaster(name = 'jetton-master-usdt') {
  const master = jettonMastersResponseSchema.parse(loadFixture(name).response).jetton_masters[0]
  if (!master) throw new Error(`fixture "${name}" has no jetton_masters[0]`)
  return master
}
