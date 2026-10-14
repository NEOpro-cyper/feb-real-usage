'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Activity, AlertTriangle, CheckCircle2, Copy, Film, Gauge, KeyRound, Lock, Plus,
  RefreshCw, RotateCcw, Settings2, ShieldCheck, ShieldX, Trash2, XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { useToast } from '@/hooks/use-toast'
import { ScrollArea } from '@/components/ui/scroll-area'

/* ------------------------------- types ------------------------------- */

interface CookieRow {
  id: string; label: string; uid: string; email: string; username: string
  plan: string; planExpire: string; isVip: boolean; status: string
  usageGb: number; realUsageGb: number; realUsageLimitGb: number
  usageSource: 'real' | 'estimate' | 'manual'; usageSyncedAt: string | null
  fetchCount: number; lastUsedAt: string | null
  lastError: string; cookiePreview: string; createdAt: string
}
interface Settings {
  proxyUrl: string; proxyEnabled: boolean; usageLimitGb: number; usageSafetyGb: number; autoUsage: boolean
  usageMode: 'real' | 'estimate'; autoSyncUsage: boolean
}
interface UsageInfo {
  mode: 'real' | 'estimate'; estGbAdded: number
  synced?: boolean; syncError?: string
  realUsedGb?: number; realLimitGb?: number; realResetAt?: string
}
interface SourceItem { label: string; type: string; url: string }
interface QualityInfo { quality: string; url: string; sizeText: string; sizeGb: number; speed: string }
interface FetchResult {
  success: boolean
  usedCookie?: { id: string; label: string; email: string; uid: string }
  ossFid?: string; fileName?: string; masterUrl?: string
  sources?: SourceItem[]; qualities?: QualityInfo[]
  estGbAdded?: number; usage?: UsageInfo; proxyUsed?: boolean
  attempts?: Array<{ label: string; email: string; outcome: string; detail?: string }>
  error?: string; message?: string
}
interface LogRow {
  id: string; fid: string; fileName: string; quality: string; status: string
  message: string; estGb: number; createdAt: string
  cookie?: { label: string; email: string } | null
}

const QUALITIES = ['AUTO', 'ORG', '4K', '1080p', '720p', '360p']

/* ------------------------------- page ------------------------------- */

