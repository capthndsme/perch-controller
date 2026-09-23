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

/** A unique index refused the row (ER_DUP_ENTRY): someone else wrote the same key first. */
export function isDuplicateEntryError(err: unknown): boolean {
  const candidate = err as { code?: unknown; errno?: unknown } | null
  return candidate?.code === 'ER_DUP_ENTRY' || candidate?.errno === 1062
}

/** A foreign key names a row that is not there (any more): ER_NO_REFERENCED_ROW(_2). */
export function isMissingParentError(err: unknown): boolean {
  const candidate = err as { code?: unknown; errno?: unknown } | null
  return (
    candidate?.code === 'ER_NO_REFERENCED_ROW_2' ||
    candidate?.code === 'ER_NO_REFERENCED_ROW' ||
    candidate?.errno === 1452 ||
    candidate?.errno === 1216
  )
}
