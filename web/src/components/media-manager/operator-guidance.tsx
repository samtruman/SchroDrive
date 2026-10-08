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
function formatBytes(value: unknown): string | undefined {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
export type PhysicalRef = { provider: string; providerItemId: string; physicalSize?: number };

function physicalRef(version: any): PhysicalRef {
  const storage = version.fingerprint?.storage || {};
  return {
    provider: String(version.providerItem?.provider || version.provider || storage.provider || ""),
    providerItemId: String(version.providerItem?.providerItemId || storage.torrentId || ""),
    physicalSize: Number(version.providerItem?.physicalSize || storage.size || 0),
  };
}

function selectionKey(ref: PhysicalRef): string {
  return `${ref.provider}:${ref.providerItemId}`;
}

type PhysicalRelease = { key: string; ref: PhysicalRef; versions: any[] };

export function groupVersionsByPhysicalItem(versions: any[]): PhysicalRelease[] {
  const releases = new Map<string, PhysicalRelease>();
  for (const version of versions) {
    const ref = physicalRef(version);
    const key = ref.provider && ref.providerItemId ? selectionKey(ref) : `unavailable:${version.id || releases.size}`;
    const release = releases.get(key) || { key, ref, versions: [] };
    if (!release.versions.some((candidate: any) => candidate.id === version.id)) release.versions.push(version);
    releases.set(key, release);
  }
  return [...releases.values()];
}

export function partitionPhysicalReleases(versions: any[]): { candidateReleases: PhysicalRelease[]; retainedReleases: PhysicalRelease[] } {
  const candidateReleases: PhysicalRelease[] = [];
  const retainedReleases: PhysicalRelease[] = [];
  for (const release of groupVersionsByPhysicalItem(versions)) {
    if (release.versions.some((version: any) => version.decision === "DELETE_CANDIDATE")) candidateReleases.push(release);
    else retainedReleases.push(release);
  }
  return { candidateReleases, retainedReleases };
}

function VersionRow({ version }: { version: any }) {
  const fp = version.fingerprint || {}, video = fp.video || {}, storage = fp.storage || {}, identity = version.identity || fp.identity || {};
  const languages = [...new Set((fp.audio || []).map((audio: any) => audio.language).filter(Boolean))].join("/");
  const name = (storage.path || version.files?.[0]?.path || "Filename unavailable").split(/[\\/]/).pop();
  const size = formatBytes(storage.size || version.files?.[0]?.size);
  const season = identity.season ?? version.season;
  const episode = identity.episode ?? version.episode;
  const episodeLabel = season !== undefined && episode !== undefined ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}` : undefined;
  return <div className="px-3 py-2">
    <p className="break-words">{episodeLabel ? `${episodeLabel} · ` : ""}{name}</p>
    <p className="text-xs text-muted-foreground">{[video.resolution, fp.release?.source, video.codec, video.dolbyVision ? "Dolby Vision" : video.hdr10 ? "HDR10" : video.dynamicRange, languages, size].filter(Boolean).join(" · ")}</p>
    <p className="mt-1 text-xs">{reasons(version)}</p>
  </div>;
}

function PhysicalReleaseCard({ release, selected, selectable, disabled, onToggle }: { release: PhysicalRelease; selected: boolean; selectable: boolean; disabled: boolean; onToggle: (selected: boolean) => void }) {
  const episodeCount = new Set(release.versions.map((version: any) => {
    const identity = version.identity || version.fingerprint?.identity || {};
    return `${identity.season ?? version.season ?? ""}:${identity.episode ?? version.episode ?? ""}`;
  })).size;
  const orderedVersions = [...release.versions].sort((left: any, right: any) => {
    const leftIdentity = left.identity || left.fingerprint?.identity || {};
    const rightIdentity = right.identity || right.fingerprint?.identity || {};
    return Number(leftIdentity.season ?? left.season ?? 0) - Number(rightIdentity.season ?? right.season ?? 0)
      || Number(leftIdentity.episode ?? left.episode ?? 0) - Number(rightIdentity.episode ?? right.episode ?? 0);
  });
  const canSelect = selectable && Boolean(release.ref.provider && release.ref.providerItemId);
  const impact = release.versions.find((version: any) => version.providerItem?.state)?.providerItem;
  const physicallyBlocked = Boolean(impact && impact.state !== "READY");
  const canSelectRelease = canSelect && !physicallyBlocked;
  const decisions = new Set(release.versions.map((version: any) => version.decision).filter(Boolean));
  const releaseRole = decisions.has("REVIEW") ? "Needs review" : decisions.has("KEEP") && decisions.has("DELETE_CANDIDATE") ? "Protected mixed release" : decisions.has("DELETE_CANDIDATE") ? "Deletion candidate" : decisions.has("KEEP") ? "Policy retained" : "Unclassified release";
  return <div className={`overflow-hidden rounded border ${selected ? "border-destructive/60 bg-destructive/5" : decisions.has("DELETE_CANDIDATE") ? "border-amber-500/40" : decisions.has("KEEP") ? "border-emerald-500/40" : "border-border/70"}`}>
    <label className={`flex items-start gap-3 p-3 ${canSelectRelease ? "cursor-pointer" : ""}`}>
      {selectable && <input type="checkbox" checked={selected} disabled={disabled || !canSelectRelease} onChange={(event) => onToggle(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{episodeCount > 1 ? `Season pack · ${episodeCount} linked episodes` : "Single media release"}</p><span className="rounded border px-2 py-0.5 text-xs">{releaseRole}</span></div>
        <p className="text-xs text-muted-foreground">{release.ref.provider || "Provider unavailable"} · ProviderItem {release.ref.providerItemId || "unavailable"}{selected ? " · selected for deletion" : ""}</p>
      </div>
    </label>
    {physicallyBlocked && <p className="border-t px-3 py-2 text-xs text-amber-700">Visible policy candidate, but physical deletion is blocked: {(impact.reasons || []).join(" · ")}</p>}
    <div className="divide-y border-t">{orderedVersions.map((version: any, index: number) => <VersionRow key={version.id || index} version={version} />)}</div>
  </div>;
}

function groupDeleteItems(items: any[]) {
  const groups = new Map<string, { key: string; title: string; season?: string | number; tmdbId?: string; items: any[]; episodes: Map<string, { key: string; season?: string | number; episode?: string | number; versions: any[] }> }>();
  for (const item of items) {
    const contentVersions = [
      ...(item.versions || []).map((version: any) => ({ ...version, providerItem: item })),
      ...(item.alternativeVersions || []).map((version: any) => ({ ...version, providerItem: { provider: version.provider || version.fingerprint?.storage?.provider, providerItemId: version.providerItemId, physicalSize: version.fingerprint?.storage?.size } })),
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

function uniqueRefs(versions: any[]): PhysicalRef[] {
  const refs = new Map<string, PhysicalRef>();
  for (const version of versions) {
    const ref = physicalRef(version);
    if (ref.provider && ref.providerItemId) refs.set(selectionKey(ref), ref);
  }
  return [...refs.values()];
}

export function recommendedDeleteRefs(items: any[]): PhysicalRef[] {
  return uniqueRefs(
    groupDeleteItems(items)
      .flatMap((group) => group.episodes)
      .flatMap((episode) => episode.versions)
      .filter((version: any) => version.decision === "DELETE_CANDIDATE"),
  );
}

export function DeleteImpactCards({ items, scope, busyId, selectedIds, onChangeSelection }: { items: any[]; scope: string; busyId?: string; selectedIds?: Set<string>; onChangeSelection: (add: PhysicalRef[], removeKeys: string[]) => void }) {
  const groups = groupDeleteItems(items);
  const selectable = scope === "candidates";
  return <section className="space-y-3" aria-label={scope === "protected" ? "Protected resources" : scope === "attention" ? "Resources needing attention" : "Deletion candidates"}>
    <div><h2 className="font-semibold">{scope === "protected" ? "Protected / Not deletable" : scope === "attention" ? "Needs review" : "Deletion candidates"}</h2><p className="text-sm text-muted-foreground">{scope === "protected" ? "These resources contain a logical candidate, but physical deletion is blocked by a KEEP/shared item, missing replacement, review, or recoverability requirement." : scope === "attention" ? "These resources have no actionable removal candidate. Resolve the review, identity, replacement, or recoverability blocker before reassessing them." : "Select complete physical releases. A season pack is one box and one selection containing all linked episodes; independently stored episodes remain separate boxes."}</p></div>
    {!items.length && <p className="rounded border p-4 text-sm">No resources match this view.</p>}
    {groups.map((group) => {
      const allVersions = group.episodes.flatMap((episode) => episode.versions);
      const allRefs = uniqueRefs(allVersions);
      const candidateRefs = uniqueRefs(allVersions.filter((version: any) => version.decision === "DELETE_CANDIDATE"));
      const candidateKeys = new Set(candidateRefs.map(selectionKey));
      const groupKeys = allRefs.map(selectionKey);
      const { candidateReleases, retainedReleases } = partitionPhysicalReleases(allVersions);
      const renderRelease = (release: PhysicalRelease) => {
        const checked = selectedIds?.has(release.key) || false;
        const toggleRelease = (nextChecked: boolean) => {
          if (!nextChecked) return onChangeSelection([], [release.key]);
          const affectedEpisodes = group.episodes.filter((episode) => episode.versions.some((version: any) => selectionKey(physicalRef(version)) === release.key));
          const conflicts = uniqueRefs(affectedEpisodes.flatMap((episode) => episode.versions)).map(selectionKey).filter((key) => key !== release.key);
          onChangeSelection([release.ref], conflicts);
        };
        return <PhysicalReleaseCard key={release.key} release={release} selected={checked} selectable={selectable} disabled={Boolean(busyId)} onToggle={toggleRelease} />;
      };
      return <Card key={group.key} className="border-primary/30"><CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{group.title}{group.season !== undefined ? ` · Season ${group.season}` : " · Film"}</h3><p className="text-xs text-muted-foreground">{group.tmdbId ? `TMDB ${group.tmdbId}` : "Canonical identity unavailable"} · {group.episodes.length} content unit{group.episodes.length === 1 ? "" : "s"} · {allRefs.length} physical ProviderItem{allRefs.length === 1 ? "" : "s"}</p></div>{selectable && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={Boolean(busyId) || candidateRefs.length === 0} onClick={() => onChangeSelection(candidateRefs, groupKeys.filter((key) => !candidateKeys.has(key)))}>Select recommended removals</Button><Button size="sm" variant="ghost" disabled={Boolean(busyId) || !groupKeys.some((key) => selectedIds?.has(key))} onClick={() => onChangeSelection([], groupKeys)}>Clear season</Button></div>}</div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <section className="space-y-3" aria-label="Recommended physical releases to delete">
            <div><h4 className="text-sm font-semibold">Recommended for deletion</h4><p className="text-xs text-muted-foreground">Complete physical releases selected by policy. One season pack remains one physical selection.</p></div>
            {candidateReleases.length ? candidateReleases.map(renderRelease) : <p className="rounded border p-3 text-sm text-muted-foreground">No policy deletion candidate in this title or season.</p>}
          </section>
          <section className="space-y-3" aria-label="Retained alternative physical releases">
            <div><h4 className="text-sm font-semibold">Retained alternatives</h4><p className="text-xs text-muted-foreground">Versions kept by policy. Select one only when you intentionally want to keep the alternative shown on the left instead.</p></div>
            {retainedReleases.length ? retainedReleases.map(renderRelease) : <p className="rounded border p-3 text-sm text-muted-foreground">No retained alternative is available.</p>}
          </section>
        </div>
      </CardContent></Card>;
    })}
  </section>;
}
