import { q, one, exec, newId } from '@/lib/db'
import { fetchRealUsage, type RealUsage } from '@/lib/febbox'

/**
 * Fresh-mirror window: when an account's usage was synced from FebBox less
 * than this many seconds ago, the DB mirror is trusted and the live
 * /console/user_traffic_query round trip in the pre-flight guard is skipped.
 * Set PREFLIGHT_TTL_SECONDS=0 to always do the live check (old behaviour).
 */
const PREFLIGHT_TTL_MS =
  Math.max(0, Number(process.env.PREFLIGHT_TTL_SECONDS ?? '90')) * 1000

/* ------------------------- settings ------------------------- */

export const DEFAULT_SETTINGS = {
  // env overrides for fresh deployments; Settings UI values (stored in DB) win after first save
  proxyUrl: process.env.DEFAULT_PROXY_URL || '',
  proxyEnabled: (process.env.DEFAULT_PROXY_ENABLED ?? 'true') === 'true',
  usageLimitGb: Number(process.env.USAGE_LIMIT_GB) || 100,
  // quota guard safety margin (GB): accounts within this distance of their
  // limit count as exhausted and are never selected/parked-in-use
  // (e.g. 2 → an account is retired at 98 GB of a 100 GB limit)
  usageSafetyGb: isFinite(Number(process.env.USAGE_SAFETY_GB))
    ? Math.max(0, Number(process.env.USAGE_SAFETY_GB))
    : 2,
  autoUsage: (process.env.AUTO_USAGE ?? 'true') === 'true',
  // 'real' → usage mirrors FebBox's own flow counter (fetched live);
  // 'estimate' → legacy behaviour (add predicted file size per fetch)
  usageMode: (process.env.USAGE_MODE === 'estimate' ? 'estimate' : 'real') as 'real' | 'estimate',
  // re-sync the used account's real usage right after every successful fetch
  autoSyncUsage: (process.env.AUTO_SYNC_USAGE ?? 'true') === 'true',
}

export type AppSettings = typeof DEFAULT_SETTINGS

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS)

