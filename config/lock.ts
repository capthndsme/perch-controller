import env from '#start/env'
import { defineConfig, stores } from '@adonisjs/lock'

/**
 * Lock config. The scheduler peer-depends on `@adonisjs/lock` so this file
 * exists primarily to satisfy the lock provider; we use the in-process
 * memory store because the runtime architecture is intentionally
 * single-process (poller lives inside the HTTP server, no separate worker).
 *
 * If we ever split the poller into its own systemd unit alongside the API
 * server, swap `LOCK_STORE=database` (or `redis`) so the two processes can
 * coordinate via a shared store instead of double-polling each collector.
 */
const lockConfig = defineConfig({
  default: env.get('LOCK_STORE'),
  stores: {
    memory: stores.memory(),
  },
})

export default lockConfig

declare module '@adonisjs/lock/types' {
  export interface LockStoresList extends InferLockStores<typeof lockConfig> {}
}
