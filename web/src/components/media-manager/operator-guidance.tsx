"use client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function ReviewActionGuide() {
  return <section aria-label="Review actions explained" className="rounded-lg border bg-muted/20 p-4 text-sm">
    <h2 className="mb-2 font-semibold">What can I do here?</h2>
    <dl className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <div><dt className="font-medium">Resolve Identity</dt><dd className="text-muted-foreground">Search TMDb and confirm the correct film or series when detection is wrong or uncertain.</dd></div>
      <div><dt className="font-medium">Accept as detected</dt><dd className="text-muted-foreground">Approve the displayed identity without correcting it. Use only when it is correct; the organizer may then continue processing it.</dd></div>
      <div><dt className="font-medium">Dismiss</dt><dd className="text-muted-foreground">Remove the organizer task from Pending without deleting media. Find it under Dismissed and restore it later.</dd></div>
      <div><dt className="font-medium">Retry / Resume</dt><dd className="text-muted-foreground">Return the task to the organizer workflow after fixing its cause. This does not select a different identity.</dd></div>
      <div><dt className="font-medium">Details</dt><dd className="text-muted-foreground">Open identity, filenames, versions and reasons in a dialog. Viewing details changes nothing.</dd></div>
    </dl>
    <p className="mt-3 text-muted-foreground">Policy and recoverability issues are evaluated from inventory. They cannot be dismissed as organizer tasks; fix the stated cause and scan again.</p>
  </section>;
}

