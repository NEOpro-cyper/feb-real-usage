import { NextRequest, NextResponse } from 'next/server'
import { extractShareKey } from '@/lib/febbox'
import { runRotation } from '@/lib/rotator'
import { guard, AUTH_PASSWORD } from '@/lib/auth'
import { withErr } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * GET /api/stream?fid=31264714[&quality=AUTO|ORG|1080p|720p|360p][&shareKey=...]
 *                     [&redirect=1][&pw=APP_PASSWORD][&key=APP_PASSWORD]
 *
 * Same engine as the dashboard's fetch button (POST /api/fetch) — cookie
 * rotation, Webshare proxy fallback, usage accounting, auto-inactive on bad
 * cookies — but one GET and a minimal response built for direct use:
 *
 *   { ok, fid, fileName, quality, stream, url, allQualities, expiresHours }
 *
 *   stream  = master (AUTO) m3u8 — point any HLS player here
 *   url     = the ?quality= variant if requested and present, else = stream
 *   &redirect=1 → 302 straight to `url` (players can't send headers or
 *                 parse JSON: `vlc '...?fid=..&redirect=1&pw=..'`)
 *
 * Signatures are re-minted per call and play from any IP for ~4-5 hours.
 * Auth: x-app-password header / Bearer, or simply &pw= (or &key=) on the URL.
 *
 * 409 no_active_cookies / 502 all_failed — same semantics as /api/fetch.
 */

export interface SourceLike {
  label: string
  url: string
}

function sourceMap(sources: SourceLike[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of sources) out[s.label] = s.url
  return out
}

async function handle(
  fid: string,
  shareKey: string | undefined,
  quality: string,
  redirect: boolean
) {
  const { status, body } = await runRotation(fid, shareKey, quality)
  if (status !== 200) return NextResponse.json(body, { status })

  const sources = body.sources as SourceLike[]
  const master = sources.find((s) => s.label === 'AUTO') || sources[0]

  let picked = master
  if (quality && quality !== 'AUTO') {
    const hit = sources.find((s) => s.label.toLowerCase() === quality.toLowerCase())
    if (hit) picked = hit
  }

  if (redirect) {
    return NextResponse.redirect(picked.url, 302)
  }

  return NextResponse.json(
    {
      ok: true,
      success: true,
      fid,
      fileName: body.fileName ?? null,
      quality: picked.label,
      stream: master.url,
      url: picked.url,
      allQualities: sourceMap(sources),
      expiresHours: 4.5,
      usedCookie: {
        id: (body.usedCookie as { id?: string })?.id,
        email: (body.usedCookie as { email?: string })?.email,
      },
      note: 'signature is re-minted per call — play from any IP for ~4-5h',
    },
    { status: 200 }
  )
}

async function GET_(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  // players can't send headers — accept the app password on the URL (?pw= / ?key=)
  const urlPw = sp.get('pw') ?? sp.get('key') ?? ''
  if (!urlPw || urlPw !== AUTH_PASSWORD) {
    const denied = guard(req)
    if (denied) return denied
  }

  const fid = String(sp.get('fid') || '').trim()
  if (!/^\d+$/.test(fid)) {
    return NextResponse.json(
      { error: 'valid numeric fid required, e.g. /api/stream?fid=31264714' },
      { status: 400 }
    )
  }
  const shareKeyRaw = sp.get('shareKey') || sp.get('share') || undefined
  const shareKey = shareKeyRaw ? extractShareKey(shareKeyRaw) : undefined
  const quality = sp.get('quality') || 'AUTO'
  const redirect = ['1', 'true', 'yes'].includes((sp.get('redirect') || '').toLowerCase())

  return handle(fid, shareKey, quality, redirect)
}

async function POST_(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const fid = String(body.fid || '').trim()
  if (!/^\d+$/.test(fid)) {
    return NextResponse.json({ error: 'valid numeric fid required' }, { status: 400 })
  }
  const shareKey = body.shareKey ? extractShareKey(String(body.shareKey)) : undefined
  const redirect = !!body.redirect
  return handle(fid, shareKey, body.quality ? String(body.quality) : 'AUTO', redirect)
}

export function GET(req: NextRequest) {
  return withErr(() => GET_(req))
}

export function POST(req: NextRequest) {
  return withErr(() => POST_(req))
}
