import {
  getSettings,
  pickCandidates,
  markInactive,
  markLimitReached,
  preflightGuard,
  recordSuccess,
  recordFailure,
  countCookies,
} from '@/lib/pool'
import {
  fetchQualitySources,
  fetchRealUsage,
  type QualityInfo,
  type SourceItem,
} from '@/lib/febbox'

export interface Attempt {
  cookieId: string
  label: string
  email: string
  outcome: string
  detail?: string
}

/** usage accounting info returned to the caller/UI */
export interface UsageInfo {
  /** 'real' → mirrored from FebBox's flow counter; 'estimate' → size-based */
  mode: 'real' | 'estimate'
  /** GB counted against this account by this fetch (estimate basis) */
  estGbAdded: number
  /** did the real-usage sync succeed? (only in real mode) */
  synced?: boolean
  syncError?: string
  /** FebBox's reported numbers after the sync */
  realUsedGb?: number
  realLimitGb?: number
  realResetAt?: string
}

export interface RotationOutcome {
  status: number
  body: Record<string, unknown>
}

/**
 * Fetch the account's real flow usage from FebBox (proxy first, direct
 * fallback). Returns null when it can't be fetched — the caller then falls
 * back to the size-based estimate.
 */
async function fetchRealForAccount(
  cookieRaw: string,
  proxy: string | null
): Promise<{ usedGb: number; limitGb?: number; resetAt?: string } | null> {
  let ru = await fetchRealUsage(cookieRaw, proxy)
  if (!ru.ok && /network error/i.test(ru.error || '')) {
    ru = await fetchRealUsage(cookieRaw, null)
  }
  if (ru.ok && typeof ru.usedGb === 'number') {
    return { usedGb: ru.usedGb, limitGb: ru.limitGb, resetAt: ru.resetAt || '' }
  }
  return null
}

/** Estimated GB a fetch counts for, given the quality list (0 when off). */
function estimateGb(
  qualities: QualityInfo[],
  requestedQuality: string,
  autoUsage: boolean
): number {
  if (!autoUsage) return 0
  if (requestedQuality !== 'AUTO' && requestedQuality !== 'ORG') {
    return qualities.find((q) => q.quality.toLowerCase() === requestedQuality.toLowerCase())?.sizeGb || 0
  }
  if (requestedQuality === 'AUTO') {
    // conservative estimate: largest transcoded (non-ORG) quality
    return Math.max(0, ...qualities.filter((q) => q.quality !== 'ORG').map((q) => q.sizeGb))
  }
  return 0 // ORG: transcoded sizes don't cover the original
}

/**
 * The rotation engine shared by POST /api/fetch and GET/POST /api/stream.
 *
 * Walks the cookie pool (active + VIP + safely under quota, least-usage then
 * least-recently-used first) and for each candidate:
 *
 *   0. PRE-FLIGHT QUOTA GUARD — in real mode, reads the account's LIVE flow
 *      usage from FebBox before spending a fetch on it. Accounts at/over
 *      (limit − safety margin) are parked `limit_reached` and skipped, so a
 *      cookie whose quota is already exceeded — or 1-2 GB short of it — is
 *      never used, even when the DB mirror is stale.
 *   1. Requests the player for the fid through the Webshare proxy (direct
 *      fallback on network error).
 *   2. On success: records usage — the pre-flight real reading, re-synced
 *      after the fetch when autoSyncUsage is on; falls back to the size
 *      estimate when real usage can't be read.
 *
 * Returns:
 *   - status 200 + masterUrl/sources/qualities on success
 *   - status 409 no_active_cookies when nothing is eligible
 *   - status 502 all_failed with per-cookie attempts
 */