const reasons = (version: any) => [...new Set((version.reasons || []).map((r: any) => typeof r === "string" ? r : r.message).filter(Boolean))].join(" · ");
const sameLogicalContent = (left: any, right: any) => {
  if (!left || !right) return false;
  if (left.groupId && right.groupId) return left.groupId === right.groupId;
  if (left.logicalKey && right.logicalKey) return left.logicalKey === right.logicalKey;
  return (left.title || "") === (right.title || "") && (left.season ?? "") === (right.season ?? "") && (left.episode ?? "") === (right.episode ?? "");
};
function formatBytes(value: unknown): string | undefined {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function VersionLine({ version }: { version: any }) {
  const fp = version.fingerprint || {}, video = fp.video || {}, storage = fp.storage || {};
  const languages = [...new Set((fp.audio || []).map((audio: any) => audio.language).filter(Boolean))].join("/");
  const name = (storage.path || version.files?.[0]?.path || "Filename unavailable").split(/[\\/]/).pop();
  const size = formatBytes(storage.size || version.files?.[0]?.size);
  return <div className="min-w-0"><p className="break-words">{version.season !== undefined ? `S${String(version.season).padStart(2,"0")}E${String(version.episode ?? 0).padStart(2,"0")} · ` : ""}{name}</p><p className="text-xs text-muted-foreground">{[video.resolution, fp.release?.source, video.codec, video.dolbyVision ? "Dolby Vision" : video.hdr10 ? "HDR10" : video.dynamicRange, languages, size, storage.provider || version.provider].filter(Boolean).join(" · ")}</p><p className="mt-1 text-xs">{reasons(version)}</p></div>;
}

function groupDeleteItems(items: any[]) {
  const groups = new Map<string, { key: string; title: string; season?: string | number; tmdbId?: string; items: any[]; episodes: Map<string, { key: string; season?: string | number; episode?: string | number; versions: any[] }> }>();
  for (const item of items) {
    const contentVersions = [
      ...(item.versions || []).map((version: any) => ({ ...version, providerItem: item })),
      ...(item.alternativeVersions || []).map((version: any) => ({ ...version, providerItem: { provider: item.provider, providerItemId: version.providerItemId } })),
    ];
    for (const version of contentVersions) {
      const identity = version.identity || version.fingerprint?.identity || {};
      const logicalKey = String(version.logicalKey || "");
      const parts = logicalKey.split(":");
      const key = identity.tmdbId
        ? `tmdb:${identity.kind || "unknown"}:${identity.tmdbId}:${identity.kind === "episode" ? `season:${identity.season ?? ""}` : "title"}`
        : logicalKey.startsWith("episode:") ? parts.slice(0, 4).join(":") : logicalKey || `${String(version.title || "unresolved").toLowerCase()}:${version.season ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, title: identity.title || version.title || "Unresolved content", season: identity.season ?? version.season, tmdbId: identity.tmdbId, items: [], episodes: new Map() };
        groups.set(key, group);
      }
      if (!group.items.includes(item)) group.items.push(item);
      const episodeKey = identity.kind === "episode" || version.season !== undefined
        ? `S${String(identity.season ?? version.season ?? "").padStart(2, "0")}E${String(identity.episode ?? version.episode ?? "").padStart(2, "0")}`
        : "film";
      const episode: { key: string; season?: string | number; episode?: string | number; versions: any[] } = group.episodes.get(episodeKey) || { key: episodeKey, season: identity.season ?? version.season, episode: identity.episode ?? version.episode, versions: [] };
      if (!episode.versions.some((candidate: any) => candidate.id === version.id && candidate.providerItem?.providerItemId === version.providerItem?.providerItemId)) episode.versions.push(version);
      group.episodes.set(episodeKey, episode);
    }
  }
  return [...groups.values()].map((group) => ({ ...group, episodes: [...group.episodes.values()] }));
}

function episodeLabel(item: any): string {
  const labels = [...new Set((item.versions || []).filter((version: any) => version.season !== undefined).map((version: any) => `S${String(version.season).padStart(2, "0")}E${String(version.episode ?? "").padStart(2, "0")}`))];
  return labels.length ? labels.join(", ") : "Film";
}

export function DeleteImpactCards({ items, scope, dryRun, busyId, selectedIds, onToggleSelected, onDetails, onDelete }: { items: any[]; scope: string; dryRun: boolean; busyId?: string; selectedIds?: Set<string>; onToggleSelected?: (item: any, selected: boolean) => void; onDetails: (item: any) => void; onDelete: (item: any) => void }) {
  const groups = groupDeleteItems(items);
  return <section className="space-y-3" aria-label={scope === "protected" ? "Protected resources" : scope === "attention" ? "Resources needing attention" : "Deletion candidates"}>
    <div><h2 className="font-semibold">{scope === "protected" ? "Protected / Not deletable" : scope === "attention" ? "Needs review" : "Deletion candidates"} · {items.length} physical resources</h2><p className="text-sm text-muted-foreground">{scope === "protected" ? "These resources contain a logical candidate, but physical deletion is blocked by a KEEP/shared item, missing replacement, review, or recoverability requirement." : scope === "attention" ? "These resources have no actionable removal candidate. Resolve the review, identity, replacement, or recoverability blocker before reassessing them." : "Content is grouped by canonical identity first. Physical ProviderItems and their actions remain separate inside each film or series season."}</p></div>
    {!items.length && <p className="rounded border p-4 text-sm">No resources match this view.</p>}
    {groups.map((group) => <Card key={group.key} className="border-primary/30"><CardContent className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{group.title}{group.season !== undefined ? ` · Season ${group.season}` : " · Film"}</h3><p className="text-xs text-muted-foreground">{group.tmdbId ? `TMDB ${group.tmdbId}` : "Canonical identity unavailable"} · {group.episodes.length} content unit{group.episodes.length === 1 ? "" : "s"} · {group.items.length} physical ProviderItem{group.items.length === 1 ? "" : "s"}</p></div></div>
      <div className="space-y-3">
        {group.episodes.map((episode) => {
          const candidates = episode.versions.filter((version: any) => version.decision === "DELETE_CANDIDATE");
          const kept = episode.versions.filter((version: any) => version.decision === "KEEP");
          const review = episode.versions.filter((version: any) => version.decision === "REVIEW");
          return <div key={episode.key} className="rounded border p-3"><p className="mb-2 font-medium">{episode.key === "film" ? "Film" : episode.key}</p><div className="grid gap-3 md:grid-cols-2">
            <div className="rounded border border-amber-500/30 p-3 text-sm"><p className="mb-1 font-semibold">Candidate versions</p>{candidates.length ? candidates.map((version: any) => <VersionLine key={`${version.id}:${version.providerItem?.providerItemId || ""}`} version={version} />) : <p className="text-muted-foreground">No deletion candidate.</p>}</div>
            <div className="rounded border border-emerald-500/30 p-3 text-sm"><p className="mb-1 font-semibold">Retained versions</p>{kept.length ? kept.map((version: any) => <VersionLine key={`${version.id}:${version.providerItem?.providerItemId || ""}`} version={version} />) : <p className="text-muted-foreground">{review.length ? "Review required before retention decision." : "No retained version."}</p>}</div>
          </div></div>;
        })}
      </div>
      <div className="space-y-2 rounded border bg-muted/10 p-3"><p className="font-medium">Physical ProviderItems</p>{group.items.map((item: any) => {
        const selectionKey = `${item.provider}:${item.providerItemId}`;
        const ready = item.state === "READY" && !item.onlyCopy && !item.protectedByKeep;
        return <div key={selectionKey} className="flex flex-wrap items-center justify-between gap-3 rounded border p-2"><div className="flex min-w-0 items-center gap-3">{scope === "candidates" && <input type="checkbox" aria-label={`Select ${episodeLabel(item)}`} checked={selectedIds?.has(selectionKey) || false} disabled={Boolean(busyId)} onChange={(event) => onToggleSelected?.(item, event.target.checked)} className="h-4 w-4" />}<div className="min-w-0"><p className="font-medium">{episodeLabel(item)}</p><p className="truncate text-xs text-muted-foreground">{item.provider} · ProviderItem {item.providerItemId} · {formatBytes(item.physicalSize) || "size unknown"}</p><p className="text-xs text-muted-foreground">{item.reasons.join(" · ")}</p></div></div><div className="flex flex-wrap gap-2"><span className="rounded border px-2 py-1 text-xs">{item.protectedByKeep ? "PROTECTED" : ready ? `ELIGIBLE · ${dryRun ? "DRY RUN" : "LIVE"}` : "NOT DELETABLE"}</span><Button size="sm" variant="outline" onClick={() => onDetails(item)}>Details</Button>{scope === "candidates" && <Button size="sm" variant="destructive" disabled={Boolean(busyId)} onClick={() => onDelete(item)}>{busyId === selectionKey ? "Deleting…" : "Delete ProviderItem"}</Button>}</div></div>;
      })}</div>
    </CardContent></Card>)}
  </section>;
}
