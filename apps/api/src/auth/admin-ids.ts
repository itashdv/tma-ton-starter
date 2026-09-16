/**
 * Admin access is decided by the API alone: the browser never sees TELEGRAM_ADMIN_IDS, and a
 * blank variable denies everyone rather than granting everyone.
 */
export function isAdminId(adminIds: ReadonlySet<string>, userId: number | bigint): boolean {
  if (adminIds.size === 0) return false
  return adminIds.has(String(userId))
}
