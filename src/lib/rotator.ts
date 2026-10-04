import { NextResponse } from 'next/server'
import {
  getSettings,
  pickCandidates,
  markInactive,
  recordSuccess,
  recordFailure,
  countCookies,
} from '@/lib/pool'
import {
  fetchPlayerSources,
  fetchQualitySizes,
  fetchRealUsage,
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

/**
 * The rotation engine shared by POST /api/fetch and GET /api/stream.
 *
 * Walks the cookie pool (active + VIP + under limit, least-usage then
 * least-recently-used first), requests the player for the fid through the
 * Webshare proxy (direct fallback on network error), and returns:
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
          : 'No active VIP cookies under the usage limit. Reset inactive/limit-reached cookies or add new ones.',
      },
    }
  }

  const attempts: Attempt[] = []

  for (const acc of candidates) {
    // 1st try through proxy, fallback to direct on network failure
    let res = await fetchPlayerSources(fid, shareKey, acc.cookieRaw, proxy)
    if (!res.ok && /network error/i.test(res.error || '')) {
      res = await fetchPlayerSources(fid, shareKey, acc.cookieRaw, null)
    }

      if (res.ok && res.sources && res.sources.length > 0) {
      const master = res.sources.find((s: SourceItem) => s.label === 'AUTO')

      // Usage accounting + last_used_at update fired in the background —
      // don't block the response. estGb=0 and real=null mean usage_gb no
      // longer increments, so the 100 GB guard effectively turns off.
      // Re-add `await fetchRealForAccount(acc.cookieRaw, proxy)` here and
      // pass it as `real` if you need the guard back.
      void recordSuccess(acc.id, {
        fid,
        fileName: res.fileName || '',
        quality: requestedQuality,
        estGb: 0,
        real: null,
      }).catch(() => {})

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
          qualities: [],
          estGbAdded: 0,
          usage: { mode: 'estimate', estGbAdded: 0 } as UsageInfo,
          proxyUsed: !!proxy,
          attempts,
        },
      }
    }
    const msg = res.error || 'unknown error'
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
