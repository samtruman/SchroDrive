"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FileUp,
  Layers3,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { normalizeIdentitySearchPrefill } from "./identity-search-prefill";
import { DeleteImpactCards, ReviewActionGuide, recommendedDeleteRefs } from "./operator-guidance";
import { ConfirmationDialog } from "./confirmation-dialog";
import { groupLibraryPhysicalReleases, libraryGroupProfileIds, matchesLibraryFilter, matchesMissingNeed, missingNeedVersions, missingProfileNeeds, physicalReleaseEpisodeCount, sortMissingNeeds, type LibraryPhysicalRelease } from "./library-filters";

type View = "overview" | "library" | "migration" | "settings";
type Profile = { id: string; name: string; enabled: boolean; priority?: number; description?: string; preferredResolution?: string; languagePolicy?: any; hardRequirements?: any; scoring?: Record<string, number>; scoringRules?: ScoringRule[]; sizePreference?: "LARGER" | "SMALLER" | "IGNORE"; minimumSizeDifferencePercent?: number; releaseGroupConsistency?: "DISABLED" | "SEASON"; acquisitionBehavior?: string; target?: string; arrProfiles?: { movie?: { provider?: "radarr"; serverId: string; qualityProfileId: string; qualityProfileName?: string }; tv?: { provider?: "sonarr"; serverId: string; qualityProfileId: string; qualityProfileName?: string } } };
type ScoringRule = { op?: "COMPARE" | "IN" | "HAS"; field: string; operator?: string; value?: unknown; values?: unknown[]; weight: number };
type PendingConfirmation = { title: string; description: string; context?: ReactNode; confirmLabel: string; variant?: "default" | "secondary" | "outline" | "destructive"; onConfirm: () => Promise<void> };
type SelectedDeleteItem = { provider: string; providerItemId: string; physicalSize?: number };

const tone: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  AVAILABLE: "default",
  REQUESTED: "secondary",
  PENDING: "secondary",
  PROCESSING: "secondary",
  NOT_REQUESTED: "outline",
  REJECTED_LEGAL: "destructive",
  CONFLICT: "destructive",
  REVIEW: "destructive",
  READY_TO_IMPORT: "default",
  IMPORTED: "default",
};
function StatusBadge({ value }: { value?: string }) {
  const text = value || "UNKNOWN";
  return (
    <Badge variant={tone[text] || "outline"}>{text.replaceAll("_", " ")}</Badge>
  );
}

function displayIdentity(item: any): any {
  const identity = item?.identity || item?.contentIdentity || {};
  const version = item?.versions?.[0] || item?.existingVersions?.[0] || item?.rejectedVersions?.[0];
  const fingerprint = version?.fingerprint || {};
  const storage = fingerprint.storage || {};
  const source = String(storage.path || version?.releaseName || version?.filename || "");
  const basename = source.split(/[\\/]/).pop() || source;
  const numericMovie = basename.match(/^(\d{1,4})[._ -]+((?:19|20|21)\d{2})(?:[._ -]|$)/);
  const identityLooksLikeRelease = /(?:proper|repack|bluray|web[-. ]?dl|webrip|hdtv|1080p|2160p|x26[45]|remux)/i.test(String(identity.title || ""));
  if (identity.kind === "movie" && numericMovie && identityLooksLikeRelease) {
    return { ...identity, title: numericMovie[1], year: Number(numericMovie[2]) };
  }
  return { ...identity, title: identity.title || item?.title || item?.versions?.[0]?.title || item?.alternativeVersions?.[0]?.title || "Unidentified content", year: identity.year, kind: identity.kind };
}

function ErrorBox({ error }: { error?: string }) {
  return error ? (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      {error}
    </div>
  ) : null;
}

function formatSize(value: unknown): string {
  const bytes = Number(value || 0);
  if (!bytes) return "size unknown";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function episodeLabel(identity: any): string {
  if (identity?.kind !== "episode" && identity?.season === undefined && identity?.episode === undefined) return "";
  const season = String(identity?.season ?? 0).padStart(2, "0");
  const episode = String(identity?.episode ?? 0).padStart(2, "0");
  return `S${season}E${episode}`;
}

function uniqueLanguages(items: any[]): string {
  return [...new Set((items || []).map((item: any) => item?.language).filter(Boolean))].join("/");
}

function failedRequirementText(version: any): string[] {
  return (version?.evaluations || []).flatMap((evaluation: any) =>
    (evaluation?.reasons || []).map((reason: any) => {
      const facts = reason?.facts || {};
      const required = facts.required?.values?.join("/") || facts.required || "";
      const availableAudio = Array.isArray(facts.availableAudio) ? facts.availableAudio.join("/") : "";
      const availableSubtitles = Array.isArray(facts.availableSubtitles) ? facts.availableSubtitles.join("/") : "";
      const comparison = [
        required ? `required: ${required}` : "",
        availableAudio ? `audio found: ${availableAudio}` : "",
        availableSubtitles ? `subtitles found: ${availableSubtitles}` : "",
      ].filter(Boolean).join(" · ");
      return `${reason?.message || reason?.code || "Requirement failed"}${comparison ? ` — ${comparison}` : ""}`;
    }),
  );
}

async function readJsonResponse<T>(response: Response, operation: string): Promise<T> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${operation} failed (HTTP ${response.status}; server returned ${contentType || "non-JSON"})`);
  }
  if (!response.ok || body?.ok === false) {
    const error = new Error(body?.error || `${operation} failed (HTTP ${response.status})`);
    (error as any).payload = body;
    throw error;
  }
  return body as T;
}

async function refreshVersionManagerInventory(providerId: string): Promise<void> {
  const providerQuery = `provider=${encodeURIComponent(providerId)}`;
  const started = await readJsonResponse<any>(
    await fetch(`/api/version-manager/scan?${providerQuery}`, { method: "POST", cache: "no-store" }),
    "Starting inventory refresh",
  );
  const jobId = String(started.job?.id || "");
  if (!jobId) throw new Error("Inventory refresh did not return a scan job");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    const status = await readJsonResponse<any>(
      await fetch(`/api/version-manager/scan/${encodeURIComponent(jobId)}`, { cache: "no-store" }),
      "Refreshing inventory",
    );
    if (status.job?.status === "COMPLETED") return;
    if (status.job?.status === "FAILED" || status.job?.status === "PARTIAL") {
      throw new Error(status.job?.error || `Inventory refresh ended with ${status.job.status}`);
    }
  }
  throw new Error("Inventory refresh is still running; reload the Library when it completes");
}

function IdentityResolver({
  reviewId,
  versionGroupId,
  versionIds,
  providerId,
  identity,
  initialQuery,
  initialType,
  initialYear,
  existingOverride,
  onSaved,
  actionLabel,
}: {
  reviewId?: string;
  versionGroupId?: string;
  versionIds?: string[];
  providerId?: string;
  identity?: Record<string, unknown>;
  initialQuery?: string;
  initialType?: "movie" | "tv";
  initialYear?: number;
  existingOverride?: Record<string, unknown>;
  onSaved?: () => void;
  actionLabel?: string;
}) {
  const prefill = normalizeIdentitySearchPrefill(initialQuery, initialYear);
  const [query, setQuery] = useState(prefill.query);
  const [type, setType] = useState<"movie" | "tv">(initialType || "movie");
  const [year, setYear] = useState(prefill.year ? String(prefill.year) : "");
  const [results, setResults] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(Boolean(existingOverride));
  const [confirmMatchOpen, setConfirmMatchOpen] = useState(false);
  const [clearMatchOpen, setClearMatchOpen] = useState(false);

  async function search() {
    if (!query.trim()) return;
    setBusy(true); setMessage("");
    try {
      const params = new URLSearchParams({ query: query.trim(), type });
      if (year.trim()) params.set("year", year.trim());
      const response = await fetch(`/api/version-manager/identity/search?${params}`, { cache: "no-store" });
      const body = await readJsonResponse<any>(response, "TMDb search");
      setResults(body.results || []);
    } catch (error: any) { setMessage(error.message || "TMDb search failed"); }
    finally { setBusy(false); }
  }

  async function saveMatch() {
    if (!selected || (!reviewId && !identity)) return;
    setBusy(true); setMessage("");
    try {
      const override = {
        title: selected.title, originalTitle: selected.originalTitle, year: selected.year,
        kind: selected.mediaType === "movie" ? "movie" : "episode", tmdbId: selected.tmdbId,
        imdbId: selected.imdbId, tvdbId: selected.tvdbId, originalLanguage: selected.originalLanguage,
      };
      const response = await fetch(reviewId ? `/api/organizer/review/${encodeURIComponent(reviewId)}` : "/api/version-manager/identity/override", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(reviewId ? { decision: "accepted", override } : { provider: providerId, identity, versionGroupId, versionIds, override }),
      });
      const body = await readJsonResponse<any>(response, "Saving identity match");
      let evaluation = body;
      if (reviewId && identity) {
        const reevaluate = await fetch("/api/version-manager/identity/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: providerId, identity, override }) });
        evaluation = await readJsonResponse<any>(reevaluate, "Re-evaluating identity");
      }
      setMessage(evaluation.reevaluated ? "Manual match saved and policy reevaluated." : "Manual match saved; it will be applied on the next cached evaluation.");
      onSaved?.();
    } catch (error: any) { setMessage(error.message || "Unable to save identity match"); }
    finally { setBusy(false); }
  }

  async function clearMatch() {
    if (!reviewId && !identity) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(reviewId ? `/api/organizer/review/${encodeURIComponent(reviewId)}` : "/api/version-manager/identity/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reviewId ? { action: "clear-match" } : { provider: providerId, action: "clear", identity, versionGroupId, versionIds }) });
      const body = await readJsonResponse<any>(response, "Clearing manual identity");
      let evaluation = body;
      if (reviewId && identity) {
        const reevaluate = await fetch("/api/version-manager/identity/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: providerId, action: "clear", identity }) });
        evaluation = await readJsonResponse<any>(reevaluate, "Re-evaluating identity");
      }
      setMessage(evaluation.reevaluated ? "Manual match cleared and policy reevaluated." : "Manual match cleared; automatic resolver will be used on the next evaluation.");
      onSaved?.();
    } catch (error: any) { setMessage(error.message || "Unable to clear manual match"); }
    finally { setBusy(false); }
  }

  return <div className="space-y-3">
    {!open ? <Button size="sm" onClick={() => setOpen(true)}>{actionLabel || (existingOverride ? "Change Match" : "Resolve Identity")}</Button> : <div className="space-y-3 rounded border p-3">
      <p className="text-sm font-medium">{actionLabel || (existingOverride ? "Change Match" : "Resolve Identity")}</p>
    <div className="flex flex-wrap items-center gap-2">
      <Input className="min-w-48 flex-1" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search TMDb title…" />
      <select className="rounded border bg-background p-2 text-sm" value={type} onChange={(event) => setType(event.target.value as "movie" | "tv")}>
        <option value="movie">Movie</option><option value="tv">TV</option>
      </select>
      <Input className="w-24" value={year} onChange={(event) => setYear(event.target.value)} placeholder="Year" inputMode="numeric" />
      <Button size="sm" variant="outline" onClick={() => void search()} disabled={busy || !query.trim()}><Search className="mr-2 h-4 w-4" />Search</Button>
    </div>
    {message && <p className="text-sm text-muted-foreground">{message}</p>}
    {results.length > 0 && <div className="space-y-2">
      {results.map((candidate) => <button type="button" key={`${candidate.mediaType}:${candidate.tmdbId}`} onClick={() => setSelected(candidate)} className={`block w-full rounded border p-3 text-left text-sm ${selected?.tmdbId === candidate.tmdbId ? "border-primary bg-primary/5" : "hover:border-primary/50"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><strong>{candidate.title}</strong><Badge variant="outline">TMDb {candidate.tmdbId}</Badge></div>
        <p className="text-muted-foreground">{candidate.originalTitle || "Original title unavailable"} · {candidate.mediaType.toUpperCase()} · {candidate.releaseDate || "Date unknown"} · {candidate.originalLanguage || "language unknown"}</p>
        <p className="text-xs text-muted-foreground">IMDb: {candidate.imdbId || "—"} · TVDb: {candidate.tvdbId || "—"}</p>
        {candidate.overview && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{candidate.overview}</p>}
      </button>)}
      <Button size="sm" onClick={() => setConfirmMatchOpen(true)} disabled={busy || !selected || (!reviewId && !identity)}>Confirm manual match</Button>
      {existingOverride && <Button size="sm" variant="destructive" onClick={() => setClearMatchOpen(true)} disabled={busy}>Clear manual match</Button>}
    </div>}
    </div>}
    <ConfirmationDialog
      open={confirmMatchOpen}
      onOpenChange={setConfirmMatchOpen}
      title="Confirm manual identity?"
      description="This identity will override automatic matching until the manual match is cleared."
      context={selected && <div className="space-y-1"><p><b>Title:</b> {selected.title || "—"}</p><p><b>Year:</b> {selected.year || "—"}</p><p><b>Type:</b> {selected.mediaType === "tv" ? "TV" : "Movie"}</p><p><b>TMDb ID:</b> {selected.tmdbId || "—"}</p></div>}
      confirmLabel="Confirm match"
      onConfirm={saveMatch}
    />
    <ConfirmationDialog
      open={clearMatchOpen}
      onOpenChange={setClearMatchOpen}
      title="Clear manual identity?"
      description="Automatic identity resolution will be restored and policy will be re-evaluated."
      confirmLabel="Clear manual match"
      variant="destructive"
      onConfirm={clearMatch}
    />
  </div>;
}
function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="mt-2 text-2xl font-semibold">{value}</p>
        {detail && (
          <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        )}
      </CardContent>
    </Card>
  );
}
function useJson<T>(url: string, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(url, { cache: "no-store" });
      const body = await readJsonResponse<T>(response, "Media Manager request");
      setData(body);
    } catch (value: any) {
      setError(value.message || "Request failed");
    } finally {
      setLoading(false);
    }
  }, [enabled, url]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, loading, error, reload: load };
}

function useMediaManagerProvider() {
  const providerData = useJson<any>("/api/version-manager/providers");
  const [providerId, setProviderId] = useState("");
  useEffect(() => {
    const providers = providerData.data?.providers || [];
    if (!providers.length) return;
    const saved = window.localStorage.getItem("media-manager-provider");
    const next = providers.some((provider: any) => provider.id === saved)
      ? saved
      : (providers.find((provider: any) => provider.default)?.id || providers[0].id);
    setProviderId((current) => providers.some((provider: any) => provider.id === current) ? current : next);
  }, [providerData.data]);
  const selectProvider = useCallback((value: string) => {
    setProviderId(value);
    window.localStorage.setItem("media-manager-provider", value);
  }, []);
  return { providers: providerData.data?.providers || [], providerId, selectProvider, loading: providerData.loading, error: providerData.error };
}

