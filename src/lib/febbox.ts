import { ProxyAgent, request, type Dispatcher } from 'undici'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const BASE = (process.env.FEBBOX_BASE || 'https://www.febbox.com').replace(/\/+$/, '')

export interface BoxHeaders {
  [k: string]: string
}

function baseHeaders(cookieRaw: string): BoxHeaders {
  return {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: BASE + '/',
    Origin: BASE,
    Cookie: cookieRaw,
    'X-Requested-With': 'XMLHttpRequest',
  }
}

/** Low-level request through optional proxy. Returns status + body text. */
export async function httpThrough(
  url: string,
  opts: {
    method?: string
    cookieRaw: string
    proxyUrl?: string | null
    form?: Record<string, string>
    extraHeaders?: BoxHeaders
    timeoutMs?: number
  }
): Promise<{ status: number; body: string }> {
  const { method = 'GET', cookieRaw, proxyUrl, form, extraHeaders, timeoutMs = 45000 } = opts
  let dispatcher: Dispatcher | undefined
  if (proxyUrl) dispatcher = new ProxyAgent(proxyUrl)

  const headers = { ...baseHeaders(cookieRaw), ...(extraHeaders || {}) }
  let body: string | undefined
  if (form) {
    body = new URLSearchParams(form).toString()
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
  }

  const res = await request(url, {
    method: method as Dispatcher.HttpMethod,
    headers,
    body,
    dispatcher,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  })
  const text = await res.body.text()
  return { status: res.statusCode, body: text }
}

/* ------------------------- cookie parsing ------------------------- */

export interface ParsedCookie {
  ok: boolean
  error?: string
  uid?: string
  token?: string
  hasSession?: boolean
}

export function parseCookieHeader(raw: string): ParsedCookie {
  const jar: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) jar[k] = v
  }
  if (!jar['PHPSESSID']) return { ok: false, error: 'missing PHPSESSID' }
  if (!jar['ui']) return { ok: false, error: 'missing ui token' }
  let uid = ''
  let token = ''
  try {
    const payload = JSON.parse(Buffer.from(jar['ui'].split('.')[1], 'base64').toString('utf8'))
    uid = String(payload?.data?.uid ?? '')
    token = String(payload?.data?.token ?? '')
  } catch {
    return { ok: false, error: 'ui cookie is not a valid JWT' }
  }
  if (!uid) return { ok: false, error: 'cannot extract uid from ui JWT' }
  return { ok: true, uid, token, hasSession: true }
}

/* ------------------------- account endpoints ------------------------- */

export interface AccountInfo {
  ok: boolean
  error?: string
  uid?: string
  email?: string
  username?: string
  plan?: string
  planExpire?: string
  isVip?: boolean
}

/** Fetch /console/user_info + /console/user_plan to validate an account. */
export async function fetchAccountInfo(cookieRaw: string, proxyUrl?: string | null): Promise<AccountInfo> {
  try {
    const info = await httpThrough(BASE + '/console/user_info', {
      cookieRaw,
      proxyUrl,
      extraHeaders: { Referer: BASE + '/console', Accept: 'application/json, text/javascript, */*; q=0.01' },
    })
    let email = ''
    let username = ''
    let expireTime = 0
    try {
      const j = JSON.parse(info.body)
      if (j.code !== 1) {
        return { ok: false, error: j.msg || 'user_info rejected (session expired?)' }
      }
      email = j.user?.email || j.user?.login_email || ''
      username = j.user?.nickname || j.user?.username || ''
      expireTime = Number(j.user?.expire_time || 0)
    } catch {
      return { ok: false, error: 'user_info returned non-JSON (likely Cloudflare/login page)' }
    }

    const plan = await httpThrough(BASE + '/console/user_plan', {
      cookieRaw,
      proxyUrl,
      extraHeaders: { Referer: BASE + '/console', Accept: 'application/json, text/javascript, */*; q=0.01' },
    })
    let planName = ''
    let planExpire = expireTime ? new Date(expireTime * 1000).toISOString().slice(0, 10) : ''
    try {
      const j = JSON.parse(plan.body)
      if (j.code === 1) {
        planName = String(j.data?.current_plan || '')
        if (j.data?.current_plan_expire) planExpire = String(j.data.current_plan_expire)
      }
    } catch {
      /* plan is best-effort */
    }
    const isVip = /vip/i.test(planName) || /premium/i.test(planName)
    return { ok: true, email, username, plan: planName || 'free', planExpire, isVip }
  } catch (e) {
    return { ok: false, error: 'network error: ' + (e as Error).message }
  }
}

