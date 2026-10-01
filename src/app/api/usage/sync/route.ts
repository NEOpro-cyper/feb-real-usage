import { NextRequest, NextResponse } from 'next/server'
import {
  getSettings,
  getCookie,
  syncCookieUsage,
  syncAllCookieUsage,
} from '@/lib/pool'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/usage/sync   body: { id?: string }
 *
 * Pulls each account's REAL high-speed flow usage straight from FebBox
 * (GET /console/user_traffic_query) and mirrors it onto the account:
 *   - usage_gb / real_usage_gb = FebBox's used GB
 *   - real_usage_limit_gb      = plan limit (e.g. 100 GB/day)
 *   - accounts crossing the configured limit → parked 'limit_reached'
 *   - parked accounts back under the limit (daily flow reset) → 'active'
 *
 * `id` → sync just that account; no body → sync the whole pool.
 */
export async function POST(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({}))

  if (body.id) {
    const acc = await getCookie(String(body.id))
    if (!acc) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const settings = await getSettings()
    const proxy = settings.proxyEnabled ? settings.proxyUrl : null
    const result = await syncCookieUsage(acc, { proxyUrl: proxy, usageLimitGb: settings.usageLimitGb })
    return NextResponse.json({ ok: result.ok, results: [result] })
  }

  const results = await syncAllCookieUsage()
  const synced = results.filter((r) => r.ok).length
  const failed = results.length - synced
  const reactivated = results.filter((r) => r.statusChanged === 'reactivated').length
  const parked = results.filter((r) => r.statusChanged === 'limit_reached').length
  return NextResponse.json({
    ok: failed === 0,
    total: results.length,
    synced,
    failed,
    reactivated,
    parked,
    results,
  })
}

/** GET = same as POST without a body — convenience for cron/ping tools */
export async function GET(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied
  const results = await syncAllCookieUsage()
  const synced = results.filter((r) => r.ok).length
  return NextResponse.json({ total: results.length, synced, failed: results.length - synced, results })
}
