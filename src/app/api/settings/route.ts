import { NextRequest, NextResponse } from 'next/server'
import { getSettings, saveSettings, AppSettings } from '@/lib/pool'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied
  return NextResponse.json(await getSettings())
}

export async function PUT(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const patch: Partial<AppSettings> = {}
  if (typeof body.proxyUrl === 'string') patch.proxyUrl = body.proxyUrl
  if (typeof body.proxyEnabled === 'boolean') patch.proxyEnabled = body.proxyEnabled
  if (body.usageLimitGb !== undefined) {
    const n = Number(body.usageLimitGb)
    if (isFinite(n) && n > 0) patch.usageLimitGb = n
  }
  if (body.usageSafetyGb !== undefined) {
    const n = Number(body.usageSafetyGb)
    if (isFinite(n) && n >= 0) patch.usageSafetyGb = n
  }
  if (typeof body.autoUsage === 'boolean') patch.autoUsage = body.autoUsage
  if (body.usageMode === 'real' || body.usageMode === 'estimate') patch.usageMode = body.usageMode
  if (typeof body.autoSyncUsage === 'boolean') patch.autoSyncUsage = body.autoSyncUsage
  return NextResponse.json(await saveSettings(patch))
}