/* ------------------------- player endpoint ------------------------- */

export interface SourceItem {
  label: string
  type: string
  url: string
}

export interface PlayerResult {
  ok: boolean
  /** account-level failure → cookie should be marked inactive */
  accountError?: boolean
  error?: string
  ossFid?: string
  sources?: SourceItem[]
  fileName?: string
  raw?: string
}

/** POST /file/player and extract the pre-signed sources array. */
export async function fetchPlayerSources(
  fid: string,
  shareKey: string | undefined,
  cookieRaw: string,
  proxyUrl?: string | null
): Promise<PlayerResult> {
  try {
    const { status, body } = await httpThrough(BASE + '/file/player', {
      method: 'POST',
      cookieRaw,
      proxyUrl,
      form: shareKey ? { fid, share_key: shareKey } : { fid },
      extraHeaders: { Referer: BASE + (shareKey ? '/share/' + shareKey : '/console') },
    })
    if (status === 403 || /Just a moment|cf-chl|challenge-platform/i.test(body)) {
      return { ok: false, error: 'Cloudflare challenge — cf_clearance cookie may be needed', accountError: false }
    }
    // error responses come back as JSON: {code: <0, msg}
    const trimmed = body.trim()
    if (trimmed.startsWith('{')) {
      try {
        const j = JSON.parse(trimmed)
        if (typeof j.code === 'number' && j.code < 0) {
          const msg = String(j.msg || 'player rejected')
          const accountLevel =
            /vip|upgrade|premium|traffic|limit|expire|login|auth|permission|banned|block/i.test(msg)
          return { ok: false, error: msg, accountError: accountLevel }
        }
      } catch {
        /* fall through */
      }
    }
    const m = trimmed.match(/var sources = (\[.*?\]);/s)
    if (!m) {
      return { ok: false, error: 'no sources array in player response (not a video file?)', accountError: false }
    }
    let sources: SourceItem[] = []
    try {
      const arr = JSON.parse(m[1])
      sources = arr.map((s: { label?: string; type?: string; file?: string }) => ({
        label: s.label || '?',
        type: s.type || 'video/mp4',
        url: s.file || '',
      }))
    } catch {
      return { ok: false, error: 'failed to parse sources JSON', accountError: false }
    }
    const oss = trimmed.match(/\/\/oss_fid:(\d+)/)
    const name = trimmed.match(/title:\s*"([^"]+)"/)
    return {
      ok: true,
      ossFid: oss ? oss[1] : undefined,
      sources,
      fileName: name ? name[1] : '',
      raw: trimmed,
    }
  } catch (e) {
    return { ok: false, error: 'network error: ' + (e as Error).message, accountError: false }
  }
}

/* ------------------------- quality list (sizes) ------------------------- */

export interface QualityInfo {
  quality: string
  url: string
  sizeText: string
  sizeGb: number
  speed: string
}

function sizeTextToGb(t: string): number {
  const m = t.match(/([\d.]+)\s*(KB|MB|GB|TB)/i)
  if (!m) return 0
  const n = parseFloat(m[1])
  const u = m[2].toUpperCase()
  if (u === 'KB') return n / 1024 / 1024
  if (u === 'MB') return n / 1024
  if (u === 'TB') return n * 1024
  return n
}

/** GET /console/video_quality_list — per-quality sizes used for usage estimation. */
export async function fetchQualitySizes(
  fid: string,
  cookieRaw: string,
  proxyUrl?: string | null
): Promise<QualityInfo[]> {
  try {
    const { body } = await httpThrough(BASE + '/console/video_quality_list?fid=' + encodeURIComponent(fid), {
      cookieRaw,
      proxyUrl,
      extraHeaders: { Referer: BASE + '/console', Accept: 'application/json, text/javascript, */*; q=0.01' },
    })
    const j = JSON.parse(body)
    if (j.code !== 1) return []
    const out: QualityInfo[] = []
    const re = /data-url="([^"]+)"\s+data-quality="([^"]+)"([\s\S]*?)(?=<div class="file_quality"|<\/div>\s*<\/div>\s*$|$)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(j.html)) !== null) {
      const tail = m[3]
      const speed = tail.match(/<span>([\d.]+\s*[KMG]?B?\/S?)<\/span>/i)
      const size = tail.match(/<p class="size">([^<]+)<\/p>/)
      const sizeText = size ? size[1].trim() : ''
      out.push({
        quality: m[2],
        url: m[1],
        sizeText,
        sizeGb: sizeTextToGb(sizeText),
        speed: speed ? speed[1] : '',
      })
    }
    return out
  } catch {
    return []
  }
}

