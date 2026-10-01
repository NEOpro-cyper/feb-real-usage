import { NextRequest, NextResponse } from 'next/server'
import { listRecentLogs } from '@/lib/pool'
import { guard } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied
  const logs = await listRecentLogs(60)
  return NextResponse.json({ logs })
}
