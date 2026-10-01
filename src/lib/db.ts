import mysql from 'mysql2/promise'
import { randomUUID } from 'crypto'

/**
 * Direct MySQL / MariaDB access — NO ORM.
 *
 * DATABASE_URL examples (env var):
 *
 *   mysql://root:Secret@127.0.0.1:3306/febusage
 *   mysql://root:Mariadb24%40@db-host:3306/febusage?ssl=true&sslaccept=accept_invalid_certs
 *
 *  - special characters in the password must be URL-encoded
 *    ( "@" -> "%40" ). A literal "@" also works — the parser
 *    splits at the LAST "@" — but encoding is cleaner.
 *  - ?ssl=true            → use TLS
 *  - ?sslaccept=accept_invalid_certs → accept self-signed certs
 *  - ?connectionLimit=10  → pool size (default 8)
 *
 * Tables are created by running schema.sql in phpMyAdmin.
 */

export interface ParsedDbUrl {
  host: string
  port: number
  user: string
  password: string
  database: string
  ssl?: mysql.SslOptions
  connectionLimit: number
}

export function parseDbUrl(raw: string): ParsedDbUrl {
  const url = new URL(raw.trim())
  const q = url.searchParams

  const sslFlag = (q.get('ssl') || '').toLowerCase()
  const sslaccept = (q.get('sslaccept') || '').toLowerCase()
  let ssl: mysql.SslOptions | undefined
  if (sslFlag === 'true' || sslFlag === '1' || sslaccept) {
    // accept_invalid_certs → self-signed cert on the VPS MariaDB
    ssl = { rejectUnauthorized: sslaccept !== 'accept_invalid_certs' }
  }

  const database = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('?')[0])

  return {
    host: url.hostname,
    port: Number(url.port) || 3306,
    user: decodeURIComponent(url.username || 'root'),
    password: decodeURIComponent(url.password || ''),
    database,
    ssl,
    connectionLimit: Number(q.get('connectionLimit')) || 8,
  }
}

const globalForDb = globalThis as unknown as { mysqlPool?: mysql.Pool; schemaReady?: Promise<void> }

function makePool(): mysql.Pool {
  const raw = process.env.DATABASE_URL
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set. Add it to .env, e.g.\n' +
        'DATABASE_URL=mysql://root:PASSWORD@127.0.0.1:3306/febusage'
    )
  }
  const cfg = parseDbUrl(raw)
  // mysql2/promise createPool returns a PromisePool: .query() is promise-based
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || undefined,
    ssl: cfg.ssl,
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit,
    queueLimit: 0,
    enableKeepAlive: true,
    charset: 'utf8mb4',
    // all timestamps are stored & read in UTC for consistent round-trips
    timezone: 'Z',
  })
  // wire the underlying callback-pool's 'connection' event to pin the session
  // time zone to UTC (matches timezone: 'Z' above)
  const rawPool = (pool as unknown as { pool: { on: (ev: string, cb: (c: unknown) => void) => void } }).pool
  rawPool?.on?.('connection', (conn) => {
    ;(conn as unknown as { query: (sql: string) => void }).query("SET time_zone = '+00:00'")
  })
  return pool
}

/** The promise-based pool (singleton, safe for dev hot-reload). */
export function getPool(): mysql.Pool {
  if (!globalForDb.mysqlPool) globalForDb.mysqlPool = makePool()
  return globalForDb.mysqlPool
}

/** Run a query, return all rows (prepared statement). */
export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await ensureSchema()
  const [rows] = await getPool().query(sql, params)
  return rows as T[]
}

/** Run a query, return the first row or null. */
export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params)
  return rows.length > 0 ? rows[0] : null
}

/** Run INSERT / UPDATE / DELETE, return the result header. */
export async function exec(sql: string, params: unknown[] = []): Promise<mysql.ResultSetHeader> {
  await ensureSchema()
  const [result] = await getPool().query(sql, params)
  return result as mysql.ResultSetHeader
}

/** Random 32-char hex id (replaces Prisma cuid). */
export function newId(): string {
  return randomUUID().replace(/-/g, '')
}

/* ------------------------- runtime schema migration ------------------------- */

