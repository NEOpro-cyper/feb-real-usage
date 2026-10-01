import { NextResponse } from 'next/server'

/**
 * Optional single-password gate for the whole API.
 *
 * Set APP_PASSWORD in the environment to protect the dashboard + API
 * (strongly recommended for any publicly reachable deployment — the pool
 * stores your FebBox session cookies).
 *
 * Client sends the password in the `x-app-password` header on every request.
 * If APP_PASSWORD is unset, everything is open (local/VPS behind firewall).
 */
export const AUTH_PASSWORD = process.env.APP_PASSWORD || ''

export function authRequired(): boolean {
  return AUTH_PASSWORD.length > 0
}

export function isAuthed(req: Request): boolean {
  if (!authRequired()) return true
  const header = req.headers.get('x-app-password') || ''
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return header === AUTH_PASSWORD || bearer === AUTH_PASSWORD
}

export function unauthorized() {
  return NextResponse.json({ error: 'unauthorized', message: 'wrong or missing app password' }, { status: 401 })
}

export function guard(req: Request): NextResponse | null {
  return isAuthed(req) ? null : unauthorized()
}
