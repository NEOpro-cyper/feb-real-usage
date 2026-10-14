import { NextRequest, NextResponse } from 'next/server'
import { parseCookieHeader, fetchAccountInfo } from '@/lib/febbox'
import { getSettings, listCookies, insertCookie, updateCookie, findCookieByUid, countCookies } from '@/lib/pool'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Optional first-run seed: set FEBBOX_SEED_COOKIE in the environment with a
// full cookie string (ci=…; PHPSESSID=…; ui=…) to pre-load one account.
function seedCookie(): string {
  return (process.env.FEBBOX_SEED_COOKIE || '').trim()
}

async function ensureSeed() {
  const raw = seedCookie()
  if (!raw) return
  const count = await countCookies()
  if (count > 0) return
  const p = parseCookieHeader(raw)
  if (!p.ok) return
  // validate the seed once so VIP status is correct from the start
  const settings = await getSettings()
  const proxy = settings.proxyEnabled ? settings.proxyUrl : null
  const info = await fetchAccountInfo(raw, proxy)
  await insertCookie({
    label: 'seeded account',
    cookieRaw: raw,
    uid: p.uid || '',
    email: info.email || '',
    username: info.username || '',
    plan: info.plan || '',
    planExpire: info.planExpire || '',
    isVip: !!info.isVip,
    status: info.ok && info.isVip ? 'active' : 'inactive',
    lastError: info.ok ? (info.isVip ? '' : 'account is not VIP') : info.error || 'validation failed',
  })
}

export async function GET(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied
  await ensureSeed()
  const cookies = await listCookies()
  const settings = await getSettings()
  return NextResponse.json({
    cookies: cookies.map((c) => ({
      id: c.id,
      label: c.label,
      uid: c.uid,
      email: c.email,
      username: c.username,
      plan: c.plan,
      planExpire: c.planExpire,
      isVip: c.isVip,
      status: c.status,
      usageGb: Math.round(c.usageGb * 100) / 100,
      realUsageGb: Math.round(c.realUsageGb * 100) / 100,
      realUsageLimitGb: Math.round(c.realUsageLimitGb * 100) / 100,
      usageSource: c.usageSource,
      usageSyncedAt: c.usageSyncedAt,
      fetchCount: c.fetchCount,
      lastUsedAt: c.lastUsedAt,
      lastError: c.lastError,
      cookiePreview: c.cookieRaw.slice(0, 48) + '…',
      createdAt: c.createdAt,
    })),
    settings,
  })
}

export async function POST(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const raw: string = body.cookies || ''
  const lines = raw
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 20)
  if (lines.length === 0) {
    return NextResponse.json({ error: 'paste at least one cookie string' }, { status: 400 })
  }
  const settings = await getSettings()
  const proxy = settings.proxyEnabled ? settings.proxyUrl : null
  const results: Array<Record<string, unknown>> = []

  for (const line of lines) {
    const parsed = parseCookieHeader(line)
    if (!parsed.ok) {
      results.push({ ok: false, error: parsed.error })
      continue
    }
    // dedupe: same uid already in pool → replace
    const existing = await findCookieByUid(parsed.uid || '')
    const info = await fetchAccountInfo(line, proxy)
    const data = {
      cookieRaw: line,
      uid: parsed.uid || '',
      email: info.email || '',
      username: info.username || '',
      plan: info.plan || '',
      planExpire: info.planExpire || '',
      isVip: !!info.isVip,
      // not VIP / rejected → saved but marked inactive, per user's rule
      status: (info.ok && info.isVip ? 'active' : 'inactive') as 'active' | 'inactive',
      lastError: info.ok ? (info.isVip ? '' : 'account is not VIP') : info.error || 'validation failed',
    }
    let id: string
    if (existing) {
      await updateCookie(existing.id, data)
      id = existing.id
    } else {
      const created = await insertCookie({ label: body.label || '', ...data })
      id = created.id
    }
    results.push({
      ok: true,
      id,
      uid: parsed.uid,
      email: info.email,
      username: info.username,
      plan: info.plan,
      isVip: info.isVip,
      status: data.status,
      error: data.lastError,
    })
  }
  return NextResponse.json({ results })
}
