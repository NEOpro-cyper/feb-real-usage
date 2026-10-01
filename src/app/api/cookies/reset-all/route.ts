import { NextRequest, NextResponse } from 'next/server'
import { q } from '@/lib/db'
import { getSettings, updateCookie } from '@/lib/pool'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/cookies/reset-all
 * Body: { clearUsage?: boolean }  (default: only clear errors + reactivate)
 * Use after purchasing/renewing plans: every inactive / limit_reached cookie
 * goes back to active, optionally with usage reset to 0.
 */
export async function POST(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const clearUsage = !!body.clearUsage
  const { usageLimitGb } = await getSettings()
  const stuck = await q<{ id: string; usage_gb: number }>(
    `SELECT id, usage_gb FROM cookie_accounts WHERE status IN ('inactive', 'limit_reached')`
  )
  let reactivated = 0
  for (const row of stuck) {
    // If usage is at/over the limit and we are not clearing usage, keep it parked.
    if (!clearUsage && Number(row.usage_gb) >= usageLimitGb) {
      await updateCookie(row.id, { status: 'limit_reached', lastError: 'usage limit reached (reset usage to reactivate)' })
      continue
    }
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
    await updateCookie(row.id, patch)
    reactivated++
  }
  return NextResponse.json({ ok: true, reactivated, total: stuck.length, clearUsage })
}
