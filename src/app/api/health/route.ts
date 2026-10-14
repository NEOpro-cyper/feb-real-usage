import { NextResponse } from 'next/server'
import { authRequired } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/health — tells the UI whether a password is required. */
export async function GET() {
  return NextResponse.json({ ok: true, authRequired: authRequired() })
}
