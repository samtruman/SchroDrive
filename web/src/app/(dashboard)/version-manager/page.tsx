"use client"

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

type PreviewVersion = {
  id: string
  decision: string
  fingerprint: {
    storage: { path: string; size: number }
    video: { resolution?: string; codec?: string }
    release: { source?: string }
    audio: Array<{ language: string; codec?: string }>
    probe: { status: string; tool: string }
    identity: { title?: string; year?: number; kind?: string; season?: number; episode?: number; originalLanguage?: string; confidence: number; resolutionStatus?: string; tmdbId?: string; imdbId?: string; tvdbId?: string; provenance?: Record<string, string>; conflicts?: Array<{ field: string; values: Array<{ value: string; source: string }> }> }
  }
  evaluations: Array<{ profileId: string; score?: number; eligible: boolean; reasons: Array<{ message: string }> }>
  reasons: Array<{ message: string }>
}

type Preview = {
  inventoryCount: number
  groupCount: number
  groups: Array<{
    id: string
    identity: { title?: string; year?: number; kind?: string; season?: number; episode?: number; originalLanguage?: string; confidence: number; resolutionStatus?: string; tmdbId?: string; imdbId?: string; tvdbId?: string; provenance?: Record<string, string>; conflicts?: Array<{ field: string; values: Array<{ value: string; source: string }> }> }
  versions: PreviewVersion[]
    remote?: { status: "SATISFIED" | "REMOTE_MISSING"; reasonCode?: string; acquisition?: { status: string } }
  }>
  probe?: { requested: number; probed: number; cacheHits: number; cacheMisses: number; unavailable: number; errors: number }
  metadata?: { plex: number; jellyfin: number; tmdb: number; matched: number; unresolved: number; conflicts: number; filenameFallback: number; originalLanguageResolved: number; cacheHits: number; cacheMisses: number; plexStatus: string; jellyfinStatus: string; tmdbStatus: string }
}

type Profile = { id: string; name: string; enabled: boolean; target: string; preferredResolution: string }
type Policy = { enableRemote: boolean; acquireMissingRemote: boolean }
type ExportPreview = { providerItems: number; exportableItems: number; magnetCount: number; generatedAt: string }
type AcquisitionPreview = {
  needId: string
  status: string
  mediaType: string
  requestedProfileName: string
  providerStatus: string
  mappingWarning?: string
  contentIdentity: { title?: string; tmdbId?: string; tvdbId?: string; imdbId?: string; season?: number; episode?: number; confidence: number }
}

