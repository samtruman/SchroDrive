"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Archive, Check, ChevronRight, ClipboardCheck, Download, ExternalLink, FileUp, Layers3, RefreshCw, Search, ShieldCheck, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

type View = "overview" | "library" | "migration" | "settings"
type Profile = { id: string; name: string; enabled: boolean; requirements?: Record<string, unknown>; hardRequirements?: unknown }

const statusTone: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  AVAILABLE: "default", REQUESTED: "secondary", PENDING: "secondary", PROCESSING: "secondary", NOT_REQUESTED: "outline",
  REJECTED_LEGAL: "destructive", CONFLICT: "destructive", REVIEW: "destructive", READY_TO_IMPORT: "default",
}

function StatusBadge({ value }: { value: string }) {
  return <Badge variant={statusTone[value] || "outline"}>{value.replaceAll("_", " ")}</Badge>
}

function SectionNav({ view }: { view: View }) {
  const links = [
    ["Overview", "/media-manager"], ["Library", "/media-manager/library?view=all"],
    ["Backup & Migration", "/media-manager/migration"], ["Settings", "/media-manager/settings"],
  ] as const
  return <nav className="flex flex-wrap gap-2 border-b pb-3">{links.map(([label, href]) => <Button key={href} asChild variant={(view === "overview" && label === "Overview") || (view === "library" && label === "Library") || (view === "migration" && label === "Backup & Migration") || (view === "settings" && label === "Settings") ? "default" : "ghost"} size="sm"><Link href={href}>{label}</Link></Button>)}</nav>
}

function Header({ view, title, description }: { view: View; title: string; description: string }) {
  return <><SectionNav view={view} /><div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-bold tracking-tight">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div></div></>
}

function Stat({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return <Card><CardContent className="p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold">{value}</p>{detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}</CardContent></Card>
}

function useJson<T>(url: string, enabled = true) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState("")
  const load = useCallback(async () => {
    if (!enabled) return
    setLoading(true); setError("")
    try { const response = await fetch(url, { cache: "no-store" }); const body = await response.json(); if (!response.ok || body.ok === false) throw new Error(body.error || "Request failed"); setData(body) }
    catch (value: any) { setError(value.message || "Request failed") }
    finally { setLoading(false) }
  }, [enabled, url])
  useEffect(() => { void load() }, [load])
  return { data, loading, error, reload: load }
}

function ErrorBox({ error }: { error: string }) { return error ? <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div> : null }

function Overview() {
  const status = useJson<any>("/api/version-manager/status")
  const migration = useJson<any>("/api/version-manager/migration/state")
  const [scan, setScan] = useState<any>(null)
  const [scanning, setScanning] = useState(false)
  async function runScan() { setScanning(true); try { const response = await fetch("/api/version-manager/preview", { cache: "no-store" }); const body = await response.json(); if (!response.ok || !body.ok) throw new Error(body.error || "Scan failed"); setScan(body) } catch (value: any) { setScan({ error: value.message }) } finally { setScanning(false) } }
  const profiles = status.data?.profiles || []
  return <div className="space-y-6"><Header view="overview" title="Media Manager" description="Inventory, identity, versions, acquisition and recovery in one place." />
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"><div><p className="font-medium">Library status</p><p className="text-sm text-muted-foreground">{scan ? `Last scan: ${scan.groupCount} content groups` : status.data?.latestScan ? "Last scan available" : "No scan run in this session"}</p></div><Button onClick={() => void runScan()} disabled={scanning}><RefreshCw className={`mr-2 h-4 w-4 ${scanning ? "animate-spin" : ""}`} />Run Scan</Button></div>
    {scan?.error && <ErrorBox error={scan.error} />}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Stat label="Library contents" value={scan?.groupCount ?? status.data?.latestScan?.groupCount ?? "—"} detail="ContentIdentity / VersionGroup" /><Stat label="Profiles" value={profiles.filter((profile: Profile) => profile.enabled).length} detail="enabled" /><Stat label="Acquisition" value={migration.data?.effective?.readyToImport ?? "—"} detail="effective ready to import" /><Stat label="Safety" value="DRY RUN" detail="Delete disabled" /></div>
    <div className="grid gap-4 lg:grid-cols-3"><Card><CardHeader><CardTitle className="text-base">Profiles</CardTitle></CardHeader><CardContent className="space-y-2">{profiles.map((profile: Profile) => <div className="flex items-center justify-between text-sm" key={profile.id}><span>{profile.name || profile.id}</span><StatusBadge value={profile.enabled ? "ENABLED" : "DISABLED"} /></div>)}</CardContent></Card><Card><CardHeader><CardTitle className="text-base">Backup & Migration</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p>Source items <strong>{migration.data?.sourceItems ?? "—"}</strong></p><p>Rejected legal <strong>{migration.data?.effective?.rejectedLegal ?? "—"}</strong></p><p>Importable remaining <strong>{migration.data?.effective?.residualTentableReady ?? "—"}</strong></p><Link className="inline-flex items-center text-primary" href="/media-manager/migration">Open migration <ChevronRight className="ml-1 h-4 w-4" /></Link></CardContent></Card><Card><CardHeader><CardTitle className="text-base">Safety status</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-green-500" />Dry run active</p><p className="text-muted-foreground">Delete executor is not implemented. Mutating workflows require their explicit controls.</p></CardContent></Card></div>
  </div>
}

