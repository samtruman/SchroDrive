"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
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

type View = "overview" | "library" | "migration" | "settings";
type Profile = { id: string; name: string; enabled: boolean; priority?: number; description?: string; preferredResolution?: string; languagePolicy?: any; hardRequirements?: any; scoring?: Record<string, number>; acquisitionBehavior?: string };

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
function ErrorBox({ error }: { error?: string }) {
  return error ? (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      {error}
    </div>
  ) : null;
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
  const [query, setQuery] = useState(initialQuery || "");
  const [type, setType] = useState<"movie" | "tv">(initialType || "movie");
  const [year, setYear] = useState(initialYear ? String(initialYear) : "");
  const [results, setResults] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(Boolean(existingOverride));

  async function search() {
    if (!query.trim()) return;
    setBusy(true); setMessage("");
    try {
      const params = new URLSearchParams({ query: query.trim(), type });
      if (year.trim()) params.set("year", year.trim());
      const response = await fetch(`/api/version-manager/identity/search?${params}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "TMDb search failed");
      setResults(body.results || []);
    } catch (error: any) { setMessage(error.message || "TMDb search failed"); }
    finally { setBusy(false); }
  }

  async function confirm() {
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
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Unable to save identity match");
      let evaluation = body;
      if (reviewId && identity) {
        const reevaluate = await fetch("/api/version-manager/identity/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity, override }) });
        evaluation = await reevaluate.json();
        if (!reevaluate.ok || !evaluation.ok) throw new Error(evaluation.error || "Unable to reevaluate identity");
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
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Unable to clear manual match");
      let evaluation = body;
      if (reviewId && identity) {
        const reevaluate = await fetch("/api/version-manager/identity/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clear", identity }) });
        evaluation = await reevaluate.json();
        if (!reevaluate.ok || !evaluation.ok) throw new Error(evaluation.error || "Unable to reevaluate identity");
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
      <Button size="sm" onClick={() => void confirm()} disabled={busy || !selected || (!reviewId && !identity)}>Confirm manual match</Button>
      {existingOverride && <Button size="sm" variant="outline" onClick={() => void clearMatch()} disabled={busy}>Clear manual match</Button>}
    </div>}
    </div>}
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
      const body = await response.json();
      if (!response.ok || body.ok === false)
        throw new Error(body.error || "Request failed");
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

function DetailPanel({ item, onClose, onReviewAction, onSaved }: { item: any; onClose: () => void; onReviewAction?: (id: string, body: Record<string, unknown>) => void; onSaved?: () => void }) {
  const review = item.review || (item.parsed ? item : undefined);
  const identity = item.identity || item.contentIdentity || (review ? { title: review.parsed?.title, year: review.parsed?.year, kind: review.parsed?.kind, confidence: review.parsed?.confidence, source: review.override ? "manual" : "unknown" } : {});
  const versions = item.versions || item.existingVersions || [];
  const reviewStatus = review?.parsed?.status;
  const identityAction = review?.override ? "Change Match" : reviewStatus === "ambiguous" || reviewStatus === "unmatched" || reviewStatus === "fallback" || reviewStatus === "conflict" ? "Resolve Identity" : "Change Match";
  return (
    <Card className="border-primary/40">
      <CardHeader className="flex flex-row items-start justify-between">
        <CardTitle className="text-base">Content Detail</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5 text-sm lg:grid-cols-2">
        <section>
          <h3 className="mb-2 font-semibold">Identity</h3>
          <dl className="space-y-1 text-muted-foreground">
            <p>
              <b className="text-foreground">Title:</b>{" "}
              {identity.title || item.title || "—"}
            </p>
            <p>
              <b className="text-foreground">Year:</b> {identity.year || "—"}
            </p>
            <p>
              <b className="text-foreground">Type:</b>{" "}
              {identity.mediaType || item.mediaType || "—"}
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
          {(identity.title || item.title) && <div className="mt-4"><h3 className="mb-2 font-semibold">Identity actions</h3><IdentityResolver reviewId={item.reviewId || review?.id} identity={{ title: identity.title || item.title, year: identity.year, kind: identity.kind, mediaType: identity.mediaType, tmdbId: identity.tmdbId }} initialQuery={identity.title || item.title} initialType={identity.kind === "episode" || identity.mediaType === "tv" ? "tv" : "movie"} initialYear={identity.year} existingOverride={item.override || review?.override || (identity.source === "manual" ? { tmdbId: identity.tmdbId } : undefined)} actionLabel={identityAction} onSaved={onSaved} /></div>}
          {review && onReviewAction && <div className="mt-4 flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => onReviewAction(review.id, { decision: "accepted" })}>Accept as detected</Button><Button size="sm" variant="outline" onClick={() => onReviewAction(review.id, { action: "retry" })}>Retry / Resume</Button><Button size="sm" variant="outline" onClick={() => onReviewAction(review.id, { decision: "dismissed" })}>Dismiss</Button></div>}
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
                <div className="rounded border p-2" key={version.id || index}>
                  <p>
                    {version.fingerprint?.media?.resolution ||
                      version.resolution ||
                      "media"}{" "}
                    ·{" "}
                    {version.fingerprint?.media?.videoCodec ||
                      version.codec ||
                      "codec unknown"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {version.fingerprint?.storage?.provider ||
                      version.provider ||
                      "provider"}{" "}
                    · score {version.score ?? "—"} · {version.decision || "—"}
                  </p>
                </div>
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
          <p className="mt-2 text-muted-foreground">Winning profiles: {versions.flatMap((version: any) => version.satisfiesProfiles || []).join(", ") || "none"}</p>
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">{versions.flatMap((version: any) => (version.reasons || []).map((reason: any) => <p key={`${version.id}-${reason.code}`}>• {reason.message}</p>))}</div>
        </section>
        <section>
          <h3 className="mb-2 font-semibold">Safety</h3>
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
  const status = useJson<any>("/api/version-manager/status");
  const migration = useJson<any>("/api/version-manager/migration/state");
  const reviewQueue = useJson<any>("/api/organizer/review?limit=200&status=pending");
  const profiles = status.data?.profiles || [];
  const identityIssues = (reviewQueue.data?.entries || []).filter((entry: any) =>
    entry.parsed?.status === "ambiguous" || entry.parsed?.status === "unmatched",
  ).length;
  const latestScan = status.data?.latestScan;
  const [scan, setScan] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  async function runScan() {
    setScanning(true);
    try {
      const response = await fetch("/api/version-manager/preview", {
        cache: "no-store",
      });
      const body = await response.json();
      setScan(response.ok ? body : { error: body.error || "Scan failed" });
    } catch (value: any) {
      setScan({ error: value.message });
    } finally {
      setScanning(false);
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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <div>
          <p className="font-medium">Library status</p>
          <p className="text-sm text-muted-foreground">
            {scan
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
      <ErrorBox error={scan?.error || status.error} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Library contents"
          value={scan?.groupCount ?? status.data?.latestScan?.groupCount ?? "—"}
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
        <Stat label="Safety" value="DRY RUN" detail="Delete disabled" />
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
            <p className="mt-1 text-2xl font-semibold">{latestScan?.reviewCount ?? "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Safety and policy blockers</p>
          </Link>
          <Link href="/media-manager/library/missing" className="rounded-md border p-3 transition-colors hover:border-primary">
            <p className="text-sm text-muted-foreground">Missing</p>
            <p className="mt-1 text-2xl font-semibold">{latestScan ? (latestScan.primaryMissing || 0) + (latestScan.remoteMissing || 0) : "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Unsatisfied enabled profiles</p>
          </Link>
          <Link href="/media-manager/library/delete-preview" className="rounded-md border p-3 transition-colors hover:border-primary">
            <p className="text-sm text-muted-foreground">Delete candidates</p>
            <p className="mt-1 text-2xl font-semibold">{latestScan?.deleteCandidateCount ?? "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Read-only preview</p>
          </Link>
        </CardContent>
      </Card>
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
              Source items <b>{migration.data?.sourceItems ?? "—"}</b>
            </p>
            <p>
              Rejected legal{" "}
              <b>{migration.data?.effective?.rejectedLegal ?? "—"}</b>
            </p>
            <p>
              Importable remaining{" "}
              <b>{migration.data?.effective?.residualTentableReady ?? "—"}</b>
            </p>
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
              Dry run active
            </p>
            <p className="text-muted-foreground">
              Delete executor is not implemented.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Library({ initialPreset = "all" }: { initialPreset?: string }) {
  const pathname = usePathname();
  const [preset, setPreset] = useState("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [profile, setProfile] = useState("all");
  const [mediaType, setMediaType] = useState("all");
  const [decision, setDecision] = useState("all");
  const [selected, setSelected] = useState<any>(null);
  const reviewQueue = useJson<any>("/api/organizer/review?limit=200&status=pending");
  const [identityOnly, setIdentityOnly] = useState(false);
  const identityIssueCount = (reviewQueue.data?.entries || []).filter((entry: any) =>
    entry.parsed?.status === "ambiguous" || entry.parsed?.status === "unmatched",
  ).length;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setPreset(params.get("view") || initialPreset);
    setIdentityOnly(params.get("reason") === "identity");
  }, [pathname, initialPreset]);
  const preview = useJson<any>(
    "/api/version-manager/preview",
    preset === "all",
  );
  const deletePreview = useJson<any>(
    "/api/version-manager/delete-preview",
    preset === "delete-preview",
  );
  const missing = useJson<any>(
    "/api/version-manager/missing",
    preset === "missing",
  );
  const [review, setReview] = useState<any>(null);
  const [reviewError, setReviewError] = useState("");
  const loadReview = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/organizer/review?limit=100&status=pending",
        { cache: "no-store" },
      );
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error);
      setReview(body);
    } catch (value: any) {
      setReviewError(value.message || "Unable to load review");
    }
  }, []);
  useEffect(() => {
    if (preset === "review") void loadReview();
  }, [loadReview, preset]);
  async function reviewAction(id: string, body: Record<string, unknown>) {
    const response = await fetch(
      `/api/organizer/review/${encodeURIComponent(id)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (response.ok) void loadReview();
    else setReviewError("Unable to save review action");
  }
  const groups = useMemo(
    () =>
      (preview.data?.groups || []).filter((group: any) => {
        const text = JSON.stringify(group).toLowerCase();
        const identity = group.identity || {};
        const versions = group.versions || [];
        const hasProfile =
          profile === "all" ||
          versions.some((version: any) =>
            (version.evaluations || []).some(
              (evaluation: any) =>
                evaluation.profileId?.toLowerCase() === profile,
            ),
          );
        const type = String(
          identity.mediaType || group.mediaType || "",
        ).toLowerCase();
        const hasStatus =
          status === "all" ||
          (status === "complete" ? versions.length > 0 : text.includes(status));
        const hasDecision =
          decision === "all" || text.toLowerCase().includes(decision);
        return (
          text.includes(query.toLowerCase()) &&
          hasProfile &&
          (mediaType === "all" || type === mediaType) &&
          hasStatus &&
          hasDecision
        );
      }),
    [preview.data, query, status, profile, mediaType, decision],
  );
  const needs = (missing.data?.previews || []).filter((item: any) =>
    JSON.stringify(item).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="space-y-6">
      <Header
        view="library"
        title="Library"
        description="One operational view for content, missing profiles and review work."
        reviewCount={identityIssueCount}
      />
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
        <Button asChild variant={preset === "delete-preview" ? "default" : "outline"} size="sm">
          <Link href="/media-manager/library/delete-preview">Delete Preview</Link>
        </Button>
      </div>
      {preset !== "review" && preset !== "delete-preview" && (
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
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
          >
            <option value="all">Profile: All</option>
            <option value="primary">PRIMARY</option>
            <option value="remote">REMOTE</option>
          </select>
          <select
            className="rounded border bg-background p-2 text-sm"
            value={mediaType}
            onChange={(event) => setMediaType(event.target.value)}
          >
            <option value="all">Type: All</option>
            <option value="movie">Movie</option>
            <option value="tv">TV</option>
          </select>
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
      {preset === "delete-preview" && (
        <>
          <Card className="border-amber-500/50">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-semibold">Delete Preview · read-only</p>
                <p className="text-sm text-muted-foreground">Policy evaluation only. No provider delete operation is available.</p>
              </div>
              <StatusBadge value="DRY RUN" />
            </CardContent>
          </Card>
          <ErrorBox error={deletePreview.error} />
          {deletePreview.loading ? <p className="text-sm text-muted-foreground">Evaluating policy…</p> : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {Object.entries(deletePreview.data?.counts || {}).map(([label, value]) => <Stat key={label} label={label.replaceAll("_", " ")} value={String(value)} />)}
              </div>
              <div className="space-y-3">
                {(deletePreview.data?.groups || []).slice(0, 200).map((group: any, index: number) => (
                  <Card key={group.id || index} className="cursor-pointer hover:border-primary/50" onClick={() => setSelected(group)}>
                    <CardContent className="space-y-3 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{group.identity?.title || "Unidentified content"}</p><p className="text-xs text-muted-foreground">{group.identity?.year || "—"} · {group.versions?.length || 0} versions · policy {deletePreview.data.policyHash}</p></div><StatusBadge value={group.versions?.some((v: any) => v.decision === "DELETE_CANDIDATE") ? "DELETE_CANDIDATE" : group.versions?.some((v: any) => v.decision === "REVIEW") ? "REVIEW" : "KEEP"} /></div>
                      <div className="grid gap-2 md:grid-cols-2">{(group.versions || []).map((version: any) => <div key={version.id} className="rounded border p-2 text-xs"><div className="flex justify-between"><StatusBadge value={version.decision} /><span>{version.fingerprint?.storage?.provider || "provider"}</span></div><p className="mt-1 text-muted-foreground">{version.reasons?.map((reason: any) => reason.message).join("; ") || "No explanation"}</p><p className="text-muted-foreground">recoverability: {version.fingerprint?.storage?.infoHash ? "YES" : "UNKNOWN"}</p></div>)}</div>
                    </CardContent>
                  </Card>
                ))}
              </div>
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
              {groups.slice(0, 200).map((group: any, index: number) => (
                <Card
                  key={group.id || index}
                  className="cursor-pointer hover:border-primary/50"
                  onClick={() => setSelected(group)}
                >
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div>
                      <p className="font-medium">
                        {group.identity?.title ||
                          group.title ||
                          "Unidentified content"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {group.identity?.year || "—"} ·{" "}
                        {group.identity?.mediaType ||
                          group.mediaType ||
                          "unknown"}{" "}
                        · {group.versions?.length || 0} versions
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(group.versions || [])
                        .slice(0, 3)
                        .map((version: any, versionIndex: number) => (
                          <StatusBadge
                            key={version.id || versionIndex}
                            value={version.decision || "VERSION"}
                          />
                        ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
              {groups.length === 0 && (
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
          {missing.loading ? (
            <p className="text-sm text-muted-foreground">
              Loading missing profiles…
            </p>
          ) : (
            <div className="space-y-3">
              {needs.map((item: any, index: number) => (
                <Card
                  key={item.needId || item.id || index}
                  className="cursor-pointer hover:border-primary/50"
                  onClick={() => setSelected(item)}
                >
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div>
                      <p className="font-medium">
                        {item.contentIdentity?.title ||
                          item.title ||
                          "Unknown content"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.contentIdentity?.mediaType || "—"} · profile{" "}
                        {item.profileId || item.missingProfileId || "—"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge value={item.status || "REVIEW"} />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelected(item);
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
                    No missing profiles. If REMOTE is disabled, missing
                    acquisition previews are intentionally not generated.
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
              <div className="flex items-center gap-2 text-sm">
                <span>Identity issues</span>
                <Badge variant={identityIssueCount > 0 ? "destructive" : "outline"}>{identityIssueCount}</Badge>
              </div>
            </CardContent>
          </Card>
          <ErrorBox error={reviewError} />
          {!review ? (
            <p className="text-sm text-muted-foreground">
              Loading review queue…
            </p>
          ) : (
            <div className="space-y-3">
              {(review.entries || []).filter((entry: any) => !identityOnly || entry.parsed?.status === "ambiguous" || entry.parsed?.status === "unmatched").map((entry: any) => (
                <Card key={entry.id}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-medium">{entry.sourceBasename}</p>
                        <p className="break-all text-xs text-muted-foreground">
                          {entry.sourcePath}
                        </p>
                      </div>
                      <StatusBadge
                        value={String(
                          entry.decision || entry.parsed?.status || "REVIEW",
                        ).toUpperCase()}
                      />
                    </div>
                    <p className="text-sm">
                      {entry.parsed?.title || "No title"} ·{" "}
                      {entry.parsed?.reason || "Review required"}
                    </p>
                    <IdentityResolver reviewId={entry.id} identity={{ title: entry.parsed?.title, year: entry.parsed?.year, kind: entry.parsed?.kind === "episode" ? "episode" : "movie" }} initialQuery={entry.parsed?.title} initialType={entry.parsed?.kind === "episode" ? "tv" : "movie"} initialYear={entry.parsed?.year} existingOverride={entry.override} actionLabel={entry.override ? "Change Match" : "Resolve Identity"} onSaved={() => void loadReview()} />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() =>
                          void reviewAction(entry.id, { decision: "accepted" })
                        }
                      >
                        <Check className="mr-2 h-4 w-4" />
                        Accept as detected
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void reviewAction(entry.id, { decision: "dismissed" })
                        }
                      >
                        <X className="mr-2 h-4 w-4" />
                        Dismiss
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void reviewAction(entry.id, { action: "retry" })
                        }
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Retry / Resume
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSelected(entry)}>
                        <ExternalLink className="mr-2 h-4 w-4" />Details
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {review.entries && review.entries.filter((entry: any) => !identityOnly || entry.parsed?.status === "ambiguous" || entry.parsed?.status === "unmatched").length === 0 && (
                <Card><CardContent className="p-6 text-sm text-muted-foreground">No identity issues require manual resolution.</CardContent></Card>
              )}
            </div>
          )}
        </>
      )}
      {selected && (
        <DetailPanel item={selected} onClose={() => setSelected(null)} onReviewAction={reviewAction} onSaved={() => { void loadReview(); setSelected(null); }} />
      )}
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
      const data = await response.json();
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Import preview failed");
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
          Import preview
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
        <Stat label="Source items" value={state.data?.sourceItems ?? "—"} />
        <Stat
          label="Already present/equivalent"
          value={state.data?.effective?.alreadyPresent ?? "—"}
        />
        <Stat
          label="Rejected legal"
          value={state.data?.effective?.rejectedLegal ?? "—"}
        />
        <Stat
          label="Import All Missing"
          value={state.data?.effective?.residualTentableReady ?? "—"}
          detail="effective ready only"
        />
      </div>
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
      <Card id="import">
        <CardHeader>
          <CardTitle className="text-base">Import preview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!importSupported && <ErrorBox error="Import preview is unavailable for the selected target provider because its declared capabilities are unsupported." />}
          <p className="text-sm text-muted-foreground">
            Analyze a manifest or generic magnets file. Execute is intentionally
            unavailable in this milestone.
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
          <ErrorBox error={fileError} />
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
    </div>
  );
}

const RULE_FIELDS = ["resolution", "source", "codec", "audioLanguage", "subtitleLanguage", "hdr", "dolbyVision", "bitrate", "fileSize", "container", "identityConfidence"];
const RULE_OPERATORS = ["equals", "not_equals", "contains", "not_contains", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "exists", "not_exists"];

function RuleBuilder({ node, onChange, onRemove, root = false }: { node: any; onChange: (node: any) => void; onRemove?: () => void; root?: boolean }) {
  const addCondition = () => onChange({ ...(node?.op === "AND" || node?.op === "OR" ? node : { op: "AND", children: [] }), children: [...(node?.children || []), { op: "COMPARE", field: "resolution", operator: "equals", value: "2160p" }] });
  const addGroup = () => onChange({ ...(node?.op === "AND" || node?.op === "OR" ? node : { op: "AND", children: [] }), children: [...(node?.children || []), { op: "AND", children: [{ op: "COMPARE", field: "resolution", operator: "equals", value: "1080p" }] }] });
  if (node?.op === "NOT") return <div className="rounded border border-dashed p-2"><div className="flex items-center justify-between"><b>NOT</b>{!root && <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>}</div><RuleBuilder node={node.child} root onChange={(child) => onChange({ ...node, child })} /></div>;
  if (node?.op === "AND" || node?.op === "OR") return <div className="space-y-2 rounded border p-2"><div className="flex flex-wrap items-center gap-2"><select className="rounded border bg-background p-1 text-sm" value={node.op} onChange={(event) => onChange({ ...node, op: event.target.value })}><option>AND</option><option>OR</option></select>{!root && <Button size="sm" variant="ghost" onClick={onRemove}>Remove group</Button>}<Button size="sm" variant="outline" onClick={addCondition}>Add condition</Button><Button size="sm" variant="outline" onClick={addGroup}>Add group</Button><Button size="sm" variant="outline" onClick={() => onChange({ op: "NOT", child: { op: "COMPARE", field: "resolution", operator: "equals", value: "2160p" } })}>Add NOT</Button></div>{(node.children || []).map((child: any, index: number) => <RuleBuilder key={index} node={child} onChange={(next) => onChange({ ...node, children: node.children.map((item: any, itemIndex: number) => itemIndex === index ? next : item) })} onRemove={() => onChange({ ...node, children: node.children.filter((_: any, itemIndex: number) => itemIndex !== index) })} />)}</div>;
  return <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/20 p-2"><select className="rounded border bg-background p-1 text-sm" value={node?.field || "resolution"} onChange={(event) => onChange({ ...node, field: event.target.value })}>{RULE_FIELDS.map((field) => <option key={field}>{field}</option>)}</select><select className="rounded border bg-background p-1 text-sm" value={node?.operator || "equals"} onChange={(event) => onChange({ ...node, operator: event.target.value })}>{RULE_OPERATORS.map((operator) => <option key={operator}>{operator}</option>)}</select>{!["exists", "not_exists"].includes(node?.operator) && <input className="min-w-28 rounded border bg-background p-1 text-sm" value={String(node?.value ?? "")} onChange={(event) => onChange({ ...node, value: event.target.value })} placeholder="value" />} {!root && <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>}</div>;
}

function SettingsView({ section = "profiles" }: { section?: string }) {
  const status = useJson<any>("/api/version-manager/status");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [policy, setPolicy] = useState<any>({ enableRemote: false, acquireMissingRemote: false, safety: { requireRecoverableBeforeDelete: true, allowDeleteWhenIdentityUncertain: false, allowDeleteWhenMetadataIncomplete: false } });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    if (status.data?.profiles) setProfiles(status.data.profiles);
    if (status.data?.policy) setPolicy(status.data.policy);
  }, [status.data]);
  async function save() {
    setSaving(true);
    setSaved("");
    try {
      const response = await fetch("/api/version-manager/profiles", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profiles, policy }),
      });
      if (!response.ok) throw new Error("Unable to save profiles");
      setSaved("Saved");
    } catch (value: any) {
      setSaved(value.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }
  function updateProfile(index: number, patch: Partial<Profile>) { setProfiles((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  function addProfile() { const id = `custom-${Date.now()}`; setProfiles((current) => [...current, { id, name: "Custom profile", enabled: true, priority: 0, preferredResolution: "1080p", languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: false, scope: "AUDIO" }, sourceOrder: [], codecOrder: [], audioOrder: [], hardRequirements: { op: "AND", children: [] }, scoring: {}, acquisitionBehavior: "DISABLED" } as any]); }
  return (
    <div className="space-y-6">
      <Header
        view="settings"
        title="Media Manager Settings"
        description="Configure profiles, acquisition behavior and safety without duplicating global provider credentials."
      />
      <div className="flex flex-wrap gap-2">
        {[["Profiles", "profiles"], ["Languages", "languages"], ["Rules", "rules"], ["Acquisition", "acquisition"], ["Safety", "safety"]].map(([label, id]) => <Button key={id} asChild variant={section === id ? "default" : "outline"}><Link href={`/media-manager/settings/${id}`}>{label}</Link></Button>)}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profiles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-end"><Button size="sm" variant="outline" onClick={addProfile}>Create profile</Button></div>
          {profiles.map((profile, index) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"
              key={profile.id}
            >
              <div>
                <input className="rounded border bg-background p-1 font-medium" value={profile.name || profile.id} onChange={(event) => updateProfile(index, { name: event.target.value })} aria-label={`${profile.id} name`} />
                <input className="mt-1 block w-full rounded border bg-background p-1 text-xs" value={profile.description || ""} onChange={(event) => updateProfile(index, { description: event.target.value })} placeholder="Description" />
                <p className="text-xs text-muted-foreground">
                  VersionProfile · requirements remain extensible
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label>Priority <input className="ml-1 w-16 rounded border bg-background p-1" type="number" value={profile.priority ?? 0} onChange={(event) => updateProfile(index, { priority: Number(event.target.value) })} /></label>
                <label>Resolution <input className="ml-1 w-20 rounded border bg-background p-1" value={profile.preferredResolution || ""} onChange={(event) => updateProfile(index, { preferredResolution: event.target.value })} /></label>
                <label>
                <input
                  type="checkbox"
                  checked={profile.enabled}
                  onChange={(event) =>
                    updateProfile(index, { enabled: event.target.checked })
                  }
                />
                Enabled
                </label>
              </div>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save profiles"}
            </Button>
            {saved && (
              <span className="text-sm text-muted-foreground">{saved}</span>
            )}
          </div>
          <div className="space-y-2 rounded border p-3"><p className="font-medium">Scoring</p><p className="text-xs text-muted-foreground">Weights are profile-specific and only apply after hard requirements pass.</p>{profiles.map((profile, index) => <details key={`score-${profile.id}`} className="rounded border p-2"><summary className="cursor-pointer text-sm">{profile.name || profile.id}</summary><div className="mt-2 space-y-2">{Object.entries(profile.scoring || {}).map(([field, weight]) => <div className="flex gap-2" key={field}><input className="flex-1 rounded border bg-background p-1 text-sm" value={field} onChange={(event) => { const scoring = { ...(profile.scoring || {}) }; delete scoring[field]; scoring[event.target.value] = Number(weight); updateProfile(index, { scoring }); }} /><input className="w-24 rounded border bg-background p-1 text-sm" type="number" value={String(weight)} onChange={(event) => updateProfile(index, { scoring: { ...(profile.scoring || {}), [field]: Number(event.target.value) } })} /><Button size="sm" variant="ghost" onClick={() => { const scoring = { ...(profile.scoring || {}) }; delete scoring[field]; updateProfile(index, { scoring }); }}>Remove</Button></div>)}<Button size="sm" variant="outline" onClick={() => updateProfile(index, { scoring: { ...(profile.scoring || {}), resolution: 0 } })}>Add scoring rule</Button></div></details>)}</div>
        </CardContent>
      </Card>
      <Card id="media-manager-languages">
        <CardHeader><CardTitle className="text-base">Languages</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">Language rules are profile-scoped. Audio and subtitles remain distinct; ORIGINAL is resolved from identity metadata.</p>
          {profiles.map((profile, index) => <div key={profile.id} className="grid gap-2 rounded border p-3 md:grid-cols-4">
            <span className="font-medium">{profile.name || profile.id}</span>
            <input className="rounded border bg-background p-2" placeholder="required: ita, eng" value={(profile.languagePolicy?.required?.values || []).join(", ")} onChange={(event) => updateProfile(index, { languagePolicy: { ...(profile.languagePolicy || {}), required: { ...(profile.languagePolicy?.required || {}), values: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } } } as any)} />
            <select className="rounded border bg-background p-2" value={profile.languagePolicy?.required?.mode || "ALL"} onChange={(event) => updateProfile(index, { languagePolicy: { ...(profile.languagePolicy || {}), required: { ...(profile.languagePolicy?.required || {}), mode: event.target.value } } } as any)}><option>ALL</option><option>ANY</option></select>
            <select className="rounded border bg-background p-2" value={profile.languagePolicy?.scope || "AUDIO"} onChange={(event) => updateProfile(index, { languagePolicy: { ...(profile.languagePolicy || {}), scope: event.target.value } } as any)}><option>AUDIO</option><option>SUBTITLE</option><option>AUDIO_OR_SUBTITLE</option></select>
          </div>)}
        </CardContent>
      </Card>
      <Card id="media-manager-rules">
        <CardHeader><CardTitle className="text-base">Rules</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm"><p className="text-muted-foreground">Hard requirements are evaluated before scoring. The builder keeps field/operator combinations within the supported rule model.</p>{profiles.map((profile, index) => <details key={profile.id} className="rounded border p-3"><summary className="cursor-pointer font-medium">{profile.name || profile.id} hard requirements</summary><div className="mt-2"><RuleBuilder node={profile.hardRequirements || { op: "AND", children: [] }} root onChange={(hardRequirements) => updateProfile(index, { hardRequirements } as any)} /></div></details>)}</CardContent>
      </Card>
      <Card id="media-manager-acquisition">
        <CardHeader><CardTitle className="text-base">Acquisition</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm"><p>Acquisition execution remains disabled for this policy milestone.</p><p className="text-muted-foreground">Seerr credentials stay in global Settings and are not duplicated here.</p><Link className="text-primary" href="/settings">Open global provider settings <ChevronRight className="inline h-4 w-4" /></Link></CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card id="media-manager-safety">
          <CardHeader>
            <CardTitle className="text-base">Safety</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><StatusBadge value="DRY RUN" /> Delete disabled / not implemented.</p>
            <label className="flex items-center gap-2"><input type="checkbox" checked={policy.safety?.requireRecoverableBeforeDelete !== false} onChange={(event) => setPolicy((current: any) => ({ ...current, safety: { ...current.safety, requireRecoverableBeforeDelete: event.target.checked } }))} /> Require recoverability before candidate</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={policy.safety?.allowDeleteWhenIdentityUncertain === true} onChange={(event) => setPolicy((current: any) => ({ ...current, safety: { ...current.safety, allowDeleteWhenIdentityUncertain: event.target.checked } }))} /> Allow uncertain identity (not recommended)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={policy.safety?.allowDeleteWhenMetadataIncomplete === true} onChange={(event) => setPolicy((current: any) => ({ ...current, safety: { ...current.safety, allowDeleteWhenMetadataIncomplete: event.target.checked } }))} /> Allow incomplete metadata (not recommended)</label>
            <p className="text-muted-foreground">
              Recoverability requirements remain fail-closed.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
export function MediaManagerShell({ view, section }: { view: View; section?: string }) {
  if (view === "overview") return <Overview />;
  if (view === "library") return <Library initialPreset={section || "all"} />;
  if (view === "migration") return <Migration section={section || "export"} />;
  return <SettingsView section={section || "profiles"} />;
}