/**
 * Makes the app self-migrating: tables are created if missing and new columns
 * are ALTER-ed in when the code knows about them (idempotent, works on both
 * MariaDB and MySQL — column existence checked via INFORMATION_SCHEMA first).
 * Memoized per process; runs once before the first real query.
 */

async function runSchemaMigration(): Promise<void> {
  const pool = getPool()
  await pool.query(`CREATE TABLE IF NOT EXISTS cookie_accounts (
    id           VARCHAR(64)      NOT NULL,
    label        VARCHAR(190)     NOT NULL DEFAULT '',
    cookie_raw   TEXT             NOT NULL,
    uid          VARCHAR(190)     NOT NULL DEFAULT '',
    email        VARCHAR(190)     NOT NULL DEFAULT '',
    username     VARCHAR(190)     NOT NULL DEFAULT '',
    plan         VARCHAR(190)     NOT NULL DEFAULT '',
    plan_expire  VARCHAR(190)     NOT NULL DEFAULT '',
    is_vip       TINYINT(1)       NOT NULL DEFAULT 0,
    status       VARCHAR(32)      NOT NULL DEFAULT 'active',
    usage_gb     DOUBLE           NOT NULL DEFAULT 0,
    fetch_count  INT UNSIGNED     NOT NULL DEFAULT 0,
    last_used_at TIMESTAMP        NULL DEFAULT NULL,
    last_error   TEXT             NULL,
    created_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_pool (status, is_vip, usage_gb),
    KEY idx_uid (uid),
    KEY idx_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS fetch_logs (
    id         VARCHAR(64)  NOT NULL,
    cookie_id  VARCHAR(64)  NULL,
    fid        VARCHAR(64)  NOT NULL DEFAULT '',
    file_name  VARCHAR(255) NOT NULL DEFAULT '',
    quality    VARCHAR(32)  NOT NULL DEFAULT '',
    status     VARCHAR(16)  NOT NULL DEFAULT 'success',
    message    TEXT         NULL,
    est_gb     DOUBLE       NOT NULL DEFAULT 0,
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_created (created_at),
    KEY idx_cookie (cookie_id),
    CONSTRAINT fk_logs_cookie FOREIGN KEY (cookie_id) REFERENCES cookie_accounts (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (
    \`key\`   VARCHAR(64) NOT NULL,
    \`value\` TEXT        NOT NULL,
    PRIMARY KEY (\`key\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  // real-usage columns (added 2026-02) — add when missing
  const wanted: Array<{ col: string; ddl: string }> = [
    { col: 'real_usage_gb',       ddl: 'ALTER TABLE cookie_accounts ADD COLUMN real_usage_gb DOUBLE NOT NULL DEFAULT 0' },
    { col: 'real_usage_limit_gb', ddl: 'ALTER TABLE cookie_accounts ADD COLUMN real_usage_limit_gb DOUBLE NOT NULL DEFAULT 0' },
    { col: 'usage_source',        ddl: "ALTER TABLE cookie_accounts ADD COLUMN usage_source VARCHAR(16) NOT NULL DEFAULT 'estimate'" },
    { col: 'usage_synced_at',     ddl: 'ALTER TABLE cookie_accounts ADD COLUMN usage_synced_at TIMESTAMP NULL DEFAULT NULL' },
  ]
  const database = (process.env.DATABASE_URL || '').trim()
  const dbName = database ? safeDbName(database) : ''
  for (const { col, ddl } of wanted) {
    let exists = false
    if (dbName) {
      const [rows] = await pool.query(
        `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cookie_accounts' AND COLUMN_NAME = ?`,
        [dbName, col]
      )
      exists = Number((rows as Array<{ n: number }>)[0]?.n || 0) > 0
    }
    if (!exists) {
      try {
        await pool.query(ddl)
      } catch (e) {
        const msg = (e as Error)?.message || ''
        if (!/duplicate column|exists/i.test(msg)) throw e
      }
    }
  }
}

function safeDbName(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return decodeURIComponent(u.pathname.replace(/^\/+/, '').split('?')[0])
  } catch {
    return ''
  }
}

export function ensureSchema(): Promise<void> {
  if (!globalForDb.schemaReady) {
    globalForDb.schemaReady = runSchemaMigration().catch((e) => {
      // allow a later request to retry after a transient failure
      globalForDb.schemaReady = undefined
      throw e
    })
  }
  return globalForDb.schemaReady
}
