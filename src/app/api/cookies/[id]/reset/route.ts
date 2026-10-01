import { NextRequest, NextResponse } from 'next/server'
import { getSettings, getCookie, updateCookie } from '@/lib/pool'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** POST /api/cookies/:id/reset — reactivate one cookie (after renewing plan etc.) */
export async function POST(req: NextRequest, { params }: Params) {
  const denied = guard(req)
  if (denied) return denied
  const { id } = await params
  const acc = await getCookie(id)
  if (!acc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const url = new URL(req.url)
  const clearUsage = url.searchParams.get('clearUsage') === '1' || acc.usageGb >= (await getSettings()).usageLimitGb && url.searchParams.get('keepUsage') !== '1'
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