/* ------------------------- real usage (flow) ------------------------- */

export interface RealUsage {
  ok: boolean
  /** account-level failure → session dead / needs re-login */
  accountError?: boolean
  error?: string
  /** used high-speed flow in GB (numeric, from FebBox) */
  usedGb?: number
  /** plan's daily flow limit in GB (e.g. 100 for Premium) */
  limitGb?: number
  /** raw display strings straight from FebBox */
  trafficUsageText?: string
  trafficLimitText?: string
  /** when FebBox resets the flow counter (raw, e.g. "23 Hours" / datetime) */
  resetAt?: string
}

function parseGbText(t: string | undefined | null): number {
  if (!t) return NaN
  const m = String(t).match(/([\d.]+)\s*(KB|MB|GB|TB)/i)
  if (!m) {
    const n = parseFloat(String(t))
    return isFinite(n) ? n : NaN
  }
  const n = parseFloat(m[1])
  const u = m[2].toUpperCase()
  if (u === 'KB') return n / 1024 / 1024
  if (u === 'MB') return n / 1024
  if (u === 'TB') return n * 1024
  return n
}

/**
 * GET /console/user_traffic_query — the account's REAL high-speed flow usage
 * as reported by FebBox (the same number the dashboard shows in the
 * "High Speed Flow" popup): { code:1, data:{ used, traffic_usage,
 * traffic_limit, reset_at } }.
 *
 * `used` is numeric GB (FebBox's own JS compares it against < 100).
 * This replaces the size-based estimate for the usage guard with the real
 * counter — including the daily reset (used drops back after reset_at).
 */
export async function fetchRealUsage(
  cookieRaw: string,
  proxyUrl?: string | null
): Promise<RealUsage> {
  try {
    const { body } = await httpThrough(BASE + '/console/user_traffic_query', {
      cookieRaw,
      proxyUrl,
      extraHeaders: { Referer: BASE + '/console', Accept: 'application/json, text/javascript, */*; q=0.01' },
    })
    const trimmed = body.trim()
    if (/^<!doctype|^<html|Just a moment|cf-chl/i.test(trimmed)) {
      return { ok: false, error: 'non-JSON response (Cloudflare/login page)' }
    }
    let j: {
      code?: number
      msg?: string
      login_required?: number
      data?: { used?: unknown; traffic_usage?: unknown; traffic_limit?: unknown; reset_at?: unknown }
    }
    try {
      j = JSON.parse(trimmed)
    } catch {
      return { ok: false, error: 'user_traffic_query returned non-JSON' }
    }
    if (j.code !== 1) {
      const accountLevel = !!j.login_required || /login|session|auth|expire/i.test(String(j.msg || ''))
      return { ok: false, accountError: accountLevel, error: j.msg || 'user_traffic_query rejected' }
    }
    const d = j.data || {}
    const usageText = d.traffic_usage != null ? String(d.traffic_usage) : ''
    const limitText = d.traffic_limit != null ? String(d.traffic_limit) : ''
    let usedGb = typeof d.used === 'number' ? d.used : parseGbText(usageText.split('/')[0])
    if (!isFinite(usedGb)) usedGb = parseGbText(usageText)
    if (!isFinite(usedGb)) return { ok: false, error: 'could not parse used GB from response' }
    const limitGb = parseGbText(limitText)
    return {
      ok: true,
      usedGb: Math.round(usedGb * 100) / 100,
      limitGb: isFinite(limitGb) ? limitGb : undefined,
      trafficUsageText: usageText,
      trafficLimitText: limitText,
      resetAt: d.reset_at != null ? String(d.reset_at) : '',
    }
  } catch (e) {
    return { ok: false, error: 'network error: ' + (e as Error).message }
  }
}

/* ------------------------- share page helpers ------------------------- */

export function extractShareKey(input: string): string {
  const m = input.match(/febbox\.com\/share\/([A-Za-z0-9]+)/)
  return m ? m[1] : input.trim()
}
