import { NextRequest, NextResponse } from 'next/server'
import { extractShareKey } from '@/lib/febbox'
import { runRotation } from '@/lib/rotator'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/fetch  { fid, shareKey?, quality? }
 * Thin wrapper around the shared rotation engine (src/lib/rotator.ts) —
 * the SAME engine /api/stream uses, so the quota guard, usage accounting
 * and cookie rotation can never drift apart between the two endpoints:
 *
 *  - pre-flight quota guard: accounts at/over (limit − safety margin) are
 *    parked `limit_reached` and skipped, never fetched with
 *  - active + VIP + safely-under-quota accounts only, least-used then
 *    least-recently-used first
 *  - usage accounting: real FebBox flow counter when possible, size
 *    estimate as fallback
 *  - account-level failure (no VIP / expired / blocked) → marked inactive,
 *    try next; quota rejections → parked limit_reached (auto-recovers on
 *    the daily flow reset); network failure → logged, try next
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

  const { status, body: result } = await runRotation(fid, shareKey, requestedQuality)
  return NextResponse.json(result, { status })
}
