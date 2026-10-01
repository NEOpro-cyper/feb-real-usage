import { NextResponse } from 'next/server'

/**
 * Turns thrown errors (mostly MySQL/mariaDB ones) into a JSON 500 response
 * with a human hint, and logs the full stack server-side so container logs
 * (pm2 logs / Coolify runtime logs) show the real cause.
 */

export interface Diagnosed {
  msg: string
  hint?: string
}

export function diagnoseError(e: unknown): Diagnosed {
  const err = e as { code?: string; errno?: number; message?: string; sqlMessage?: string; sqlState?: string }
  const code = err?.code || ''
  const msg = err?.sqlMessage || err?.message || String(e)

  const table: Record<string, string> = {
    ER_ACCESS_DENIED_ERROR: 'MariaDB rejected the login — check user/password in DATABASE_URL (and that the user may connect from the app host)',
    ER_BAD_DB_ERROR: "that database does not exist — create it in phpMyAdmin or fix the name in DATABASE_URL",
    ER_NO_SUCH_TABLE: 'tables are missing — import schema.sql in phpMyAdmin (select the database → SQL tab → paste → Go)',
    ER_HOST_NOT_PRIVILEGED: 'MariaDB only allows this user from certain hosts — run: CREATE USER ... @\'%\' / GRANT ALL ON <db>.* TO that user',
    ER_NOT_SUPPORTED_AUTH_MODE: 'auth plugin mismatch — try: ALTER USER <user>@<host> IDENTIFIED WITH mysql_native_password BY <password>',
    ECONNREFUSED: 'nothing is listening at host:port — note that inside a container 127.0.0.1 is the container itself, not the host MariaDB',
    ENOTFOUND: 'the hostname in DATABASE_URL does not resolve from inside the app — use the DB container name / VPS IP',
    ETIMEDOUT: 'connection timed out — firewall or wrong host:port in DATABASE_URL',
    ECONNRESET: 'connection reset — check TLS settings (?ssl=true / ?sslaccept=accept_invalid_certs) and the DB host',
  }

  let hint = code ? table[code] : undefined

  if (!hint) {
    if (/DATABASE_URL is not set/.test(msg)) {
      hint = 'set DATABASE_URL in .env (or the panel env) and restart the app'
    } else if (/getaddrinfo|ENOTFOUND/i.test(msg)) {
      hint = 'the hostname in DATABASE_URL does not resolve from inside the app — use the DB container name / VPS IP'
    } else if (/ECONNREFUSED/i.test(msg)) {
      hint = 'nothing is listening at host:port — inside a container 127.0.0.1 is the container itself, not the host MariaDB'
    } else if (/handshake|ssl|tls/i.test(msg)) {
      hint = 'TLS handshake failed — if MariaDB has no TLS remove ?ssl=true; if self-signed keep ?sslaccept=accept_invalid_certs in DATABASE_URL'
    } else if (/Access denied/i.test(msg)) {
      hint = 'MariaDB rejected the login — check user/password in DATABASE_URL'
    } else if (/Unknown database/i.test(msg)) {
      hint = 'that database does not exist — create it in phpMyAdmin or fix DATABASE_URL'
    }
  }
  return { msg, hint }
}

/** Wrap a route handler so nothing ever escapes as a bare HTML 500. */
export function withErr(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  return fn().catch((e: unknown) => apiError(e))
}

export function apiError(e: unknown): NextResponse {
  const { msg, hint } = diagnoseError(e)
  console.error('[api] 500:', (e as Error)?.stack || e)
  return NextResponse.json({ error: msg, ...(hint ? { hint } : {}) }, { status: 500 })
}
