import { NextRequest, NextResponse } from 'next/server'
import { getSettings, getCookie, updateCookie } from '@/lib/pool'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** POST /api/cookies/:id/usage — manually add used GB to an account */
export async function POST(req: NextRequest, { params }: Params) {
  const denied = guard(req)
  if (denied) return denied
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const gb = Number(body.gb)
  if (!isFinite(gb)) return NextResponse.json({ error: 'gb number required' }, { status: 400 })
  const acc = await getCookie(id)
  if (!acc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const { usageLimitGb } = await getSettings()
  const usageGb = Math.max(0, acc.usageGb + gb)
  await updateCookie(id, {
    usageGb,
    // manual adjustments are their own source — the next real-usage sync overwrites them
    usageSource: 'manual',
    status: usageGb >= usageLimitGb ? 'limit_reached' : acc.status === 'limit_reached' && gb < 0 ? 'active' : acc.status,
  })
  return NextResponse.json({ ok: true, usageGb: Math.round(usageGb * 100) / 100 })
}
