import { NextRequest, NextResponse } from 'next/server'
import { fetchAccountInfo } from '@/lib/febbox'
import { getSettings, getCookie, updateCookie, deleteCookie } from '@/lib/pool'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** DELETE one cookie from pool */
export async function DELETE(req: NextRequest, { params }: Params) {
  const denied = guard(req)
  if (denied) return denied
  const { id } = await params
  await deleteCookie(id)
  return NextResponse.json({ ok: true })
}

/** PATCH = re-validate / refresh plan info for one cookie */
export async function PATCH(req: NextRequest, { params }: Params) {
  const denied = guard(req)
  if (denied) return denied
  const { id } = await params
  const acc = await getCookie(id)
  if (!acc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const settings = await getSettings()
  const proxy = settings.proxyEnabled ? settings.proxyUrl : null
  const info = await fetchAccountInfo(acc.cookieRaw, proxy)
  if (!info.ok) {
    await updateCookie(id, { status: 'inactive', lastError: info.error || 'validation failed' })
    return NextResponse.json({ ok: false, error: info.error })
  }
  await updateCookie(id, {
    email: info.email || acc.email,
    username: info.username || acc.username,
    plan: info.plan || acc.plan,
    planExpire: info.planExpire || acc.planExpire,
    isVip: !!info.isVip,
    // usage status (limit_reached) is preserved; only auth state flips to inactive
    status: info.isVip ? (acc.status === 'inactive' ? 'active' : acc.status) : 'inactive',
    lastError: info.isVip ? '' : 'account is not VIP',
  })
  return NextResponse.json({ ok: true, isVip: info.isVip, plan: info.plan, email: info.email })
}