export default function Page() {
  const { toast } = useToast()
  const [cookies, setCookies] = useState<CookieRow[] | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [logs, setLogs] = useState<LogRow[]>([])

  // fetch form
  const [fid, setFid] = useState('')
  const [shareKey, setShareKey] = useState('')
  const [quality, setQuality] = useState('AUTO')
  const [fetching, setFetching] = useState(false)
  const [result, setResult] = useState<FetchResult | null>(null)

  // add cookies
  const [addOpen, setAddOpen] = useState(false)
  const [addText, setAddText] = useState('')
  const [adding, setAdding] = useState(false)
  const [syncingUsage, setSyncingUsage] = useState(false)
  const [addResults, setAddResults] = useState<Array<{ ok: boolean; email?: string; uid?: string; status?: string; error?: string }>>([])

  // settings dialog
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)

  // optional password gate (APP_PASSWORD set on the server)
  const [needsAuth, setNeedsAuth] = useState<boolean | null>(null)
  const [pwInput, setPwInput] = useState('')

  /** fetch wrapper that attaches the app password (if stored) and reacts to 401 */
  const api = useCallback(async (path: string, init?: RequestInit) => {
    const pw = typeof window !== 'undefined' ? localStorage.getItem('fbp_pw') || '' : ''
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        ...(pw ? { 'x-app-password': pw } : {}),
      },
    })
    if (res.status === 401) {
      setNeedsAuth(true)
      throw new Error('unauthorized')
    }
    return res
  }, [])

  const loadCookies = useCallback(async () => {
    const r = await api('/api/cookies')
    const j = await r.json()
    setCookies(j.cookies)
    setSettings(j.settings)
  }, [api])
  const loadLogs = useCallback(async () => {
    const r = await api('/api/logs')
    const j = await r.json()
    setLogs(j.logs || [])
  }, [api])
  useEffect(() => {
    ;(async () => {
      try {
        const h = await fetch('/api/health').then((r) => r.json())
        if (!h.authRequired) {
          setNeedsAuth(false)
          loadCookies()
          loadLogs()
          return
        }
        const pw = localStorage.getItem('fbp_pw') || ''
        const probe = await fetch('/api/cookies', {
          headers: pw ? { 'x-app-password': pw } : {},
        })
        if (probe.status === 401) {
          setNeedsAuth(true)
        } else {
          setNeedsAuth(false)
          loadCookies()
          loadLogs()
        }
      } catch {
        setNeedsAuth(false)
        loadCookies().catch(() => {})
      }
    })()
  }, [loadCookies, loadLogs])

  const unlock = () => {
    localStorage.setItem('fbp_pw', pwInput)
    setPwInput('')
    setNeedsAuth(false)
    loadCookies().catch(() => {
      // wrong password → back to gate
      localStorage.removeItem('fbp_pw')
      setNeedsAuth(true)
    })
    loadLogs().catch(() => {})
  }

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text) } catch { /* noop */ }
    toast({ description: 'Copied to clipboard' })
  }

  /* ------------------------------ actions ------------------------------ */

  const doFetch = async () => {
    if (!/^\d+$/.test(fid.trim())) {
      toast({ title: 'Invalid fid', description: 'fid must be numeric, e.g. 31264714', variant: 'destructive' })
      return
    }
    setFetching(true)
    setResult(null)
    try {
      const r = await api('/api/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fid: fid.trim(), shareKey: shareKey.trim() || undefined, quality }),
      })
      const j: FetchResult = await r.json()
      setResult(j)
      if (j.success) {
        const u = j.usage
        const usageDesc = u?.mode === 'real' && u.synced
          ? `real usage ${u.realUsedGb} / ${u.realLimitGb ?? '?'} GB`
          : u?.mode === 'real'
            ? 'real usage unavailable — estimate applied'
            : `+${j.estGbAdded} GB est.`
        toast({ title: 'Master playlist fetched', description: `via ${j.usedCookie?.email || 'account'} · ${usageDesc}` })
      } else if (j.error === 'no_active_cookies') {
        toast({ title: 'No active cookies', description: j.message, variant: 'destructive' })
      } else {
        toast({ title: 'All cookies failed', description: 'See attempts in the result panel', variant: 'destructive' })
      }
      loadCookies(); loadLogs()
    } finally {
      setFetching(false)
    }
  }

  const addCookies = async () => {
    setAdding(true)
    setAddResults([])
    try {
      const r = await api('/api/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: addText }),
      })
      const j = await r.json()
      setAddResults(j.results || [])
      toast({ description: `${(j.results || []).filter((x: { ok: boolean }) => x.ok).length} cookie(s) processed` })
      loadCookies()
    } finally {
      setAdding(false)
    }
  }

  const resetAll = async (clearUsage: boolean) => {
    const r = await api('/api/cookies/reset-all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearUsage }),
    })
    const j = await r.json()
    toast({ description: `Reactivated ${j.reactivated}/${j.total} cookie(s)${clearUsage ? ', usage cleared' : ''}` })
    loadCookies()
  }

  const resetOne = async (id: string, clearUsage = false) => {
    await api(`/api/cookies/${id}/reset?clearUsage=${clearUsage ? '1' : '0'}`, { method: 'POST' })
    toast({ description: 'Cookie reactivated' })
    loadCookies()
  }

  const deleteOne = async (id: string) => {
    await api(`/api/cookies/${id}`, { method: 'DELETE' })
    toast({ description: 'Cookie removed' })
    loadCookies()
  }

  const validateOne = async (id: string) => {
    toast({ description: 'Validating account…' })
    const r = await api(`/api/cookies/${id}`, { method: 'PATCH' })
    const j = await r.json()
    if (j.ok) {
      toast({ title: 'Account OK', description: `${j.email || ''} — plan: ${j.plan || '?'}, VIP: ${j.isVip ? 'yes' : 'NO'}` })
    } else {
      toast({ title: 'Validation failed', description: j.error, variant: 'destructive' })
    }
    loadCookies()
  }

  const addUsage = async (id: string, gb: number) => {
    await api(`/api/cookies/${id}/usage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gb }),
    })
    toast({ description: `${gb >= 0 ? 'Added' : 'Removed'} ${Math.abs(gb)} GB usage` })
    loadCookies()
  }

  const syncAllUsage = async () => {
    setSyncingUsage(true)
    try {
      const r = await api('/api/usage/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = await r.json()
      const parts = [`Synced ${j.synced}/${j.total} account(s)`]
      if (j.reactivated > 0) parts.push(`${j.reactivated} back after flow reset`)
      if (j.parked > 0) parts.push(`${j.parked} hit the limit`)
      if (j.failed > 0) parts.push(`${j.failed} failed`)
      toast({
        description: parts.join(' · '),
        variant: j.failed > 0 && j.synced === 0 ? 'destructive' : undefined,
      })
      loadCookies()
    } finally {
      setSyncingUsage(false)
    }
  }

  const syncOneUsage = async (id: string) => {
    toast({ description: 'Fetching real usage from FebBox…' })
    const r = await api('/api/usage/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const j = await r.json()
    const res = j.results?.[0]
    if (res?.ok) {
      toast({
        title: 'Real usage synced',
        description: `${res.usedGb} GB used${res.limitGb ? ` of ${res.limitGb} GB` : ''}${res.resetAt ? ` · resets: ${res.resetAt}` : ''}${res.statusChanged === 'reactivated' ? ' · account reactivated' : ''}`,
      })
    } else {
      toast({ title: 'Sync failed', description: res?.error || 'unknown error', variant: 'destructive' })
    }
    loadCookies()
  }

  const saveSettings = async () => {
    if (!settingsDraft) return
    setSavingSettings(true)
    try {
      const r = await api('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsDraft),
      })
      setSettings(await r.json())
      setSettingsOpen(false)
      toast({ description: 'Settings saved' })
      loadCookies()
    } finally {
      setSavingSettings(false)
    }
  }

  /* ------------------------------- derived ------------------------------- */

  const active = cookies?.filter((c) => c.status === 'active') || []
  const inactive = cookies?.filter((c) => c.status === 'inactive') || []
  const limited = cookies?.filter((c) => c.status === 'limit_reached') || []
  const totalUsage = cookies?.reduce((s, c) => s + c.usageGb, 0) || 0

  const statusBadge = (s: string) => {
    if (s === 'active') return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200">active</Badge>
    if (s === 'limit_reached') return <Badge className="bg-amber-100 text-amber-800 border-amber-200">limit reached</Badge>
    return <Badge className="bg-red-100 text-red-700 border-red-200">inactive</Badge>
  }

  /* -------------------------------- render -------------------------------- */

  // password gate (only when APP_PASSWORD is set on the server and unlocked session missing)
  if (needsAuth === true) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
        <Card className="w-full max-w-sm p-6">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-900 text-white">
            <Lock className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold text-zinc-900">FebBox HLS Pool</h1>
          <p className="mb-4 mt-1 text-sm text-zinc-500">This deployment is password protected. Enter the app password to continue.</p>
          <Label htmlFor="pw">App password</Label>
          <Input
            id="pw" type="password" value={pwInput} autoFocus
            onChange={(e) => setPwInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && pwInput && unlock()}
            className="mt-1" placeholder="••••••••"
          />
          <Button onClick={unlock} disabled={!pwInput} className="mt-4 w-full">Unlock</Button>
        </Card>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {/* header */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 text-white">
              <Film className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-zinc-900">FebBox HLS Pool</h1>
              <p className="text-xs text-zinc-500">Multi-account cookie rotation → master playlist fetcher</p>
            </div>
          </div>
          <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => settings && setSettingsDraft({ ...settings })}>
                <Settings2 className="mr-1.5 h-4 w-4" /> Settings
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Pool settings</DialogTitle>
                <DialogDescription>Proxy, usage limit and usage tracking mode (real vs estimated).</DialogDescription>
              </DialogHeader>
              {settingsDraft && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <Label className="text-sm">Use Webshare rotating proxy</Label>
                      <p className="text-xs text-zinc-500">Route all febbox requests through the proxy</p>
                    </div>
                    <Switch checked={settingsDraft.proxyEnabled}
                      onCheckedChange={(v) => setSettingsDraft({ ...settingsDraft, proxyEnabled: v })} />
                  </div>
                  <div>
                    <Label className="text-sm">Proxy URL</Label>
                    <Input value={settingsDraft.proxyUrl}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, proxyUrl: e.target.value })}
                      className="mt-1 font-mono text-xs" placeholder="http://user:pass@p.webshare.io:80" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-sm">Usage limit per account (GB)</Label>
                      <Input type="number" value={settingsDraft.usageLimitGb}
                        onChange={(e) => setSettingsDraft({ ...settingsDraft, usageLimitGb: Number(e.target.value) })}
                        className="mt-1" />
                    </div>
                    <div>
                      <Label className="text-sm">Safety margin (GB)</Label>
                      <Input type="number" value={settingsDraft.usageSafetyGb}
                        onChange={(e) => setSettingsDraft({ ...settingsDraft, usageSafetyGb: Number(e.target.value) })}
                        className="mt-1" />
                      <p className="mt-1 text-xs text-zinc-500">
                        Quota guard: accounts within this margin of their limit are
                        never used (2 → retired at 98 GB of a 100 GB limit)
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <Label className="text-sm">Auto usage estimate</Label>
                      <p className="text-xs text-zinc-500">Add file size on each fetch (estimate mode only)</p>
                    </div>
                    <Switch checked={settingsDraft.autoUsage}
                      onCheckedChange={(v) => setSettingsDraft({ ...settingsDraft, autoUsage: v })} />
                  </div>
                  <div>
                    <Label className="text-sm">Usage tracking mode</Label>
                    <Select value={settingsDraft.usageMode}
                      onValueChange={(v) => setSettingsDraft({ ...settingsDraft, usageMode: v as 'real' | 'estimate' })}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="real">Real — fetch actual flow usage from FebBox</SelectItem>
                        <SelectItem value="estimate">Estimate — add predicted file size (legacy)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-xs text-zinc-500">
                      Real mode reads each account's own high-speed flow counter
                      (/console/user_traffic_query) — the same 100 GB/day number FebBox shows,
                      including its daily reset. Accounts that drop back under the limit are
                      reactivated automatically.
                    </p>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <Label className="text-sm">Sync usage after every fetch</Label>
                      <p className="text-xs text-zinc-500">Refresh the used account's real usage right after each fetch (real mode)</p>
                    </div>
                    <Switch checked={settingsDraft.autoSyncUsage}
                      onCheckedChange={(v) => setSettingsDraft({ ...settingsDraft, autoSyncUsage: v })} />
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button onClick={saveSettings} disabled={savingSettings || !settingsDraft}>
                  {savingSettings ? 'Saving…' : 'Save settings'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </header>

        {/* stats */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-4"><div className="flex items-center gap-2 text-sm text-zinc-500"><ShieldCheck className="h-4 w-4 text-emerald-600" />Active</div><p className="mt-1 text-2xl font-semibold text-zinc-900">{cookies ? active.length : '—'}</p></Card>
          <Card className="p-4"><div className="flex items-center gap-2 text-sm text-zinc-500"><ShieldX className="h-4 w-4 text-red-500" />Inactive</div><p className="mt-1 text-2xl font-semibold text-zinc-900">{cookies ? inactive.length : '—'}</p></Card>
          <Card className="p-4"><div className="flex items-center gap-2 text-sm text-zinc-500"><AlertTriangle className="h-4 w-4 text-amber-500" />Limit reached</div><p className="mt-1 text-2xl font-semibold text-zinc-900">{cookies ? limited.length : '—'}</p></Card>
          <Card className="p-4"><div className="flex items-center gap-2 text-sm text-zinc-500"><Activity className="h-4 w-4 text-zinc-400" />Total usage</div><p className="mt-1 text-2xl font-semibold text-zinc-900">{cookies ? `${totalUsage.toFixed(1)} GB` : '—'}</p></Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-5">
          {/* fetch panel */}
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" />Fetch master playlist</CardTitle>
              <CardDescription>Enter a file fid — the pool picks the least-used active VIP account and returns all quality URLs.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label htmlFor="fid">File ID (fid)</Label>
                  <Input id="fid" value={fid} onChange={(e) => setFid(e.target.value)}
                    placeholder="e.g. 31264714" className="mt-1 font-mono" />
                </div>
                <div>
                  <Label htmlFor="shareKey">Share key <span className="text-zinc-400">(optional)</span></Label>
                  <Input id="shareKey" value={shareKey} onChange={(e) => setShareKey(e.target.value)}
                    placeholder="ahu5PuF5 or full share URL" className="mt-1" />
                </div>
                <div>
                  <Label>Quality</Label>
                  <Select value={quality} onValueChange={setQuality}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {QUALITIES.map((q) => <SelectItem key={q} value={q}>{q}{q === 'AUTO' ? ' (adaptive master)' : ''}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button onClick={doFetch} disabled={fetching} className="w-full sm:w-auto">
                {fetching ? <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Rotating cookies…</> : <><Play />Fetch playlist</>}
              </Button>

              {/* result */}
              {result && (
                <div className="mt-2 rounded-lg border bg-white p-4">
                  {result.success ? (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200">success</Badge>
                        <span className="text-sm text-zinc-600">{result.fileName}</span>
                        <span className="text-xs text-zinc-400">oss_fid {result.ossFid}</span>
                        <Badge variant="outline">{result.usedCookie?.email}</Badge>
                        {result.proxyUsed && <Badge variant="outline" className="text-xs">via proxy</Badge>}
                        {result.usage?.mode === 'real' && result.usage.synced ? (
                          <Badge className="bg-sky-100 text-sky-800 border-sky-200 text-xs">
                            real usage {result.usage.realUsedGb} / {result.usage.realLimitGb ?? '?'} GB
                            {result.usage.realResetAt ? ` · resets ${result.usage.realResetAt}` : ''}
                          </Badge>
                        ) : result.usage?.mode === 'real' ? (
                          <Badge variant="outline" className="text-xs text-amber-700">
                            real usage unavailable — +{result.usage.estGbAdded} GB est. applied
                          </Badge>
                        ) : result.estGbAdded ? (
                          <Badge variant="outline" className="text-xs">+{result.estGbAdded} GB usage (est.)</Badge>
                        ) : null}
                      </div>
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <Label className="text-xs uppercase tracking-wide text-zinc-500">Master playlist (AUTO · adaptive)</Label>
                          <Button variant="ghost" size="sm" onClick={() => copy(result.masterUrl || '')}><Copy className="h-3.5 w-3.5" /> Copy</Button>
                        </div>
                        <div className="max-h-24 overflow-y-auto rounded-md bg-zinc-900 p-3 font-mono text-xs leading-relaxed break-all text-emerald-300">
                          {result.masterUrl}
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs uppercase tracking-wide text-zinc-500">All quality URLs (pre-signed)</Label>
                        <div className="mt-1 max-h-56 space-y-1.5 overflow-y-auto pr-1">
                          {result.sources?.map((s) => (
                            <div key={s.label} className="flex items-center gap-2 rounded-md border p-2">
                              <Badge variant="outline" className="w-16 shrink-0 justify-center">{s.label}</Badge>
                              <span className="flex-1 truncate font-mono text-xs text-zinc-600">{s.url}</span>
                              <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={() => copy(s.url)}><Copy className="h-3.5 w-3.5" /></Button>
                            </div>
                          ))}
                        </div>
                      </div>
                      {result.qualities && result.qualities.length > 0 && (
                        <div>
                          <Label className="text-xs uppercase tracking-wide text-zinc-500">Sizes (usage estimation basis)</Label>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {result.qualities.map((q) => (
                              <Badge key={q.quality} variant="secondary" className="text-xs">
                                {q.quality}: {q.sizeText || '?'}{q.speed ? ` · ${q.speed}` : ''}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <XCircle className="h-5 w-5 text-red-500" />
                        <span className="font-medium text-zinc-900">{result.error === 'all_failed' ? 'All cookies failed' : result.error}</span>
                      </div>
                      <p className="text-sm text-zinc-600">{result.message}</p>
                      {result.attempts && result.attempts.length > 0 && (
                        <div className="space-y-1.5">
                          {result.attempts.map((a, i) => (
                            <div key={i} className="rounded-md border border-red-100 bg-red-50 p-2 text-xs">
                              <span className="font-medium">{a.email || a.label}</span>
                              <span className="mx-1.5 text-zinc-400">·</span>
                              <span className={a.outcome === 'account_inactive' ? 'text-red-700' : 'text-amber-700'}>
                                {a.outcome === 'account_inactive' ? 'marked inactive' : 'error'}
                              </span>
                              {a.detail && <div className="mt-0.5 text-zinc-500">{a.detail}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* recent logs */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4" />Recent fetches</CardTitle>
              <CardDescription>Rotation history across the pool</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[420px] pr-3">
                {logs.length === 0 ? (
                  <p className="py-8 text-center text-sm text-zinc-400">No fetches yet</p>
                ) : (
                  <div className="space-y-2">
                    {logs.map((l) => (
                      <div key={l.id} className="rounded-md border p-2.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-zinc-800">{l.fileName || `fid ${l.fid}`}</span>
                          {l.status === 'success'
                            ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                            : <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-zinc-500">
                          <span>{l.quality}</span>
                          {l.cookie?.email && <span>· {l.cookie.email}</span>}
                          {l.estGb > 0 && <span>· +{l.estGb} GB</span>}
                          <span>· {new Date(l.createdAt).toLocaleTimeString()}</span>
                        </div>
                        {l.status === 'failed' && l.message && <p className="mt-1 text-red-600">{l.message}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        {/* cookie pool */}
        <Card className="mt-6">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2"><Plus className="h-4 w-4" />Cookie pool</CardTitle>
              <CardDescription>
                Least-used active VIP account is picked first. Failed accounts are marked inactive automatically —
                reset them after you renew.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={syncAllUsage} disabled={syncingUsage}>
                {syncingUsage ? <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Gauge className="mr-1.5 h-3.5 w-3.5" />}
                Sync real usage
              </Button>
              <Button variant="outline" size="sm" onClick={() => resetAll(false)}><RotateCcw className="mr-1.5 h-3.5 w-3.5" />Reset inactive</Button>
              <Button variant="outline" size="sm" onClick={() => resetAll(true)}><RotateCcw className="mr-1.5 h-3.5 w-3.5" />Reset + clear usage</Button>
              <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogTrigger asChild><Button size="sm"><Plus className="mr-1.5 h-3.5 w-3.5" />Add cookies</Button></DialogTrigger>
                <DialogContent className="sm:max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Add account cookies</DialogTitle>
                    <DialogDescription>
                      One cookie string per line (must contain PHPSESSID + ui). Each is validated —
                      non-VIP or rejected accounts are saved but marked <b>inactive</b>.
                    </DialogDescription>
                  </DialogHeader>
                  <Textarea rows={6} value={addText} onChange={(e) => setAddText(e.target.value)}
                    placeholder={'ci=…; PHPSESSID=…; ui=eyJ0eXAi…\nci=…; PHPSESSID=…; ui=eyJ0eXAi…'} className="font-mono text-xs" />
                  {addResults.length > 0 && (
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">
                      {addResults.map((r, i) => (
                        <div key={i} className="flex items-center gap-2">
                          {r.ok
                            ? <CheckCircle2 className={r.status === 'active' ? 'h-3.5 w-3.5 text-emerald-600' : 'h-3.5 w-3.5 text-amber-500'} />
                            : <XCircle className="h-3.5 w-3.5 text-red-500" />}
                          <span className="font-medium">{r.email || r.uid || '?'}</span>
                          <span className="text-zinc-500">{r.ok ? `→ ${r.status}${r.error ? ` (${r.error})` : ''}` : r.error}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <DialogFooter>
                    <Button onClick={addCookies} disabled={adding || addText.trim().length < 20}>
                      {adding ? <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Validating…</> : 'Validate & add'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            {!cookies ? (
              <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : cookies.length === 0 ? (
              <p className="py-10 text-center text-sm text-zinc-400">Pool is empty — add your first cookie above.</p>
            ) : (
              <div className="max-h-[520px] overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader className="sticky top-0 bg-white">
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="hidden md:table-cell">Plan</TableHead>
                      <TableHead className="w-[160px]">Usage / {settings?.usageLimitGb ?? 100} GB</TableHead>
                      <TableHead className="hidden sm:table-cell">Fetches</TableHead>
                      <TableHead className="hidden lg:table-cell">Last error</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cookies.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell>{statusBadge(c.status)}</TableCell>
                        <TableCell>
                          <div className="font-medium text-zinc-900">{c.email || c.label || `uid ${c.uid}`}</div>
                          <div className="text-xs text-zinc-400">{c.username ? c.username + ' · ' : ''}uid {c.uid}</div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <div className="text-sm">{c.plan || '—'}</div>
                          <div className="text-xs text-zinc-400">{c.planExpire || ''}</div>
                        </TableCell>
                        <TableCell>
                          <Progress value={Math.min(100, (c.usageGb / (settings?.usageLimitGb || 100)) * 100)} className="h-2" />
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                            <span className="font-medium text-zinc-700">{c.usageGb.toFixed(1)} GB</span>
                            {c.usageSource === 'real' ? (
                              <Badge className="bg-sky-100 text-sky-800 border-sky-200 px-1 py-0 text-[10px]">REAL</Badge>
                            ) : c.usageSource === 'manual' ? (
                              <Badge className="bg-violet-100 text-violet-800 border-violet-200 px-1 py-0 text-[10px]">MANUAL</Badge>
                            ) : (
                              <Badge variant="outline" className="px-1 py-0 text-[10px] text-zinc-400">EST</Badge>
                            )}
                            {c.realUsageLimitGb > 0 && <span className="text-zinc-400">/ {c.realUsageLimitGb} GB plan</span>}
                            {c.usageSyncedAt && (
                              <span className="text-zinc-400" title={`Synced from FebBox ${new Date(c.usageSyncedAt).toLocaleString()}`}>
                                · {new Date(c.usageSyncedAt).toLocaleTimeString()}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-sm">{c.fetchCount}</TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <span className="block max-w-[220px] truncate text-xs text-zinc-500" title={c.lastError}>{c.lastError || '—'}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="outline" size="sm">Manage</Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>{c.email || c.label}</DropdownMenuLabel>
                              <DropdownMenuItem onClick={() => validateOne(c.id)}><RefreshCw className="mr-2 h-3.5 w-3.5" />Re-validate account</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => syncOneUsage(c.id)}><Gauge className="mr-2 h-3.5 w-3.5" />Sync real usage from FebBox</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => resetOne(c.id, false)}><RotateCcw className="mr-2 h-3.5 w-3.5" />Reactivate</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => resetOne(c.id, true)}><RotateCcw className="mr-2 h-3.5 w-3.5" />Reactivate + clear usage</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuLabel className="text-xs text-zinc-400">Adjust usage</DropdownMenuLabel>
                              <DropdownMenuItem onClick={() => addUsage(c.id, 1)}>+1 GB</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => addUsage(c.id, 5)}>+5 GB</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => addUsage(c.id, 10)}>+10 GB</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => addUsage(c.id, -1)}>-1 GB</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-red-600" onClick={() => deleteOne(c.id)}><Trash2 className="mr-2 h-3.5 w-3.5" />Delete cookie</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <footer className="mt-8 pb-4 text-center text-xs text-zinc-400">
          Cookie pool rotates least-used VIP accounts first · failed accounts are marked inactive · reset after renewing your plan
        </footer>
      </div>
    </main>
  )
}

function Play() {
  return <Film className="mr-2 h-4 w-4" />
}