export async function getSettings(): Promise<AppSettings> {
  const rows = await q<{ key: string; value: string }>(
    `SELECT \`key\`, \`value\` FROM settings WHERE \`key\` IN (${SETTINGS_KEYS.map(() => '?').join(',')})`,
    SETTINGS_KEYS
  )
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const safety = Number(map.usageSafetyGb)
  return {
    proxyUrl: map.proxyUrl ?? DEFAULT_SETTINGS.proxyUrl,
    proxyEnabled: (map.proxyEnabled ?? String(DEFAULT_SETTINGS.proxyEnabled)) === 'true',
    usageLimitGb: Number(map.usageLimitGb ?? DEFAULT_SETTINGS.usageLimitGb) || 100,
    usageSafetyGb: isFinite(safety) && safety >= 0 ? safety : DEFAULT_SETTINGS.usageSafetyGb,
    autoUsage: (map.autoUsage ?? String(DEFAULT_SETTINGS.autoUsage)) === 'true',
    usageMode: (map.usageMode === 'estimate' ? 'estimate' : 'real') as 'real' | 'estimate',
    autoSyncUsage: (map.autoSyncUsage ?? String(DEFAULT_SETTINGS.autoSyncUsage)) === 'true',
  }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const entries = Object.entries(patch).filter(([k]) => k in DEFAULT_SETTINGS)
  for (const [key, value] of entries) {
    await exec(
      `INSERT INTO settings (\`key\`, \`value\`) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
      [key, String(value)]
    )
  }
  return getSettings()
}

/* ------------------------- quota guard ------------------------- */

/**
 * Hard quota for an account: its own FebBox plan limit when known
 * (real_usage_limit_gb, e.g. 100 GB/day Premium), otherwise the globally
 * configured limit — whichever is lower.
 */
export function hardLimitGb(
  s: Pick<AppSettings, 'usageLimitGb'>,
  accountLimitGb?: number | null
): number {
  const own = Number(accountLimitGb) || 0
  return own > 0 ? Math.min(s.usageLimitGb, own) : s.usageLimitGb
}

/**
 * Usage threshold above which an account counts as exhausted — never picked,
 * parked as soon as a sync/preflight sees it past this point:
 *   hard limit − safety margin.
 * A 100 GB limit with a 2 GB margin retires the account at 98 GB so a fetch
 * never tips it over the quota.
 */
export function quotaThresholdGb(
  s: Pick<AppSettings, 'usageLimitGb' | 'usageSafetyGb'>,
  accountLimitGb?: number | null
): number {
  return Math.max(0, hardLimitGb(s, accountLimitGb) - (Number(s.usageSafetyGb) || 0))
}

/* ------------------------- cookie accounts ------------------------- */

export interface CookieAccount {
  id: string
  label: string
  cookieRaw: string
  uid: string
  email: string
  username: string
  plan: string
  planExpire: string
  isVip: boolean
  status: 'active' | 'inactive' | 'limit_reached'
  usageGb: number
  /** real high-speed flow usage as last reported by FebBox (GB) */
  realUsageGb: number
  /** plan's daily flow limit as reported by FebBox (GB, e.g. 100) */
  realUsageLimitGb: number
  /** 'real' → usage_gb mirrors FebBox; 'estimate' → size-based; 'manual' → hand-adjusted */
  usageSource: 'real' | 'estimate' | 'manual'
  usageSyncedAt: Date | null
  fetchCount: number
  lastUsedAt: Date | null
  lastError: string
  createdAt: Date
  updatedAt: Date
}

interface DbRow {
  id: string
  label: string
  cookieRaw: string
  uid: string
  email: string
  username: string
  plan: string
  planExpire: string
  isVip: number
  status: string
  usageGb: number
  realUsageGb: number
  realUsageLimitGb: number
  usageSource: string
  usageSyncedAt: Date | null
  fetchCount: number
  lastUsedAt: Date | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

// aliases map snake_case columns straight onto the camelCase interface
const SELECT_COOKIE = `
  SELECT id, label, cookie_raw AS cookieRaw, uid, email, username, plan,
         plan_expire AS planExpire, is_vip AS isVip, status,
         usage_gb AS usageGb,
         real_usage_gb AS realUsageGb, real_usage_limit_gb AS realUsageLimitGb,
         usage_source AS usageSource, usage_synced_at AS usageSyncedAt,
         fetch_count AS fetchCount,
         last_used_at AS lastUsedAt, last_error AS lastError,
         created_at AS createdAt, updated_at AS updatedAt
  FROM cookie_accounts`

function hydrate(r: DbRow): CookieAccount {
  return {
    ...r,
    isVip: !!r.isVip,
    status: (r.status || 'active') as CookieAccount['status'],
    lastError: r.lastError || '',
    usageGb: Number(r.usageGb) || 0,
    realUsageGb: Number(r.realUsageGb) || 0,
    realUsageLimitGb: Number(r.realUsageLimitGb) || 0,
    usageSource: (r.usageSource === 'real' || r.usageSource === 'manual'
      ? r.usageSource
      : 'estimate') as CookieAccount['usageSource'],
    usageSyncedAt: r.usageSyncedAt || null,
  }
}

export type NewCookieData = Omit<
  CookieAccount,
  'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'fetchCount' | 'usageSyncedAt'
    | 'usageGb' | 'realUsageGb' | 'realUsageLimitGb' | 'usageSource'
> & {
  fetchCount?: number
  lastUsedAt?: Date | null
  usageGb?: number
  realUsageGb?: number
  realUsageLimitGb?: number
  usageSource?: 'real' | 'estimate' | 'manual'
}

export async function insertCookie(data: NewCookieData): Promise<CookieAccount> {
  const id = newId()
  await exec(
    `INSERT INTO cookie_accounts
       (id, label, cookie_raw, uid, email, username, plan, plan_expire,
        is_vip, status, usage_gb, real_usage_gb, real_usage_limit_gb,
        usage_source, fetch_count, last_used_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.label || '',
      data.cookieRaw,
      data.uid || '',
      data.email || '',
      data.username || '',
      data.plan || '',
      data.planExpire || '',
      data.isVip ? 1 : 0,
      data.status || 'active',
      data.usageGb || 0,
      data.realUsageGb || 0,
      data.realUsageLimitGb || 0,
      data.usageSource || 'estimate',
      data.fetchCount ?? 0,
      data.lastUsedAt ?? null,
      data.lastError || '',
    ]
  )
  const created = await getCookie(id)
  return created as CookieAccount
}

export type CookiePatch = Partial<
  Pick<
    CookieAccount,
    | 'label'
    | 'cookieRaw'
    | 'uid'
    | 'email'
    | 'username'
    | 'plan'
    | 'planExpire'
    | 'isVip'
    | 'status'
    | 'usageGb'
    | 'realUsageGb'
    | 'realUsageLimitGb'
    | 'usageSource'
    | 'lastError'
  >
> & { lastUsedAt?: Date | null; usageSyncedAt?: Date | null }

const PATCH_COLUMNS: Record<string, string> = {
  label: 'label',
  cookieRaw: 'cookie_raw',
  uid: 'uid',
  email: 'email',
  username: 'username',
  plan: 'plan',
  planExpire: 'plan_expire',
  isVip: 'is_vip',
  status: 'status',
  usageGb: 'usage_gb',
  realUsageGb: 'real_usage_gb',
  realUsageLimitGb: 'real_usage_limit_gb',
  usageSource: 'usage_source',
  usageSyncedAt: 'usage_synced_at',
  lastError: 'last_error',
  lastUsedAt: 'last_used_at',
}

export async function updateCookie(id: string, patch: CookiePatch): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    const col = PATCH_COLUMNS[key]
    if (!col) continue
    sets.push(`\`${col}\` = ?`)
    if (key === 'isVip') params.push(value ? 1 : 0)
    else if (key === 'lastError') params.push(String(value ?? '').slice(0, 500))
    else params.push(value)
  }
  if (sets.length === 0) return
  params.push(id)
  await exec(`UPDATE cookie_accounts SET ${sets.join(', ')} WHERE id = ?`, params)
}

