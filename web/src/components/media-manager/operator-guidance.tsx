"use client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function ReviewActionGuide() {
  return <section aria-label="Review actions explained" className="rounded-lg border bg-muted/20 p-4 text-sm">
    <h2 className="font-semibold">Only unresolved work appears here</h2>
    <p className="mt-1 text-muted-foreground">Each card explains the blocker and exposes the action that can resolve it. Identity problems can be matched or retried; ranking ties let you choose the copy to keep; metadata and recoverability problems state what must be restored before reevaluation.</p>
  </section>;
}

const reasons = (version: any) => (version.reasons || []).map((r: any) => typeof r === "string" ? r : r.message).join(" · ");
function VersionLine({ version }: { version: any }) {
  const fp = version.fingerprint || {}, video = fp.video || {}, storage = fp.storage || {};
  const languages = [...new Set((fp.audio || []).map((audio: any) => audio.language).filter(Boolean))].join("/");
  const name = (storage.path || version.files?.[0]?.path || "Filename unavailable").split(/[\\/]/).pop();
  return <div className="min-w-0"><p className="break-words">{version.season !== undefined ? `S${String(version.season).padStart(2,"0")}E${String(version.episode ?? 0).padStart(2,"0")} · ` : ""}{name}</p><p className="text-xs text-muted-foreground">{[video.resolution, fp.release?.source, video.codec, video.dolbyVision ? "Dolby Vision" : video.hdr10 ? "HDR10" : video.dynamicRange, languages, storage.provider || version.provider].filter(Boolean).join(" · ")}</p><p className="mt-1 text-xs">{reasons(version)}</p></div>;
}

export function DeleteImpactCards({ items, scope, dryRun, busyId, onDetails, onDelete }: { items: any[]; scope: string; dryRun: boolean; busyId?: string; onDetails: (item: any) => void; onDelete: (item: any) => void }) {
  return <section className="space-y-3" aria-label={scope === "protected" ? "Protected resources" : "Deletion candidates"}>
    <div><h2 className="font-semibold">{scope === "protected" ? "Protected / Not deletable" : scope === "attention" ? "Needs review" : "Deletion candidates"} · {items.length} physical resources</h2><p className="text-sm text-muted-foreground">{scope === "protected" ? "These resources contain a logical candidate, but physical deletion is blocked by a KEEP/shared item, missing replacement, review, or recoverability requirement." : scope === "attention" ? "These resources have no actionable removal candidate. Resolve the review, identity, replacement, or recoverability blocker before reassessing them." : dryRun ? "Each physical resource has a confirmed KEEP replacement. Validate dry run repeats all checks against the provider without deleting anything." : "Each physical resource has a confirmed KEEP replacement. You can validate safely or delete it after an explicit confirmation; every action repeats all checks first."}</p></div>
    {!items.length && <p className="rounded border p-4 text-sm">No resources match this view.</p>}
    {items.map(item => {
      const candidates = item.versions.filter((v: any) => v.decision === "DELETE_CANDIDATE");
      const title = (candidates[0] || item.versions[0])?.title || "Unresolved content";
      return <Card key={`${item.provider}:${item.providerItemId}`} data-testid="delete-resource"><CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{title}</h3><span className="rounded border px-2 py-1 text-xs">{item.protectedByKeep ? "PROTECTED" : item.state === "READY" ? `ELIGIBLE · ${dryRun ? "DRY RUN" : "LIVE"}` : "NOT DELETABLE"}</span></div>
        {candidates.map((candidate: any) => {
          const kept = [...item.versions.filter((v: any) => v.decision === "KEEP"), ...(item.alternativeVersions || [])].filter((v: any) => v.groupId === candidate.groupId);
          return <div key={candidate.id} className="grid gap-3 md:grid-cols-2"><div className="rounded border border-amber-500/30 p-3 text-sm"><p className="mb-1 font-semibold">Candidate</p><VersionLine version={candidate} /></div><div className="rounded border border-emerald-500/30 p-3 text-sm"><p className="mb-1 font-semibold">Kept instead · same content / episode</p>{kept.length ? kept.map((v: any) => <VersionLine key={v.id} version={v} />) : <p>No confirmed KEEP replacement. Physical deletion is blocked.</p>}</div></div>;
        })}
        {!candidates.length && <p className="text-sm">No removal candidate. {item.versions.some((v: any) => v.decision === "REVIEW") ? "Resolve the review blockers before a decision can be made." : "The versions in this resource are retained."}</p>}
        <div className="text-sm"><p className="font-semibold">Physical deletion: {item.state === "READY" && !item.onlyCopy && !item.protectedByKeep ? dryRun ? "eligible; validation only while Dry run is enabled" : "eligible after final provider revalidation" : "blocked"}</p><p className="text-muted-foreground">{item.reasons.join(" · ")}</p></div>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => onDetails(item)}>Details</Button>{scope === "candidates" && <Button size="sm" variant={dryRun ? "secondary" : "destructive"} disabled={Boolean(busyId)} onClick={() => onDelete(item)}>{busyId === `${item.provider}:${item.providerItemId}` ? dryRun ? "Validating…" : "Deleting…" : dryRun ? "Delete · dry run" : "Delete ProviderItem"}</Button>}</div>
      </CardContent></Card>;
    })}
  </section>;
}
