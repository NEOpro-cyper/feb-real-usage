import { NextRequest, NextResponse } from 'next/server'
import { getCookie, updateCookie } from '@/lib/pool'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/cookies/:id/reset — reactivate one cookie (after renewing plan etc.)
 *
 * Usage is only cleared when ?clearUsage=1 is passed EXPLICITLY. A bare reset
 * keeps the usage counter, so an account whose quota is already exceeded
 * stays blocked by the quota guard (it would be re-parked on the next sync
 * or pre-flight check anyway). The reset-all endpoint behaves the same way.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const denied = guard(req)
  if (denied) return denied
  const { id } = await params
  const acc = await getCookie(id)
  if (!acc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const url = new URL(req.url)
  const clearUsage = url.searchParams.get('clearUsage') === '1'
  const patch: {
    status: 'active'
    lastError: string
    usageGb?: number
    realUsageGb?: number
    realUsageLimitGb?: number
    usageSource?: 'estimate' | 'real' | 'manual'
    usageSyncedAt?: null
  } = { status: 'active', lastError: '' }
  if (clearUsage) {
    patch.usageGb = 0
    patch.realUsageGb = 0
    patch.realUsageLimitGb = 0
    patch.usageSource = 'estimate'
    patch.usageSyncedAt = null
  }
  await updateCookie(id, patch)
  return NextResponse.json({ ok: true, clearedUsage: clearUsage })
}
