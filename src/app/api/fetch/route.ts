import { NextRequest, NextResponse } from 'next/server'
import { countCookies } from '@/lib/pool'
import {
  fetchQualitySources,
  fetchRealUsage,
  extractShareKey,
  type SourceItem,
} from '@/lib/febbox'
import {
  getSettings,
  pickCandidates,
  markInactive,
  recordSuccess,
  recordFailure,
} from '@/lib/pool'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface Attempt {
  cookieId: string
  label: string
  email: string
  outcome: string
  detail?: string
}

/**
 * POST /api/fetch  { fid, shareKey?, quality? }
 * Rotates through the cookie pool (least-usage, least-recently-used first),
 * requests the player for the fid via the Webshare rotating proxy,
 * and returns the master (AUTO) playlist URL + all pre-signed quality URLs.
 *
 * Rules:
 *  - account-level failure (no VIP / expired / blocked) → cookie marked inactive, try next
 *  - network failure → logged, try next cookie (cookie NOT marked inactive)
 *  - all failed → success:false, error:"all_failed" with per-cookie attempts
 */
export async function POST(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const fid = String(body.fid || '').trim()
  if (!/^\d+$/.test(fid)) {
    return NextResponse.json({ error: 'valid numeric fid required' }, { status: 400 })
  }
  const shareKey = body.shareKey ? extractShareKey(String(body.shareKey)) : undefined
  const requestedQuality = body.quality ? String(body.quality) : 'AUTO'

  const settings = await getSettings()
  const proxy = settings.proxyEnabled ? settings.proxyUrl : null
  const candidates = await pickCandidates()

  if (candidates.length === 0) {
    const total = await countCookies()
    return NextResponse.json(
      {
        success: false,
        error: 'no_active_cookies',
        message: total === 0
          ? 'Pool is empty — add cookies first.'
          : 'No active VIP cookies under the usage limit. Reset inactive/limit-reached cookies or add new ones.',
      },
      { status: 409 }
    )
  }

  const attempts: Attempt[] = []

  for (const acc of candidates) {
    // 1st try through proxy, fallback to direct on network failure
    let res = await fetchQualitySources(fid, acc.cookieRaw, proxy)
    if (!res.ok && /network error/i.test(res.error || '')) {
      res = await fetchQualitySources(fid, acc.cookieRaw, null)
    }

    if (res.ok && res.sources && res.sources.length > 0) {
      const qualities = res.qualities || []
      let estGb = 0
      if (settings.autoUsage) {
        if (requestedQuality !== 'AUTO' && requestedQuality !== 'ORG') {
          estGb = qualities.find((q) => q.quality.toLowerCase() === requestedQuality.toLowerCase())?.sizeGb || 0
        } else if (requestedQuality === 'AUTO') {
          // conservative estimate: largest transcoded (non-ORG) quality
          estGb = Math.max(0, ...qualities.filter((q) => q.quality !== 'ORG').map((q) => q.sizeGb))
        }
      }

      // usage accounting: real FebBox flow counter when possible, estimate otherwise
      const usage: Record<string, unknown> = { mode: settings.usageMode, estGbAdded: Math.round(estGb * 100) / 100 }
      let real: { usedGb: number; limitGb?: number; resetAt?: string } | null = null
      if (settings.usageMode === 'real') {
        let ru = await fetchRealUsage(acc.cookieRaw, proxy)
        if (!ru.ok && /network error/i.test(ru.error || '')) {
          ru = await fetchRealUsage(acc.cookieRaw, null)
        }
        if (ru.ok && typeof ru.usedGb === 'number') {
          real = { usedGb: ru.usedGb, limitGb: ru.limitGb, resetAt: ru.resetAt || '' }
          usage.synced = true
          usage.realUsedGb = real.usedGb
          usage.realLimitGb = real.limitGb
          usage.realResetAt = real.resetAt
        } else {
          usage.synced = false
          usage.syncError = 'could not read FebBox flow usage — estimate applied as fallback'
        }
      }
      await recordSuccess(acc.id, {
        fid,
        fileName: res.fileName || '',
        quality: requestedQuality,
        estGb,
        real,
      })

      const master = res.sources.find((s: SourceItem) => s.label === 'AUTO')
      return NextResponse.json({
        success: true,
        usedCookie: { id: acc.id, label: acc.label, email: acc.email, uid: acc.uid },
        fid,
        shareKey: shareKey || null,
        ossFid: res.ossFid,
        fileName: res.fileName,
        masterUrl: master?.url || res.sources[0].url,
        sources: res.sources,
        qualities,
        estGbAdded: usage.estGbAdded,
        usage,
        proxyUsed: !!proxy,
        attempts,
      })
    }

    // failure path
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

  return NextResponse.json(
    { success: false, error: 'all_failed', message: 'Every cookie in the pool failed.', attempts },
    { status: 502 }
  )
}
