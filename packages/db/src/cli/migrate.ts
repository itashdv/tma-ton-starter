import { runMigrations } from '../migrate'
import { loadRootEnv, requireEnv } from './env'

loadRootEnv()
const url = requireEnv('DATABASE_URL')
await runMigrations(url)
console.log('migrations applied')
