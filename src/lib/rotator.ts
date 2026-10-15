import {
  getSettings,
  pickCandidates,
  markInactive,
  markLimitReached,
  preflightGuard,
  recordSuccess,
  recordFailure,
  countCookies,
  syncCookieUsage,
} from '@/lib/pool'
import {
  fetchQualitySources,
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
 * STICKY COOKIE — reuse the last cookie that produced a successful fetch
 * instead of re-rotating on every request. The pool order (least usage,
 * then LRU) makes consecutive requests flip-flop between cookies once a
 * post-fetch sync bumps usage, and every flip pays a live FebBox pre-flight
 * round trip. Sticking to one healthy cookie until it errors/parks (or the
 * TTL below expires) removes that overhead — while the per-candidate
 * fallback loop still handles failure inside the same request.
 * Env: STICKY_COOKIE_MINUTES (default 30).
 */
const STICKY_TTL_MS =
  Math.max(1, Number(process.env.STICKY_COOKIE_MINUTES || '30')) * 60_000
let sticky: { cookieId: string; until: number } | null = null

/**
 * SIGNATURE CACHE — febbox play URLs stay valid for hours, so a successful
 * outcome is cached per fid+shareKey and repeat requests return instantly
 * with zero febbox traffic and zero cookie usage.
 * Env: SIGNATURE_CACHE_MINUTES (default 20, 0 disables).
 */
const SIG_CACHE_TTL_MS =
  Math.max(0, Number(process.env.SIGNATURE_CACHE_MINUTES ?? '20')) * 60_000
const SIG_CACHE_MAX = 500
const sigCache = new Map<string, { at: number; outcome: RotationOutcome }>()

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

  const cacheKey = `${fid}|${shareKey || ''}`
  const hit = sigCache.get(cacheKey)
  if (hit) {
    if (SIG_CACHE_TTL_MS > 0 && Date.now() - hit.at < SIG_CACHE_TTL_MS) {
      return {
        status: 200,
        body: { ...hit.outcome.body, cached: true },
      }
    }
    sigCache.delete(cacheKey)
  }

  const candidates = await pickCandidates()

  // sticky-first: try the last cookie that succeeded before the pool order
  if (sticky && sticky.until > Date.now()) {
    const pinnedId = sticky.cookieId
    const idx = candidates.findIndex((c) => c.id === pinnedId)
    if (idx > 0) {
      const [pinned] = candidates.splice(idx, 1)
      candidates.unshift(pinned)
    } else if (idx === -1) {
      sticky = null
    }
  }

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
      if (sticky && sticky.cookieId === acc.id) sticky = null
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
      // Record usage with the pre-flight reading NOW; the FebBox counter
      // re-sync runs in the BACKGROUND so it never blocks the response.
      let real = pf.real
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

      // background usage re-sync (also re-applies parking on the mirror)
      if (settings.usageMode === 'real' && settings.autoSyncUsage) {
        void syncCookieUsage(acc, {
          proxyUrl: proxy,
          usageLimitGb: settings.usageLimitGb,
          usageSafetyGb: settings.usageSafetyGb,
        }).catch(() => {})
      }

      sticky = { cookieId: acc.id, until: Date.now() + STICKY_TTL_MS }

      const outcome: RotationOutcome = {
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
      if (SIG_CACHE_TTL_MS > 0) {
        sigCache.set(cacheKey, { at: Date.now(), outcome })
        if (sigCache.size > SIG_CACHE_MAX) {
          const oldest = sigCache.keys().next().value
          if (oldest) sigCache.delete(oldest)
        }
      }
      return outcome
    }

    // failure path — quota rejections PARK the account (auto-recovers on
    // FebBox's daily flow reset), other account-level errors deactivate it,
    // network/transient errors leave the cookie active.
    const msg = res.error || 'unknown error'
    if (sticky && sticky.cookieId === acc.id) sticky = null
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
