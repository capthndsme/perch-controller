/**
 * InnoDB deadlock victim, or a lock wait that ran out of patience: the two
 * errors a statement can get from a concurrent writer (the poller, the rollup
 * maintainer, retention) that are worth retrying rather than aborting on.
 */
export function isLockContentionError(err: unknown): boolean {
  const candidate = err as { code?: unknown; errno?: unknown } | null
  return (
    candidate?.code === 'ER_LOCK_DEADLOCK' ||
    candidate?.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    candidate?.errno === 1213 ||
    candidate?.errno === 1205
  )
}
