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
const formatSize = (value: unknown) => {
  const bytes = Number(value || 0);
  if (!bytes) return "Size unknown";
  const gib = bytes / 1024 / 1024 / 1024;
  return gib >= 1 ? `${gib.toFixed(2)} GiB` : `${Math.round(bytes / 1_000_000)} MB`;
};
const eligibleEvaluation = (version: any) => (version.evaluations || []).find((evaluation: any) => evaluation.eligible) || version.evaluations?.[0];
export function DecisionEvidence({ candidate, kept }: { candidate: any; kept: any }) {
  const candidateFp = candidate.fingerprint || {}, keptFp = kept.fingerprint || {};
  const candidateVideo = candidateFp.video || {}, keptVideo = keptFp.video || {};
  const candidateStorage = candidateFp.storage || {}, keptStorage = keptFp.storage || {};
  const candidateEvaluation = eligibleEvaluation(candidate), keptEvaluation = eligibleEvaluation(kept);
  const candidateScore = Number(candidateEvaluation?.score ?? 0), keptScore = Number(keptEvaluation?.score ?? 0);
  const candidateLanguage = Number(candidateEvaluation?.breakdown?.language ?? 0), keptLanguage = Number(keptEvaluation?.breakdown?.language ?? 0);
  const evidence: string[] = [];
  if (candidateVideo.resolution && keptVideo.resolution && candidateVideo.resolution !== keptVideo.resolution) {
    evidence.push(`Resolution ranking: ${keptVideo.resolution} retained over ${candidateVideo.resolution}.`);
  }
  if (keptLanguage !== candidateLanguage) {
    evidence.push(`Preferred-language score: retained ${keptLanguage}, candidate ${candidateLanguage}.`);
  }
  if (keptScore !== candidateScore) {
    evidence.push(`Total policy score: retained ${keptScore}, candidate ${candidateScore}.`);
  } else if (candidateVideo.resolution === keptVideo.resolution && candidateStorage.size && keptStorage.size && Number(candidateStorage.size) !== Number(keptStorage.size)) {
    evidence.push(`File-size preference: ${formatSize(keptStorage.size)} retained over ${formatSize(candidateStorage.size)}.`);
  }
  if (candidateEvaluation?.eligible && keptEvaluation?.eligible) evidence.push("Mandatory audio, subtitle and advanced requirements: passed by both files.");
  if (!evidence.length) evidence.push("No decisive comparison is available in this snapshot; open Details to inspect the detected metadata.");
  return <ul className="mt-2 space-y-1 text-xs"><li className="font-medium">Why this copy is preferred</li>{evidence.map((item) => <li key={item} className="text-muted-foreground">• {item}</li>)}</ul>;
}
export function VersionLine({ version }: { version: any }) {
  const fp = version.fingerprint || {}, video = fp.video || {}, storage = fp.storage || {};
  const languages = [...new Set((fp.audio || []).map((audio: any) => audio.language).filter(Boolean))].join("/");
  const name = (storage.path || version.files?.[0]?.path || "Filename unavailable").split(/[\\/]/).pop();
  return <div className="min-w-0"><p className="break-words">{version.season !== undefined ? `S${String(version.season).padStart(2,"0")}E${String(version.episode ?? 0).padStart(2,"0")} · ` : ""}{name}</p><p className="text-xs text-muted-foreground">{[video.resolution, fp.release?.source, video.codec, video.dolbyVision ? "Dolby Vision" : video.hdr10 ? "HDR10" : video.dynamicRange, languages, formatSize(storage.size), storage.provider || version.provider].filter(Boolean).join(" · ")}</p><p className="mt-1 text-xs">{reasons(version)}</p></div>;
}

