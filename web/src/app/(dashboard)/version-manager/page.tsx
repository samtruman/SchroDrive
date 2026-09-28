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
    identity: { tmdbId?: string; imdbId?: string; tvdbId?: string }
  }
  evaluations: Array<{ profileId: string; score?: number; eligible: boolean; reasons: Array<{ message: string }> }>
  reasons: Array<{ message: string }>
}

type Preview = {
  inventoryCount: number
  groupCount: number
  groups: Array<{
    id: string
    identity: { title?: string; year?: number; confidence: number }
  versions: PreviewVersion[]
    remote?: { status: "SATISFIED" | "REMOTE_MISSING"; reasonCode?: string; acquisition?: { status: string } }
  }>
  probe?: { requested: number; probed: number; cacheHits: number; cacheMisses: number; unavailable: number; errors: number }
  metadata?: { plex: number; jellyfin: number; tmdb: number; matched: number; unresolved: number }
}

type Profile = { id: string; name: string; enabled: boolean; target: string; preferredResolution: string }
type Policy = { enableRemote: boolean; acquireMissingRemote: boolean }

export default function VersionManagerPage() {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [policy, setPolicy] = useState<Policy>({ enableRemote: false, acquireMissingRemote: false })
  const [saving, setSaving] = useState(false)

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
      const response = await fetch("/api/version-manager/status", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profiles, policy }) })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Profile save failed")
      setProfiles(data.profiles)
      setPolicy(data.policy)
    } catch (err) { setError(err instanceof Error ? err.message : "Profile save failed") }
    finally { setSaving(false) }
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
          {policy.enableRemote && <div className="text-sm">REMOTE missing: <strong>{preview.groups.filter((group) => group.remote?.status === "REMOTE_MISSING").length}</strong> groups</div>}
          {preview.groups.slice(0, 50).map((group) => <div key={group.id} className="rounded-lg border p-4">
            <div className="mb-2 flex items-center justify-between"><div className="font-medium">{group.identity.title || "Unknown identity"}{group.identity.year ? ` (${group.identity.year})` : ""}</div><span className="text-xs text-muted-foreground">confidence {Math.round(group.identity.confidence * 100)}%</span></div>
            {group.remote?.status === "REMOTE_MISSING" && <div className="mb-2 text-sm text-amber-600">REMOTE_MISSING — no eligible verified 1080p version{group.remote.acquisition ? " · ACQUISITION_NEEDED" : " · informational only"}</div>}
            <div className="space-y-2">{group.versions.map((version) => <div key={version.id} className="rounded border p-2 text-sm"><div className="flex flex-wrap items-center gap-2"><Badge variant={version.decision === "KEEP" ? "default" : version.decision === "REVIEW" ? "secondary" : "destructive"}>{version.decision}</Badge><span>{version.fingerprint.video.resolution || "?"} {version.fingerprint.release.source || "unknown source"}</span><span className="text-muted-foreground">{version.fingerprint.video.codec || "?"} · {version.fingerprint.audio.map((audio) => audio.language).join(", ") || "unknown language"}</span><Badge variant="outline">{version.fingerprint.probe.status}</Badge></div><div className="mt-1 text-xs text-muted-foreground">{version.evaluations.map((evaluation) => `${evaluation.profileId}: ${evaluation.eligible ? evaluation.score ?? "eligible" : "ineligible"}`).join(" · ")} — {version.reasons.map((reason) => reason.message).join("; ")}</div></div>)}</div>
          </div>)}
        </CardContent>
      </Card>}
    </div>
  )
}
