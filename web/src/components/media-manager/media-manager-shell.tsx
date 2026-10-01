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
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DeleteImpactCards, ReviewActionGuide } from "./operator-guidance";
import { ProviderMigration } from "./provider-migration";
import { ConfirmationDialog } from "./confirmation-dialog";

type View = "overview" | "library" | "migration" | "settings";
type Profile = { id: string; name: string; enabled: boolean; priority?: number; description?: string; preferredResolution?: string; languagePolicy?: any; hardRequirements?: any; scoring?: Record<string, number>; scoringRules?: ScoringRule[]; sizePreference?: "LARGER" | "SMALLER" | "IGNORE"; minimumSizeDifferencePercent?: number; acquisitionBehavior?: string; target?: string; arrProfiles?: { movie?: { provider?: "radarr"; serverId: string; qualityProfileId: string; qualityProfileName?: string }; tv?: { provider?: "sonarr"; serverId: string; qualityProfileId: string; qualityProfileName?: string } } };
type ScoringRule = { op?: "COMPARE" | "IN" | "HAS"; field: string; operator?: string; value?: unknown; values?: unknown[]; weight: number };
type PendingConfirmation = { title: string; description: string; context?: ReactNode; confirmLabel: string; variant?: "default" | "secondary" | "outline" | "destructive"; onConfirm: () => Promise<void> };

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
  const version = item?.versions?.[0] || item?.existingVersions?.[0];
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