const resolutionRank = (resolution: unknown) => ({"2160p": 2160, "1080p": 1080, "720p": 720, "576p": 576, "480p": 480}[String(resolution || "").toLowerCase()] || Number.parseInt(String(resolution || ""), 10) || 0);
const comparisonReasons = (candidate: any, kept: any) => {
  if (!kept) return ["No retained replacement is available in this snapshot."];
  const candidateFp = candidate.fingerprint || {}, keptFp = kept.fingerprint || {};
  const candidateVideo = candidateFp.video || {}, keptVideo = keptFp.video || {};
  const candidateStorage = candidateFp.storage || {}, keptStorage = keptFp.storage || {};
  const reasons: string[] = [];
  const candidateResolution = candidateVideo.resolution, keptResolution = keptVideo.resolution;
  if (candidateResolution && keptResolution && candidateResolution !== keptResolution) {
    reasons.push(resolutionRank(keptResolution) > resolutionRank(candidateResolution) ? `Resolution: ${keptResolution} retained over ${candidateResolution}.` : `Resolution: ${keptResolution} preferred by the active policy over ${candidateResolution}.`);
  }
  if (candidateStorage.size && keptStorage.size && Number(candidateStorage.size) !== Number(keptStorage.size) && candidateResolution === keptResolution) {
    reasons.push(Number(keptStorage.size) > Number(candidateStorage.size) ? `File size: ${formatSize(keptStorage.size)} retained over ${formatSize(candidateStorage.size)} at the same resolution.` : `File size: ${formatSize(keptStorage.size)} selected by the active policy over ${formatSize(candidateStorage.size)} at the same resolution.`);
  }
  const candidateLanguages = new Set((candidateFp.audio || []).map((audio: any) => audio.language).filter(Boolean));
  const keptLanguages = new Set((keptFp.audio || []).map((audio: any) => audio.language).filter(Boolean));
  const missingLanguages = [...keptLanguages].filter((language) => !candidateLanguages.has(language));
  if (missingLanguages.length) reasons.push(`Preferred audio language present in retained copy: ${missingLanguages.join(", ")}.`);
  if (!reasons.length) reasons.push("The retained copy ranks higher under the active retention policy.");
  return reasons;
};

