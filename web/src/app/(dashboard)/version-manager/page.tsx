"use client"

import { useState } from "react"
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
  }
}

type Preview = {
  inventoryCount: number
  groupCount: number
  groups: Array<{
    id: string
    identity: { title?: string; year?: number; confidence: number }
    versions: PreviewVersion[]
  }>
}

export default function VersionManagerPage() {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        <CardContent className="flex gap-2"><Badge variant="outline">DRY RUN</Badge><Badge variant="secondary">PRIMARY enabled</Badge><Badge variant="outline">REMOTE optional</Badge></CardContent>
      </Card>
      {error && <Card><CardContent className="pt-6 text-destructive">{error}</CardContent></Card>}
      {preview && <Card>
        <CardHeader><CardTitle>Latest preview</CardTitle><CardDescription>{preview.inventoryCount} media files in {preview.groupCount} version groups.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {preview.groups.slice(0, 50).map((group) => <div key={group.id} className="rounded-lg border p-4">
            <div className="mb-2 flex items-center justify-between"><div className="font-medium">{group.identity.title || "Unknown identity"}{group.identity.year ? ` (${group.identity.year})` : ""}</div><span className="text-xs text-muted-foreground">confidence {Math.round(group.identity.confidence * 100)}%</span></div>
            <div className="space-y-2">{group.versions.map((version) => <div key={version.id} className="flex flex-wrap items-center gap-2 text-sm"><Badge variant={version.decision === "KEEP" ? "default" : version.decision === "REVIEW" ? "secondary" : "destructive"}>{version.decision}</Badge><span>{version.fingerprint.video.resolution || "?"} {version.fingerprint.release.source || "unknown source"}</span><span className="text-muted-foreground">{version.fingerprint.video.codec || "?"} · {version.fingerprint.audio.map((audio) => audio.language).join(", ") || "unknown language"}</span></div>)}</div>
          </div>)}
        </CardContent>
      </Card>}
    </div>
  )
}