function ProviderSelector({ providers, value, onChange }: { providers: any[]; value: string; onChange: (value: string) => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3"><div><p className="text-sm font-semibold">Managed library</p><p className="text-xs text-muted-foreground">Every view and action below is limited to this debrid service.</p></div><select aria-label="Managed library" className="min-w-48 rounded border bg-background p-2 text-sm" value={value} onChange={(event) => onChange(event.target.value)}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>)}</select></div>;
}

function SectionNav({ view, reviewCount }: { view: View; reviewCount?: number }) {
  const links = [
    ["Overview", "/media-manager"],
    ["Library", "/media-manager/library"],
    ["Backup & Migration", "/media-manager/migration/export"],
    ["Settings", "/media-manager/settings/profiles"],
  ] as const;
  return (
    <nav className="flex flex-wrap gap-2 border-b pb-3">
      {links.map(([label, href]) => (
        <Button
          key={href}
          asChild
          variant={
            (view === "overview" && label === "Overview") ||
            (view === "library" && label === "Library") ||
            (view === "migration" && label === "Backup & Migration") ||
            (view === "settings" && label === "Settings")
              ? "default"
              : "ghost"
          }
          size="sm"
        >
          <Link href={href}>
            {label}
            {label === "Library" && reviewCount !== undefined && reviewCount > 0 && (
              <Badge className="ml-2" variant="destructive">{reviewCount}</Badge>
            )}
          </Link>
        </Button>
      ))}
    </nav>
  );
}
function Header({
  view,
  title,
  description,
  reviewCount,
}: {
  view: View;
  title: string;
  description: string;
  reviewCount?: number;
}) {
  return (
    <>
      <SectionNav view={view} reviewCount={reviewCount} />
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </>
  );
}

function DetailPanel({ item, providerId, onClose, onReviewAction, onSaved }: { item: any; providerId?: string; onClose: () => void; onReviewAction?: (id: string, body: Record<string, unknown>, item?: any) => void; onSaved?: () => void }) {
  const review = item.review || (item.parsed ? item : undefined);
  const identity = item.identity || item.contentIdentity || (review ? { title: review.parsed?.title, year: review.parsed?.year, kind: review.parsed?.kind, confidence: review.parsed?.confidence, source: review.override ? "manual" : "unknown" } : item.versions?.[0]?.fingerprint?.identity || {});
  const shownIdentity = displayIdentity(item);
  const versions = Array.isArray(item.versions) && item.versions.length
    ? item.versions
    : Array.isArray(item.existingVersions) && item.existingVersions.length
      ? item.existingVersions
      : item.rejectedVersions || [];
  const reasonText = (value: any) => [...new Set((Array.isArray(value) ? value : []).map((reason: any) => typeof reason === "string" ? reason : reason?.message).filter(Boolean))].join(" · ");
  const reviewStatus = review?.parsed?.status;
  const identityAction = review?.override ? "Change Match" : reviewStatus === "ambiguous" || reviewStatus === "unmatched" || reviewStatus === "fallback" || reviewStatus === "conflict" ? "Resolve Identity" : "Change Match";
  const leafName = (value: unknown) => String(value || "").split(/[\\/]/).pop() || "—";
  const versionDetails = (version: any) => {
    const fingerprint = version.fingerprint || {};
    const video = fingerprint.video || {};
    const storage = fingerprint.storage || {
      provider: version.provider,
      torrentId: version.providerItemId,
      path: version.files?.[0]?.path,
      size: version.files?.[0]?.size,
    };
    const release = fingerprint.release || {};
    const audio = [...new Set((fingerprint.audio || []).map((item: any) => item.language).filter(Boolean))].join(", ");
    return { fingerprint, video, storage, release, audio, name: leafName(storage.path || version.releaseName || version.filename) };
  };
  const decisionVersions = versions.filter((version: any) => ["KEEP", "REVIEW", "DELETE_CANDIDATE"].includes(version.decision));
  const candidates = decisionVersions.filter((version: any) => version.decision === "DELETE_CANDIDATE");
  const keeps = decisionVersions.filter((version: any) => version.decision === "KEEP");
  const sameLogicalContent = (left: any, right: any) => {
    if (!left || !right) return false;
    if (left.groupId && right.groupId) return left.groupId === right.groupId;
    if (left.logicalKey && right.logicalKey) return left.logicalKey === right.logicalKey;
    return (left.title || "") === (right.title || "") && (left.season ?? "") === (right.season ?? "") && (left.episode ?? "") === (right.episode ?? "");
  };
  const keptForCandidate = (candidate: any) => [...keeps, ...(item.alternativeVersions || [])].filter((version: any) => sameLogicalContent(candidate, version));
  const isDeleteImpact = Array.isArray(item.alternativeVersions) || item.providerItemId !== undefined;
  return (
    <Card className="border-primary/40">
      <CardHeader className="flex flex-row items-start justify-between">
        <CardTitle className="text-base">Content Detail</CardTitle>
        <Button aria-label="Close details" variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5 text-sm lg:grid-cols-2">
        <section>
          <h3 className="mb-2 font-semibold">Identity</h3>
          <dl className="space-y-1 text-muted-foreground">
            <p>
              <b className="text-foreground">Title:</b>{" "}
              {shownIdentity.title}
            </p>
            <p>
              <b className="text-foreground">Year:</b> {shownIdentity.year || "—"}
            </p>
            <p>
              <b className="text-foreground">Type:</b>{" "}
              {identity.mediaType || identity.kind || item.mediaType || shownIdentity.kind || "—"}
            </p>
            <p>
              <b className="text-foreground">TMDb:</b>{" "}
              {identity.tmdbId || identity.tmdb?.id || "—"}
            </p>
            <p>
              <b className="text-foreground">TVDb / IMDb:</b>{" "}
              {identity.tvdbId || "—"} / {identity.imdbId || "—"}
            </p>
            <p>
              <b className="text-foreground">Confidence:</b>{" "}
              {identity.confidence ?? item.confidence ?? "—"}
            </p>
            <p>
              <b className="text-foreground">Provenance:</b>{" "}
              {identity.provenance ? JSON.stringify(identity.provenance) : "—"}
            </p>
          </dl>
          {review && <div className="mt-4 rounded border bg-muted/20 p-3"><h3 className="mb-2 font-semibold">Detected identity</h3><p><b>Title:</b> {review.parsed?.title || "—"}</p><p><b>Type:</b> {review.parsed?.kind || "—"}</p><p><b>Status:</b> {review.parsed?.status || "—"}</p><p><b>Confidence:</b> {review.parsed?.confidence ?? "—"}</p><p><b>Reason:</b> {review.parsed?.reason || "—"}</p></div>}
          {review && <div className="mt-4 rounded border border-amber-500/40 bg-amber-500/5 p-3"><h3 className="mb-2 font-semibold">Problem and required action</h3><p>{(item.blockers || item.reasonCodes || []).join(" · ") || "The item requires operator review before an automatic decision is safe."}</p><p className="mt-1 text-xs text-muted-foreground">Identity confidence: {identity.confidence ?? "unknown"} · Recoverability: {item.recoverability?.status || "unknown"}</p><p className="mt-1 break-all text-xs text-muted-foreground">Source: {item.sourceBasename || review.sourceBasename || review.sourcePath || "not available"}</p></div>}
          {(identity.title || item.title) && (review || item.allowIdentityActions !== false) && <div className="mt-4"><h3 className="mb-2 font-semibold">Identity actions</h3><IdentityResolver reviewId={item.reviewId || review?.id} versionGroupId={item.versionGroupId} providerId={providerId} identity={{ title: identity.title || item.title, year: identity.year, kind: identity.kind, mediaType: identity.mediaType, tmdbId: identity.tmdbId }} initialQuery={identity.title || item.title} initialType={identity.kind === "episode" || identity.mediaType === "tv" ? "tv" : "movie"} initialYear={identity.year} existingOverride={item.override || review?.override || (identity.source === "manual" ? { tmdbId: identity.tmdbId } : undefined)} actionLabel={identityAction} onSaved={onSaved} /></div>}
          {review && onReviewAction && <div className="mt-4 flex flex-wrap gap-2">{review.decision === "dismissed" ? <Button size="sm" onClick={() => onReviewAction(review.id, { action: "retry" }, review)}>Restore to Review</Button> : <><Button size="sm" variant="secondary" onClick={() => onReviewAction(review.id, { decision: "accepted" }, review)}>Accept as detected</Button><Button size="sm" variant="outline" onClick={() => onReviewAction(review.id, { action: "retry" }, review)}>Retry / Resume</Button><Button size="sm" variant="destructive" onClick={() => onReviewAction(review.id, { decision: "dismissed" }, review)}>Dismiss</Button></>}</div>}
        </section>
        <section>
          <h3 className="mb-2 font-semibold">Profiles</h3>
          <div className="flex flex-wrap gap-2">
            {(item.evaluations || item.profiles || []).map(
              (profile: any, index: number) => (
                <span
                  key={profile.profileId || profile.id || index}
                  className="rounded border px-2 py-1"
                >
                  {profile.profileName ||
                    profile.name ||
                    profile.profileId ||
                    profile.id}
                  :{" "}
                  {profile.satisfied || profile.eligible
                    ? "satisfied"
                    : "missing"}
                </span>
              ),
            )}
          </div>
          <h3 className="mb-2 mt-4 font-semibold">Versions</h3>
          <div className="space-y-2">
            {versions.length ? (
              versions.map((version: any, index: number) => (
                (() => { const detail = versionDetails(version); return <div className="rounded border p-2" key={version.id || index}>
                  <p className="font-medium">{detail.video.resolution || version.resolution || "Resolution unknown"} · {detail.video.codec || version.codec || "Codec unknown"} · {detail.video.dolbyVision || detail.video.hdr10 ? "HDR" : "SDR"}</p>
                  <p className="text-xs text-muted-foreground">{detail.name} · {detail.storage.provider || version.provider || "Provider unknown"} · {detail.storage.torrentId || version.providerItemId || "ProviderItem unknown"}</p>
                  <p className="text-xs text-muted-foreground">{detail.audio ? `Audio: ${detail.audio} · ` : ""}{detail.storage.size ? `${Math.round(Number(detail.storage.size) / 1_000_000)} MB · ` : ""}{version.decision || "Decision unknown"}</p>
                  <p className="mt-1 text-xs">Version ID: {version.id || "—"}</p>
                  <p className="text-xs">Release: {detail.name}</p>
                  {detail.storage.path && <p className="break-all text-xs text-muted-foreground">Path: {detail.storage.path}</p>}
                  {detail.fingerprint.subtitles?.length > 0 && <p className="text-xs text-muted-foreground">Subtitles: {[...new Set(detail.fingerprint.subtitles.map((subtitle: any) => subtitle.language).filter(Boolean))].join(", ")}</p>}
                </div>; })()
              ))
            ) : (
              <p className="text-muted-foreground">
                No version details available.
              </p>
            )}
          </div>
        </section>
        <section>
          <h3 className="mb-2 font-semibold">Policy / Decision</h3>
          <p><b>Decision:</b> <StatusBadge value={item.decision || versions[0]?.decision || "REVIEW"} /></p>
          <p className="mt-2"><b>Matched slot:</b> {versions.flatMap((version: any) => version.satisfiesProfiles || []).join(", ") || "none"}</p>
          {candidates.length > 0 && <div className="mt-3 rounded border border-amber-500/50 bg-amber-500/5 p-3"><p className="font-semibold">Decision comparison</p>{candidates.map((version: any, index: number) => { const retained = keptForCandidate(version); return <div key={version.id || index} className="mt-3 rounded border border-border/70 p-2"><p><b>Delete candidate:</b> {versionDetails(version).name}</p><p className="text-xs text-muted-foreground">{reasonText(version.reasons) || "Policy marked this version as redundant or lower priority."}</p><div className="mt-2">{retained.length ? retained.map((keptVersion: any, keptIndex: number) => <div key={keptVersion.id || keptIndex}><p><b>Kept instead for the same content / episode:</b> {keptVersion.providerItemId ? `${keptVersion.title || "Content"} · ProviderItem ${keptVersion.providerItemId}` : versionDetails(keptVersion).name}</p><p className="text-xs text-muted-foreground">{reasonText(keptVersion.reasons) || "Winning version for the matched retention slot."}</p></div>) : <p className="text-xs text-amber-700">No retained replacement for this same content / episode. Physical deletion must stay blocked.</p>}</div></div>; })}</div>}
          <p className="mt-2 text-muted-foreground">Winning profiles: {versions.flatMap((version: any) => version.satisfiesProfiles || []).join(", ") || "none"}</p>
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">{versions.flatMap((version: any) => (Array.isArray(version.reasons) ? version.reasons : []).map((reason: any, index: number) => <p key={`${version.id}-${reason.code || index}`}>• {typeof reason === "string" ? reason : reason.message}</p>))}</div>
        </section>
        <section>
          <h3 className="mb-2 font-semibold">Safety</h3>
          {isDeleteImpact && <><p><b>Physical resource:</b> {item.provider} · ProviderItem {item.providerItemId || "unknown"}</p><p><b>Physical size:</b> {item.physicalSize ? `${Math.round(Number(item.physicalSize) / 1_000_000)} MB` : "unknown"} · <b>Physical deletion:</b> {item.protectedByKeep ? "PROTECTED" : item.state === "READY" ? "ELIGIBLE after final revalidation" : "BLOCKED"}</p><p><b>Copy status:</b> {item.onlyCopy ? "Only copy / no same-content alternative" : "Alternative retained or shared physical resource"}</p>{item.reasons?.length > 0 && <p className="text-amber-700">Reasons: {item.reasons.join(" · ")}</p>}</>}
          {versions.length ? versions.map((version: any, index: number) => <p key={version.id || index} className="text-sm text-muted-foreground">{version.fingerprint?.storage?.provider || "provider"} · recoverability: {version.fingerprint?.storage?.infoHash ? "YES · infohash available" : "UNKNOWN · review required"}</p>) : <p className="text-muted-foreground">No safety details available.</p>}
        </section>
        <details className="rounded border p-3 lg:col-span-2">
          <summary className="cursor-pointer font-semibold">
            Evidence / diagnostics
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {JSON.stringify(
              item.evidence || item.disagreements || item,
              null,
              2,
            )}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}

function Overview() {
  const provider = useMediaManagerProvider();
  const providerQuery = provider.providerId ? `provider=${encodeURIComponent(provider.providerId)}` : "";
  const status = useJson<any>(`/api/version-manager/status?${providerQuery}`, Boolean(provider.providerId));
  const deleteDryRun = status.data?.policy?.safety?.deleteDryRun !== false;
  const migration = useJson<any>("/api/version-manager/migration/state");
  const reviewQueue = useJson<any>(`/api/version-manager/review?status=pending&${providerQuery}`, Boolean(provider.providerId));
  const profiles = status.data?.profiles || [];
  const identityIssues = reviewQueue.data?.summary?.identityIssues ?? 0;
  const latestScan = status.data?.latestScan;
  const evaluation = status.data?.policyEvaluation;
  const migrationValue = (value: unknown): string | number => migration.loading ? "…" : migration.error ? "Unavailable" : typeof value === "string" || typeof value === "number" ? value : "Not calculated";
  const [scan, setScan] = useState<any>(null);
  const [scanJob, setScanJob] = useState<any>(status.data?.scanJob?.job || null);
  const [scanError, setScanError] = useState("");
  const scanning = ["SCANNING", "ENRICHING", "EVALUATING", "PERSISTING"].includes(scanJob?.status);

  useEffect(() => {
    let cancelled = false;
    const loadJob = async () => {
      try {
        if (!provider.providerId) return;
        const response = await fetch(`/api/version-manager/scan?${providerQuery}`, { cache: "no-store" });
        const body = await readJsonResponse<any>(response, "Scan status");
        if (!cancelled) setScanJob(body.job || null);
      } catch (value: any) {
        if (!cancelled) setScanError(value.message || "Unable to read scan status");
      }
    };
    void loadJob();
    return () => { cancelled = true; };
  }, [provider.providerId, providerQuery]);

  useEffect(() => {
    if (!scanning || !scanJob?.id) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/version-manager/scan/${encodeURIComponent(scanJob.id)}`, { cache: "no-store" });
        const body = await readJsonResponse<any>(response, "Scan status");
        setScanJob(body.job);
        if (["COMPLETED", "FAILED", "PARTIAL"].includes(body.job?.status)) {
          await status.reload();
          if (body.job.status === "COMPLETED") {
            const result = await fetch(`/api/version-manager/preview?${providerQuery}`, { cache: "no-store" });
            setScan(await readJsonResponse<any>(result, "Inventory snapshot"));
          }
        }
      } catch (value: any) { setScanError(value.message || "Unable to read scan status"); }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [scanJob?.id, scanning, status.reload, providerQuery]);

  async function runScan() {
    setScanError("");
    try {
      const response = await fetch(`/api/version-manager/scan?${providerQuery}`, { method: "POST", cache: "no-store" });
      const body = await readJsonResponse<any>(response, "Starting library scan");
      setScanJob(body.job);
    } catch (value: any) {
      setScanError(value.message || "Unable to start scan");
    }
  }
  return (
    <div className="space-y-6">
      <Header
        view="overview"
        title="Media Manager"
        description="Inventory, identity, versions, acquisition and recovery in one place."
        reviewCount={identityIssues}
      />
      <ProviderSelector providers={provider.providers} value={provider.providerId} onChange={(value) => { provider.selectProvider(value); setScan(null); setScanJob(null); setScanError(""); }} />
      <ErrorBox error={provider.error} />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <div>
          <p className="font-medium">Library status</p>
          <p className="text-sm text-muted-foreground">
            {scanJob?.status && scanJob.status !== "COMPLETED"
              ? `${scanJob.status}${scanJob.phase ? ` · ${scanJob.phase}` : ""}${scanJob.total ? ` · ${scanJob.completed}/${scanJob.total}` : ` · ${scanJob.completed} processed`}`
              : scan
              ? `${scan.groupCount} content groups in last scan`
              : status.data?.latestScan
                ? "Last scan available"
                : "No scan run in this session"}
          </p>
        </div>
        <Button onClick={() => void runScan()} disabled={scanning}>
          <RefreshCw
            className={`mr-2 h-4 w-4 ${scanning ? "animate-spin" : ""}`}
          />
          Run Scan
        </Button>
      </div>
      <ErrorBox error={scanError || scan?.error || status.error} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Library contents"
          value={scan?.groupCount ?? evaluation?.counts?.contentCount ?? latestScan?.groupCount ?? "—"}
          detail="ContentIdentity / VersionGroup"
        />
        <Stat
          label="Profiles"
          value={profiles.filter((profile: Profile) => profile.enabled).length}
          detail="enabled"
        />
        <Stat
          label="Acquisition"
          value={migration.data?.effective?.readyToImport ?? "—"}
          detail="effective ready"
        />
        <Stat label="Safety" value={deleteDryRun ? "DRY RUN" : "LIVE"} detail={deleteDryRun ? "validation only" : "provider deletion enabled"} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Needs attention</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link href="/media-manager/library/review?reason=identity" className="rounded-md border p-3 transition-colors hover:border-primary">
            <p className="text-sm text-muted-foreground">Identity issues</p>
            <p className="mt-1 text-2xl font-semibold">{reviewQueue.loading ? "—" : identityIssues}</p>
            <p className="mt-1 text-xs text-muted-foreground">Manual match available</p>
          </Link>
          <Link href="/media-manager/library/review" className="rounded-md border p-3 transition-colors hover:border-primary">
            <p className="text-sm text-muted-foreground">Manual review</p>
            <p className="mt-1 text-2xl font-semibold">{reviewQueue.loading ? "—" : reviewQueue.data?.entries?.length ?? 0}</p>
            <p className="mt-1 text-xs text-muted-foreground">Identity and recoverability issues</p>
          </Link>
          <Link href="/media-manager/library/missing" className="rounded-md border p-3 transition-colors hover:border-primary">
            <p className="text-sm text-muted-foreground">Missing</p>
            <p className="mt-1 text-2xl font-semibold">{evaluation ? (evaluation.counts.primaryMissing || 0) + (evaluation.counts.remoteMissing || 0) : "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Unsatisfied enabled profiles</p>
          </Link>
          <Link href="/media-manager/library/delete-preview" className="rounded-md border p-3 transition-colors hover:border-primary">
            <p className="text-sm text-muted-foreground">Delete candidates</p>
            <p className="mt-1 text-2xl font-semibold">{evaluation?.counts?.deleteCandidateCount ?? latestScan?.deleteCandidateCount ?? "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Read-only preview</p>
          </Link>
        </CardContent>
      </Card>
      {evaluation?.status === "STALE" && <Card className="border-amber-500/50"><CardContent className="p-4 text-sm"><b>Policy evaluation is stale.</b> The current configuration differs from the snapshot evaluation; read-only projections are being recalculated from the existing snapshot, without rescanning providers.</CardContent></Card>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profiles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {profiles.map((profile: Profile) => (
              <div className="flex justify-between text-sm" key={profile.id}>
                {profile.name || profile.id}
                <StatusBadge value={profile.enabled ? "ENABLED" : "DISABLED"} />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Backup & Migration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              Source items <b>{migrationValue(migration.data?.sourceItems)}</b>
            </p>
            <p>
              Rejected legal{" "}
              <b>{migrationValue(migration.data?.effective?.rejectedLegal)}</b>
            </p>
            <p>
              Importable remaining{" "}
              <b>{migrationValue(migration.data?.effective?.residualTentableReady)}</b>
            </p>
            {migration.error && <p className="text-xs text-muted-foreground">Migration state is not calculated: {migration.error}</p>}
            <Link
              className="inline-flex items-center text-primary"
              href="/media-manager/migration"
            >
              Open migration <ChevronRight className="ml-1 h-4 w-4" />
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Safety status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-green-500" />
              {deleteDryRun ? "Dry run active" : "Live deletion enabled"}
            </p>
            <p className="text-muted-foreground">
              {deleteDryRun ? "Candidates can be revalidated against the provider, but the delete API cannot be called." : "Eligible ProviderItems can be deleted after final revalidation and explicit confirmation."}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function LibraryReleaseList({
  releases,
  selectedIds,
  onToggle,
  onSelectAll,
  onDetails,
}: {
  releases: LibraryPhysicalRelease[];
  selectedIds: Set<string>;
  onToggle: (release: LibraryPhysicalRelease, checked: boolean) => void;
  onSelectAll: (releases: LibraryPhysicalRelease[]) => void;
  onDetails: (release: LibraryPhysicalRelease) => void;
}) {
  if (!releases.length) return <p className="text-sm text-muted-foreground">No physical release is available for the current filters.</p>;
  return (
    <div className="space-y-2">
      <div className="flex justify-end"><Button size="sm" variant="outline" onClick={() => onSelectAll(releases)}>Select all releases</Button></div>
      {releases.map((release) => {
        const uniqueUnits = physicalReleaseEpisodeCount(release);
        const isPack = uniqueUnits > 1;
        return (
          <div key={release.key} className={`rounded border p-3 ${selectedIds.has(release.key) ? "border-destructive/60 bg-destructive/5" : ""}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <label className="flex min-w-0 flex-1 items-start gap-2">
                <input className="mt-1" type="checkbox" checked={selectedIds.has(release.key)} onChange={(event) => onToggle(release, event.target.checked)} />
                <span className="min-w-0">
                  <span className="block font-medium">{isPack ? `Season pack · ${uniqueUnits} linked episodes` : "Single media release"}</span>
                  <span className="block text-xs text-muted-foreground">{release.provider} · ProviderItem {release.providerItemId} · {formatSize(release.physicalSize)}</span>
                </span>
              </label>
              <div className="flex items-center gap-2">{!release.recoverable && <Badge variant="destructive">RESTORE SAFETY BLOCK</Badge>}<Button size="sm" variant="ghost" onClick={() => onDetails(release)}>Details</Button></div>
            </div>
            <div className="mt-3 space-y-2">
              {release.members.map(({ group, version }) => {
                const identity = group.identity || {};
                const fingerprint = version.fingerprint || {};
                const video = fingerprint.video || {};
                const storage = fingerprint.storage || {};
                const fileName = String(storage.path || version.releaseName || version.filename || version.id).split(/[\\/]/).pop();
                const audio = uniqueLanguages(fingerprint.audio || []);
                return (
                  <div key={version.id} className="rounded border border-border/60 p-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2"><p className="break-all font-medium">{episodeLabel(identity) ? `${episodeLabel(identity)} · ` : ""}{fileName}</p><StatusBadge value={version.decision} /></div>
                    <p className="mt-1 text-muted-foreground">{video.resolution || "resolution unknown"} · {video.codec || "codec unknown"} · {video.dolbyVision ? "Dolby Vision" : video.hdr10Plus ? "HDR10+" : video.hdr10 ? "HDR10" : "SDR"}{audio ? ` · audio ${audio}` : ""} · {formatSize(storage.size)}</p>
                    {(version.reasons || []).length > 0 && <p className="mt-1">{(version.reasons || []).map((reason: any) => typeof reason === "string" ? reason : reason.message).filter(Boolean).join(" · ")}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Library({ initialPreset = "all" }: { initialPreset?: string }) {
  const pathname = usePathname();
  const provider = useMediaManagerProvider();
  const providerQuery = provider.providerId ? `provider=${encodeURIComponent(provider.providerId)}` : "";
  const [preset, setPreset] = useState("all");
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState("all");
  const [mediaType, setMediaType] = useState("all");
  const [decision, setDecision] = useState("all");
  const [multipleVersions, setMultipleVersions] = useState(false);
  const [sort, setSort] = useState("title");
  const [deleteScope, setDeleteScope] = useState("candidates");
  const [selected, setSelected] = useState<any>(null);
  const [reviewStatus, setReviewStatus] = useState<"pending" | "dismissed" | "all">("pending");
  const [reviewIssueFilter, setReviewIssueFilter] = useState<"all" | "identity" | "recoverability">("all");
  const [missingStatus, setMissingStatus] = useState<"pending" | "dismissed" | "all">("pending");
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [deleteBusy, setDeleteBusy] = useState("");
  const [selectedDeleteItems, setSelectedDeleteItems] = useState<Map<string, SelectedDeleteItem>>(new Map());
  const [deleteNotice, setDeleteNotice] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const reviewQueue = useJson<any>(`/api/version-manager/review?status=pending&${providerQuery}`, Boolean(provider.providerId));
  const [identityOnly, setIdentityOnly] = useState(false);
  const identityIssueCount = reviewQueue.data?.summary?.identityIssues ?? 0;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setPreset(params.get("view") || initialPreset);
    setIdentityOnly(params.get("reason") === "identity");
  }, [pathname, initialPreset]);
  const preview = useJson<any>(
    `/api/version-manager/preview?${providerQuery}`,
    preset === "all" && Boolean(provider.providerId),
  );
  const deletePreview = useJson<any>(
    `/api/version-manager/delete-preview?${providerQuery}`,
    (preset === "all" || preset === "delete-preview" || preset === "delete") && Boolean(provider.providerId),
  );
  const deleteImpact = useJson<any>(
    `/api/version-manager/delete?scope=${encodeURIComponent(deleteScope)}&q=${encodeURIComponent(query)}&${providerQuery}`,
    (preset === "delete-preview" || preset === "delete") && Boolean(provider.providerId),
  );
  useEffect(() => {
    setSelectedDeleteItems(new Map());
  }, [deleteScope, query, provider.providerId]);
  const visibleDeleteItems = deleteImpact.data?.items || [];
  const visibleRecommendedDeleteRefs = recommendedDeleteRefs(visibleDeleteItems);
  function changeDeleteSelection(add: SelectedDeleteItem[], removeKeys: string[]) {
    setSelectedDeleteItems((current) => {
      const next = new Map(current);
      for (const key of removeKeys) next.delete(key);
      for (const item of add) next.set(`${item.provider}:${item.providerItemId}`, item);
      return next;
    });
  }
  function toggleLibraryRelease(release: LibraryPhysicalRelease, checked: boolean) {
    const item = { provider: release.provider, providerItemId: release.providerItemId, physicalSize: release.physicalSize };
    changeDeleteSelection(checked ? [item] : [], checked ? [] : [release.key]);
  }
  function selectLibraryReleases(releases: LibraryPhysicalRelease[]) {
    changeDeleteSelection(releases.map((release) => ({ provider: release.provider, providerItemId: release.providerItemId, physicalSize: release.physicalSize })), []);
  }
  function showLibraryReleaseDetails(release: LibraryPhysicalRelease) {
    const first = release.members[0];
    setSelected({
      identity: first?.group?.identity,
      versions: release.members.map(({ version }) => version),
      provider: release.provider,
      providerItemId: release.providerItemId,
      physicalSize: release.physicalSize,
      state: "MANUAL_SELECTION",
      protectedByKeep: release.members.some(({ version }) => version.decision === "KEEP"),
      reasons: release.recoverable ? [] : ["Deletion is blocked because this ProviderItem is not confirmed recoverable."],
      allowIdentityActions: false,
    });
  }
  async function executeBulkDelete(items: SelectedDeleteItem[]) {
    if (!provider.providerId || items.some((item) => item.provider !== provider.providerId)) throw new Error("The selection does not belong to the currently managed provider");
    const deleteContext = preset === "all" ? deletePreview.data : deleteImpact.data;
    const dryRun = deleteContext?.dryRun !== false;
    const selection = items.map(({ provider, providerItemId }) => ({ provider, providerItemId }));
    const grouped = new Map<string, SelectedDeleteItem[]>();
    for (const item of items) grouped.set(item.provider, [...(grouped.get(item.provider) || []), item]);
    const deletedProviderItemIds: string[] = [];
    setDeleteBusy("batch");
    setDeleteNotice("");
    setDeleteError("");
    try {
      for (const [provider, providerItems] of grouped) {
        const providerItemIds = providerItems.map((item) => String(item.providerItemId));
        const response = await fetch("/api/version-manager/delete/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, providerItemIds, selection, snapshotId: deleteContext?.snapshotId, dryRun, confirmation: dryRun ? undefined : JSON.stringify(providerItemIds) }) });
        const result = await readJsonResponse<any>(response, dryRun ? "Selection validation" : "Selected provider deletion");
        if (!dryRun) deletedProviderItemIds.push(...(result.providerItemIds || result.results?.filter((item: any) => item.status === "DELETED").map((item: any) => item.providerItemId) || []));
      }
      setSelectedDeleteItems(new Map());
      if (dryRun) {
        setDeleteNotice(`Validated ${items.length} selected ProviderItems. No provider data was deleted.`);
        await Promise.all([preview.reload(), deleteImpact.reload(), deletePreview.reload()]);
        return;
      }
      setDeleteBusy("refresh");
      setDeleteNotice(`Deleted ${deletedProviderItemIds.length || items.length} selected ProviderItems. Updating the library inventory…`);
      try {
        const delta = await readJsonResponse<any>(
          await fetch("/api/version-manager/snapshot/apply-deletion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider.providerId, snapshotId: deleteContext?.snapshotId, providerItemIds: deletedProviderItemIds }) }),
          "Updating the library inventory",
        );
        await Promise.all([preview.reload(), deleteImpact.reload(), deletePreview.reload()]);
        setDeleteNotice(`Deleted ${deletedProviderItemIds.length || items.length} selected ProviderItems. Library inventory updated incrementally (${delta.removedVersionCount || deletedProviderItemIds.length} versions removed).`);
      } catch (deltaError: any) {
        setDeleteNotice("Deletion completed. The incremental inventory update was not available; starting a full reconciliation…");
        try {
          await refreshVersionManagerInventory(provider.providerId);
          await Promise.all([preview.reload(), deleteImpact.reload(), deletePreview.reload()]);
          setDeleteNotice(`Deleted ${deletedProviderItemIds.length || items.length} selected ProviderItems. The library inventory is now up to date.`);
        } catch (refreshError: any) {
          setDeleteError(`Deletion completed, but the library refresh did not finish: ${refreshError?.message || deltaError?.message || "reload the Library before deleting again"}`);
        }
      }
    } catch (value: any) {
      if (value?.payload?.refreshRequired) {
        const staleIds = Array.isArray(value.payload.staleProviderItemIds) ? value.payload.staleProviderItemIds : [];
        setSelectedDeleteItems(new Map());
        setDeleteBusy("refresh");
        setDeleteNotice(`${staleIds.length || "One or more"} selected ProviderItem${staleIds.length === 1 ? " is" : "s are"} already absent. No additional ProviderItems were deleted; refreshing the library before another selection…`);
        try {
          await refreshVersionManagerInventory(provider.providerId);
          await Promise.all([preview.reload(), deleteImpact.reload(), deletePreview.reload()]);
          setDeleteNotice("The library inventory was refreshed. Review the remaining candidates and confirm a new selection.");
        } catch (refreshError: any) {
          setDeleteError(`Inventory changed and no additional ProviderItems were deleted. Automatic refresh failed: ${refreshError?.message || "reload the Library before continuing"}`);
        }
        return;
      }
      setDeleteError(value.message || "Selected deletion failed");
      throw value;
    } finally { setDeleteBusy(""); }
  }
  function requestBulkDelete() {
    const items = [...selectedDeleteItems.values()];
    if (!items.length) return;
    const totalGiB = items.reduce((total, item) => total + Number(item.physicalSize || 0), 0) / 1024 / 1024 / 1024;
    setConfirmation({ title: `Delete ${items.length} selected ProviderItems?`, description: "The complete selection will be revalidated as one retention decision. A policy-retained release may be deleted only when an admissible unselected alternative remains for every affected film or episode.", context: <div className="space-y-1"><p><b>Selected:</b> {items.length} physical ProviderItems</p><p><b>Known selected size:</b> {totalGiB ? `${totalGiB.toFixed(2)} GiB` : "unknown"}</p></div>, confirmLabel: `Delete ${items.length} selected`, variant: "destructive", onConfirm: () => executeBulkDelete(items) });
  }
  const reviewPreview = useJson<any>(
    `/api/version-manager/preview?${providerQuery}`,
    preset === "review" && Boolean(provider.providerId),
  );
  const missing = useJson<any>(
    `/api/version-manager/missing?status=${missingStatus}&${providerQuery}`,
    preset === "missing" && Boolean(provider.providerId),
  );
  const [review, setReview] = useState<any>(null);
  const [reviewError, setReviewError] = useState("");
  const loadReview = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/version-manager/review?status=${reviewStatus}&${providerQuery}`,
        { cache: "no-store" },
      );
      const body = await readJsonResponse<any>(response, "Review queue request");
      setReview(body);
      setReviewError("");
    } catch (value: any) {
      setReviewError(value.message || "Unable to load review");
    }
  }, [reviewStatus, providerQuery]);
  useEffect(() => {
    if (preset === "review") void loadReview();
  }, [loadReview, preset, reviewStatus]);
  async function reviewAction(id: string, body: Record<string, unknown>, item?: any) {
    const endpoint = item?.organizerReview
      ? `/api/organizer/review/${encodeURIComponent(id)}`
      : `/api/version-manager/review/${encodeURIComponent(id)}`;
    const response = await fetch(
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "Unable to save review action");
    }
    await Promise.all([loadReview(), reviewQueue.reload()]);
  }
  async function missingAction(item: any, action: "dismiss" | "restore") {
    const key = item.dismissalKey || item.id;
    if (!key || !provider.providerId) return;
    const response = await fetch(`/api/version-manager/missing/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: provider.providerId, action }),
    });
    await readJsonResponse<any>(response, action === "dismiss" ? "Dismissing missing item" : "Restoring missing item");
    await missing.reload();
  }
  function requestReviewAction(id: string, body: Record<string, unknown>, item?: any) {
    const isRestore = body.action === "retry" && item?.decision === "dismissed";
    const isAccept = body.decision === "accepted";
    const isDismiss = body.decision === "dismissed";
    setConfirmation({
      title: isRestore ? "Restore review item?" : isAccept ? "Accept detected identity?" : isDismiss ? "Dismiss review item?" : "Retry review item?",
      description: isRestore ? "This item will be returned to the pending review queue." : isAccept ? "The detected identity will be accepted without a manual TMDb match." : isDismiss ? "This item will be removed from the pending review queue and kept in review history." : "The item will be returned to the organizer review workflow.",
      context: item?.parsed?.title ? <p><b>Detected title:</b> {item.parsed.title}</p> : undefined,
      confirmLabel: isRestore ? "Restore to Review" : isAccept ? "Accept as detected" : isDismiss ? "Dismiss" : "Retry / Resume",
      variant: isDismiss ? "destructive" : isAccept ? "secondary" : "default",
      onConfirm: () => reviewAction(id, body, item),
    });
  }
  const groups = useMemo(
    () => (preview.data?.groups || []).filter((group: any) => matchesLibraryFilter(group, {
      query,
      profile,
      mediaType: mediaType as "all" | "movie" | "tv",
      decision: decision as "all" | "keep" | "review" | "delete_candidate",
      multipleVersions,
    })),
    [preview.data, query, profile, mediaType, decision, multipleVersions],
  );
  const profileOptions = useMemo(
    (): string[] => [...new Set<string>((preview.data?.groups || []).flatMap((group: any) => libraryGroupProfileIds(group)))].sort(),
    [preview.data],
  );
  const libraryRows = useMemo(() => {
    const rows = new Map<string, { kind: "movie" | "show" | "unknown"; title: string; year?: number; groups: any[] }>();
    for (const group of groups) {
      const identity = displayIdentity(group);
      const isEpisode = identity.kind === "episode";
      const canonicalId = identity.tmdbId || identity.tvdbId;
      const fallbackTitle = String(identity.normalizedTitle || identity.title || group.title || "unidentified").trim().toLowerCase();
      const fallbackYear = identity.year ? String(identity.year) : "";
      const key = isEpisode
        ? `show:${canonicalId || `${fallbackTitle}:${fallbackYear}`}`
        : `movie:${canonicalId || `${fallbackTitle}:${fallbackYear}`}`;
      const current: { kind: "movie" | "show" | "unknown"; title: string; year?: number; groups: any[] } = rows.get(key) || { kind: isEpisode ? "show" : identity.kind === "movie" ? "movie" : "unknown", title: identity.title || group.title || "Unidentified content", year: identity.year, groups: [] };
      current.groups.push(group);
      rows.set(key, current);
    }
    return [...rows.values()].sort((left, right) => sort === "versions" ? right.groups.reduce((n, group) => n + group.versions.length, 0) - left.groups.reduce((n, group) => n + group.versions.length, 0) : left.title.localeCompare(right.title));
  }, [groups, sort]);
  const fullPhysicalReleaseByKey = useMemo(
    () => new Map(groupLibraryPhysicalReleases(preview.data?.groups || []).map((release) => [release.key, release])),
    [preview.data],
  );
  const completePhysicalReleasesFor = (filteredGroups: any[]): LibraryPhysicalRelease[] =>
    groupLibraryPhysicalReleases(filteredGroups).map((release) => fullPhysicalReleaseByKey.get(release.key) || release);
  const rawNeeds = missingProfileNeeds(missing.data);
  const missingProfileOptions = [...new Set<string>(rawNeeds.map((item: any) => item.profileId || item.missingProfileId).filter(Boolean))].sort();
  const needs = sortMissingNeeds(rawNeeds.filter((item: any) => matchesMissingNeed(item, {
    query,
    profile,
    mediaType: mediaType as "all" | "movie" | "tv",
  })));
  const missingRows = useMemo(() => {
    type MissingRow = { title: string; year?: number; mediaType: string; season?: number; items: any[] };
    const rows = new Map<string, MissingRow>();
    for (const item of needs) {
      const identity = item.contentIdentity || {};
      const isTv = item.mediaType === "tv" || identity.kind === "episode";
      const title = String(identity.title || item.title || "Unknown content");
      const canonical = identity.tmdbId || identity.tvdbId || identity.imdbId || `${String(identity.normalizedTitle || title).toLowerCase()}:${identity.year || ""}`;
      const key = isTv ? `tv:${canonical}:season:${identity.season ?? item.season ?? "unknown"}` : `movie:${canonical}`;
      const current: MissingRow = rows.get(key) || { title, year: identity.year, mediaType: isTv ? "tv" : "movie", season: isTv ? identity.season ?? item.season : undefined, items: [] };
      current.items.push(item);
      rows.set(key, current);
    }
    return [...rows.values()].sort((left, right) => left.title.localeCompare(right.title) || Number(left.season || 0) - Number(right.season || 0));
  }, [needs]);
  const enrichReviewEntry = (entry: any) => {
    const ids = new Set(entry.versionIds || []);
    const snapshotVersions = (reviewPreview.data?.groups || []).flatMap((group: any) => group.versions || []).filter((version: any) => ids.has(version.id));
    const versions = Array.isArray(entry.versions) && entry.versions.length ? entry.versions : snapshotVersions;
    return { ...entry, versions, review: entry.review || entry.organizerReview, allowIdentityActions: entry.issueTypes?.includes("IDENTITY_ISSUE") };
  };
  const contentReviewEntries = (review?.entries || []).filter((entry: any) =>
    entry.issueTypes?.includes("IDENTITY_ISSUE") || entry.issueTypes?.includes("RECOVERABILITY_ISSUE"),
  );
  return (
    <div className="space-y-6">
      <Header
        view="library"
        title="Library"
        description="One operational view for content, missing profiles and review work."
        reviewCount={identityIssueCount}
      />
      <ProviderSelector providers={provider.providers} value={provider.providerId} onChange={(value) => { provider.selectProvider(value); setSelected(null); setSelectedDeleteItems(new Map()); setReview(null); setDeleteNotice(""); setDeleteError(""); }} />
      <ErrorBox error={provider.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          asChild
          variant={preset === "all" ? "default" : "outline"}
          size="sm"
        >
          <Link href="/media-manager/library">All</Link>
        </Button>
        <Button
          asChild
          variant={preset === "missing" ? "default" : "outline"}
          size="sm"
        >
          <Link href="/media-manager/library/missing">Policy Missing</Link>
        </Button>
        <Button
          asChild
          variant={preset === "review" ? "default" : "outline"}
          size="sm"
        >
          <Link href="/media-manager/library/review">Review</Link>
        </Button>
        <Button asChild variant={preset === "delete" || preset === "delete-preview" ? "default" : "outline"} size="sm">
          <Link href="/media-manager/library/delete">Policy Delete</Link>
        </Button>
      </div>
      {preset === "all" && (
        <>
          <p className="text-xs text-muted-foreground">All is grouped by media identity. “More than one version” finds films or episodes with alternatives; “Contains decision” finds content with at least one version in that policy state.</p>
          <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="relative"><Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, episode, filename or ProviderItem…" /></div>
            <select className="rounded border bg-background p-2 text-sm" value={profile} onChange={(event) => setProfile(event.target.value)}><option value="all">Profile: All</option>{profileOptions.map((profileId) => <option key={profileId} value={profileId}>{profileId.toUpperCase()}</option>)}</select>
            <select className="rounded border bg-background p-2 text-sm" value={mediaType} onChange={(event) => setMediaType(event.target.value)}><option value="all">Type: All</option><option value="movie">Movies</option><option value="tv">TV episodes</option></select>
            <label className="flex items-center gap-2 rounded border px-2 text-sm"><input type="checkbox" checked={multipleVersions} onChange={(event) => setMultipleVersions(event.target.checked)} /> More than one version</label>
            <select className="rounded border bg-background p-2 text-sm" value={sort} onChange={(event) => setSort(event.target.value)}><option value="title">Sort: title</option><option value="versions">Sort: version count</option></select>
            <select className="rounded border bg-background p-2 text-sm" value={decision} onChange={(event) => setDecision(event.target.value)}><option value="all">Contains decision: All</option><option value="keep">KEEP</option><option value="review">REVIEW</option><option value="delete_candidate">DELETE CANDIDATE</option></select>
          </div>
        </>
      )}
      {preset === "missing" && (
        <>
          <p className="text-xs text-muted-foreground">Policy Missing lists identified films and episodes for which no current file reaches the configured profile target, including its target resolution and mandatory requirements.</p>
            <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-4">
              <div className="relative"><Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, episode, filename or failed requirement…" /></div>
              <select className="rounded border bg-background p-2 text-sm" value={profile} onChange={(event) => setProfile(event.target.value)}><option value="all">Profile: All</option>{missingProfileOptions.map((profileId) => <option key={profileId} value={profileId}>{profileId.toUpperCase()}</option>)}</select>
              <select className="rounded border bg-background p-2 text-sm" value={mediaType} onChange={(event) => setMediaType(event.target.value)}><option value="all">Type: All</option><option value="movie">Movies</option><option value="tv">TV episodes</option></select>
              <select className="rounded border bg-background p-2 text-sm" value={missingStatus} onChange={(event) => setMissingStatus(event.target.value as typeof missingStatus)}><option value="pending">Pending</option><option value="dismissed">Dismissed</option><option value="all">All statuses</option></select>
            </div>
        </>
      )}
      {(preset === "delete" || preset === "delete-preview") && (
        <>
          <div className="flex flex-wrap items-center gap-2"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, release, filename or provider item…" /><select value={deleteScope} onChange={(event) => setDeleteScope(event.target.value)} className="rounded border bg-background p-2 text-sm"><option value="candidates">Delete candidates · physically eligible</option><option value="protected">Protected / Not deletable</option><option value="attention">Needs attention · policy / restore safety</option></select></div>
          <ErrorBox error={deletePreview.error || deleteImpact.error || deleteError} />
          {deleteNotice && <p className="rounded border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">{deleteNotice}</p>}
          {deletePreview.loading ? <p className="text-sm text-muted-foreground">Evaluating policy…</p> : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {Object.entries(deletePreview.data?.counts || {}).map(([label, value]) => <Stat key={label} label={label.replaceAll("_", " ")} value={String(value)} />)}
              </div>
              {deleteScope === "candidates" && visibleDeleteItems.length > 0 && <div className="flex flex-wrap items-center justify-end gap-2 rounded-lg border p-3"><Button size="sm" variant="outline" disabled={Boolean(deleteBusy) || visibleRecommendedDeleteRefs.length === 0} onClick={() => changeDeleteSelection(visibleRecommendedDeleteRefs, [...selectedDeleteItems.keys()])}>Select all recommended</Button><Button size="sm" variant="ghost" disabled={Boolean(deleteBusy) || selectedDeleteItems.size === 0} onClick={() => setSelectedDeleteItems(new Map())}>Clear selection</Button><span className="text-sm text-muted-foreground">{selectedDeleteItems.size} physical item{selectedDeleteItems.size === 1 ? "" : "s"} selected</span><Button size="sm" variant="destructive" disabled={Boolean(deleteBusy) || selectedDeleteItems.size === 0} onClick={requestBulkDelete}>{deleteBusy === "batch" ? "Deleting selection…" : deleteBusy === "refresh" ? "Refreshing library…" : "Delete selected"}</Button></div>}
              <DeleteImpactCards items={visibleDeleteItems} scope={deleteScope} busyId={deleteBusy} selectedIds={new Set(selectedDeleteItems.keys())} onChangeSelection={changeDeleteSelection} />
            </>
          )}
        </>
      )}
      {preset === "all" && (
        <>
          <ErrorBox error={preview.error || deletePreview.error || deleteError} />
          {deleteNotice && <p className="rounded border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">{deleteNotice}</p>}
          {selectedDeleteItems.size > 0 && <div className="sticky top-2 z-10 flex flex-wrap items-center justify-end gap-2 rounded-lg border bg-background/95 p-3 shadow"><Button size="sm" variant="ghost" disabled={Boolean(deleteBusy)} onClick={() => setSelectedDeleteItems(new Map())}>Clear selection</Button><span className="text-sm text-muted-foreground">{selectedDeleteItems.size} physical release{selectedDeleteItems.size === 1 ? "" : "s"} selected</span><Button size="sm" variant="destructive" disabled={Boolean(deleteBusy) || deletePreview.loading} onClick={requestBulkDelete}>{deleteBusy === "batch" ? "Deleting selection…" : "Delete selected"}</Button></div>}
          {preview.loading ? (
            <p className="text-sm text-muted-foreground">Loading library…</p>
          ) : (
            <div className="space-y-3">
              {libraryRows.slice(0, 200).map((row, index) => (
                <Card key={`${row.kind}-${row.title}-${index}`}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div><p className="font-medium">{row.title}</p><p className="text-xs text-muted-foreground">{row.year || "—"} · {row.kind === "show" ? "TV series" : row.kind === "movie" ? "Movie" : "Unresolved"} · {completePhysicalReleasesFor(row.groups).length} physical releases</p></div>
                      <StatusBadge value={row.kind === "show" ? "SERIES" : row.kind === "movie" ? "MOVIE" : "UNRESOLVED"} />
                    </div>
                    {row.kind === "show" ? (
                      <div className="space-y-2 border-l-2 pl-3">
                        {[...new Set(row.groups.map((group) => group.identity?.season || 0))].sort((a, b) => a - b).map((season) => {
                          const seasonGroups = row.groups.filter((group) => (group.identity?.season || 0) === season);
                          const releases = completePhysicalReleasesFor(seasonGroups);
                          return <details key={season} className="rounded border p-3"><summary className="cursor-pointer font-medium">Season {season || "unknown"} · {seasonGroups.length} episodes · {releases.length} physical releases</summary><div className="mt-3"><LibraryReleaseList releases={releases} selectedIds={new Set(selectedDeleteItems.keys())} onToggle={toggleLibraryRelease} onSelectAll={selectLibraryReleases} onDetails={showLibraryReleaseDetails} /></div></details>;
                        })}
                      </div>
                    ) : <LibraryReleaseList releases={completePhysicalReleasesFor(row.groups)} selectedIds={new Set(selectedDeleteItems.keys())} onToggle={toggleLibraryRelease} onSelectAll={selectLibraryReleases} onDetails={showLibraryReleaseDetails} />}
                  </CardContent>
                </Card>
              ))}
              {libraryRows.length === 0 && <Card><CardContent className="p-6 text-sm text-muted-foreground">No contents match the current filters.</CardContent></Card>}
            </div>
          )}
        </>
      )}
      {preset === "missing" && (
        <>
          <ErrorBox error={missing.error} />
          {missing.loading ? (
            <p className="text-sm text-muted-foreground">
              Loading missing profiles…
            </p>
          ) : (
            <div className="space-y-3">
              {missingRows.map((row) => <Card key={`${row.mediaType}:${row.title}:${row.season || "movie"}`}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><p className="font-medium">{row.title}{row.mediaType === "tv" ? ` · Season ${row.season ?? "unknown"}` : ""}</p><p className="text-xs text-muted-foreground">{row.year || "—"} · {row.mediaType === "tv" ? `${row.items.length} missing episode${row.items.length === 1 ? "" : "s"}` : "movie"}</p></div>
                    <StatusBadge value="REQUIREMENT MISSING" />
                  </div>
                  <div className="space-y-2 border-l-2 pl-3">
                    {row.items.map((item: any, index: number) => {
                      const identity = item.contentIdentity || {};
                      const versions = missingNeedVersions(item);
                      const itemKey = item.dismissalKey || item.id || String(index);
                      const dismissed = item.decision === "dismissed";
                      return <div key={itemKey} className="rounded border p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-medium">{row.mediaType === "tv" ? episodeLabel(identity) || `Episode ${identity.episode || item.episode || "unknown"}` : row.title}</p><p className="text-xs text-muted-foreground">profile {item.profileName || item.profileId || item.missingProfileId || "—"} · {item.whatIsMissing || item.reason || "profile target not satisfied"}</p></div><div className="flex items-center gap-2">{dismissed ? <StatusBadge value="DISMISSED" /> : <StatusBadge value="MISSING" />}<Button size="sm" variant="outline" onClick={() => setSelected(selected?.id === itemKey ? null : { ...item, id: itemKey })}>Details</Button><Button size="sm" variant="ghost" onClick={() => void missingAction(item, dismissed ? "restore" : "dismiss")}>{dismissed ? "Restore" : "Dismiss"}</Button></div></div>
                        {!dismissed && versions.length > 0 && <div className="mt-2 space-y-2">{versions.map((version: any) => { const fingerprint = version.fingerprint || {}; const storage = fingerprint.storage || {}; const video = fingerprint.video || {}; const name = String(storage.path || version.releaseName || version.filename || version.id).split(/[\\/]/).pop(); return <div key={version.id} className="rounded border p-2 text-xs"><p className="break-all font-medium">Current file · {name}</p><p className="mt-1 text-muted-foreground">{video.resolution || "resolution unknown"} · {video.codec || "codec unknown"} · audio {uniqueLanguages(fingerprint.audio || []) || "unknown"} · subtitles {uniqueLanguages(fingerprint.subtitles || []) || "none"} · {formatSize(storage.size)}</p>{failedRequirementText(version).map((reason, reasonIndex) => <p key={reasonIndex} className="mt-1 text-amber-700">{reason}</p>)}</div>; })}</div>}
                        {selected?.id === itemKey && <DetailPanel providerId={provider.providerId} item={{ ...item, id: itemKey, allowIdentityActions: false }} onClose={() => setSelected(null)} />}
                      </div>;
                    })}
                  </div>
                </CardContent>
              </Card>)}
              {needs.length === 0 && (
                <Card>
                  <CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
                    <p>Every identified movie and episode currently reaches the target of its enabled profile.</p>
                    {!missing.data?.adapter?.canRequest && <p>Acquisition preview is unavailable because the corresponding request gateway is disabled.</p>}
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>
      )}
      {preset === "review" && (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-semibold">Review queue</p>
                <p className="text-sm text-muted-foreground">
                  {identityOnly
                    ? "Identity issues with a manual Resolve Identity action."
                    : "Identity and recoverability issues that need an operator decision. Policy-only items are shown in Policy Missing. Restore-safety blockers are shown in Policy Delete."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>All <Badge variant="outline">{review ? contentReviewEntries.length : "—"}</Badge></span>
                <span>Identity <Badge variant={review?.summary?.identityIssues > 0 ? "destructive" : "outline"}>{review?.summary?.identityIssues ?? "—"}</Badge></span>
                <span>Recoverability <Badge variant="outline">{review?.summary?.recoverabilityIssues ?? "—"}</Badge></span>
              </div>
            </CardContent>
          </Card>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
            <span className="text-sm font-medium">Review status</span>
            <select className="rounded border bg-background p-2 text-sm" value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value as typeof reviewStatus)}>
              <option value="pending">Pending</option>
              <option value="dismissed">Dismissed</option>
              <option value="all">All statuses</option>
            </select>
            <select className="rounded border bg-background p-2 text-sm" value={reviewIssueFilter} onChange={(event) => setReviewIssueFilter(event.target.value as typeof reviewIssueFilter)}>
              <option value="all">All issues</option>
              <option value="identity">Identity issues</option>
              <option value="recoverability">Recoverability issues</option>
            </select>
            <span className="text-xs text-muted-foreground">Dismissed items remain auditable and can be restored.</span>
          </div>
          <ErrorBox error={reviewError} />
          {!review ? (
            <p className="text-sm text-muted-foreground">
              Loading review queue…
            </p>
          ) : (
            <div className="space-y-3">
              {contentReviewEntries.filter((entry: any) => {
                if (identityOnly && !entry.issueTypes?.includes("IDENTITY_ISSUE")) return false;
                if (reviewIssueFilter === "identity" && !entry.issueTypes?.includes("IDENTITY_ISSUE")) return false;
                if (reviewIssueFilter === "recoverability" && !entry.issueTypes?.includes("RECOVERABILITY_ISSUE")) return false;
                return true;
              }).map((entry: any) => {
                const enriched = enrichReviewEntry(entry);
                const expanded = selected?.key === entry.key;
                return <div key={entry.id || entry.key} className="space-y-2">
                  <Card>
                    <CardContent className="space-y-3 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div><p className="font-medium">{entry.title || entry.sourceBasename || "Unidentified content"}{episodeLabel(entry.identity || entry) ? ` · ${episodeLabel(entry.identity || entry)}` : ""}</p><p className="break-all text-xs text-muted-foreground">{entry.year || "—"} · {entry.kind || "unknown"}{entry.sourceBasename ? ` · ${entry.sourceBasename}` : ""}</p></div>
                        <div className="flex flex-wrap gap-1">{(entry.issueTypes || []).map((issue: string) => <StatusBadge key={issue} value={issue} />)}</div>
                      </div>
                      <p className="text-sm font-medium">{(entry.blockers || []).slice(0, 3).join(" · ") || "Review required"}</p>
                      {(enriched.versions || []).map((version: any) => {
                        const fingerprint = version.fingerprint || {};
                        const storage = fingerprint.storage || {};
                        const video = fingerprint.video || {};
                        const requirements = failedRequirementText(version);
                        return <div key={version.id} className="rounded border p-3 text-xs"><p className="break-all font-medium">{String(storage.path || version.releaseName || version.filename || version.id).split(/[\\/]/).pop()}</p><p className="mt-1 text-muted-foreground">{video.resolution || "resolution unknown"} · {video.codec || "codec unknown"} · audio {uniqueLanguages(fingerprint.audio || []) || "unknown"} · {formatSize(storage.size)} · {storage.provider || "provider unknown"} · ProviderItem {storage.torrentId || "unknown"}</p>{requirements.map((reason, index) => <p key={index} className="mt-1 text-amber-700">{reason}</p>)}</div>;
                      })}
                      {entry.issueTypes?.includes("IDENTITY_ISSUE") && entry.decision !== "dismissed" && <IdentityResolver reviewId={entry.organizerReview?.id} versionGroupId={entry.versionGroupId} versionIds={entry.versionIds} providerId={provider.providerId} identity={entry.identity} initialQuery={entry.title || entry.sourceBasename} initialType={entry.kind === "episode" ? "tv" : "movie"} initialYear={entry.year} existingOverride={entry.organizerReview?.override} actionLabel={entry.organizerReview?.override ? "Change Match" : "Resolve Identity"} onSaved={() => void loadReview()} />}
                      <div className="flex flex-wrap gap-2">
                        {entry.organizerReview && (entry.decision === "dismissed" ? <Button size="sm" onClick={() => requestReviewAction(entry.organizerReview.id, { action: "retry" }, entry)}><RefreshCw className="mr-2 h-4 w-4" />Restore to Review</Button> : <><Button size="sm" variant="secondary" onClick={() => requestReviewAction(entry.organizerReview.id, { decision: "accepted" }, entry.organizerReview)}><Check className="mr-2 h-4 w-4" />Accept as detected</Button><Button size="sm" variant="destructive" onClick={() => requestReviewAction(entry.organizerReview.id, { decision: "dismissed" }, entry.organizerReview)}><X className="mr-2 h-4 w-4" />Dismiss</Button><Button size="sm" variant="outline" onClick={() => requestReviewAction(entry.organizerReview.id, { action: "retry" }, entry.organizerReview)}><RefreshCw className="mr-2 h-4 w-4" />Retry / Resume</Button></>)}
                        {!entry.organizerReview && (entry.decision === "dismissed" ? <Button size="sm" onClick={() => requestReviewAction(entry.key, { action: "restore" }, entry)}><RefreshCw className="mr-2 h-4 w-4" />Restore to Review</Button> : <Button size="sm" variant="outline" onClick={() => requestReviewAction(entry.key, { action: "dismiss" }, entry)}><X className="mr-2 h-4 w-4" />Dismiss</Button>)}
                        <Button size="sm" variant="ghost" onClick={() => setSelected(expanded ? null : enriched)}><ExternalLink className="mr-2 h-4 w-4" />{expanded ? "Close details" : "Details"}</Button>
                      </div>
                    </CardContent>
                  </Card>
                  {expanded && <DetailPanel providerId={provider.providerId} item={enriched} onClose={() => setSelected(null)} onReviewAction={requestReviewAction} onSaved={() => { void loadReview(); setSelected(null); }} />}
                </div>;
              })}
              {review && contentReviewEntries.filter((entry: any) => {
                if (identityOnly && !entry.issueTypes?.includes("IDENTITY_ISSUE")) return false;
                if (reviewIssueFilter === "identity" && !entry.issueTypes?.includes("IDENTITY_ISSUE")) return false;
                if (reviewIssueFilter === "recoverability" && !entry.issueTypes?.includes("RECOVERABILITY_ISSUE")) return false;
                return true;
              }).length === 0 && (
                <Card><CardContent className="p-6 text-sm text-muted-foreground">No review items match the selected filter.</CardContent></Card>
              )}
            </div>
          )}
        </>
      )}
      {selected && preset !== "missing" && preset !== "review" && (
        <DetailPanel providerId={provider.providerId} item={selected} onClose={() => setSelected(null)} onReviewAction={requestReviewAction} onSaved={() => { void loadReview(); setSelected(null); }} />
      )}
      {confirmation && <ConfirmationDialog open={Boolean(confirmation)} onOpenChange={(open) => !open && setConfirmation(null)} title={confirmation.title} description={confirmation.description} context={confirmation.context} confirmLabel={confirmation.confirmLabel} variant={confirmation.variant} onConfirm={async () => { await confirmation.onConfirm(); setConfirmation(null); }} />}
    </div>
  );
}

function Migration({ section = "export" }: { section?: string }) {
  const capabilities = useJson<any>("/api/version-manager/migration/capabilities");
  const [sourceProvider, setSourceProvider] = useState("alldebrid");
  const [targetProvider, setTargetProvider] = useState("realdebrid");
  const state = useJson<any>(`/api/version-manager/migration/state?source=${encodeURIComponent(sourceProvider)}&target=${encodeURIComponent(targetProvider)}`);
  const [mode, setMode] = useState("FULL");
  const [fileError, setFileError] = useState("");
  const [importPlan, setImportPlan] = useState<any>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [selectedExport, setSelectedExport] = useState<Set<string>>(new Set());
  const [selectedImport, setSelectedImport] = useState<Set<string>>(new Set());
  const [backupToImport, setBackupToImport] = useState("");
  const [migrationJob, setMigrationJob] = useState<any>(null);
  const [migrationStartError, setMigrationStartError] = useState("");
  const magnetBackups = useJson<any>(`/api/version-manager/magnet-backup?provider=${encodeURIComponent(sourceProvider)}`);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupSchedule, setBackupSchedule] = useState<any>(null);
  const [backupToDelete, setBackupToDelete] = useState<any>(null);
  const [backupNotice, setBackupNotice] = useState("");
  const [backupError, setBackupError] = useState("");
  useEffect(() => { if (magnetBackups.data?.schedule) setBackupSchedule(magnetBackups.data.schedule); }, [magnetBackups.data?.schedule?.updatedAt]);
  async function previewFile(file: File) {
    setLoadingFile(true);
    setFileError("");
    try {
      const text = await file.text();
      const body = file.name.toLowerCase().endsWith(".json")
        ? { targetProvider, manifest: JSON.parse(text) }
        : { targetProvider, magnetsText: text };
      const response = await fetch("/api/version-manager/import/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJsonResponse<any>(response, "Import preview");
      setImportPlan(data);
      setSelectedImport(new Set());
    } catch (value: any) {
      setFileError(value.message || "Unable to preview import");
    } finally {
      setLoadingFile(false);
    }
  }
  const exportItems = state.data?.items || [];
  const effectiveReady = exportItems.filter(
    (item: any) => item.effectiveStatus === "READY_TO_IMPORT",
  );
  async function createMagnetBackup(mode: "FULL" | "INCREMENTAL") {
    setBackupBusy(true); setBackupError(""); setBackupNotice("");
    try {
      const response = await fetch("/api/version-manager/magnet-backup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: sourceProvider, mode }) });
      const body = await readJsonResponse<any>(response, "Magnet backup");
      await magnetBackups.reload();
      setBackupNotice(`${mode === "FULL" ? "Full" : "Incremental"} backup created.`);
      return body;
    } catch (error: any) { setBackupError(error.message || "Backup failed"); throw error; } finally { setBackupBusy(false); }
  }
  async function saveBackupSchedule() {
    setBackupBusy(true); setBackupError(""); setBackupNotice("");
    try { const response = await fetch("/api/version-manager/magnet-backup", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(backupSchedule) }); const body = await readJsonResponse<any>(response, "Saving backup schedule"); setBackupSchedule(body.schedule); setBackupNotice(body.schedule.enabled ? "Automatic backup schedule saved." : "Automatic backups disabled."); await magnetBackups.reload(); }
    catch (error: any) { setBackupError(error.message || "Unable to save backup schedule"); }
    finally { setBackupBusy(false); }
  }
  async function deleteBackup(backup: any) {
    setBackupBusy(true); setBackupError(""); setBackupNotice("");
    try { const response = await fetch(`/api/version-manager/magnet-backup/${encodeURIComponent(backup.id)}`, { method: "DELETE" }); await readJsonResponse<any>(response, "Deleting backup"); if (backupToImport === backup.id) setBackupToImport(""); setBackupNotice(`Backup from ${new Date(backup.createdAt).toLocaleString()} deleted.`); await magnetBackups.reload(); }
    catch (error: any) { setBackupError(error.message || "Unable to delete backup"); throw error; }
    finally { setBackupBusy(false); }
  }
  async function startMigration() {
    if (!importPlan || !selectedImport.size || !window.confirm("Start the selected migration? The source provider is not modified; the target provider will receive the selected magnets.")) return;
    setMigrationStartError("");
    const items = (importPlan.items || []).filter((item: any) => selectedImport.has(item.infoHash || String(item.index)));
    try {
      const response = await fetch("/api/version-manager/migration/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "START_MIGRATION", sourceProvider, targetProvider, items }) });
      const body = await readJsonResponse<any>(response, "Starting migration");
      setMigrationJob(body.job);
    } catch (error: any) { setMigrationStartError(error.message || "Unable to start migration"); }
  }
  async function previewMagnetBackup(id: string) {
    if (!id) return;
    setLoadingFile(true); setFileError("");
    try {
      const backupResponse = await fetch(`/api/version-manager/magnet-backup/${encodeURIComponent(id)}`, { cache: "no-store" });
      const backup = await readJsonResponse<any>(backupResponse, "Magnet backup");
      if (!backup.document.manifest) throw new Error("This incremental backup requires its full baseline before preview");
      const response = await fetch("/api/version-manager/import/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetProvider, manifest: backup.document.manifest }) });
      setImportPlan(await readJsonResponse<any>(response, "Import preview")); setSelectedImport(new Set());
    } catch (error: any) { setFileError(error.message || "Unable to preview magnet backup"); } finally { setLoadingFile(false); }
  }
  useEffect(() => {
    if (!migrationJob?.id || ["COMPLETED", "PARTIAL", "FAILED"].includes(migrationJob.status)) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/version-manager/migration/jobs/${encodeURIComponent(migrationJob.id)}`, { cache: "no-store" });
      if (response.ok) setMigrationJob((await response.json()).job);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [migrationJob?.id, migrationJob?.status]);
  const toggle = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    id: string,
  ) =>
    setter((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const selectedIds = [...selectedExport].join(",");
  const providerList = capabilities.data?.providers || [];
  const sourceInfo = providerList.find((provider: any) => provider.providerId === sourceProvider);
  const targetInfo = providerList.find((provider: any) => provider.providerId === targetProvider);
  const routeInfo = capabilities.data?.routes?.find((route: any) => route.sourceProvider === sourceProvider && route.targetProvider === targetProvider);
  const capability = (provider: any, name: string) => provider?.capabilities?.find((item: any) => item.capability === name);
  const capabilityLevel = (provider: any, name: string) => capability(provider, name)?.validation || "UNVALIDATED";
  const exportSupported = ["inventory", "magnetExport", "recoverability"].every((name) => { const item = capability(sourceInfo, name); return item && item.support !== "UNSUPPORTED" && item.support !== "UNKNOWN"; });
  const importSupported = ["inventory", "importMagnet", "infohash"].every((name) => { const item = capability(targetInfo, name); return item && item.support !== "UNSUPPORTED" && item.support !== "UNKNOWN"; });
  return (
    <div className="space-y-6">
      <Header
        view="migration"
        title="Backup & Migration"
        description="Portable export, safe import preview and migration history."
      />
      <div className="flex flex-wrap gap-2">
        <Button asChild variant={section === "export" ? "default" : "outline"}>
          <Link href="/media-manager/migration/export">
          <Archive className="mr-2 h-4 w-4" />
          Export
          </Link>
        </Button>
        <Button asChild variant={section === "import" ? "default" : "outline"}>
          <Link href="/media-manager/migration/import">
          <FileUp className="mr-2 h-4 w-4" />
          Migration Preview
          </Link>
        </Button>
        <Button asChild variant={section === "history" ? "default" : "outline"}>
          <Link href="/media-manager/migration/history">
          Jobs / History
          </Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Provider capabilities</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">Source provider
              <select className="mt-1 block w-full rounded border bg-background p-2" value={sourceProvider} onChange={(event) => { setSourceProvider(event.target.value); setSelectedExport(new Set()); }}>
                {providerList.map((provider: any) => <option key={provider.providerId} value={provider.providerId} disabled={!provider.configured}>{provider.displayName}{provider.configured ? "" : " (not configured)"}</option>)}
              </select>
            </label>
            <label className="text-sm">Target provider
              <select className="mt-1 block w-full rounded border bg-background p-2" value={targetProvider} onChange={(event) => { setTargetProvider(event.target.value); setImportPlan(null); }}>
                {providerList.map((provider: any) => <option key={provider.providerId} value={provider.providerId} disabled={!provider.configured}>{provider.displayName}{provider.configured ? "" : " (not configured)"}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <StatusBadge value={`SOURCE EXPORT: ${capabilityLevel(sourceInfo, "magnetExport")}`} />
            <StatusBadge value={`SOURCE RECOVERY: ${capabilityLevel(sourceInfo, "recoverability")}`} />
            <StatusBadge value={`TARGET IMPORT: ${capabilityLevel(targetInfo, "importMagnet")}`} />
            <StatusBadge value={`ROUTE: ${routeInfo?.level || "UNVALIDATED"}`} />
          </div>
          <p className="text-xs text-muted-foreground">Capabilities are declared per provider. The route is not assumed symmetric; only AllDebrid → Real-Debrid is currently E2E validated.</p>
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Source items" value={state.loading ? "…" : state.error ? "Unavailable" : state.data?.sourceItems ?? "Not calculated"} />
        <Stat
          label="Already present/equivalent"
          value={state.loading ? "…" : state.error ? "Unavailable" : state.data?.effective?.alreadyPresent ?? "Not calculated"}
        />
        <Stat
          label="Rejected legal"
          value={state.loading ? "…" : state.error ? "Unavailable" : state.data?.effective?.rejectedLegal ?? "Not calculated"}
        />
        <Stat
          label="Import All Missing"
          value={state.loading ? "…" : state.error ? "Unavailable" : state.data?.effective?.residualTentableReady ?? "Not calculated"}
          detail="effective ready only"
        />
      </div>
      {state.error && /provider is not configured/i.test(state.error)
        ? <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300">Migration preview is unavailable because {state.error.toLowerCase()}. Configure the provider in <Link className="underline" href="/settings">Settings</Link>, or select another configured route.</div>
        : <ErrorBox error={state.error ? `Migration state is not calculated: ${state.error}` : ""} />}
      <Card id="export">
        <CardHeader>
          <CardTitle className="text-base">Export</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!exportSupported && <ErrorBox error="Export is unavailable for the selected source provider because its declared capabilities are unsupported." />}
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm">
              Mode{" "}
              <select
                className="ml-2 rounded border bg-background p-2"
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value);
                  setSelectedExport(new Set());
                }}
              >
                <option>FULL</option>
                <option>KEEP</option>
                <option>PRIMARY</option>
                <option>REMOTE</option>
                <option>PRIMARY+REMOTE</option>
                <option>SELECTED</option>
              </select>
            </label>
            {mode === "SELECTED" && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setSelectedExport(
                      new Set(
                        exportItems
                          .filter(
                            (item: any) =>
                              item.status !== "REVIEW" &&
                              item.effectiveStatus !== "REJECTED_LEGAL",
                          )
                          .map(
                            (item: any) => item.providerItemId || item.infoHash,
                          ),
                      ),
                    )
                  }
                >
                  Select all eligible
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedExport(new Set())}
                >
                  Clear
                </Button>
                <span className="text-sm text-muted-foreground">
                  Selected {selectedExport.size} items
                </span>
              </>
            )}
          </div>
          {mode === "SELECTED" && (
            <div className="max-h-56 overflow-auto rounded border">
              {exportItems.map((item: any, index: number) => {
                const id =
                  item.providerItemId || item.infoHash || String(index);
                const disabled =
                  item.status === "REVIEW" ||
                  item.effectiveStatus === "REJECTED_LEGAL";
                return (
                  <label
                    className="flex items-center gap-2 border-b p-2 text-sm last:border-0"
                    key={id}
                  >
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={selectedExport.has(id)}
                      onChange={() => toggle(setSelectedExport, id)}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {item.originalName || "item"}
                    </span>
                    <StatusBadge value={item.effectiveStatus || item.status} />
                  </label>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <a
                href={exportSupported ? `/api/version-manager/export?provider=${encodeURIComponent(sourceProvider)}&mode=${encodeURIComponent(mode)}&format=manifest${mode === "SELECTED" ? `&selected=${encodeURIComponent(selectedIds)}` : ""}` : "#export"}
              >
                <Download className="mr-2 h-4 w-4" />
                manifest.json
              </a>
            </Button>
            <Button asChild variant="outline">
              <a
                href={exportSupported ? `/api/version-manager/export?provider=${encodeURIComponent(sourceProvider)}&mode=${encodeURIComponent(mode)}&format=magnets${mode === "SELECTED" ? `&selected=${encodeURIComponent(selectedIds)}` : ""}` : "#export"}
              >
                <Download className="mr-2 h-4 w-4" />
                magnets.txt
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card id="magnet-backup">
        <CardHeader><CardTitle className="text-base">Magnet Backup</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Stores provider magnet references and file metadata only; it never downloads media bytes.</p>
          <div className="rounded border p-3 text-sm"><p className="font-medium">Server backup folder</p><p className="mt-1 text-xs text-muted-foreground">Backup Now, incremental backups and scheduled backups use this server path. Changing it does not move or delete files in the previous folder.</p>{backupSchedule ? <input aria-label="Server backup folder" className="mt-2 w-full rounded border bg-background p-2 font-mono text-xs" value={backupSchedule.storageDirectory || magnetBackups.data?.storageDirectory || "/data/magnet-backups"} onChange={(event) => setBackupSchedule((current: any) => ({ ...current, storageDirectory: event.target.value }))} /> : <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{magnetBackups.loading ? "Loading…" : magnetBackups.data?.storageDirectory || "Unavailable"}</p>}</div>
          {backupSchedule && <div className="space-y-3 rounded border p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">Automatic backup schedule</p><p className="text-xs text-muted-foreground">The scheduler runs inside SchröDrive and uses the selected timezone.</p></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={backupSchedule.enabled === true} onChange={(event) => setBackupSchedule((current: any) => ({ ...current, enabled: event.target.checked, provider: current.provider || sourceProvider }))} /> Enabled</label></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="grid gap-1 text-xs"><span>Provider</span><select className="rounded border bg-background p-2 text-sm" value={backupSchedule.provider || sourceProvider} onChange={(event) => setBackupSchedule((current: any) => ({ ...current, provider: event.target.value }))}>{providerList.filter((provider: any) => provider.configured).map((provider: any) => <option key={provider.providerId} value={provider.providerId}>{provider.displayName || provider.providerId}</option>)}</select></label>
            <label className="grid gap-1 text-xs"><span>Backup type</span><select className="rounded border bg-background p-2 text-sm" value={backupSchedule.mode || "FULL"} onChange={(event) => setBackupSchedule((current: any) => ({ ...current, mode: event.target.value }))}><option value="FULL">Full</option><option value="INCREMENTAL">Incremental</option></select></label>
            <label className="grid gap-1 text-xs"><span>Frequency</span><select className="rounded border bg-background p-2 text-sm" value={backupSchedule.frequency || "DAILY"} onChange={(event) => setBackupSchedule((current: any) => ({ ...current, frequency: event.target.value }))}><option value="DAILY">Every day</option><option value="WEEKLY">Every week</option></select></label>
            <label className="grid gap-1 text-xs"><span>Time</span><input className="rounded border bg-background p-2 text-sm" type="time" value={backupSchedule.time || "03:00"} onChange={(event) => setBackupSchedule((current: any) => ({ ...current, time: event.target.value }))} /></label>
            {backupSchedule.frequency === "WEEKLY" && <label className="grid gap-1 text-xs"><span>Weekday</span><select className="rounded border bg-background p-2 text-sm" value={backupSchedule.weekday ?? 0} onChange={(event) => setBackupSchedule((current: any) => ({ ...current, weekday: Number(event.target.value) }))}>{["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
            <label className="grid gap-1 text-xs"><span>Timezone</span><input className="rounded border bg-background p-2 text-sm" value={backupSchedule.timezone || "Europe/Rome"} onChange={(event) => setBackupSchedule((current: any) => ({ ...current, timezone: event.target.value }))} /></label>
            <label className="grid gap-1 text-xs"><span>Keep latest</span><input className="rounded border bg-background p-2 text-sm" type="number" min="1" max="1000" value={backupSchedule.keepLatest ?? 90} onChange={(event) => setBackupSchedule((current: any) => ({ ...current, keepLatest: Number(event.target.value) }))} /></label>
            <label className="grid gap-1 text-xs"><span>Keep monthly</span><input className="rounded border bg-background p-2 text-sm" type="number" min="0" max="120" value={backupSchedule.keepMonthly ?? 24} onChange={(event) => setBackupSchedule((current: any) => ({ ...current, keepMonthly: Number(event.target.value) }))} /></label>
          </div><div className="flex flex-wrap items-center gap-3"><Button size="sm" disabled={backupBusy} onClick={() => void saveBackupSchedule()}>Save schedule</Button><span className="text-xs text-muted-foreground">{backupSchedule.lastRunAt ? `Last run: ${new Date(backupSchedule.lastRunAt).toLocaleString()} · ${backupSchedule.lastStatus || "UNKNOWN"}` : "No scheduled run yet."}</span></div>{backupSchedule.lastError && <p className="text-xs text-destructive">{backupSchedule.lastError}</p>}</div>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={backupBusy || !sourceInfo?.configured} onClick={() => void createMagnetBackup("FULL").catch(() => undefined)}>Backup Now</Button>
            <Button size="sm" variant="outline" disabled={backupBusy || !sourceInfo?.configured} onClick={() => void createMagnetBackup("INCREMENTAL").catch(() => undefined)}>Incremental Backup</Button>
          </div>
          <ErrorBox error={backupError} />{backupNotice && <p className="rounded border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">{backupNotice}</p>}
          <p className="text-xs text-muted-foreground">{magnetBackups.loading ? "Loading backup history…" : `${magnetBackups.data?.backups?.length || 0} backup records`}</p>
          <div className="max-h-80 space-y-2 overflow-auto">{(magnetBackups.data?.backups || []).map((backup: any) => <div className="flex flex-wrap items-center justify-between gap-3 rounded border p-3 text-xs" key={backup.id}><div><p className="font-medium">{backup.mode} · {backup.itemCount} items · {backup.provider}</p><p className="text-muted-foreground">{backup.valid ? "VALID" : "INVALID"} · {new Date(backup.createdAt).toLocaleString()}{backup.baseBackupId ? " · depends on full baseline" : ""}</p></div><Button size="sm" variant="destructive" disabled={backupBusy} onClick={() => setBackupToDelete(backup)}>Delete backup</Button></div>)}{!magnetBackups.loading && !(magnetBackups.data?.backups || []).length && <p className="rounded border p-3 text-sm text-muted-foreground">No backups recorded for this provider.</p>}</div>
        </CardContent>
      </Card>
      <Card id="import">
        <CardHeader>
          <CardTitle className="text-base">Migration Preview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!importSupported && <ErrorBox error="Migration preview is unavailable for the selected target provider because its declared capabilities are unsupported." />}
          <p className="text-sm text-muted-foreground">
            Analyze a manifest or magnets file, reconcile it with the target,
            select eligible items, then use the explicit confirmation to start
            a persistent target-provider migration job. The source provider
            is never modified.
          </p>
          <input
            type="file"
            accept=".json,.txt,.magnet"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void previewFile(file);
            }}
            disabled={loadingFile}
          />
          <div className="flex flex-wrap items-center gap-2"><select className="rounded border bg-background p-2 text-sm" value={backupToImport} onChange={(event) => { setBackupToImport(event.target.value); void previewMagnetBackup(event.target.value); }}><option value="">Import from Magnet Backup…</option>{(magnetBackups.data?.backups || []).map((backup: any) => <option key={backup.id} value={backup.id}>{backup.mode} · {backup.createdAt}</option>)}</select><span className="text-xs text-muted-foreground">Read-only preview; no import starts here.</span></div>
          <ErrorBox error={fileError} />
          {!importPlan && <div className="flex flex-wrap items-center gap-2"><Button disabled>Execute Migration</Button><span className="text-xs text-muted-foreground">Generate a valid migration preview and select eligible items to enable execution.</span></div>}
          {importPlan && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setSelectedImport(
                      new Set(
                        (importPlan.items || [])
                          .filter(
                            (item: any) =>
                              (state.data?.effectiveByProviderItemId?.[
                                item.providerItemId
                              ] || item.status) === "READY_TO_IMPORT",
                          )
                          .map(
                            (item: any) => item.infoHash || String(item.index),
                          ),
                      ),
                    )
                  }
                >
                  Select all effective ready
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedImport(new Set())}
                >
                  Clear
                </Button>
                <span className="text-sm text-muted-foreground">
                  Selected {selectedImport.size} items
                </span>
              </div>
              <div className="max-h-56 overflow-auto rounded border">
                {(importPlan.items || []).map((item: any) => {
                  const id = item.infoHash || String(item.index);
                  const effectiveStatus =
                    state.data?.effectiveByProviderItemId?.[
                      item.providerItemId
                    ] || item.status;
                  const eligible = effectiveStatus === "READY_TO_IMPORT";
                  return (
                    <label
                      className="flex items-center gap-2 border-b p-2 text-sm last:border-0"
                      key={id}
                    >
                      <input
                        type="checkbox"
                        disabled={!eligible}
                        checked={selectedImport.has(id)}
                        onChange={() => toggle(setSelectedImport, id)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {item.originalName ||
                          item.infoHash ||
                          `item ${item.index}`}
                      </span>
                      <StatusBadge value={effectiveStatus} />
                    </label>
                  );
                })}
              </div>
              <ErrorBox error={migrationStartError} />
              {migrationJob && <div className="rounded border p-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><b>Migration job {migrationJob.status}</b><span>{migrationJob.processed}/{migrationJob.total}</span></div><p className="mt-1 text-muted-foreground">Imported {migrationJob.imported} · skipped {migrationJob.skipped} · failed {migrationJob.failed}</p></div>}
              <Button disabled={!selectedImport.size || !importSupported || Boolean(migrationJob && ["QUEUED", "RUNNING"].includes(migrationJob.status))} onClick={() => void startMigration()}>Execute Migration</Button>
            </>
          )}
        </CardContent>
      </Card>
      <Card id="history">
        <CardHeader>
          <CardTitle className="text-base">Jobs / History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(state.data?.jobs || []).map((job: any) => (
            <details className="rounded border p-3" key={job.jobId}>
              <summary className="flex cursor-pointer flex-wrap gap-3">
                <span className="font-mono text-xs">{job.jobId}</span>
                <StatusBadge value={job.status} />
                <span className="text-sm text-muted-foreground">
                  {job.total} items · {job.sourceProvider} →{" "}
                  {job.targetProvider}
                </span>
              </summary>
              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
                <span>
                  Imported <b>{job.imported}</b>
                </span>
                <span>
                  Skipped <b>{job.skipped}</b>
                </span>
                <span>
                  Rejected legal <b>{job.rejectedLegal}</b>
                </span>
                <span>
                  Failed <b>{job.failed}</b>
                </span>
              </div>
              <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                {(job.items || []).slice(0, 50).map((item: any) => (
                  <p key={`${item.infoHash}-${item.createdAt}`}>
                    {item.infoHash} · {item.status}{" "}
                    {item.reason ? `· ${item.reason}` : ""}
                  </p>
                ))}
              </div>
            </details>
          ))}
          {!state.loading && !(state.data?.jobs || []).length && (
            <p className="text-sm text-muted-foreground">
              No migration jobs recorded.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Effective migration state</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            Raw provider state is reconciled with audit. Legal rejections are
            never silently retried.
          </p>
          <div className="overflow-x-auto rounded border">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="p-2">Item</th>
                  <th className="p-2">Hash</th>
                  <th className="p-2">Raw</th>
                  <th className="p-2">Effective</th>
                  <th className="p-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {(state.data?.items || [])
                  .slice(0, 100)
                  .map((item: any, index: number) => (
                    <tr
                      className="border-t"
                      key={`${item.infoHash || "item"}-${index}`}
                    >
                      <td className="max-w-xs truncate p-2">
                        {item.originalName || "—"}
                      </td>
                      <td className="p-2 font-mono text-xs">
                        {item.infoHash || "—"}
                      </td>
                      <td className="p-2">
                        <StatusBadge value={item.status} />
                      </td>
                      <td className="p-2">
                        <StatusBadge value={item.effectiveStatus} />
                      </td>
                      <td className="max-w-xs p-2 text-xs text-muted-foreground">
                        {item.reason || "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      {backupToDelete && <ConfirmationDialog open onOpenChange={(open) => !open && setBackupToDelete(null)} title="Delete this backup?" description="This permanently removes the local backup JSON from the server. Provider media and magnets are not changed." context={<div className="space-y-1"><p><b>{backupToDelete.mode}</b> · {backupToDelete.itemCount} items</p><p>{new Date(backupToDelete.createdAt).toLocaleString()} · {backupToDelete.provider}</p></div>} confirmLabel="Delete backup" variant="destructive" onConfirm={async () => { await deleteBackup(backupToDelete); setBackupToDelete(null); }} />}
    </div>
  );
}

const RULE_FIELD_CONFIG: Record<string, { label: string; type: "enum" | "text" | "number" | "boolean"; values?: string[] }> = {
  resolution: { label: "Resolution", type: "enum", values: ["4320p", "2160p", "1440p", "1080p", "720p", "576p", "480p"] },
  source: { label: "Source", type: "enum", values: ["REMUX", "BLURAY", "WEB-DL", "WEBRIP", "HDTV"] },
  codec: { label: "Video codec", type: "enum", values: ["HEVC", "AV1", "H264", "AVC"] },
  audioCodec: { label: "Audio codec", type: "enum", values: ["TRUEHD", "DTS-HD MA", "DTS-HD", "DDP", "EAC3", "AAC"] },
  audioLanguage: { label: "Audio language", type: "enum", values: ["ita", "eng", "fra", "deu", "spa", "jpn", "original"] },
  subtitleLanguage: { label: "Subtitle language", type: "enum", values: ["ita", "eng", "fra", "deu", "spa", "jpn", "original"] },
  hdr: { label: "HDR", type: "boolean" },
  dolbyVision: { label: "Dolby Vision", type: "boolean" },
  atmos: { label: "Atmos", type: "boolean" },
  bitrate: { label: "Bitrate", type: "number" },
  fileSize: { label: "File size (bytes)", type: "number" },
  channels: { label: "Audio channels", type: "number" },
  container: { label: "Container", type: "enum", values: ["mkv", "mp4", "m4v", "avi", "ts", "m2ts", "webm"] },
  originalLanguage: { label: "Original language", type: "enum", values: ["ita", "eng", "fra", "deu", "spa", "heb", "jpn"] },
  identityConfidence: { label: "Identity confidence", type: "number" },
  mediaType: { label: "Media type", type: "enum", values: ["movie", "episode", "unknown"] },
  profileEligible: { label: "Profile eligible", type: "boolean" },
};
const RULE_FIELDS = Object.keys(RULE_FIELD_CONFIG);
const TEXT_OPERATORS = ["equals", "not_equals", "contains", "not_contains", "exists", "not_exists"];
const NUMBER_OPERATORS = ["equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "exists", "not_exists"];
const BOOLEAN_OPERATORS = ["equals", "not_equals", "exists", "not_exists"];

function operatorsForField(field: string) {
  const type = RULE_FIELD_CONFIG[field]?.type || "text";
  return type === "number" ? NUMBER_OPERATORS : type === "boolean" ? BOOLEAN_OPERATORS : TEXT_OPERATORS;
}

function defaultRuleValue(field: string) {
  const config = RULE_FIELD_CONFIG[field];
  if (config?.type === "boolean") return false;
  if (config?.type === "number") return 0;
  return config?.values?.[0] || "";
}

function RuleValueEditor({ field, value, onChange }: { field: string; value: unknown; onChange: (value: unknown) => void }) {
  const config = RULE_FIELD_CONFIG[field] || { label: field, type: "text" as const };
  if (config.type === "boolean") return <select className="rounded border bg-background p-1 text-sm" value={String(value === true)} onChange={(event) => onChange(event.target.value === "true")}><option value="true">true</option><option value="false">false</option></select>;
  if (config.type === "number") return <input className="w-32 rounded border bg-background p-1 text-sm" type="number" value={String(value ?? "")} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} />;
  if (config.type === "enum") return <select className="rounded border bg-background p-1 text-sm" value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>{config.values?.map((item) => <option key={item}>{item}</option>)}</select>;
  return <input className="min-w-28 rounded border bg-background p-1 text-sm" value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />;
}

function RuleBuilder({ node, onChange, onRemove, root = false }: { node: any; onChange: (node: any) => void; onRemove?: () => void; root?: boolean }) {
  const addCondition = () => onChange({ ...(node?.op === "AND" || node?.op === "OR" ? node : { op: "AND", children: [] }), children: [...(node?.children || []), { op: "COMPARE", field: "resolution", operator: "equals", value: "2160p" }] });
  const addGroup = () => onChange({ ...(node?.op === "AND" || node?.op === "OR" ? node : { op: "AND", children: [] }), children: [...(node?.children || []), { op: "AND", children: [{ op: "COMPARE", field: "resolution", operator: "equals", value: "1080p" }] }] });
  if (node?.op === "NOT") return <div className="rounded border border-dashed p-2"><div className="flex items-center justify-between"><b>NOT</b>{!root && <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>}</div><RuleBuilder node={node.child} root onChange={(child) => onChange({ ...node, child })} /></div>;
  if (node?.op === "AND" || node?.op === "OR") return <div className="space-y-2 rounded border p-2"><div className="flex flex-wrap items-center gap-2"><select className="rounded border bg-background p-1 text-sm" value={node.op} onChange={(event) => onChange({ ...node, op: event.target.value })}><option>AND</option><option>OR</option></select>{!root && <Button size="sm" variant="ghost" onClick={onRemove}>Remove group</Button>}<Button size="sm" variant="outline" onClick={addCondition}>Add condition</Button><Button size="sm" variant="outline" onClick={addGroup}>Add group</Button><Button size="sm" variant="outline" onClick={() => onChange({ op: "NOT", child: { op: "COMPARE", field: "resolution", operator: "equals", value: "2160p" } })}>Add NOT</Button></div>{(node.children || []).map((child: any, index: number) => <RuleBuilder key={index} node={child} onChange={(next) => onChange({ ...node, children: node.children.map((item: any, itemIndex: number) => itemIndex === index ? next : item) })} onRemove={() => onChange({ ...node, children: node.children.filter((_: any, itemIndex: number) => itemIndex !== index) })} />)}</div>;
  const field = node?.field || "resolution";
  const operator = node?.operator || "equals";
  const changeField = (nextField: string) => onChange({ op: "COMPARE", field: nextField, operator: operatorsForField(nextField)[0], value: defaultRuleValue(nextField) });
  if (node?.op === "IN") return <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/20 p-2"><span className="text-xs text-muted-foreground">{RULE_FIELD_CONFIG[field]?.label || field}</span><b>in</b><input className="min-w-48 rounded border bg-background p-1 text-sm" value={(node.values || []).join(", ")} onChange={(event) => onChange({ ...node, values: event.target.value.split(",").map((item: string) => item.trim()).filter(Boolean) })} />{!root && <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>}</div>;
  if (node?.op === "HAS") return <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/20 p-2"><select className="rounded border bg-background p-1 text-sm" value={field} onChange={(event) => changeField(event.target.value)}>{RULE_FIELDS.map((item) => <option key={item} value={item}>{RULE_FIELD_CONFIG[item].label}</option>)}</select><b>has</b><RuleValueEditor field={field} value={node.value} onChange={(value) => onChange({ ...node, value })} />{!root && <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>}</div>;
  return <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/20 p-2"><select className="rounded border bg-background p-1 text-sm" value={field} onChange={(event) => changeField(event.target.value)}>{RULE_FIELDS.map((item) => <option key={item} value={item}>{RULE_FIELD_CONFIG[item].label}</option>)}</select><select className="rounded border bg-background p-1 text-sm" value={operator} onChange={(event) => onChange({ ...node, operator: event.target.value })}>{operatorsForField(field).map((item) => <option key={item}>{item}</option>)}</select>{!["exists", "not_exists"].includes(operator) && <RuleValueEditor field={field} value={node?.value} onChange={(value) => onChange({ ...node, value })} />}{!root && <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>}</div>;
}

function ScoringRuleEditor({ rule, onChange, onRemove }: { rule: ScoringRule; onChange: (rule: ScoringRule) => void; onRemove: () => void }) {
  const field = rule.field || "resolution";
  const mode = rule.op || "COMPARE";
  const operator = rule.operator || "equals";
  const changeField = (nextField: string) => onChange({ ...rule, field: nextField, operator: operatorsForField(nextField)[0], value: defaultRuleValue(nextField), values: undefined });
  const changeMode = (nextMode: string) => onChange(nextMode === "IN" ? { op: "IN", field, values: [String(defaultRuleValue(field))], weight: rule.weight } : nextMode === "HAS" ? { op: "HAS", field, value: defaultRuleValue(field), weight: rule.weight } : { op: "COMPARE", field, operator: operatorsForField(field)[0], value: defaultRuleValue(field), weight: rule.weight });
  return <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/20 p-2"><select className="rounded border bg-background p-1 text-sm" value={field} onChange={(event) => changeField(event.target.value)} aria-label="Scoring field">{RULE_FIELDS.map((item) => <option key={item} value={item}>{RULE_FIELD_CONFIG[item].label}</option>)}</select><select className="rounded border bg-background p-1 text-sm" value={mode} onChange={(event) => changeMode(event.target.value)} aria-label="Scoring match mode"><option value="COMPARE">compare</option><option value="IN">in</option><option value="HAS">has</option></select>{mode === "COMPARE" && <><select className="rounded border bg-background p-1 text-sm" value={operator} onChange={(event) => onChange({ ...rule, op: "COMPARE", operator: event.target.value })} aria-label="Scoring operator">{operatorsForField(field).map((item) => <option key={item}>{item}</option>)}</select>{!["exists", "not_exists"].includes(operator) && <RuleValueEditor field={field} value={rule.value} onChange={(value) => onChange({ ...rule, op: "COMPARE", value })} />}</>}{mode === "IN" && <input className="min-w-48 rounded border bg-background p-1 text-sm" value={(rule.values || []).join(", ")} onChange={(event) => onChange({ ...rule, op: "IN", values: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} aria-label="Scoring values" />}{mode === "HAS" && <RuleValueEditor field={field} value={rule.value} onChange={(value) => onChange({ ...rule, op: "HAS", value })} />}<input className="w-24 rounded border bg-background p-1 text-sm" type="number" value={String(rule.weight ?? 0)} onChange={(event) => onChange({ ...rule, weight: Number(event.target.value) })} aria-label="Scoring weight" /><Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button></div>;
}

function validateUiRule(node: any): string | undefined {
  if (!node || typeof node !== "object") return "Rule is incomplete";
  if (node.op === "AND" || node.op === "OR") {
    if (!Array.isArray(node.children) || (node.op === "OR" && node.children.length === 0)) return `${node.op} group must contain at least one condition`;
    for (const child of node.children) { const error = validateUiRule(child); if (error) return error; }
    return undefined;
  }
  if (node.op === "NOT") return validateUiRule(node.child);
  if (!["COMPARE", "IN", "HAS"].includes(node.op) || !RULE_FIELD_CONFIG[node.field]) return "Select a supported rule field";
  const config = RULE_FIELD_CONFIG[node.field];
  if (node.op === "IN") return Array.isArray(node.values) && node.values.length > 0 ? undefined : "IN requires at least one value";
  if (["exists", "not_exists"].includes(node.operator)) return undefined;
  if (node.value === undefined || node.value === null || node.value === "") return "This operator requires a value";
  if (config.type === "number" && (typeof node.value !== "number" || !Number.isFinite(node.value))) return `${config.label} requires a numeric value`;
  if (config.type === "boolean" && typeof node.value !== "boolean") return `${config.label} requires true or false`;
  return undefined;
}

const LANGUAGE_CODES = ["ita", "eng", "spa", "fra", "deu", "jpn", "heb", "original"];
function LanguageCodePicker({ label, values, onChange, ariaLabel, ordered = false }: { label: string; values: string[]; onChange: (values: string[]) => void; ariaLabel: string; ordered?: boolean }) {
  const [pending, setPending] = useState("");
  const add = () => { if (pending && !values.includes(pending)) { onChange([...values, pending]); setPending(""); } };
  const remove = (code: string) => onChange(values.filter((value) => value !== code));
  const move = (index: number, direction: -1 | 1) => { const next = index + direction; if (next < 0 || next >= values.length) return; const copy = [...values]; [copy[index], copy[next]] = [copy[next], copy[index]]; onChange(copy); };
  return <div className="grid gap-2"><span>{label}</span><div className="flex flex-wrap gap-2"><select className="rounded border bg-background p-2 text-sm" aria-label={`${ariaLabel} code`} value={pending} onChange={(event) => setPending(event.target.value)}><option value="">Select language code…</option>{LANGUAGE_CODES.filter((code) => !values.includes(code)).map((code) => <option key={code} value={code}>{code}</option>)}</select><Button type="button" size="sm" variant="outline" onClick={add} disabled={!pending}>Add</Button></div>{values.length ? <div className="flex flex-wrap gap-2">{values.map((code, index) => <span key={code} className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"><code>{code}</code>{ordered && <><button type="button" aria-label={`Move ${code} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button type="button" aria-label={`Move ${code} down`} disabled={index === values.length - 1} onClick={() => move(index, 1)}>↓</button></>}<button type="button" aria-label={`Remove ${code}`} onClick={() => remove(code)}>×</button></span>)}</div> : <span className="text-xs text-muted-foreground">None configured — leave empty for no language preference.</span>}</div>;
}

function SettingsView({ section = "profiles" }: { section?: string }) {
  const provider = useMediaManagerProvider();
  const providerQuery = provider.providerId ? `provider=${encodeURIComponent(provider.providerId)}` : "";
  const status = useJson<any>(`/api/version-manager/status?${providerQuery}`, Boolean(provider.providerId));
  const sectionIds = ["profiles", "languages", "rules", "safety", "retention"];
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [policy, setPolicy] = useState<any>({ acquisitionMode: "ARR", enableRemote: false, acquireMissingRemote: false, preferCompletePack: false, safety: { deleteDryRun: true, requireRecoverableBeforeDelete: true, allowDeleteWhenIdentityUncertain: false, allowDeleteWhenMetadataIncomplete: false } });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [saveError, setSaveError] = useState("");
  const [persistedSettings, setPersistedSettings] = useState("");
  const [impact, setImpact] = useState<any>(null);
  const [requiredAudioInput, setRequiredAudioInput] = useState("");
  const [preferredAudioInput, setPreferredAudioInput] = useState("");
  const [requiredSubtitleInput, setRequiredSubtitleInput] = useState("");
  const [preferredSubtitleInput, setPreferredSubtitleInput] = useState("");
  useEffect(() => {
    if (status.data?.profiles) {
      const nextProfiles = status.data.profiles as Profile[];
      const nextPolicy = status.data.policy || policy;
      const nextRetentionProfile = nextProfiles.find((profile) => profile.target === "QUALITY" && profile.enabled)
        || nextProfiles.find((profile) => profile.target !== "DIRECT_PLAY");
      const languagePolicy = nextRetentionProfile?.languagePolicy || {};
      const legacyTrack = { required: languagePolicy.required || { values: [], mode: "ALL" }, preferred: languagePolicy.preferred || [], original: languagePolicy.original === true, missingRequiredAction: languagePolicy.missingRequiredAction || "REVIEW" };
      const audioPolicy = languagePolicy.audio || (languagePolicy.scope === "SUBTITLE" ? { required: { values: [], mode: "ALL" }, preferred: [], original: false } : legacyTrack);
      const subtitlePolicy = languagePolicy.subtitles || (languagePolicy.scope === "SUBTITLE" ? legacyTrack : { required: { values: [], mode: "ALL" }, preferred: [] });
      setProfiles(nextProfiles);
      setPolicy(nextPolicy);
      setRequiredAudioInput((audioPolicy.required?.values || []).join(", "));
      setPreferredAudioInput((audioPolicy.preferred || []).join(", "));
      setRequiredSubtitleInput((subtitlePolicy.required?.values || []).join(", "));
      setPreferredSubtitleInput((subtitlePolicy.preferred || []).join(", "));
      setPersistedSettings(JSON.stringify({ profiles: nextProfiles, policy: nextPolicy }));
    }
  }, [status.data]);
  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash.slice(1);
      const next = sectionIds.includes(hash) ? hash : section;
      requestAnimationFrame(() => document.getElementById(`media-manager-${next}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [section]);
  const settingsSnapshot = JSON.stringify({ profiles, policy });
  const hasUnsavedChanges = persistedSettings !== "" && settingsSnapshot !== persistedSettings;
  const retentionProfileIndex = profiles.findIndex((profile) => profile.target === "QUALITY" && profile.enabled) >= 0
    ? profiles.findIndex((profile) => profile.target === "QUALITY" && profile.enabled)
    : profiles.findIndex((profile) => profile.target !== "DIRECT_PLAY");
  const retentionProfile = retentionProfileIndex >= 0 ? profiles[retentionProfileIndex] : undefined;
  async function save() {
    setSaving(true);
    setSaved("");
    setSaveError("");
    try {
      for (const profile of profiles) {
        const ruleError = validateUiRule(profile.hardRequirements || { op: "AND", children: [] });
        if (ruleError) throw new Error(`${profile.name || profile.id}: ${ruleError}`);
        for (const rule of profile.scoringRules || []) {
          const scoringError = validateUiRule({ ...rule, op: rule.op || "COMPARE" });
          if (scoringError) throw new Error(`${profile.name || profile.id}: scoring rule is invalid — ${scoringError}`);
          if (!Number.isFinite(Number(rule.weight))) throw new Error(`${profile.name || profile.id}: scoring weight must be numeric`);
        }
      }
      const response = await fetch("/api/version-manager/profiles", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profiles, policy }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to save configuration");
      setSaved("Saved");
      setPersistedSettings(settingsSnapshot);
    } catch (value: any) {
      setSaveError(value.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }
  async function previewImpact() {
    setSaved("");
    setSaveError("");
    try {
      const response = await fetch("/api/version-manager/profiles/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider.providerId, profiles, policy }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Impact preview unavailable");
      setImpact(payload);
    } catch (value: any) { setSaved(value.message || "Impact preview unavailable"); }
  }
  function updateProfile(index: number, patch: Partial<Profile>) { setProfiles((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  const parseLanguages = (value: string) => value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  function updateLanguageTrack(kind: "audio" | "subtitles", patch: Record<string, unknown>) {
    if (!retentionProfile) return;
    const languagePolicy = retentionProfile.languagePolicy || {};
    const empty = { required: { values: [], mode: "ALL" }, preferred: [], ...(kind === "audio" ? { original: false } : {}), missingRequiredAction: "REVIEW" };
    const legacy = { required: languagePolicy.required || empty.required, preferred: languagePolicy.preferred || [], original: languagePolicy.original === true, missingRequiredAction: languagePolicy.missingRequiredAction || "REVIEW" };
    const fallback = kind === "audio"
      ? (languagePolicy.scope === "SUBTITLE" ? empty : legacy)
      : (languagePolicy.scope === "SUBTITLE" ? legacy : empty);
    updateProfile(retentionProfileIndex, { languagePolicy: { ...languagePolicy, [kind]: { ...fallback, ...(languagePolicy[kind] || {}), ...patch } } } as any);
  }
  const currentLanguagePolicy = retentionProfile?.languagePolicy || {};
  const legacyLanguageTrack = { required: currentLanguagePolicy.required || { values: [], mode: "ALL" }, preferred: currentLanguagePolicy.preferred || [], original: currentLanguagePolicy.original === true, missingRequiredAction: currentLanguagePolicy.missingRequiredAction || "REVIEW" };
  const audioLanguagePolicy = currentLanguagePolicy.audio || (currentLanguagePolicy.scope === "SUBTITLE" ? { required: { values: [], mode: "ALL" }, preferred: [], original: false, missingRequiredAction: "REVIEW" } : legacyLanguageTrack);
  const subtitleLanguagePolicy = currentLanguagePolicy.subtitles || (currentLanguagePolicy.scope === "SUBTITLE" ? legacyLanguageTrack : { required: { values: [], mode: "ALL" }, preferred: [], missingRequiredAction: "REVIEW" });
  return (
    <div className="w-full min-w-0 space-y-6" data-testid="media-manager-settings">
      <Header
        view="settings"
        title="Media Manager Settings"
        description="Configure local retention criteria and safety for files already present."
      />
      <ProviderSelector providers={provider.providers} value={provider.providerId} onChange={(value) => { provider.selectProvider(value); setImpact(null); }} />
      <ErrorBox error={provider.error} />
      <Card id="media-manager-identity" className="scroll-mt-20">
        <CardHeader><CardTitle className="text-base">Identity resolution</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-start gap-3 rounded border p-3">
            <input className="mt-1" type="checkbox" checked={policy.useArrIdentityResolution === true} onChange={(event) => setPolicy((current: any) => ({ ...current, useArrIdentityResolution: event.target.checked }))} />
            <span><span className="font-medium">Use ARR parser for unresolved identities</span><span className="mt-1 block text-muted-foreground">When enabled, Media Manager may ask Radarr or Sonarr to parse an unresolved movie or episode path. This is an identity-resolution helper, not an import scan or acquisition request.</span></span>
          </label>
          <p className="text-xs text-muted-foreground">Radarr/Sonarr URL and API key remain in <Link className="underline" href="/settings">General Settings → ARR</Link>. If ARR is disabled or unavailable, the normal Media Manager resolution and Review fallback remains in effect.</p>
        </CardContent>
      </Card>
      <Card id="media-manager-profiles" className="scroll-mt-20">
        <CardHeader><CardTitle className="text-base">How retention decides</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded border p-3"><p className="font-medium">1 · Admissibility</p><p className="text-xs text-muted-foreground">Required audio, subtitles and additional mandatory rules decide whether a version may compete.</p></div>
            <div className="rounded border p-3"><p className="font-medium">2 · One winner</p><p className="text-xs text-muted-foreground">Among admissible versions, language and resolution preferences select one KEEP. File size is used only for equivalent resolution and audio languages.</p></div>
            <div className="rounded border p-3"><p className="font-medium">3 · Safe outcome</p><p className="text-xs text-muted-foreground">Uncertain evidence goes to Review. A losing version becomes a candidate only with a surviving replacement and all deletion protections satisfied.</p></div>
          </div>
          {retentionProfile && (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"
              key={retentionProfile.id}
            >
              <div>
                <p className="font-medium">Current file retention</p>
                <p className="text-xs text-muted-foreground">
                  Evaluated locally on files already present.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="grid gap-1 text-xs"><span>Preferred resolution <span className="text-muted-foreground">(preference, not requirement)</span></span><input className="w-28 rounded border bg-background p-2 text-sm" value={retentionProfile.preferredResolution || ""} onChange={(event) => updateProfile(retentionProfileIndex, { preferredResolution: event.target.value })} /></label>
                <label>
                <input
                  type="checkbox"
                  checked={retentionProfile.enabled}
                  onChange={(event) =>
                    updateProfile(retentionProfileIndex, { enabled: event.target.checked })
                  }
                />
                Evaluate this policy
                </label>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save retention policy"}
            </Button>
            <Button variant="outline" onClick={() => void previewImpact()}>Preview impact</Button>
            {saved && (
              <span className="text-sm text-muted-foreground">{saved}</span>
            )}
            {saveError && <span className="text-sm text-destructive">{saveError}</span>}
          </div>
          {impact && <div className="space-y-3 rounded border bg-muted/20 p-3 text-sm"><div><p className="font-medium">Read-only impact preview</p><p className="text-muted-foreground">Nothing was saved and no files were changed. {impact.changed?.length || 0} version decisions would change.</p></div><div className="grid gap-2 sm:grid-cols-3">{["KEEP", "DELETE_CANDIDATE", "REVIEW"].map((decision) => <div key={decision} className="rounded border p-2"><p className="text-xs text-muted-foreground">{decision.replaceAll("_", " ")}</p><p className="font-medium">{impact.current?.decisions?.[decision] || 0} → {impact.proposed?.decisions?.[decision] || 0}</p></div>)}</div></div>}
        </CardContent>
      </Card>
      <Card id="media-manager-languages" className="scroll-mt-20">
        <CardHeader><CardTitle className="text-base">Language requirements and preferences</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">Audio and subtitle tracks are evaluated independently. Choose canonical language codes from the menus; add more than one value when needed and order preferred languages by priority.</p>
          {retentionProfile && <div className="grid gap-4 xl:grid-cols-2">
            <div className="space-y-3 rounded border p-3"><div><p className="font-medium">Audio tracks</p><p className="text-xs text-muted-foreground">Mandatory languages determine admissibility; preferred languages help choose the single winner.</p></div><div className="grid gap-2 sm:grid-cols-2">
              <LanguageCodePicker label="Required audio languages" ariaLabel="Required audio languages" values={audioLanguagePolicy.required?.values || []} onChange={(values) => updateLanguageTrack("audio", { required: { ...audioLanguagePolicy.required, values } })} />
              <label className="grid gap-1 text-xs"><span>Match</span><select className="rounded border bg-background p-2 text-sm" aria-label="Required audio match" value={audioLanguagePolicy.required?.mode || "ALL"} onChange={(event) => updateLanguageTrack("audio", { required: { ...audioLanguagePolicy.required, mode: event.target.value } })}><option value="ALL">All required</option><option value="ANY">Any required</option></select></label>
              <LanguageCodePicker label="Preferred audio languages, in order" ariaLabel="Preferred audio languages" ordered values={audioLanguagePolicy.preferred || []} onChange={(values) => updateLanguageTrack("audio", { preferred: values })} />
              <label className="grid gap-1 text-xs"><span>If required audio is missing</span><select className="rounded border bg-background p-2 text-sm" aria-label="Missing required audio action" value={audioLanguagePolicy.missingRequiredAction || "REVIEW"} onChange={(event) => updateLanguageTrack("audio", { missingRequiredAction: event.target.value })}><option value="REVIEW">Needs review</option><option value="DELETE_IF_REPLACED">Candidate only with replacement</option></select></label>
              <label className="flex items-center gap-2 self-end rounded border p-2"><input type="checkbox" checked={audioLanguagePolicy.original === true} onChange={(event) => updateLanguageTrack("audio", { original: event.target.checked })} /> Prefer original-language audio</label>
            </div></div>
            <div className="space-y-3 rounded border p-3"><div><p className="font-medium">Subtitle tracks</p><p className="text-xs text-muted-foreground">Subtitle requirements never satisfy an audio requirement, and audio never satisfies a subtitle requirement.</p></div><div className="grid gap-2 sm:grid-cols-2">
              <LanguageCodePicker label="Required subtitle languages" ariaLabel="Required subtitle languages" values={subtitleLanguagePolicy.required?.values || []} onChange={(values) => updateLanguageTrack("subtitles", { required: { ...subtitleLanguagePolicy.required, values } })} />
              <label className="grid gap-1 text-xs"><span>Match</span><select className="rounded border bg-background p-2 text-sm" aria-label="Required subtitle match" value={subtitleLanguagePolicy.required?.mode || "ALL"} onChange={(event) => updateLanguageTrack("subtitles", { required: { ...subtitleLanguagePolicy.required, mode: event.target.value } })}><option value="ALL">All required</option><option value="ANY">Any required</option></select></label>
              <LanguageCodePicker label="Preferred subtitle languages, in order" ariaLabel="Preferred subtitle languages" ordered values={subtitleLanguagePolicy.preferred || []} onChange={(values) => updateLanguageTrack("subtitles", { preferred: values })} />
              <label className="grid gap-1 text-xs sm:col-span-2"><span>If required subtitles are missing</span><select className="rounded border bg-background p-2 text-sm" aria-label="Missing required subtitle action" value={subtitleLanguagePolicy.missingRequiredAction || "REVIEW"} onChange={(event) => updateLanguageTrack("subtitles", { missingRequiredAction: event.target.value })}><option value="REVIEW">Needs review</option><option value="DELETE_IF_REPLACED">Candidate only with replacement</option></select></label>
            </div></div>
          </div>}
          <p className="text-xs text-muted-foreground">This release uses provider data and filename-derived metadata. Technical stream probing is deferred; unknown evidence stays in Review.</p>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card id="media-manager-safety" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-base">Safety</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="rounded border p-3"><label className="flex items-start gap-3"><input className="mt-1" type="checkbox" checked={policy.safety?.deleteDryRun !== false} onChange={(event) => setPolicy((current: any) => ({ ...current, safety: { ...current.safety, deleteDryRun: event.target.checked } }))} /><span><span className="flex items-center gap-2 font-medium"><StatusBadge value={policy.safety?.deleteDryRun !== false ? "DRY RUN" : "LIVE"} /> Dry run only</span><span className="mt-1 block text-muted-foreground">When enabled, Delete performs all candidate and provider checks but cannot call the provider delete API.</span></span></label></div>
            {policy.safety?.deleteDryRun === false && <p className="rounded border border-destructive/50 bg-destructive/5 p-3 text-destructive"><b>Live deletion is enabled.</b> Each eligible ProviderItem still requires explicit confirmation and is revalidated immediately before deletion.</p>}
            <label className="flex items-center gap-2"><input type="checkbox" checked={policy.safety?.requireRecoverableBeforeDelete !== false} onChange={(event) => setPolicy((current: any) => ({ ...current, safety: { ...current.safety, requireRecoverableBeforeDelete: event.target.checked } }))} /> Require recoverability before candidate</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={policy.safety?.allowDeleteWhenIdentityUncertain === true} onChange={(event) => setPolicy((current: any) => ({ ...current, safety: { ...current.safety, allowDeleteWhenIdentityUncertain: event.target.checked } }))} /> Allow uncertain identity (not recommended)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={policy.safety?.allowDeleteWhenMetadataIncomplete === true} onChange={(event) => setPolicy((current: any) => ({ ...current, safety: { ...current.safety, allowDeleteWhenMetadataIncomplete: event.target.checked } }))} /> Allow incomplete metadata (not recommended)</label>
            <p className="text-muted-foreground">
              Recoverability requirements remain fail-closed.
            </p>
          </CardContent>
        </Card>
        <Card id="media-manager-retention" className="scroll-mt-20">
          <CardHeader><CardTitle>Retention</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">One version wins. After mandatory audio and subtitle requirements pass, size is the final tie-breaker between equally ranked files at the same resolution.</p>
            <label className="flex items-center gap-2"><input type="checkbox" checked={policy.preferCompletePack === true} onChange={(event) => setPolicy((current: any) => ({ ...current, preferCompletePack: event.target.checked }))} /> Prefer complete packs during delete impact analysis</label>
            {retentionProfile && <div className="grid gap-2 rounded border p-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="grid gap-1 text-xs"><span>For equally ranked files at the same resolution</span><select className="rounded border bg-background p-2 text-sm" value={retentionProfile.sizePreference || "IGNORE"} onChange={(event) => updateProfile(retentionProfileIndex, { sizePreference: event.target.value as Profile["sizePreference"] })}><option value="LARGER">Keep larger file</option><option value="SMALLER">Keep smaller file</option><option value="IGNORE">Do not use size</option></select></label>
              <label className="grid gap-1 text-xs"><span>Minimum size difference %</span><input className="w-28 rounded border bg-background p-2 text-sm" type="number" min="0" max="100" value={retentionProfile.minimumSizeDifferencePercent ?? 0} onChange={(event) => updateProfile(retentionProfileIndex, { minimumSizeDifferencePercent: Math.max(0, Number(event.target.value) || 0) })} /></label>
              {retentionProfile.target === "QUALITY" && <label className="grid gap-1 text-xs"><span>Release group consistency</span><select className="rounded border bg-background p-2 text-sm" aria-label="Release group consistency" value={retentionProfile.releaseGroupConsistency || "DISABLED"} onChange={(event) => updateProfile(retentionProfileIndex, { releaseGroupConsistency: event.target.value as Profile["releaseGroupConsistency"] })}><option value="DISABLED">Disabled</option><option value="SEASON">Prefer one release group per season</option></select><span className="text-muted-foreground">Used only when one release group clearly wins the season.</span></label>}
            </div>}
          </CardContent>
        </Card>
      </div>
      <Card id="media-manager-rules" className="scroll-mt-20">
        <CardHeader><CardTitle className="text-base">Advanced rules</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm"><p className="text-muted-foreground">Optional expert controls for cases not covered above. Codec and source do not imply quality unless you explicitly add a rule.</p>{retentionProfile && <><details className="rounded border p-3"><summary className="cursor-pointer font-medium">Additional mandatory requirements</summary><p className="mt-2 text-xs text-muted-foreground">A failed requirement makes the version inadmissible; it cannot be rescued by ranking points.</p><div className="mt-2"><RuleBuilder node={retentionProfile.hardRequirements || { op: "AND", children: [] }} root onChange={(hardRequirements) => updateProfile(retentionProfileIndex, { hardRequirements } as any)} /></div></details><details className="rounded border p-3"><summary className="cursor-pointer font-medium">Additional ranking adjustments</summary><p className="mt-2 text-xs text-muted-foreground">Applied only after mandatory requirements pass. A weight of zero has no effect.</p><div className="mt-2 space-y-2">{(retentionProfile.scoringRules || []).map((rule, ruleIndex) => <ScoringRuleEditor key={ruleIndex} rule={rule} onChange={(next) => updateProfile(retentionProfileIndex, { scoringRules: (retentionProfile.scoringRules || []).map((item, itemIndex) => itemIndex === ruleIndex ? next : item) })} onRemove={() => updateProfile(retentionProfileIndex, { scoringRules: (retentionProfile.scoringRules || []).filter((_, itemIndex) => itemIndex !== ruleIndex) })} />)}<Button size="sm" variant="outline" onClick={() => updateProfile(retentionProfileIndex, { scoringRules: [...(retentionProfile.scoringRules || []), { op: "COMPARE", field: "resolution", operator: "equals", value: "2160p", weight: 10 }] })}>Add ranking adjustment</Button>{Object.keys(retentionProfile.scoring || {}).length > 0 && <p className="text-xs text-muted-foreground">Legacy field weights are preserved for compatibility.</p>}</div></details></>}</CardContent>
      </Card>
      {(hasUnsavedChanges || saving || saved || saveError) && <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur">
        {hasUnsavedChanges && <span className="text-sm text-amber-700">Unsaved retention changes</span>}
        {saved && !hasUnsavedChanges && <span className="text-sm text-emerald-700">Retention policy saved</span>}
        {saveError && <span className="text-sm text-destructive">{saveError}</span>}
        <Button onClick={() => void save()} disabled={saving || !hasUnsavedChanges}>{saving ? "Saving…" : "Save retention policy"}</Button>
      </div>}
    </div>
  );
}
export function MediaManagerShell({ view, section }: { view: View; section?: string }) {
  if (view === "overview") return <Overview />;
  if (view === "library") return <Library initialPreset={section || "all"} />;
  if (view === "migration") return <Migration section={section || "export"} />;
  return <SettingsView section={section || "profiles"} />;
}