export async function runRotation(
  fid: string,
  shareKey: string | undefined,
  requestedQuality: string
): Promise<RotationOutcome> {
  const settings = await getSettings()
  const proxy = settings.proxyEnabled ? settings.proxyUrl : null
  const candidates = await pickCandidates()

  if (candidates.length === 0) {
    const total = await countCookies()
    return {
      status: 409,
      body: {
        success: false,
        error: 'no_active_cookies',
        message: total === 0
          ? 'Pool is empty — add cookies first.'
          : 'No active VIP cookies under the usage limit (incl. safety margin). Reset inactive/limit-reached cookies or add new ones.',
      },
    }
  }

  const attempts: Attempt[] = []

  for (const acc of candidates) {
    // 0) pre-flight quota guard — never fetch with an exhausted/near-exhausted cookie
    const pf = await preflightGuard(acc, { proxyUrl: proxy, settings })
    if (!pf.ok) {
      await recordFailure(acc.id, { fid, message: pf.reason || 'quota guard' })
      attempts.push({
        cookieId: acc.id,
        label: acc.label,
        email: acc.email,
        outcome: 'limit_reached',
        detail: pf.reason,
      })
      continue
    }

    // 1st try through proxy, fallback to direct on network failure
    let res = await fetchQualitySources(fid, acc.cookieRaw, proxy)
    if (!res.ok && /network error/i.test(res.error || '')) {
      res = await fetchQualitySources(fid, acc.cookieRaw, null)
    }

    if (res.ok && res.sources && res.sources.length > 0) {
      const master = res.sources.find((s: SourceItem) => s.label === 'AUTO')
      const qualities = res.qualities || []
      const estGb = estimateGb(qualities, requestedQuality, settings.autoUsage)
      const estGbAdded = Math.round(estGb * 100) / 100

      // Usage accounting: start from the pre-flight real reading; when
      // autoSyncUsage is on, re-sync AFTER the fetch so usage_gb reflects
      // what was just consumed. Falls back to the size estimate when real
      // usage can't be read (so the guard still works).
      let real = pf.real
      if (settings.usageMode === 'real' && settings.autoSyncUsage) {
        const fresh = await fetchRealForAccount(acc.cookieRaw, proxy)
        if (fresh) real = fresh
      }
      await recordSuccess(acc.id, {
        fid,
        fileName: res.fileName || '',
        quality: requestedQuality,
        estGb,
        real,
      })

      const usage: UsageInfo = settings.usageMode === 'real'
        ? real
          ? {
              mode: 'real',
              estGbAdded,
              synced: true,
              realUsedGb: real.usedGb,
              realLimitGb: real.limitGb,
              realResetAt: real.resetAt || undefined,
            }
          : {
              mode: 'real',
              estGbAdded,
              synced: false,
              syncError: 'could not read FebBox flow usage — estimate applied as fallback',
            }
        : { mode: 'estimate', estGbAdded }

      return {
        status: 200,
        body: {
          success: true,
          usedCookie: { id: acc.id, label: acc.label, email: acc.email, uid: acc.uid },
          fid,
          shareKey: shareKey || null,
          ossFid: res.ossFid,
          fileName: res.fileName,
          masterUrl: master?.url || res.sources[0].url,
          sources: res.sources,
          qualities,
          estGbAdded,
          usage,
          proxyUsed: !!proxy,
          attempts,
        },
      }
    }

    // failure path — quota rejections PARK the account (auto-recovers on
    // FebBox's daily flow reset), other account-level errors deactivate it,
    // network/transient errors leave the cookie active.
    const msg = res.error || 'unknown error'
    if (res.limitError || (res.accountError && /traffic|limit|flow|quota|exceed/i.test(msg))) {
      await markLimitReached(acc.id)
      await recordFailure(acc.id, { fid, message: msg })
      attempts.push({
        cookieId: acc.id,
        label: acc.label,
        email: acc.email,
        outcome: 'limit_reached',
        detail: msg,
      })
      continue
    }
    if (res.accountError) {
      await markInactive(acc.id, msg)
      await recordFailure(acc.id, { fid, message: msg, accountError: true })
      attempts.push({ cookieId: acc.id, label: acc.label, email: acc.email, outcome: 'account_inactive', detail: msg })
    } else {
      await recordFailure(acc.id, { fid, message: msg })
      attempts.push({ cookieId: acc.id, label: acc.label, email: acc.email, outcome: 'error', detail: msg })
    }
  }

  return {
    status: 502,
    body: { success: false, error: 'all_failed', message: 'Every cookie in the pool failed.', attempts },
  }
}