export async function getCookie(id: string): Promise<CookieAccount | null> {
  const row = await one<DbRow>(`${SELECT_COOKIE} WHERE id = ?`, [id])
  return row ? hydrate(row) : null
}

export async function findCookieByUid(uid: string): Promise<CookieAccount | null> {
  if (!uid) return null
  const row = await one<DbRow>(`${SELECT_COOKIE} WHERE uid = ? LIMIT 1`, [uid])
  return row ? hydrate(row) : null
}

export async function listCookies(): Promise<CookieAccount[]> {
  const rows = await q<DbRow>(`${SELECT_COOKIE} ORDER BY created_at ASC, id ASC`)
  return rows.map(hydrate)
}

export async function countCookies(): Promise<number> {
  const row = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM cookie_accounts`)
  return Number(row?.n || 0)
}

export async function deleteCookie(id: string): Promise<void> {
  await exec(`DELETE FROM cookie_accounts WHERE id = ?`, [id])
}

/* ------------------------- cookie selection ------------------------- */

/**
 * Pick candidate cookies for a fetch: active + VIP + SAFELY under quota.
 *
 * Quota guard (belt): usage_gb must sit under (configured limit − safety
 * margin), AND when FebBox has already reported the account's own plan
 * limit, real_usage_gb must sit under (that limit − safety margin) too.
 * Accounts at/over either threshold — even 1-2 GB short of the limit — are
 * never returned. Order: least usage first, then least-recently-used —
 * spreads the budget evenly across the pool.
 */
export async function pickCandidates(): Promise<CookieAccount[]> {
  const { usageLimitGb, usageSafetyGb } = await getSettings()
  const rows = await q<DbRow>(
    `${SELECT_COOKIE}
     WHERE status = 'active' AND is_vip = 1
       AND usage_gb < GREATEST(? - ?, 0)
       AND (real_usage_limit_gb <= 0
            OR real_usage_gb < GREATEST(real_usage_limit_gb - ?, 0))
     ORDER BY usage_gb ASC, last_used_at ASC, created_at ASC`,
    [usageLimitGb, usageSafetyGb, usageSafetyGb]
  )
  return rows.map(hydrate)
}

/* ------------------------- real usage sync ------------------------- */

export interface SyncUsageResult {
  ok: boolean
  cookieId: string
  email: string
  label: string
  error?: string
  /** real values applied to the DB (only when ok) */
  usedGb?: number
  limitGb?: number
  resetAt?: string
  /** 'real' → DB updated from FebBox; 'skipped' → usageMode is estimate */
  source?: 'real' | 'skipped'
  /** status changes applied by this sync */
  statusChanged?: 'limit_reached' | 'reactivated' | null
  /** usage threshold applied by this sync (limit − safety margin) */
  thresholdGb?: number
}

/**
 * Fetch the account's REAL flow usage from FebBox (/console/user_traffic_query)
 * and mirror it onto the account:
 *   - usage_gb / real_usage_gb = FebBox's used GB
 *   - real_usage_limit_gb      = FebBox's plan limit (e.g. 100 GB/day)
 *   - usage_source = 'real', usage_synced_at = NOW()
 *   - active account crossing the configured limit → parked 'limit_reached'
 *   - parked account back under the limit (FebBox daily reset!) → 'active' again
 *
 * Network rule: try through the proxy first, fall back to a direct call.
 */
export async function syncCookieUsage(
  acc: CookieAccount,
  opts: { proxyUrl?: string | null; usageLimitGb: number; usageSafetyGb?: number }
): Promise<SyncUsageResult> {
  const base = { cookieId: acc.id, email: acc.email, label: acc.label }
  let res: RealUsage = await fetchRealUsage(acc.cookieRaw, opts.proxyUrl)
  if (!res.ok && /network error/i.test(res.error || '')) {
    res = await fetchRealUsage(acc.cookieRaw, null)
  }
  if (!res.ok || typeof res.usedGb !== 'number') {
    return { ...base, ok: false, error: res.error || 'usage fetch failed' }
  }

  const usedGb = res.usedGb
  // the account's own plan limit (as reported by FebBox) binds when lower,
  // and the safety margin keeps accounts well clear of the hard quota
  const threshold = quotaThresholdGb(
    { usageLimitGb: opts.usageLimitGb, usageSafetyGb: opts.usageSafetyGb ?? 0 },
    res.limitGb
  )
  let statusChanged: SyncUsageResult['statusChanged'] = null
  let status = acc.status
  if (acc.status === 'active' && usedGb >= threshold) {
    status = 'limit_reached'
    statusChanged = 'limit_reached'
  } else if (acc.status === 'limit_reached' && usedGb < threshold) {
    // FebBox reset the daily flow → put the account back to work
    status = 'active'
    statusChanged = 'reactivated'
  }

  await exec(
    `UPDATE cookie_accounts
     SET usage_gb = ?, real_usage_gb = ?, real_usage_limit_gb = ?,
         usage_source = 'real', usage_synced_at = NOW(),
         status = ?, last_error = ?
     WHERE id = ?`,
    [
      usedGb,
      usedGb,
      res.limitGb ?? 0,
      status,
      // refresh the stored error text only when it matters
      status === 'limit_reached' ? 'usage limit reached' : acc.status === 'limit_reached' && status === 'active' ? '' : acc.lastError,
      acc.id,
    ]
  )
  return {
    ...base,
    ok: true,
    usedGb,
    limitGb: res.limitGb,
    resetAt: res.resetAt || '',
    source: 'real',
    statusChanged,
    thresholdGb: threshold,
  }
}

/* ------------------------- pre-flight quota guard ------------------------- */

export interface PreflightResult {
  /** true → the account may be used for a fetch */
  ok: boolean
  /** human-readable reason when not ok (quota guard tripped) */
  reason?: string
  /** fresh real usage read from FebBox (null when not readable / estimate mode) */
  real: { usedGb: number; limitGb?: number; resetAt?: string } | null
  /** status change applied by the guard's sync */
  statusChanged?: 'limit_reached' | 'reactivated' | null
  /** why no live reading was possible (account still usable, DB guard applies) */
  error?: string
}

/**
 * Pre-flight quota guard — run BEFORE spending a fetch on an account.
 *
 * In 'real' mode this reads the account's LIVE flow usage from FebBox
 * (via syncCookieUsage, which also mirrors + parks it) and rejects the
 * account when usage is at/over (limit − safety margin). This is what
 * stops the pool from using a cookie whose quota is already exceeded or
 * 1-2 GB short of the limit — even when the DB mirror is stale.
 *
 * In 'estimate' mode the DB mirror (usage_gb, enforced by pickCandidates)
 * is the guard and this is a pass-through.
 *
 * If the live check fails (network etc.) the account is NOT blocked: the
 * DB mirror still guards via pickCandidates, and the caller falls back to
 * estimate accounting.
 */
export async function preflightGuard(
  acc: CookieAccount,
  opts: { proxyUrl?: string | null; settings: AppSettings }
): Promise<PreflightResult> {
  if (opts.settings.usageMode !== 'real') {
    return { ok: true, real: null }
  }
  // Fresh-mirror shortcut — skip the live FebBox round trip when the mirror
  // was synced moments ago. The mirror values still guard the quota.
  const syncedAgeMs = acc.usageSyncedAt
    ? Date.now() - new Date(acc.usageSyncedAt).getTime()
    : Number.POSITIVE_INFINITY
  if (PREFLIGHT_TTL_MS > 0 && syncedAgeMs < PREFLIGHT_TTL_MS) {
    const ownLimit = acc.realUsageLimitGb > 0 ? acc.realUsageLimitGb : null
    const threshold = quotaThresholdGb(opts.settings, ownLimit)
    const real = {
      usedGb: acc.realUsageGb,
      limitGb: ownLimit ?? undefined,
      resetAt: '',
    }
    if (acc.realUsageGb >= threshold) {
      return {
        ok: false,
        reason:
          `quota guard (cached mirror): ${acc.realUsageGb} GB used ≥ ` +
          `${threshold} GB threshold (${opts.settings.usageSafetyGb} GB safety margin)`,
        real,
      }
    }
    return {
      ok: true,
      real,
      error: 'preflight skipped — mirror fresher than TTL',
    }
  }
  const sync = await syncCookieUsage(acc, {
    proxyUrl: opts.proxyUrl,
    usageLimitGb: opts.settings.usageLimitGb,
    usageSafetyGb: opts.settings.usageSafetyGb,
  })
  if (!sync.ok) {
    return { ok: true, real: null, error: sync.error }
  }
  const usedGb = sync.usedGb as number
  const threshold = quotaThresholdGb(opts.settings, sync.limitGb)
  if (usedGb >= threshold) {
    return {
      ok: false,
      reason:
        `quota guard: ${usedGb} GB used ≥ ${threshold} GB threshold ` +
        `(limit ${sync.limitGb ?? opts.settings.usageLimitGb} GB, ` +
        `${opts.settings.usageSafetyGb} GB safety margin)`,
      real: { usedGb, limitGb: sync.limitGb, resetAt: sync.resetAt || '' },
      statusChanged: sync.statusChanged,
    }
  }
  return {
    ok: true,
    real: { usedGb, limitGb: sync.limitGb, resetAt: sync.resetAt || '' },
    statusChanged: sync.statusChanged,
  }
}

/** Sync every cookie in the pool (sequential — pools are small). */
export async function syncAllCookieUsage(): Promise<SyncUsageResult[]> {
  const settings = await getSettings()
  const proxy = settings.proxyEnabled ? settings.proxyUrl : null
  const all = await listCookies()
  const out: SyncUsageResult[] = []
  for (const acc of all) {
    out.push(await syncCookieUsage(acc, {
      proxyUrl: proxy,
      usageLimitGb: settings.usageLimitGb,
      usageSafetyGb: settings.usageSafetyGb,
    }))
  }
  return out
}

/* ------------------------- state transitions ------------------------- */

/** Does an error message look account-level (→ mark inactive)? */
export function isAccountLevelError(msg: string): boolean {
  return /vip|upgrade|premium|traffic|limit|expire|login|auth|permission|banned|block|session/i.test(msg)
}

export async function markInactive(cookieId: string, reason: string) {
  await updateCookie(cookieId, { status: 'inactive', lastError: reason.slice(0, 500) })
}

export async function markLimitReached(cookieId: string) {
  await updateCookie(cookieId, { status: 'limit_reached', lastError: 'usage limit reached' })
}

export async function recordSuccess(
  cookieId: string,
  opts: {
    fid: string
    fileName: string
    quality: string
    estGb: number
    /**
     * Real usage fetched from FebBox for this account right after the fetch.
     * When present, usage_gb is REPLACED by FebBox's own flow counter
     * (source 'real'); when absent (fetch failed / estimate mode) the
     * estimated size is ADDED (source 'estimate') so the guard still works.
     */
    real?: { usedGb: number; limitGb?: number; resetAt?: string } | null
  }
) {
  const { usageLimitGb, usageSafetyGb } = await getSettings()
  if (opts.real && typeof opts.real.usedGb === 'number') {
    const used = opts.real.usedGb
    // park at the safety margin (limit − margin), respecting the account's
    // own plan limit when FebBox reported one — never let a fetch tip it over
    const threshold = quotaThresholdGb({ usageLimitGb, usageSafetyGb }, opts.real.limitGb)
    await exec(
      `UPDATE cookie_accounts
       SET usage_gb = ?,
           real_usage_gb = ?,
           real_usage_limit_gb = ?,
           usage_source = 'real',
           usage_synced_at = NOW(),
           status = IF(? >= ?, 'limit_reached', IF(status = 'limit_reached', 'active', status)),
           last_error = IF(? >= ?, 'usage limit reached', ''),
           fetch_count = fetch_count + 1,
           last_used_at = NOW()
       WHERE id = ?`,
      [used, used, opts.real.limitGb ?? 0, used, threshold, used, threshold, cookieId]
    )
  } else {
    // status is computed BEFORE usage_gb is reassigned (SET runs left to right),
    // so IF(usage_gb + est >= threshold) compares against the pre-update value.
    // Threshold = configured limit − safety margin (the per-account plan-limit
    // check runs separately in pickCandidates via real_usage_gb).
    const threshold = Math.max(0, usageLimitGb - (Number(usageSafetyGb) || 0))
    await exec(
      `UPDATE cookie_accounts
       SET status = IF(usage_gb + ? >= ?, 'limit_reached', status),
           usage_gb = usage_gb + ?,
           usage_source = 'estimate',
           fetch_count = fetch_count + 1,
           last_used_at = NOW(),
           last_error = ''
       WHERE id = ?`,
      [opts.estGb, threshold, opts.estGb, cookieId]
    )
  }
  await insertLog({
    cookieId,
    fid: opts.fid,
    fileName: opts.fileName.slice(0, 200),
    quality: opts.quality,
    status: 'success',
    message: opts.real ? 'ok · usage synced from FebBox' : 'ok',
    estGb: opts.estGb,
  })
}

export async function recordFailure(
  cookieId: string | null,
  opts: { fid: string; message: string; accountError?: boolean }
) {
  if (cookieId && opts.accountError) await markInactive(cookieId, opts.message)
  await insertLog({
    cookieId,
    fid: opts.fid,
    status: 'failed',
    message: opts.message.slice(0, 500),
  })
}

/* ------------------------- fetch logs ------------------------- */

export interface FetchLogRow {
  id: string
  cookieId: string | null
  fid: string
  fileName: string
  quality: string
  status: string
  message: string
  estGb: number
  createdAt: Date
  cookie: { label: string; email: string } | null
}

interface LogDbRow {
  id: string
  cookieId: string | null
  fid: string
  fileName: string
  quality: string
  status: string
  message: string | null
  estGb: number
  createdAt: Date
  cookieLabel: string | null
  cookieEmail: string | null
}

export async function insertLog(data: {
  cookieId: string | null
  fid: string
  fileName?: string
  quality?: string
  status: 'success' | 'failed'
  message: string
  estGb?: number
}) {
  await exec(
    `INSERT INTO fetch_logs (id, cookie_id, fid, file_name, quality, status, message, est_gb)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), data.cookieId, data.fid || '', data.fileName || '', data.quality || '', data.status, data.message, data.estGb || 0]
  )
}

export async function listRecentLogs(take = 60): Promise<FetchLogRow[]> {
  const rows = await q<LogDbRow>(
    `SELECT l.id, l.cookie_id AS cookieId, l.fid, l.file_name AS fileName, l.quality,
            l.status, l.message, l.est_gb AS estGb, l.created_at AS createdAt,
            c.label AS cookieLabel, c.email AS cookieEmail
     FROM fetch_logs l
     LEFT JOIN cookie_accounts c ON l.cookie_id = c.id
     ORDER BY l.created_at DESC
     LIMIT ${Number(take) || 60}`
  )
  return rows.map((r) => ({
    id: r.id,
    cookieId: r.cookieId,
    fid: r.fid,
    fileName: r.fileName,
    quality: r.quality,
    status: r.status,
    message: r.message || '',
    estGb: Number(r.estGb) || 0,
    createdAt: r.createdAt,
    cookie: r.cookieId && r.cookieLabel !== null ? { label: r.cookieLabel || '', email: r.cookieEmail || '' } : null,
  }))
}