function Library() {
  const pathname = usePathname(); const [preset, setPreset] = useState("all")
  useEffect(() => { setPreset(new URLSearchParams(window.location.search).get("view") || "all") }, [pathname])
  const preview = useJson<any>("/api/version-manager/preview", preset === "all")
  const missing = useJson<any>("/api/version-manager/missing", preset === "missing")
  const [review, setReview] = useState<any>(null); const [reviewError, setReviewError] = useState(""); const [query, setQuery] = useState("")
  const loadReview = useCallback(async () => { try { const response = await fetch("/api/organizer/review?limit=100&status=pending", { cache: "no-store" }); const body = await response.json(); if (!response.ok || !body.ok) throw new Error(body.error); setReview(body) } catch (value: any) { setReviewError(value.message || "Unable to load review") } }, [])
  useEffect(() => { if (preset === "review") void loadReview() }, [loadReview, preset])
  async function reviewAction(id: string, body: Record<string, unknown>) { const response = await fetch(`/api/organizer/review/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (response.ok) void loadReview(); else setReviewError("Unable to save review action") }
  const groups = (preview.data?.groups || []).filter((group: any) => JSON.stringify(group).toLowerCase().includes(query.toLowerCase()))
  const needs = (missing.data?.previews || []).filter((item: any) => JSON.stringify(item).toLowerCase().includes(query.toLowerCase()))
  return <div className="space-y-6"><Header view="library" title="Library" description="One operational view for content, missing profiles and review work." /><div className="flex flex-wrap gap-2"><Button asChild variant={preset === "all" ? "default" : "outline"} size="sm"><Link href="/media-manager/library?view=all">All</Link></Button><Button asChild variant={preset === "missing" ? "default" : "outline"} size="sm"><Link href="/media-manager/library?view=missing">Missing</Link></Button><Button asChild variant={preset === "review" ? "default" : "outline"} size="sm"><Link href="/media-manager/library?view=review">Review</Link></Button><div className="relative ml-auto min-w-[220px]"><Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title…" /></div></div>
    {preset === "all" && <><ErrorBox error={preview.error} />{preview.loading ? <p className="text-sm text-muted-foreground">Loading library…</p> : <div className="space-y-3">{groups.slice(0, 200).map((group: any, index: number) => <Card key={group.id || index}><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="font-medium">{group.identity?.title || group.title || "Unidentified content"}</p><p className="text-xs text-muted-foreground">{group.identity?.year || "—"} · {group.identity?.mediaType || group.mediaType || "unknown"} · {group.versions?.length || 0} versions</p></div><div className="flex flex-wrap gap-2">{(group.versions || []).slice(0, 3).map((version: any, versionIndex: number) => <StatusBadge key={version.id || versionIndex} value={version.decision || "VERSION"} />)}</div></CardContent></Card>)}{groups.length === 0 && <Card><CardContent className="p-6 text-sm text-muted-foreground">No contents match the current search.</CardContent></Card>}</div>}</>}
    {preset === "missing" && <><ErrorBox error={missing.error} />{missing.loading ? <p className="text-sm text-muted-foreground">Loading missing profiles…</p> : <div className="space-y-3">{needs.map((item: any, index: number) => <Card key={item.needId || item.id || index}><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="font-medium">{item.contentIdentity?.title || item.title || "Unknown content"}</p><p className="text-xs text-muted-foreground">{item.contentIdentity?.mediaType || "—"} · profile {item.profileId || item.missingProfileId || "—"}</p></div><div className="flex items-center gap-2"><StatusBadge value={item.status || "REVIEW"} /><Button size="sm" variant="outline">Details</Button></div></CardContent></Card>)}{needs.length === 0 && <Card><CardContent className="p-6 text-sm text-muted-foreground">No missing profiles.</CardContent></Card>}</div>}</>}
    {preset === "review" && <><ErrorBox error={reviewError} />{!review ? <p className="text-sm text-muted-foreground">Loading review queue…</p> : <div className="space-y-3">{(review.entries || []).map((entry: any) => <Card key={entry.id}><CardContent className="space-y-3 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{entry.sourceBasename}</p><p className="break-all text-xs text-muted-foreground">{entry.sourcePath}</p></div><StatusBadge value={String(entry.decision || entry.parsed?.status || "REVIEW").toUpperCase()} /></div><p className="text-sm">{entry.parsed?.title || "No title"} · {entry.parsed?.reason || "Review required"}</p><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => void reviewAction(entry.id, { decision: "accepted" })}><Check className="mr-2 h-4 w-4" />Accept</Button><Button size="sm" variant="outline" onClick={() => void reviewAction(entry.id, { decision: "dismissed" })}><X className="mr-2 h-4 w-4" />Dismiss</Button><Button size="sm" variant="outline" onClick={() => void reviewAction(entry.id, { action: "retry" })}><RefreshCw className="mr-2 h-4 w-4" />Retry / Resume</Button><Button size="sm" variant="ghost" asChild><Link href={`/review/${encodeURIComponent(entry.id)}`}><ExternalLink className="mr-2 h-4 w-4" />Details</Link></Button></div></CardContent></Card>)}</div>}</>}
  </div>
}

function Migration() {
  const state = useJson<any>("/api/version-manager/migration/state")
  const [mode, setMode] = useState("FULL"); const [fileError, setFileError] = useState(""); const [importPlan, setImportPlan] = useState<any>(null); const [loadingFile, setLoadingFile] = useState(false)
  async function previewFile(file: File) { setLoadingFile(true); setFileError(""); try { const text = await file.text(); const isManifest = file.name.toLowerCase().endsWith(".json"); const body = isManifest ? { targetProvider: "realdebrid", manifest: JSON.parse(text) } : { targetProvider: "realdebrid", magnetsText: text }; const response = await fetch("/api/version-manager/import/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || "Import preview failed"); setImportPlan(data) } catch (value: any) { setFileError(value.message || "Unable to preview import") } finally { setLoadingFile(false) } }
  return <div className="space-y-6"><Header view="migration" title="Backup & Migration" description="Portable export, safe import preview and migration history." /><div className="flex flex-wrap gap-2"><Button variant="default"><Archive className="mr-2 h-4 w-4" />Export</Button><Button variant="outline"><FileUp className="mr-2 h-4 w-4" />Import preview</Button><Button variant="outline" disabled>Jobs / History</Button></div>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Stat label="Source items" value={state.data?.sourceItems ?? "—"} /><Stat label="Already present/equivalent" value={state.data?.effective?.alreadyPresent ?? "—"} /><Stat label="Rejected legal" value={state.data?.effective?.rejectedLegal ?? "—"} /><Stat label="Import All Missing" value={state.data?.effective?.residualTentableReady ?? "—"} detail="effective ready only" /></div>
    <Card><CardHeader><CardTitle className="text-base">Export</CardTitle></CardHeader><CardContent className="flex flex-wrap items-center gap-3"><label className="text-sm">Mode <select className="ml-2 rounded border bg-background p-2" value={mode} onChange={(event) => setMode(event.target.value)}><option>FULL</option><option>KEEP</option><option>PRIMARY</option><option>REMOTE</option><option>PRIMARY+REMOTE</option><option>SELECTED</option></select></label><Button asChild variant="outline"><a href={`/api/version-manager/export?mode=${encodeURIComponent(mode)}&format=manifest`}><Download className="mr-2 h-4 w-4" />manifest.json</a></Button><Button asChild variant="outline"><a href={`/api/version-manager/export?mode=${encodeURIComponent(mode)}&format=magnets`}><Download className="mr-2 h-4 w-4" />magnets.txt</a></Button></CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">Import preview</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">Analyze a SchröDrive manifest or generic magnets file. Execute remains disabled in this UI.</p><input type="file" accept=".json,.txt,.magnet" onChange={(event) => { const file = event.target.files?.[0]; if (file) void previewFile(file) }} disabled={loadingFile} /><ErrorBox error={fileError} />{importPlan && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{Object.entries(importPlan.counts || {}).map(([key, value]) => <div className="rounded border p-3" key={key}><p className="text-xs text-muted-foreground">{key.replaceAll("_", " ")}</p><p className="text-xl font-semibold">{String(value)}</p></div>)}</div>}</CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">Effective migration state</CardTitle></CardHeader><CardContent><p className="mb-3 text-sm text-muted-foreground">Provider inventory is reconciled with migration audit. Legal rejections are not automatically retried.</p><div className="max-h-72 overflow-auto rounded border"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-muted"><tr><th className="p-2">Item</th><th className="p-2">Hash</th><th className="p-2">Raw</th><th className="p-2">Effective</th><th className="p-2">Reason</th></tr></thead><tbody>{(state.data?.items || []).slice(0, 100).map((item: any, index: number) => <tr className="border-t" key={`${item.infoHash || "item"}-${index}`}><td className="p-2">{item.originalName || "—"}</td><td className="p-2 font-mono text-xs">{item.infoHash || "—"}</td><td className="p-2"><StatusBadge value={item.status} /></td><td className="p-2"><StatusBadge value={item.effectiveStatus} /></td><td className="max-w-xs p-2 text-xs text-muted-foreground">{item.reason || "—"}</td></tr>)}</tbody></table></div></CardContent></Card>
  </div>
}

function SettingsView() {
  const status = useJson<any>("/api/version-manager/status"); const [profiles, setProfiles] = useState<Profile[]>([]); const [saving, setSaving] = useState(false); const [saved, setSaved] = useState("")
  useEffect(() => { if (status.data?.profiles) setProfiles(status.data.profiles) }, [status.data])
  async function save() { setSaving(true); setSaved(""); try { const response = await fetch("/api/version-manager/profiles", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profiles, policy: status.data?.policy || {} }) }); if (!response.ok) throw new Error("Unable to save profiles"); setSaved("Saved") } catch (value: any) { setSaved(value.message || "Save failed") } finally { setSaving(false) } }
  return <div className="space-y-6"><Header view="settings" title="Media Manager Settings" description="Configure profiles, acquisition behavior and safety without duplicating global provider credentials." /><div className="flex flex-wrap gap-2"><Button variant="default">Profiles</Button><Button variant="outline">Languages</Button><Button variant="outline">Rules</Button><Button variant="outline">Acquisition</Button><Button variant="outline">Safety</Button></div><Card><CardHeader><CardTitle className="text-base">Profiles</CardTitle></CardHeader><CardContent className="space-y-4">{profiles.map((profile, index) => <div className="flex flex-wrap items-center justify-between gap-3 rounded border p-3" key={profile.id}><div><p className="font-medium">{profile.name || profile.id}</p><p className="text-xs text-muted-foreground">VersionProfile · requirements remain extensible</p></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={profile.enabled} onChange={(event) => setProfiles((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item))} />Enabled</label></div>)}<div className="flex items-center gap-3"><Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save profiles"}</Button>{saved && <span className="text-sm text-muted-foreground">{saved}</span>}</div></CardContent></Card><div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle className="text-base">Acquisition</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p>Missing-profile evaluation remains profile-aware.</p><p>Seerr credentials are managed in the global Settings page.</p><Link className="text-primary" href="/settings">Open global provider settings <ChevronRight className="inline h-4 w-4" /></Link></CardContent></Card><Card><CardHeader><CardTitle className="text-base">Safety</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p><StatusBadge value="DRY RUN" /> Delete is disabled / not implemented.</p><p className="text-muted-foreground">Recoverability requirements and future cleanup controls remain fail-closed.</p></CardContent></Card></div></div>
}

export function MediaManagerShell({ view }: { view: View }) {
  if (view === "overview") return <Overview />
  if (view === "library") return <Library />
  if (view === "migration") return <Migration />
  return <SettingsView />
}
