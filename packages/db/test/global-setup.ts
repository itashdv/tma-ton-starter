import { runMigrations } from '../src/migrate'
import { getTestDatabaseUrl } from './helpers'

/** Vitest globalSetup for the integration project: migrate the test database once. */
export default async function setup(): Promise<void> {
  await runMigrations(getTestDatabaseUrl())
}