export function DeleteImpactCards({ items, scope, dryRun, busyId, selectedIds, onToggleSelected, onDetails, onDelete }: { items: any[]; scope: string; dryRun: boolean; busyId?: string; selectedIds?: Set<string>; onToggleSelected?: (item: any, selected: boolean) => void; onDetails: (item: any) => void; onDelete: (item: any) => void }) {
  const logicalGroups = new Map<string, { title: string; items: any[] }>();
  for (const item of items) {
    const anchor = item.versions.find((version: any) => version.decision === "DELETE_CANDIDATE") || item.versions[0];
    const groupId = anchor?.groupId || `${item.provider}:${item.providerItemId}`;
    const key = `${item.provider}:${groupId}`;
    const group: { title: string; items: any[] } = logicalGroups.get(key) || { title: anchor?.title || "Unresolved content", items: [] };
    group.items.push(item);
    logicalGroups.set(key, group);
  }
  const groupedItems = [...logicalGroups.values()].sort((a, b) => a.title.localeCompare(b.title));
  return <section className="space-y-3" aria-label={scope === "protected" ? "Protected resources" : "Deletion candidates"}>
    <div><h2 className="font-semibold">{scope === "protected" ? "Protected / Not deletable" : scope === "attention" ? "Needs review" : "Deletion candidates"} · {items.length} physical resources · {groupedItems.length} logical contents</h2><p className="text-sm text-muted-foreground">{scope === "protected" ? "These resources contain a logical candidate, but physical deletion is blocked by a KEEP/shared item, missing replacement, review, or recoverability requirement." : scope === "attention" ? "These resources have no actionable removal candidate. Resolve the review, identity, replacement, or recoverability blocker before reassessing them." : dryRun ? "Each physical resource has a confirmed KEEP replacement. Validate dry run repeats all checks against the provider without deleting anything." : "Each physical resource has a confirmed KEEP replacement. You can validate safely or delete it after an explicit confirmation; every action repeats all checks first."}</p></div>
    {!items.length && <p className="rounded border p-4 text-sm">No resources match this view.</p>}
    {groupedItems.map(group => {
      const retained: any[] = group.items.flatMap((item: any) => [...item.versions, ...(item.alternativeVersions || [])]).filter((v: any) => v.decision === "KEEP" || v.isRetained || v.retained === true).slice(0, 1);
      return <Card key={`${group.title}:${group.items.map((item: any) => item.providerItemId).join(",")}`} data-testid="delete-logical-group"><CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{group.title}</h3><span className="rounded border px-2 py-1 text-xs">{group.items.length} physical resource{group.items.length === 1 ? "" : "s"} · one logical content</span></div>
        <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-[980px] text-left text-sm"><thead className="border-b bg-muted/20"><tr><th className="p-3 font-semibold">Kept</th><th className="p-3 font-semibold">Excluded / deletion candidates</th><th className="p-3 font-semibold">Reason</th><th className="p-3 font-semibold">Action</th></tr></thead><tbody>
          {group.items.map((item: any, itemIndex: number) => {
            const candidates = item.versions.filter((v: any) => v.decision === "DELETE_CANDIDATE");
            const reviews = item.versions.filter((v: any) => v.decision === "REVIEW");
            const selectionKey = `${item.provider}:${item.providerItemId}`;
            const keptForItem = item.versions.filter((v: any) => v.decision === "KEEP");
            const primaryKept = keptForItem[0] || retained[0];
            const decisionText = candidates.length ? "DELETE CANDIDATE" : reviews.length ? "REVIEW" : primaryKept ? "KEEP" : "RETAINED";
            const reasonText = candidates.length ? (candidates.flatMap((v: any) => v.reasons || []).join(" · ") || item.reasons.join(" · ")) : item.reasons.join(" · ") || "Retained by the active policy";
            return <tr key={selectionKey} data-testid="delete-resource" className="border-b align-top last:border-0">
              {itemIndex === 0 && <td rowSpan={group.items.length} className="p-3 align-top">{primaryKept ? <><span className="mb-2 inline-block rounded border border-emerald-500/30 px-2 py-1 text-xs font-semibold">KEEP · one retained copy</span><VersionLine version={primaryKept} /></> : <span className="text-muted-foreground">No retained winner</span>}</td>}
              <td className="p-3">{candidates.length ? <div className="space-y-3">{candidates.map((candidate: any) => <div key={candidate.id} className="rounded border border-amber-500/30 p-3"><VersionLine version={candidate} /><ul className="mt-2 space-y-1 text-xs font-medium text-amber-700 dark:text-amber-300">{comparisonReasons(candidate, primaryKept).map((reason: string) => <li key={reason}>• {reason}</li>)}</ul></div>)}</div> : <span className="text-muted-foreground">No deletion candidate</span>}</td>
              <td className="p-3"><span className="mb-2 inline-block rounded border px-2 py-1 text-xs">{decisionText}</span><p className="text-muted-foreground">{reasonText}</p><p className="mt-2 text-xs text-muted-foreground">ProviderItem {item.providerItemId} · {item.provider}</p></td>
              <td className="p-3"><div className="flex min-w-[150px] flex-col gap-2">{scope === "candidates" && <input type="checkbox" aria-label={`Select ${group.title} ${item.providerItemId}`} checked={selectedIds?.has(selectionKey) || false} disabled={Boolean(busyId)} onChange={(event) => onToggleSelected?.(item, event.target.checked)} className="h-4 w-4" />}<Button size="sm" variant="outline" onClick={() => onDetails(item)}>Details</Button>{scope === "candidates" && <Button size="sm" variant={dryRun ? "secondary" : "destructive"} disabled={Boolean(busyId)} onClick={() => onDelete(item)}>{busyId === selectionKey ? dryRun ? "Validating…" : "Deleting…" : dryRun ? "Delete · dry run" : "Delete ProviderItem"}</Button>}<p className="text-xs text-muted-foreground">{item.state === "READY" && !item.onlyCopy && !item.protectedByKeep ? dryRun ? "Eligible; dry run only" : "Eligible after revalidation" : "Blocked"}</p></div></td>
            </tr>;
          })}
        </tbody></table></div>
      </CardContent></Card>;
    })}
  </section>;
}