export default function VersionManagerPage() {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [policy, setPolicy] = useState<Policy>({ enableRemote: false, acquireMissingRemote: false })
  const [saving, setSaving] = useState(false)
  const [exportPreview, setExportPreview] = useState<ExportPreview | null>(null)
  const [exportLoading, setExportLoading] = useState(false)
  const [missing, setMissing] = useState<{ needs: AcquisitionPreview[]; adapter: { enabled: boolean; canRequest: boolean; tvScope: string } } | null>(null)
  const [missingLoading, setMissingLoading] = useState(false)

  useEffect(() => {
    fetch("/api/version-manager/status").then((response) => response.json()).then((data) => { setProfiles(data.profiles || []); setPolicy(data.policy || { enableRemote: false, acquireMissingRemote: false }) }).catch(() => undefined)
  }, [])

  async function runPreview() {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/version-manager/preview")
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Preview failed")
      setPreview(data as Preview)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed")
    } finally {
      setLoading(false)
    }
  }

  async function saveProfiles() {
    setSaving(true)
    try {
      const response = await fetch("/api/version-manager/profiles", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profiles, policy }) })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Profile save failed")
      setProfiles(data.profiles)
      setPolicy(data.policy)
    } catch (err) { setError(err instanceof Error ? err.message : "Profile save failed") }
    finally { setSaving(false) }
  }

  async function loadExportPreview() {
    setExportLoading(true)
    try {
      const response = await fetch("/api/version-manager/export?mode=FULL_LIBRARY&format=preview")
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Export preview failed")
      setExportPreview(data)
    } catch (err) { setError(err instanceof Error ? err.message : "Export preview failed") }
    finally { setExportLoading(false) }
  }

  async function loadMissingPreview() {
    setMissingLoading(true)
    try {
      const response = await fetch("/api/version-manager/missing")
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Missing versions preview failed")
      setMissing({ needs: data.previews || [], adapter: data.adapter })
    } catch (err) { setError(err instanceof Error ? err.message : "Missing versions preview failed") }
    finally { setMissingLoading(false) }
  }

  function downloadExport(format: "magnets" | "manifest") {
    window.location.href = `/api/version-manager/export?mode=FULL_LIBRARY&format=${format}`
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Version Manager</h1>
          <p className="text-muted-foreground">Policy-based, read-only version analysis.</p>
        </div>
        <Button onClick={runPreview} disabled={loading}>{loading ? "Scanning…" : "Run read-only scan"}</Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Safety mode</CardTitle>
          <CardDescription>Inventory, fingerprinting and decisions are currently dry-run only. Provider deletion is not implemented.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2"><Badge variant="outline">DRY RUN</Badge><Badge variant="secondary">PRIMARY enabled</Badge><Badge variant="outline">REMOTE {policy.enableRemote ? "enabled" : "disabled"}</Badge></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Missing Versions</CardTitle><CardDescription>Read-only acquisition preview. No Seerr request can be sent from this milestone.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={loadMissingPreview} disabled={missingLoading || !policy.enableRemote}>{missingLoading ? "Checking…" : "Preview missing profiles"}</Button>
          {!policy.enableRemote && <p className="text-sm text-muted-foreground">Enable REMOTE to evaluate missing profile needs.</p>}
          {missing && <>
            <div className="rounded border p-3 text-sm">Needs: <strong>{missing.needs.length}</strong> · Seerr: <strong>{missing.adapter.enabled ? "configured" : "configuration unavailable"}</strong> · requests: <strong>{missing.adapter.canRequest ? "enabled" : "disabled"}</strong></div>
            <div className="space-y-2">{missing.needs.slice(0, 50).map((need) => <div key={need.needId} className="rounded border p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><strong>{need.contentIdentity.title || "Unknown identity"}</strong>{need.contentIdentity.season !== undefined && <span>S{String(need.contentIdentity.season).padStart(2, "0")}E{String(need.contentIdentity.episode).padStart(2, "0")}</span>}<Badge variant={need.status === "ACQUISITION_ELIGIBLE" ? "default" : "secondary"}>{need.status}</Badge></div><div className="text-muted-foreground">{need.requestedProfileName} · {need.mediaType} · confidence {Math.round(need.contentIdentity.confidence * 100)}% · Seerr {need.providerStatus}</div>{need.mappingWarning && <div className="mt-1 text-amber-600">{need.mappingWarning}</div>}</div>)}</div>
          </>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Export / Migration</CardTitle><CardDescription>Read-only FULL LIBRARY export. It uses provider inventory directly and includes uncertain or un-fingerprinted items when an infohash is available.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={loadExportPreview} disabled={exportLoading}>{exportLoading ? "Loading…" : "Preview Full Library"}</Button>
          {exportPreview && <div className="rounded border p-3 text-sm">Provider items: <strong>{exportPreview.providerItems}</strong> · Exportable: <strong>{exportPreview.exportableItems}</strong> · Unique magnets: <strong>{exportPreview.magnetCount}</strong><div className="mt-1 text-muted-foreground">Snapshot: {new Date(exportPreview.generatedAt).toLocaleString()}</div></div>}
          <div className="flex flex-wrap gap-2"><Button onClick={() => downloadExport("magnets")} disabled={!exportPreview}>Download magnets.txt</Button><Button variant="outline" onClick={() => downloadExport("manifest")} disabled={!exportPreview}>Download manifest.json</Button></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Optional multi-version mode</CardTitle><CardDescription>REMOTE is an independent 1080p Direct Play slot. It is disabled by default and never falls back to 2160p.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.enableRemote} onChange={(event) => setPolicy((current) => ({ ...current, enableRemote: event.target.checked }))} /> Enable REMOTE / Direct Play version</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.acquireMissingRemote} disabled={!policy.enableRemote} onChange={(event) => setPolicy((current) => ({ ...current, acquireMissingRemote: event.target.checked }))} /> Acquire missing REMOTE versions <span className="text-muted-foreground">(manual approval only)</span></label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Version profiles</CardTitle><CardDescription>These settings are persisted locally. They only affect dry-run evaluation.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {profiles.map((profile) => <div key={profile.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
            <input type="checkbox" checked={profile.enabled} onChange={(event) => setProfiles((items) => items.map((item) => item.id === profile.id ? { ...item, enabled: event.target.checked } : item))} aria-label={`${profile.name} enabled`} />
            <span className="min-w-48 font-medium">{profile.name}</span>
            <label className="text-sm text-muted-foreground">Preferred resolution <select className="ml-2 rounded border bg-background px-2 py-1 text-foreground" value={profile.preferredResolution} onChange={(event) => setProfiles((items) => items.map((item) => item.id === profile.id ? { ...item, preferredResolution: event.target.value } : item))}><option>2160p</option><option>1080p</option><option>720p</option></select></label>
          </div>)}
          {profiles.length > 0 && <Button variant="outline" onClick={saveProfiles} disabled={saving}>{saving ? "Saving…" : "Save profiles"}</Button>}
        </CardContent>
      </Card>
      {error && <Card><CardContent className="pt-6 text-destructive">{error}</CardContent></Card>}
      {preview && <Card>
        <CardHeader><CardTitle>Latest verified preview</CardTitle><CardDescription>{preview.inventoryCount} media files in {preview.groupCount} version groups.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {preview.probe && <div className="grid gap-2 text-sm md:grid-cols-6"><span>Probed: <strong>{preview.probe.probed}</strong></span><span>Cache hit: <strong>{preview.probe.cacheHits}</strong></span><span>Cache miss: <strong>{preview.probe.cacheMisses}</strong></span><span>Unavailable: <strong>{preview.probe.unavailable}</strong></span><span>Errors: <strong>{preview.probe.errors}</strong></span><span>Metadata matched: <strong>{preview.metadata?.matched ?? 0}</strong></span></div>}
          {preview.metadata && <div className="rounded border p-3 text-sm">Identity: <strong>{preview.metadata.matched}</strong> matched · <strong>{preview.metadata.unresolved}</strong> fallback/uncertain · <strong>{preview.metadata.conflicts}</strong> conflicts · original language <strong>{preview.metadata.originalLanguageResolved}</strong> · metadata cache {preview.metadata.cacheHits} hit / {preview.metadata.cacheMisses} miss. Plex: {preview.metadata.plexStatus}; Jellyfin: {preview.metadata.jellyfinStatus}; TMDb: {preview.metadata.tmdbStatus}.</div>}
          {policy.enableRemote && <div className="text-sm">REMOTE missing: <strong>{preview.groups.filter((group) => group.remote?.status === "REMOTE_MISSING").length}</strong> groups</div>}
          {preview.groups.slice(0, 50).map((group) => <div key={group.id} className="rounded-lg border p-4">
            <div className="mb-2 flex items-center justify-between"><div className="font-medium">{group.identity.title || "Unknown identity"}{group.identity.year ? ` (${group.identity.year})` : ""}</div><span className="text-xs text-muted-foreground">confidence {Math.round(group.identity.confidence * 100)}%</span></div>
            <div className="mb-2 text-xs text-muted-foreground">IDs: TMDb {group.identity.tmdbId || "—"} · IMDb {group.identity.imdbId || "—"} · TVDb {group.identity.tvdbId || "—"} · original language {group.identity.originalLanguage || "—"} · {group.identity.resolutionStatus || "fallback"}</div>
            {group.identity.provenance && <div className="mb-2 text-xs text-muted-foreground">Evidence: {[...new Set(Object.values(group.identity.provenance))].join(" · ") || "—"}</div>}
            {group.identity.conflicts && <div className="mb-2 text-xs text-amber-600">Identity conflict: {group.identity.conflicts.map((conflict) => `${conflict.field}=${conflict.values.map((value) => `${value.value} (${value.source})`).join(" vs ")}`).join("; ")}</div>}
            {group.remote?.status === "REMOTE_MISSING" && <div className="mb-2 text-sm text-amber-600">REMOTE_MISSING — no eligible verified 1080p version{group.remote.acquisition ? " · ACQUISITION_NEEDED" : " · informational only"}</div>}
            <div className="space-y-2">{group.versions.map((version) => <div key={version.id} className="rounded border p-2 text-sm"><div className="flex flex-wrap items-center gap-2"><Badge variant={version.decision === "KEEP" ? "default" : version.decision === "REVIEW" ? "secondary" : "destructive"}>{version.decision}</Badge><span>{version.fingerprint.video.resolution || "?"} {version.fingerprint.release.source || "unknown source"}</span><span className="text-muted-foreground">{version.fingerprint.video.codec || "?"} · {version.fingerprint.audio.map((audio) => audio.language).join(", ") || "unknown language"}</span><Badge variant="outline">{version.fingerprint.probe.status}</Badge></div><div className="mt-1 text-xs text-muted-foreground">{version.evaluations.map((evaluation) => `${evaluation.profileId}: ${evaluation.eligible ? evaluation.score ?? "eligible" : "ineligible"}`).join(" · ")} — {version.reasons.map((reason) => reason.message).join("; ")}</div></div>)}</div>
          </div>)}
        </CardContent>
      </Card>}
    </div>
  )
}