function episodeLabel(item: any): string {
  const season = item?.season ?? item?.contentIdentity?.season ?? item?.identity?.season;
  const episode = item?.episode ?? item?.contentIdentity?.episode ?? item?.identity?.episode;
  return season !== undefined && episode !== undefined ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}` : "";
}

function reviewGuidance(entry: any): { heading: string; explanation: string; action: string } {
  const codes = new Set<string>(entry.reasonCodes || []);
  const count = entry.versionIds?.length || 0;
  if (codes.has("policy_tie")) return {
    heading: "Equivalent versions: no unique winner",
    explanation: `${count || "Multiple"} admissible copies have the same ranking under the current policy. They are here because the one-winner rule cannot choose safely; no deletion candidate was created.`,
    action: "Choose the copy to keep below. The other tied copies will become deletion candidates, or change the ranking rules when the preference should apply to the whole provider.",
  };
  if (codes.has("required_audio_language_missing") || codes.has("required_subtitle_language_missing") || codes.has("hard_rule_failed") || codes.has("hard_requirement_failed")) return {
    heading: "Mandatory requirements are not met",
    explanation: "The inventoried versions fail at least one required audio, subtitle or hard-rule condition.",
    action: "Open Details to see the failed evidence. Correct the requirement in Settings if it is wrong, or add a compliant version, then run a new scan.",
  };
  if (codes.has("recoverability_unknown") || codes.has("recoverability_required")) return {
    heading: "Recoverability evidence is missing",
    explanation: "The policy cannot prove that the provider item can be restored, so it refuses to make an automatic removal decision.",
    action: "Restore the magnet or infohash evidence at the provider, then run a new scan. The current copy remains retained.",
  };
  if (entry.organizerReview) return {
    heading: "Identity needs an operator decision",
    explanation: "The organizer could not identify this file with enough confidence.",
    action: "Resolve Identity when the match is wrong or uncertain; Accept as detected only when the displayed identity is correct; Dismiss only hides this organizer task.",
  };
  return {
    heading: "Automatic decision is blocked",
    explanation: "The current evidence is insufficient for a safe one-winner retention decision.",
    action: "Open Details, correct the stated blocker, then run a new scan. No media is changed from this screen.",
  };
}

function ErrorBox({ error }: { error?: string }) {
  return error ? (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      {error}
    </div>
  ) : null;
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
    throw new Error(body?.error || `${operation} failed (HTTP ${response.status})`);
  }
  return body as T;
}

function IdentityResolver({
  reviewId,
  identity,
  initialQuery,
  initialType,
  initialYear,
  existingOverride,
  onSaved,
  actionLabel,
}: {
  reviewId?: string;
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
        body: JSON.stringify(reviewId ? { decision: "accepted", override } : { identity, override }),
      });
      const body = await readJsonResponse<any>(response, "Saving identity match");
      let evaluation = body;
      if (reviewId && identity) {
        const reevaluate = await fetch("/api/version-manager/identity/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity, override }) });
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
      const response = await fetch(reviewId ? `/api/organizer/review/${encodeURIComponent(reviewId)}` : "/api/version-manager/identity/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reviewId ? { action: "clear-match" } : { action: "clear", identity }) });
      const body = await readJsonResponse<any>(response, "Clearing manual identity");
      let evaluation = body;
      if (reviewId && identity) {
        const reevaluate = await fetch("/api/version-manager/identity/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clear", identity }) });
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
    const next = providers.some((provider: any) => provider.id === saved) ? saved : (providers.find((provider: any) => provider.default)?.id || providers[0].id);
    setProviderId((current) => providers.some((provider: any) => provider.id === current) ? current : next);
  }, [providerData.data]);
  const selectProvider = useCallback((value: string) => { setProviderId(value); window.localStorage.setItem("media-manager-provider", value); }, []);
  return { providers: providerData.data?.providers || [], providerId, selectProvider, loading: providerData.loading, error: providerData.error };
}

function ProviderSelector({ providers, value, onChange }: { providers: any[]; value: string; onChange: (value: string) => void }) {
  return <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3"><div><p className="text-sm font-semibold">Managed provider</p><p className="text-xs text-muted-foreground">Library decisions never cross provider boundaries.</p></div><select aria-label="Managed provider" className="min-w-48 rounded border bg-background p-2 text-sm" value={value} onChange={(event) => onChange(event.target.value)}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>)}</select></div>;
}

function SectionNav({ view, reviewCount }: { view: View; reviewCount?: number }) {
  const links = [
    ["Overview", "/media-manager"],
    ["Library", "/media-manager/library"],
    ["Backup & Migration", "/media-manager/migration"],
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

function DetailPanel({ item, onClose, onReviewAction, onSaved }: { item: any; onClose: () => void; onReviewAction?: (id: string, body: Record<string, unknown>, item?: any) => void; onSaved?: () => void }) {
  const review = item.review || (item.parsed ? item : undefined);
  const identity = item.identity || item.contentIdentity || (review ? { title: review.parsed?.title, year: review.parsed?.year, kind: review.parsed?.kind, confidence: review.parsed?.confidence, source: review.override ? "manual" : "unknown" } : {});
  const shownIdentity = displayIdentity(item);
  const versions = item.versions || item.existingVersions || [];
  const reviewStatus = review?.parsed?.status;
  const identityAction = review?.override ? "Change Match" : reviewStatus === "ambiguous" || reviewStatus === "unmatched" || reviewStatus === "fallback" || reviewStatus === "conflict" ? "Resolve Identity" : "Change Match";
  const leafName = (value: unknown) => String(value || "").split(/[\\/]/).pop() || "—";
  const versionDetails = (version: any) => {
    const fingerprint = version.fingerprint || {};
    const video = fingerprint.video || {};
    const storage = fingerprint.storage || {};
    const release = fingerprint.release || {};
    const audio = [...new Set((fingerprint.audio || []).map((item: any) => item.language).filter(Boolean))].join(", ");
    return { fingerprint, video, storage, release, audio, name: leafName(storage.path || version.files?.[0]?.path || version.releaseName || version.filename) };
  };
  const decisionVersions = versions.filter((version: any) => ["KEEP", "REVIEW", "DELETE_CANDIDATE"].includes(version.decision));
  const candidates = decisionVersions.filter((version: any) => version.decision === "DELETE_CANDIDATE");
  const keeps = decisionVersions.filter((version: any) => version.decision === "KEEP");
  const isPolicyTie = (item.reasonCodes || []).includes("policy_tie") || versions.some((version: any) => (version.reasons || []).some((reason: any) => reason.code === "policy_tie"));
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
        <section className="min-w-0">
          <h3 className="mb-2 font-semibold">Identity</h3>
          <dl className="space-y-1 text-muted-foreground">
            <p className="break-all">
              <b className="text-foreground">Title:</b>{" "}
              {shownIdentity.title}
            </p>
            <p>
              <b className="text-foreground">Year:</b> {shownIdentity.year || "—"}
            </p>
            <p>
              <b className="text-foreground">Type:</b>{" "}
              {identity.mediaType || identity.kind || item.mediaType || item.kind || "—"}
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
            <p className="break-all">
              <b className="text-foreground">Provenance:</b>{" "}
              {identity.provenance ? JSON.stringify(identity.provenance) : "—"}
            </p>
          </dl>
          {review && <div className="mt-4 rounded border bg-muted/20 p-3"><h3 className="mb-2 font-semibold">Detected identity</h3><p><b>Title:</b> {review.parsed?.title || "—"}</p><p><b>Type:</b> {review.parsed?.kind || "—"}</p><p><b>Status:</b> {review.parsed?.status || "—"}</p><p><b>Confidence:</b> {review.parsed?.confidence ?? "—"}</p><p><b>Reason:</b> {review.parsed?.reason || "—"}</p></div>}
          {review && <div className="mt-4 rounded border border-amber-500/40 bg-amber-500/5 p-3"><h3 className="mb-2 font-semibold">Problem and required action</h3><p>{(item.blockers || item.reasonCodes || []).join(" · ") || "The item requires operator review before an automatic decision is safe."}</p><p className="mt-1 text-xs text-muted-foreground">Identity confidence: {identity.confidence ?? "unknown"} · Recoverability: {item.recoverability?.status || "unknown"}</p><p className="mt-1 break-all text-xs text-muted-foreground">Source: {item.sourceBasename || review.sourceBasename || review.sourcePath || "not available"}</p></div>}
          {(identity.title || item.title) && (review || item.allowIdentityActions !== false) && <div className="mt-4"><h3 className="mb-2 font-semibold">Identity actions</h3><IdentityResolver reviewId={item.reviewId || review?.id} identity={{ title: identity.title || item.title, year: identity.year, kind: identity.kind, mediaType: identity.mediaType, tmdbId: identity.tmdbId }} initialQuery={identity.title || item.title} initialType={identity.kind === "episode" || identity.mediaType === "tv" ? "tv" : "movie"} initialYear={identity.year} existingOverride={item.override || review?.override || (identity.source === "manual" ? { tmdbId: identity.tmdbId } : undefined)} actionLabel={identityAction} onSaved={onSaved} /></div>}
          {review && onReviewAction && <div className="mt-4 flex flex-wrap gap-2">{review.decision === "dismissed" ? <Button size="sm" onClick={() => onReviewAction(review.id, { action: "retry" }, review)}>Restore to Review</Button> : <><Button size="sm" variant="secondary" onClick={() => onReviewAction(review.id, { decision: "accepted" }, review)}>Accept as detected</Button><Button size="sm" variant="outline" onClick={() => onReviewAction(review.id, { action: "retry" }, review)}>Retry / Resume</Button><Button size="sm" variant="destructive" onClick={() => onReviewAction(review.id, { decision: "dismissed" }, review)}>Dismiss</Button></>}</div>}
        </section>
        <section className="min-w-0">
          <h3 className="mb-2 font-semibold">Versions</h3>
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
          {candidates.length > 0 && <div className="mt-3 space-y-3 rounded border p-3"><p className="font-semibold">Decision comparison</p>{candidates.map((version: any) => <div key={version.id}><p><b>Candidate:</b> {versionDetails(version).name}</p><p>{(version.reasons || []).map((reason: any) => typeof reason === "string" ? reason : reason.message).join(" · ")}</p>{[...keeps, ...(item.alternativeVersions || [])].filter((keep: any) => !version.groupId || keep.groupId === version.groupId).map((keep: any) => <p key={keep.id}><b>Kept instead:</b> {versionDetails(keep).name}</p>)}</div>)}</div>}
          <p className="mt-2 text-muted-foreground">{isPolicyTie ? "No retained winner has been selected: the admissible versions remain tied and are all kept in Review." : "The retained version is the single best admissible version under the local retention policy."}</p>
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">{versions.flatMap((version: any) => (version.reasons || []).map((reason: any) => <p key={`${version.id}-${reason.code}`}>• {reason.message}</p>))}</div>
        </section>
        <section>
          <h3 className="mb-2 font-semibold">Safety</h3>
          {isDeleteImpact && <><p><b>Physical resource:</b> ProviderItem {item.providerItemId || "unknown"}</p><p><b>Physical deletion:</b> {item.protectedByKeep ? "PROTECTED" : item.state === "READY" ? "ELIGIBLE after final revalidation" : "BLOCKED"}</p>{item.protectedByKeep && <p className="text-amber-700">Protection reason: this ProviderItem is also referenced by a KEEP version or shared content.</p>}</>}
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
  const deleteCandidates = useJson<any>(`/api/version-manager/delete?scope=candidates&${providerQuery}`, Boolean(provider.providerId));
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
        const response = await fetch(`/api/version-manager/scan?${providerQuery}`, { cache: "no-store" });
        const body = await readJsonResponse<any>(response, "Scan status");
        if (!cancelled) setScanJob(body.job || null);
      } catch (value: any) {
        if (!cancelled) setScanError(value.message || "Unable to read scan status");
      }
    };
    void loadJob();
    return () => { cancelled = true; };
  }, [providerQuery]);

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
        description="Inventory, identity, one-version retention, review and provider migration in one place."
        reviewCount={identityIssues}
      />
      <ProviderSelector providers={provider.providers} value={provider.providerId} onChange={(value) => { provider.selectProvider(value); setScan(null); setScanJob(null); }} />
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
        <Stat label="Versions" value={evaluation?.counts?.versionCount ?? latestScan?.versionCount ?? "—"} detail="files evaluated" />
        <Stat label="Needs review" value={evaluation?.counts?.reviewCount ?? latestScan?.reviewCount ?? "—"} detail="uncertain decisions" />
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
            <p className="text-sm text-muted-foreground">Policy review</p>
            <p className="mt-1 text-2xl font-semibold">{evaluation?.counts?.reviewCount ?? latestScan?.reviewCount ?? "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Safety and policy blockers</p>
          </Link>
          <Link href="/media-manager/library/missing" className="rounded-md border p-3 transition-colors hover:border-primary">
            <p className="text-sm text-muted-foreground">Unresolved retention gaps</p>
            <p className="mt-1 text-2xl font-semibold">{evaluation ? evaluation.counts.primaryMissing || 0 : "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">No unique KEEP, unmet requirements, identity or recovery blocker</p>
          </Link>
          <Link href="/media-manager/library/delete-preview" className="rounded-md border p-3 transition-colors hover:border-primary">
            <p className="text-sm text-muted-foreground">Delete candidates</p>
            <p className="mt-1 text-2xl font-semibold">{deleteCandidates.loading ? "—" : deleteCandidates.data?.items?.length ?? "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Physically eligible · read-only preview</p>
          </Link>
        </CardContent>
      </Card>
      {evaluation?.status === "STALE" && <Card className="border-amber-500/50"><CardContent className="p-4 text-sm"><b>Policy evaluation is stale.</b> The current configuration differs from the snapshot evaluation; read-only projections are being recalculated from the existing snapshot, without rescanning providers.</CardContent></Card>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Retention policy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {profiles.filter((profile: Profile) => profile.target !== "DIRECT_PLAY").map((profile: Profile) => (
              <div className="flex justify-between text-sm" key={profile.id}>
                Local retention policy
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

function Library({ initialPreset = "all" }: { initialPreset?: string }) {
  const pathname = usePathname();
  const provider = useMediaManagerProvider();
  const providerQuery = provider.providerId ? `provider=${encodeURIComponent(provider.providerId)}` : "";
  const [preset, setPreset] = useState("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [mediaType, setMediaType] = useState("all");
  const [decision, setDecision] = useState("all");
  const [multipleVersions, setMultipleVersions] = useState(false);
  const [needsAttention, setNeedsAttention] = useState(false);
  const [sort, setSort] = useState("title");
  const [deleteScope, setDeleteScope] = useState("candidates");
  const [selected, setSelected] = useState<any>(null);
  const [reviewStatus, setReviewStatus] = useState<"pending" | "dismissed">("pending");
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [deleteBusy, setDeleteBusy] = useState("");
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
    (preset === "delete-preview" || preset === "delete") && Boolean(provider.providerId),
  );
  const deleteImpact = useJson<any>(
    `/api/version-manager/delete?scope=${encodeURIComponent(deleteScope)}&q=${encodeURIComponent(query)}&${providerQuery}`,
    (preset === "delete-preview" || preset === "delete") && Boolean(provider.providerId),
  );
  async function waitForRefresh(job: any) {
    if (!job?.id) return;
    for (let attempt = 0; attempt < 180; attempt++) {
      const response = await fetch(`/api/version-manager/scan/${encodeURIComponent(job.id)}`, { cache: "no-store" });
      const body = await readJsonResponse<any>(response, "Refreshing provider library");
      if (body.job?.status === "COMPLETED") return;
      if (["FAILED", "PARTIAL"].includes(body.job?.status)) throw new Error(body.job.lastError || "Provider library refresh failed");
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error("Provider library refresh timed out");
  }
  async function executeDelete(item: any) {
    const dryRun = deleteImpact.data?.dryRun !== false;
    const key = `${item.provider}:${item.providerItemId}`;
    setDeleteBusy(key);
    setDeleteNotice("");
    setDeleteError("");
    try {
      const response = await fetch("/api/version-manager/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: item.provider, providerItemId: item.providerItemId, snapshotId: deleteImpact.data?.snapshotId, dryRun, confirmation: dryRun ? undefined : item.providerItemId }) });
      const body = await readJsonResponse<any>(response, dryRun ? "Dry-run validation" : "Provider deletion");
      if (body.executed) {
        setDeleteNotice(`Deleted ${item.provider}:${item.providerItemId}. Updating this provider library…`);
        await waitForRefresh(body.refreshJob);
      }
      await deleteImpact.reload();
      await deletePreview.reload();
      setDeleteNotice(body.executed ? `Deleted ${item.provider}:${item.providerItemId}. Provider library updated.` : `Dry run passed for ${item.provider}:${item.providerItemId}. No provider data was deleted.`);
    } catch (value: any) {
      setDeleteError(value.message || "Delete action failed");
      throw value;
    } finally { setDeleteBusy(""); }
  }
  function requestDelete(item: any) {
    const dryRun = deleteImpact.data?.dryRun !== false;
    const gib = Number(item.physicalSize || 0) / 1024 / 1024 / 1024;
    setConfirmation({ title: dryRun ? "Run delete simulation?" : "Delete this ProviderItem?", description: dryRun ? "Dry run is enabled. SchröDrive will repeat every safety and provider check, but it cannot call the provider delete API." : "This is a real provider deletion. The current snapshot, replacement, protection and provider presence will be checked again immediately before deletion.", context: <div className="space-y-1"><p><b>Provider:</b> {item.provider}</p><p><b>ProviderItem:</b> {item.providerItemId}</p><p><b>Physical size:</b> {gib ? `${gib.toFixed(2)} GiB` : "unknown"}</p></div>, confirmLabel: dryRun ? "Run dry run" : "Delete ProviderItem", variant: dryRun ? "secondary" : "destructive", onConfirm: () => executeDelete(item) });
  }
  const reviewPreview = useJson<any>(
    `/api/version-manager/preview?${providerQuery}`,
    preset === "review" && Boolean(provider.providerId),
  );
  const missing = useJson<any>(
    `/api/version-manager/missing?${providerQuery}`,
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
  async function reviewAction(id: string, body: Record<string, unknown>) {
    const response = await fetch(
      `/api/organizer/review/${encodeURIComponent(id)}`,
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
      onConfirm: () => reviewAction(id, body),
    });
  }
  async function chooseReviewWinner(entry: any, version: any) {
    setReviewError("");
    try {
      const response = await fetch("/api/version-manager/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider.providerId, groupId: entry.versionGroupId, versionId: version.id }) });
      await readJsonResponse<any>(response, "Selecting retained version");
      await Promise.all([loadReview(), reviewQueue.reload(), reviewPreview.reload()]);
    } catch (error: any) { setReviewError(error.message || "Unable to select retained version"); }
  }
  const groups = useMemo(
    () =>
      (preview.data?.groups || []).filter((group: any) => {
        const text = JSON.stringify(group).toLowerCase();
        const identity = group.identity || {};
        const versions = group.versions || [];
        const type = String(
          identity.mediaType || group.mediaType || "",
        ).toLowerCase();
        const isTv = identity.kind === "episode" || type === "episode" || type === "tv";
        const hasStatus =
          status === "all" ||
          (status === "complete" ? versions.length > 0 : text.includes(status));
        const hasDecision =
          decision === "all" || text.toLowerCase().includes(decision);
        return (
          text.includes(query.toLowerCase()) &&
          (mediaType === "all" || (mediaType === "tv" ? isTv : !isTv)) &&
          hasStatus &&
          hasDecision &&
          (!multipleVersions || versions.length > 1) &&
          (!needsAttention || versions.some((version: any) => ["REVIEW", "DELETE_CANDIDATE"].includes(version.decision)))
        );
      }),
    [preview.data, query, status, mediaType, decision, multipleVersions, needsAttention],
  );
  const libraryRows = useMemo(() => {
    const rows = new Map<string, { kind: "movie" | "show" | "unknown"; title: string; year?: number; groups: any[] }>();
    for (const group of groups) {
      const identity = displayIdentity(group);
      const isEpisode = identity.kind === "episode";
      const showIdentity = identity.tmdbId || identity.tvdbId || String(identity.title || "unknown").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const key = isEpisode ? `show:${showIdentity}` : `group:${group.id}`;
      const current: { kind: "movie" | "show" | "unknown"; title: string; year?: number; groups: any[] } = rows.get(key) || { kind: isEpisode ? "show" : identity.kind === "movie" ? "movie" : "unknown", title: identity.title || group.title || "Unidentified content", year: identity.year, groups: [] };
      current.groups.push(group);
      rows.set(key, current);
    }
    return [...rows.values()].sort((left, right) => sort === "versions" ? right.groups.reduce((n, group) => n + group.versions.length, 0) - left.groups.reduce((n, group) => n + group.versions.length, 0) : left.title.localeCompare(right.title));
  }, [groups, sort]);
  const needs = (missing.data?.needs || []).filter((item: any) =>
    JSON.stringify(item).toLowerCase().includes(query.toLowerCase()),
  );
  const enrichReviewEntry = (entry: any) => {
    const ids = new Set(entry.versionIds || []);
    const versions = entry.versions?.length ? entry.versions : (reviewPreview.data?.groups || []).flatMap((group: any) => group.versions || []).filter((version: any) => ids.has(version.id));
    return { ...entry, versions, review: entry.review || entry.organizerReview };
  };
  return (
    <div className="space-y-6">
      <Header
        view="library"
        title="Library"
        description="Content first, with one winning version and every uncertain or protected case made explicit."
        reviewCount={identityIssueCount}
      />
      <ProviderSelector providers={provider.providers} value={provider.providerId} onChange={(value) => { provider.selectProvider(value); setSelected(null); setDeleteNotice(""); setDeleteError(""); }} />
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
          <Link href="/media-manager/library/missing">Missing</Link>
        </Button>
        <Button
          asChild
          variant={preset === "review" ? "default" : "outline"}
          size="sm"
        >
          <Link href="/media-manager/library/review">Review</Link>
        </Button>
        <Button asChild variant={preset === "delete" || preset === "delete-preview" ? "default" : "outline"} size="sm">
          <Link href="/media-manager/library/delete">Delete</Link>
        </Button>
      </div>
      {preset === "all" && (
        <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title…"
            />
          </div>
          <select
            className="rounded border bg-background p-2 text-sm"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">Status: All</option>
            <option value="complete">Complete</option>
            <option value="missing">Missing</option>
            <option value="requested">Requested</option>
            <option value="processing">Processing</option>
            <option value="attention">Attention</option>
          </select>
          <select
            className="rounded border bg-background p-2 text-sm"
            value={mediaType}
            onChange={(event) => setMediaType(event.target.value)}
          >
            <option value="all">Type: All</option>
            <option value="movie">Movies</option>
            <option value="tv">TV Shows</option>
          </select>
          <label className="flex items-center gap-2 rounded border px-2 text-sm"><input type="checkbox" checked={multipleVersions} onChange={(event) => setMultipleVersions(event.target.checked)} /> Multiple versions</label>
          <label className="flex items-center gap-2 rounded border px-2 text-sm"><input type="checkbox" checked={needsAttention} onChange={(event) => setNeedsAttention(event.target.checked)} /> Needs attention</label>
          <select className="rounded border bg-background p-2 text-sm" value={sort} onChange={(event) => setSort(event.target.value)}><option value="title">Sort: title</option><option value="versions">Sort: versions</option></select>
          <select
            className="rounded border bg-background p-2 text-sm"
            value={decision}
            onChange={(event) => setDecision(event.target.value)}
          >
            <option value="all">Decision: All</option>
            <option value="keep">KEEP</option>
            <option value="review">REVIEW</option>
            <option value="delete_candidate">DELETE_CANDIDATE</option>
          </select>
        </div>
      )}
      {preset === "missing" && (
        <div className="relative rounded-lg border p-3">
          <Search className="absolute left-5 top-5.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search content without an admissible version…" />
        </div>
      )}
      {(preset === "delete" || preset === "delete-preview") && (
        <>
          <Card className="border-amber-500/50">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-semibold">Delete · impact analysis</p>
                <p className="text-sm text-muted-foreground">{deleteImpact.data?.dryRun !== false ? "Dry run is enabled: actions revalidate the physical resource against the provider without deleting it." : "Live mode is enabled: eligible resources can be deleted only after final revalidation and explicit confirmation."}</p>
              </div>
              <StatusBadge value={deleteImpact.data?.dryRun !== false ? "DRY RUN" : "LIVE"} />
            </CardContent>
          </Card>
          <div className="flex flex-wrap items-center gap-2"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, release, filename or provider item…" /><select value={deleteScope} onChange={(event) => setDeleteScope(event.target.value)} className="rounded border bg-background p-2 text-sm"><option value="candidates">Delete candidates · physically eligible</option><option value="protected">Protected / Not deletable</option><option value="attention">Needs attention</option></select></div>
          <ErrorBox error={deletePreview.error || deleteImpact.error || deleteError} />
          {deleteNotice && <p className="rounded border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">{deleteNotice}</p>}
          {deletePreview.loading ? <p className="text-sm text-muted-foreground">Evaluating policy…</p> : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Stat label="Contents" value={deletePreview.data?.counts?.contents ?? "—"} />
                <Stat label="Versions" value={deletePreview.data?.counts?.versions ?? "—"} />
                <Stat label="Retained" value={deletePreview.data?.counts?.KEEP ?? "—"} />
                <Stat label="Logical candidates" value={deletePreview.data?.counts?.DELETE_CANDIDATE ?? "—"} detail="individual versions" />
                <Stat label="Physical resources" value={deleteImpact.data?.items?.length ?? "—"} detail={deleteScope === "candidates" ? "eligible in this view" : deleteScope === "protected" ? "protected in this view" : "need attention"} />
              </div>
              <DeleteImpactCards items={deleteImpact.data?.items || []} scope={deleteScope} dryRun={deleteImpact.data?.dryRun !== false} busyId={deleteBusy} onDetails={setSelected} onDelete={requestDelete} />
            </>
          )}
        </>
      )}
      {preset === "all" && (
        <>
          <ErrorBox error={preview.error} />
          {preview.loading ? (
            <p className="text-sm text-muted-foreground">Loading library…</p>
          ) : (
            <div className="space-y-3">
              {libraryRows.slice(0, 200).map((row, index) => (
                <Card key={`${row.kind}-${row.title}-${index}`} className="cursor-pointer transition-colors hover:border-primary/50" onClick={() => row.kind !== "show" && setSelected(row.groups[0])} onKeyDown={(event) => { if (row.kind !== "show" && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setSelected(row.groups[0]); } }} role={row.kind === "show" ? undefined : "button"} tabIndex={row.kind === "show" ? undefined : 0}>
                  <CardContent className="space-y-2 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div><p className="font-medium">{row.title}</p><p className="text-xs text-muted-foreground">{row.year || "—"} · {row.kind === "show" ? "TV show" : row.kind === "movie" ? "Movie" : "Unresolved"} · {row.groups.reduce((count, group) => count + group.versions.length, 0)} versions</p></div>
                      <StatusBadge value={row.kind === "show" ? "SERIES" : row.kind === "movie" ? "MOVIE" : "UNRESOLVED"} />
                    </div>
                    {row.kind === "show" ? <div className="space-y-2 border-l-2 pl-3">{[...new Map(row.groups.map((group) => [group.identity?.season || 0, row.groups.filter((candidate) => (candidate.identity?.season || 0) === (group.identity?.season || 0))])).entries()].sort(([a], [b]) => a - b).map(([season, seasonGroups]) => <details key={season} className="rounded border p-2"><summary className="cursor-pointer text-sm font-medium">Season {season || "unknown"} · {seasonGroups.length} episodes</summary><div className="mt-2 space-y-2">{seasonGroups.sort((a, b) => (a.identity?.episode || 0) - (b.identity?.episode || 0)).map((group) => <div key={group.id} className="rounded border p-2 text-sm"><button className="font-medium hover:underline" onClick={() => setSelected(group)}>Episode {group.identity?.episode || "unknown"} · {group.versions.length} versions</button><div className="mt-1 flex flex-wrap gap-1">{group.versions.map((version: any) => <StatusBadge key={version.id} value={version.decision} />)}</div></div>)}</div></details>)}</div> : <div className="grid gap-2 sm:grid-cols-2">{row.groups.flatMap((group) => group.versions).slice(0, 8).map((version: any) => { const fingerprint = version.fingerprint || {}; const storage = fingerprint.storage || {}; const video = fingerprint.video || {}; return <button className="rounded border p-2 text-left text-xs hover:border-primary/50" key={version.id} onClick={() => setSelected(row.groups.find((group) => group.versions.some((candidate: any) => candidate.id === version.id)))}><p className="font-medium">{video.resolution || "Resolution unknown"} · {video.codec || "Codec unknown"} · {video.dolbyVision || video.hdr10 ? "HDR" : "SDR"}</p><p className="text-muted-foreground">{String(storage.path || version.releaseName || version.filename || "Release unknown").split(/[\\/]/).pop()} · {version.decision || "REVIEW"}</p></button>; })}</div>}
                  </CardContent>
                </Card>
              ))}
              {libraryRows.length === 0 && (
                <Card>
                  <CardContent className="p-6 text-sm text-muted-foreground">
                    No contents match the current filters.
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>
      )}
      {preset === "missing" && (
        <>
          <ErrorBox error={missing.error} />
          <Card>
            <CardContent className="space-y-2 p-4">
              <p className="font-semibold">What does Missing mean?</p>
              <p className="text-sm text-muted-foreground">This view lists what is missing from a complete local retention decision. It does not mean that the media file is absent and it does not represent a pending Seerr download. Each row states whether the policy lacks a unique winner, required evidence, a compliant version, or a reliable identity.</p>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">Unique winner {(missing.data?.summary?.NO_UNIQUE_WINNER || 0)}</Badge>
                <Badge variant="outline">Requirements {(missing.data?.summary?.REQUIREMENTS_NOT_MET || 0)}</Badge>
                <Badge variant="outline">Identity {(missing.data?.summary?.IDENTITY_UNRESOLVED || 0)}</Badge>
                <Badge variant="outline">Recoverability {(missing.data?.summary?.RECOVERABILITY_UNCONFIRMED || 0)}</Badge>
              </div>
            </CardContent>
          </Card>
          {missing.loading ? (
            <p className="text-sm text-muted-foreground">
              Loading policy gaps…
            </p>
          ) : (
            <div className="space-y-3">
              {needs.map((item: any, index: number) => (
                <Card
                  key={item.needId || item.id || index}
                  className="hover:border-primary/50"
                >
                  <CardContent className="space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">
                        {item.contentIdentity?.title ||
                          item.title ||
                          "Unknown content"}
                        </p>
                        <p className="text-xs text-muted-foreground">{item.contentIdentity?.year || "—"} · {item.mediaType === "tv" ? "TV episode" : "Movie"}{episodeLabel(item) ? ` · ${episodeLabel(item)}` : ""} · {item.profileName}</p>
                      </div>
                      <StatusBadge value={item.gapType || "REVIEW"} />
                    </div>
                    <div className="grid gap-2 text-sm md:grid-cols-3">
                      <div className="rounded border p-3"><p className="font-medium">What is missing</p><p className="text-muted-foreground">{item.whatIsMissing}</p></div>
                      <div className="rounded border p-3"><p className="font-medium">Why it is here</p><p className="text-muted-foreground">{item.why}</p></div>
                      <div className="rounded border p-3"><p className="font-medium">What you can do</p><p className="text-muted-foreground">{item.nextAction}</p></div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(item.gapType === "IDENTITY_UNRESOLVED" || item.gapType === "NO_UNIQUE_WINNER" || item.gapType === "RECOVERABILITY_UNCONFIRMED") && <Button asChild size="sm" variant="outline"><Link href="/media-manager/library/review">Open Review</Link></Button>}
                      {item.gapType === "REQUIREMENTS_NOT_MET" && <Button asChild size="sm" variant="outline"><Link href="/media-manager/settings/profiles">Open Retention Settings</Link></Button>}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelected({ ...item, versions: [...(item.existingVersions || []), ...(item.rejectedVersions || [])] });
                        }}
                      >
                        Details
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {needs.length === 0 && (
                <Card>
                  <CardContent className="p-6 text-sm text-muted-foreground">
                    Every content item has an admissible retained version under
                    the active local policy.
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
                    : "Organizer identity issues and other operator review work."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>All <Badge variant="outline">{review?.summary?.total ?? "—"}</Badge></span>
                <span>Identity <Badge variant={review?.summary?.identityIssues > 0 ? "destructive" : "outline"}>{review?.summary?.identityIssues ?? "—"}</Badge></span>
                <span>Policy <Badge variant="outline">{review?.summary?.policyReviews ?? "—"}</Badge></span>
                <span>Recoverability <Badge variant="outline">{review?.summary?.recoverabilityIssues ?? "—"}</Badge></span>
              </div>
            </CardContent>
          </Card>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
            <span className="text-sm font-medium">Review status</span>
            <select className="rounded border bg-background p-2 text-sm" value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value as "pending" | "dismissed")}>
              <option value="pending">Pending</option>
              <option value="dismissed">Dismissed</option>
            </select>
            <span className="text-xs text-muted-foreground">Dismissed items remain auditable and can be restored.</span>
          </div>
          <ReviewActionGuide />
          <ErrorBox error={reviewError} />
          {!review ? (
            <p className="text-sm text-muted-foreground">
              Loading review queue…
            </p>
          ) : (
            <div className="space-y-3">
              {(review.entries || []).filter((entry: any) => !identityOnly || entry.issueTypes?.includes("IDENTITY_ISSUE")).map((entry: any) => (
                <Card key={entry.key}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-medium">{entry.title || entry.sourceBasename || "Unidentified content"}</p>
                        <p className="break-all text-xs text-muted-foreground">{entry.year || "—"} · {entry.kind || "unknown"}{episodeLabel(entry) ? ` · ${episodeLabel(entry)}` : ""}{entry.sourceBasename ? ` · ${entry.sourceBasename}` : ""}</p>
                      </div>
                      <div className="flex flex-wrap gap-1">{(entry.issueTypes || []).map((issue: string) => <StatusBadge key={issue} value={issue} />)}</div>
                    </div>
                    {(() => { const guidance = reviewGuidance(entry); return <div className="grid gap-2 text-sm md:grid-cols-2"><div className="rounded border p-3"><p className="font-medium">Why it is here · {guidance.heading}</p><p className="mt-1 text-muted-foreground">{guidance.explanation}</p></div><div className="rounded border p-3"><p className="font-medium">What you can do</p><p className="mt-1 text-muted-foreground">{guidance.action}</p></div></div>; })()}
                    {(entry.reasonCodes || []).includes("policy_tie") && <div className="space-y-2 rounded border border-amber-500/40 p-3"><p className="font-medium">Choose the one copy to keep</p><p className="text-xs text-muted-foreground">This choice applies only to this content on {provider.providers.find((item: any) => item.id === provider.providerId)?.name || provider.providerId}. Every other tied copy becomes a deletion candidate and still passes the normal safety checks.</p><div className="grid gap-2 lg:grid-cols-2">{(entry.versions || []).map((version: any) => { const storage = version.fingerprint?.storage || {}; const video = version.fingerprint?.video || {}; const filename = String(storage.path || version.id).split(/[\\/]/).pop(); return <div key={version.id} className="flex items-start justify-between gap-3 rounded border p-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{filename}</p><p className="text-xs text-muted-foreground">{video.resolution || "Resolution unknown"} · {storage.size ? `${Math.round(Number(storage.size) / 1_000_000)} MB` : "Size unknown"}</p></div><Button size="sm" onClick={() => void chooseReviewWinner(entry, version)}>Keep this copy</Button></div>; })}</div><Button asChild size="sm" variant="outline"><Link href="/media-manager/settings/profiles">Change ranking rules instead</Link></Button></div>}
                    {entry.organizerReview && entry.decision !== "dismissed" && <IdentityResolver reviewId={entry.organizerReview.id} identity={entry.identity} initialQuery={entry.title} initialType={entry.kind === "episode" ? "tv" : "movie"} initialYear={entry.year} existingOverride={entry.organizerReview.override} actionLabel={entry.organizerReview.override ? "Change Match" : "Resolve Identity"} onSaved={() => void loadReview()} />}
                    <div className="flex flex-wrap gap-2">
                      {entry.organizerReview && (entry.decision === "dismissed" ? <Button size="sm" onClick={() => requestReviewAction(entry.organizerReview.id, { action: "retry" }, entry)}><RefreshCw className="mr-2 h-4 w-4" />Restore to Review</Button> : <><Button size="sm" variant="secondary" onClick={() => requestReviewAction(entry.organizerReview.id, { decision: "accepted" }, entry.organizerReview)}><Check className="mr-2 h-4 w-4" />Accept as detected</Button><Button size="sm" variant="destructive" onClick={() => requestReviewAction(entry.organizerReview.id, { decision: "dismissed" }, entry.organizerReview)}><X className="mr-2 h-4 w-4" />Dismiss</Button><Button size="sm" variant="outline" onClick={() => requestReviewAction(entry.organizerReview.id, { action: "retry" }, entry.organizerReview)}><RefreshCw className="mr-2 h-4 w-4" />Retry / Resume</Button></>)}
                      <Button size="sm" variant="ghost" onClick={() => setSelected(enrichReviewEntry(entry))}>
                        <ExternalLink className="mr-2 h-4 w-4" />Details
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {review.entries && review.entries.filter((entry: any) => !identityOnly || entry.issueTypes?.includes("IDENTITY_ISSUE")).length === 0 && (
                <Card><CardContent className="p-6 text-sm text-muted-foreground">No review items match the selected filter.</CardContent></Card>
              )}
            </div>
          )}
        </>
      )}
      {selected && <Dialog open onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl" showCloseButton={false}>
          <DialogTitle>Content details</DialogTitle>
          <DialogDescription>Inspect the detected identity, versions, decision reasons and available actions.</DialogDescription>
          <DetailPanel item={selected} onClose={() => setSelected(null)} onReviewAction={requestReviewAction} onSaved={() => { void loadReview(); setSelected(null); }} />
        </DialogContent>
      </Dialog>}
      {confirmation && <ConfirmationDialog open={Boolean(confirmation)} onOpenChange={(open) => !open && setConfirmation(null)} title={confirmation.title} description={confirmation.description} context={confirmation.context} confirmLabel={confirmation.confirmLabel} variant={confirmation.variant} onConfirm={async () => { await confirmation.onConfirm(); setConfirmation(null); }} />}
    </div>
  );
}

function Migration({ section = "migration" }: { section?: string }) {
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
        description="Migrate directly between providers, or use separate file import and export tools."
      />
      <div className="flex flex-wrap gap-2">
        <Button asChild variant={section === "migration" ? "default" : "outline"}><Link href="/media-manager/migration">Provider migration</Link></Button>
        <Button asChild variant={section === "export" ? "default" : "outline"}>
          <Link href="/media-manager/migration/export">
          <Archive className="mr-2 h-4 w-4" />
          Export
          </Link>
        </Button>
        <Button asChild variant={section === "import" ? "default" : "outline"}>
          <Link href="/media-manager/migration/import">
          <FileUp className="mr-2 h-4 w-4" />
          Restore / Import file
          </Link>
        </Button>
        <Button asChild variant={section === "history" ? "default" : "outline"}>
          <Link href="/media-manager/migration/history">
          Jobs / History
          </Link>
        </Button>
      </div>
      {section === "migration" && <ProviderMigration />}
      {section !== "migration" && <>
      {(section === "export" || section === "import") && <>
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
      <ErrorBox error={state.error ? `Migration state is not calculated: ${state.error}` : ""} />
      </>}
      {section === "export" && <>
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
      </>}
      {section === "import" &&
      <Card id="import">
        <CardHeader>
          <CardTitle className="text-base">Restore / Import file</CardTitle>
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
      }
      {section === "history" && <>
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
      </>}
      {backupToDelete && <ConfirmationDialog open onOpenChange={(open) => !open && setBackupToDelete(null)} title="Delete this backup?" description="This permanently removes the local backup JSON from the server. Provider media and magnets are not changed." context={<div className="space-y-1"><p><b>{backupToDelete.mode}</b> · {backupToDelete.itemCount} items</p><p>{new Date(backupToDelete.createdAt).toLocaleString()} · {backupToDelete.provider}</p></div>} confirmLabel="Delete backup" variant="destructive" onConfirm={async () => { await deleteBackup(backupToDelete); setBackupToDelete(null); }} />}
      </>}
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

function SettingsView({ section = "profiles" }: { section?: string }) {
  const status = useJson<any>("/api/version-manager/status");
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
      const response = await fetch("/api/version-manager/profiles/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profiles, policy }) });
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
          <p className="text-muted-foreground">Audio and subtitle tracks are evaluated independently. Separate multiple languages with commas. Aliases such as it/ita/italiano and en/eng/english are normalized.</p>
          {retentionProfile && <div className="grid gap-4 xl:grid-cols-2">
            <div className="space-y-3 rounded border p-3"><div><p className="font-medium">Audio tracks</p><p className="text-xs text-muted-foreground">Mandatory languages determine admissibility; preferred languages help choose the single winner.</p></div><div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs"><span>Required audio languages</span><input className="rounded border bg-background p-2 text-sm" aria-label="Required audio languages" placeholder="ita, eng" value={requiredAudioInput} onChange={(event) => { const value = event.target.value; setRequiredAudioInput(value); updateLanguageTrack("audio", { required: { ...audioLanguagePolicy.required, values: parseLanguages(value) } }); }} /></label>
              <label className="grid gap-1 text-xs"><span>Match</span><select className="rounded border bg-background p-2 text-sm" aria-label="Required audio match" value={audioLanguagePolicy.required?.mode || "ALL"} onChange={(event) => updateLanguageTrack("audio", { required: { ...audioLanguagePolicy.required, mode: event.target.value } })}><option value="ALL">All required</option><option value="ANY">Any required</option></select></label>
              <label className="grid gap-1 text-xs sm:col-span-2"><span>Preferred audio languages, in order</span><input className="rounded border bg-background p-2 text-sm" aria-label="Preferred audio languages" placeholder="ita, original, eng" value={preferredAudioInput} onChange={(event) => { const value = event.target.value; setPreferredAudioInput(value); updateLanguageTrack("audio", { preferred: parseLanguages(value) }); }} /></label>
              <label className="grid gap-1 text-xs"><span>If required audio is missing</span><select className="rounded border bg-background p-2 text-sm" aria-label="Missing required audio action" value={audioLanguagePolicy.missingRequiredAction || "REVIEW"} onChange={(event) => updateLanguageTrack("audio", { missingRequiredAction: event.target.value })}><option value="REVIEW">Needs review</option><option value="DELETE_IF_REPLACED">Candidate only with replacement</option></select></label>
              <label className="flex items-center gap-2 self-end rounded border p-2"><input type="checkbox" checked={audioLanguagePolicy.original === true} onChange={(event) => updateLanguageTrack("audio", { original: event.target.checked })} /> Prefer original-language audio</label>
            </div></div>
            <div className="space-y-3 rounded border p-3"><div><p className="font-medium">Subtitle tracks</p><p className="text-xs text-muted-foreground">Subtitle requirements never satisfy an audio requirement, and audio never satisfies a subtitle requirement.</p></div><div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs"><span>Required subtitle languages</span><input className="rounded border bg-background p-2 text-sm" aria-label="Required subtitle languages" placeholder="ita, eng" value={requiredSubtitleInput} onChange={(event) => { const value = event.target.value; setRequiredSubtitleInput(value); updateLanguageTrack("subtitles", { required: { ...subtitleLanguagePolicy.required, values: parseLanguages(value) } }); }} /></label>
              <label className="grid gap-1 text-xs"><span>Match</span><select className="rounded border bg-background p-2 text-sm" aria-label="Required subtitle match" value={subtitleLanguagePolicy.required?.mode || "ALL"} onChange={(event) => updateLanguageTrack("subtitles", { required: { ...subtitleLanguagePolicy.required, mode: event.target.value } })}><option value="ALL">All required</option><option value="ANY">Any required</option></select></label>
              <label className="grid gap-1 text-xs sm:col-span-2"><span>Preferred subtitle languages, in order</span><input className="rounded border bg-background p-2 text-sm" aria-label="Preferred subtitle languages" placeholder="ita, eng" value={preferredSubtitleInput} onChange={(event) => { const value = event.target.value; setPreferredSubtitleInput(value); updateLanguageTrack("subtitles", { preferred: parseLanguages(value) }); }} /></label>
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
            <p className="text-muted-foreground">One version wins. Size is a final tie-breaker only when resolution and detected audio-language sets are equivalent.</p>
            <label className="flex items-center gap-2"><input type="checkbox" checked={policy.preferCompletePack === true} onChange={(event) => setPolicy((current: any) => ({ ...current, preferCompletePack: event.target.checked }))} /> Prefer complete packs during delete impact analysis</label>
            {retentionProfile && <div className="grid gap-2 rounded border p-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="grid gap-1 text-xs"><span>When resolution and audio languages are equivalent</span><select className="rounded border bg-background p-2 text-sm" value={retentionProfile.sizePreference || "IGNORE"} onChange={(event) => updateProfile(retentionProfileIndex, { sizePreference: event.target.value as Profile["sizePreference"] })}><option value="LARGER">Keep larger file</option><option value="SMALLER">Keep smaller file</option><option value="IGNORE">Do not use size</option></select></label>
              <label className="grid gap-1 text-xs"><span>Minimum size difference %</span><input className="w-28 rounded border bg-background p-2 text-sm" type="number" min="0" max="100" value={retentionProfile.minimumSizeDifferencePercent ?? 0} onChange={(event) => updateProfile(retentionProfileIndex, { minimumSizeDifferencePercent: Math.max(0, Number(event.target.value) || 0) })} /></label>
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
  if (view === "migration") return <Migration section={section || "migration"} />;
  return <SettingsView section={section || "profiles"} />;
}
