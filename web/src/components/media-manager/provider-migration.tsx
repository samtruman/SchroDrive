"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "./confirmation-dialog";

async function json(url: string, body?: unknown) {
  const response = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok || value.ok === false) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

export function ProviderMigration() {
  const [capabilities, setCapabilities] = useState<any>(null);
  const [source, setSource] = useState("alldebrid"), [target, setTarget] = useState("realdebrid");
  const [plan, setPlan] = useState<any>(null), [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false), [job, setJob] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const generation = useRef(0);
  useEffect(() => {
    void json("/api/version-manager/migration/capabilities").then(setCapabilities).catch(error => setError(error.message));
    void json("/api/version-manager/migration/jobs").then(value => setHistory(value.jobs || [])).catch(error => setError(error.message));
    return () => { generation.current++; };
  }, []);
  useEffect(() => {
    if (!job?.id || !["QUEUED", "RUNNING"].includes(job.status)) return;
    const timer = window.setInterval(() => {
      void json(`/api/version-manager/migration/jobs/${encodeURIComponent(job.id)}`).then(value => {
        setJob(value.job); setHistory(current => [value.job, ...current.filter(item => item.id !== value.job.id)]);
      }).catch(error => setError(error.message));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);
  const providers = capabilities?.providers || [];
  const route = capabilities?.routes?.find((route: any) => route.sourceProvider === source && route.targetProvider === target);
  const routeReady = source !== target && route?.supported && providers.find((p: any) => p.providerId === source)?.configured && providers.find((p: any) => p.providerId === target)?.configured;
  const active = job && ["QUEUED", "RUNNING"].includes(job.status);
  const ready = (plan?.items || []).filter((item: any) => item.effectiveStatus === "READY_TO_IMPORT" && item.infoHash);
  function reset() { generation.current++; setPlan(null); setSelected(new Set()); setError(""); setConfirm(false); setBusy(false); }
  async function preview() {
    const current = ++generation.current;
    setBusy(true); setError(""); setPlan(null); setSelected(new Set());
    try {
      const value = await json("/api/version-manager/migration/preview", { sourceProvider: source, targetProvider: target });
      if (current === generation.current) setPlan(value);
    } catch (error: any) { if (current === generation.current) setError(error.message); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function execute() {
    if (!plan || !selected.size || plan.sourceProvider !== source || plan.targetProvider !== target) throw new Error("Load a preview for this route first");
    const result = await json("/api/version-manager/migration/jobs", { confirm: "START_MIGRATION", previewId: plan.previewId, sourceProvider: source, targetProvider: target, selectedHashes: [...selected] });
    setJob(result.job); setHistory(current => [result.job, ...current.filter(item => item.id !== result.job.id)]); setSelected(new Set()); setPlan(null);
  }
  return <section className="space-y-4" aria-label="Provider migration">
    <div className="rounded-lg border p-5 space-y-4">
      <h2 className="text-lg font-semibold">Migrate between providers</h2>
      <p className="text-sm text-muted-foreground">Choose the origin and destination. SchröDrive reads the source inventory directly and checks what is already present at the target. No file upload is needed.</p>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium">Source provider<select className="mt-1 block w-full rounded border bg-background p-2" value={source} disabled={active} onChange={event => { reset(); setSource(event.target.value); }}>{providers.map((p: any) => <option key={p.providerId} value={p.providerId} disabled={!p.configured}>{p.displayName}{!p.configured ? " (not configured)" : ""}</option>)}</select></label>
        <label className="text-sm font-medium">Target provider<select className="mt-1 block w-full rounded border bg-background p-2" value={target} disabled={active} onChange={event => { reset(); setTarget(event.target.value); }}>{providers.map((p: any) => <option key={p.providerId} value={p.providerId} disabled={!p.configured}>{p.displayName}{!p.configured ? " (not configured)" : ""}</option>)}</select></label>
      </div>
      {source === target && <p className="text-sm text-destructive">Choose two different providers.</p>}
      {capabilities && !routeReady && source !== target && <p className="text-sm text-destructive">This route is unavailable. Check provider configuration and supported inventory/import capabilities.</p>}
      <div className="flex flex-wrap items-center gap-3"><Button disabled={!routeReady || busy || active} onClick={() => void preview()}>{busy ? "Reading provider inventories…" : "Load provider preview"}</Button><span className="text-sm text-muted-foreground">Read-only preview · source remains unchanged</span></div>
      <p className="text-xs text-muted-foreground">Execution adds the selected magnet references at the target. It does not transfer media bytes or delete anything at the source.</p>
    </div>
    {error && <p role="alert" className="rounded border border-destructive p-3 text-sm">{error}</p>}
    {plan && <div className="rounded-lg border p-5 space-y-4">
      <h2 className="font-semibold">Reconciliation preview · {plan.sourceProvider} → {plan.targetProvider}</h2>
      <p className="text-sm">Source: {plan.sourceItems} items · Target: {plan.targetItems} items · Eligible: {ready.length}</p>
      <div className="flex flex-wrap gap-3 text-xs">{Object.entries(plan.counts).map(([status,count]) => <span className="rounded border p-2" key={status}>{status.replaceAll("_", " ")}: {String(count)}</span>)}</div>
      <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={!ready.length} onClick={() => setSelected(new Set(ready.map((item: any) => item.infoHash)))}>Select eligible items</Button><Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear</Button><span className="text-sm">Selected {selected.size}</span></div>
      {!ready.length && <p className="text-sm">Nothing eligible to migrate. Existing items and blocked items are excluded; see each reason below.</p>}
      <div className="max-h-96 overflow-auto rounded border">{plan.items.map((item: any) => <label key={item.index} className="flex items-start gap-3 border-b p-3 text-sm last:border-0"><input aria-label={`Select ${item.originalName || item.index}`} type="checkbox" className="mt-1" disabled={item.effectiveStatus !== "READY_TO_IMPORT" || !item.infoHash} checked={selected.has(item.infoHash)} onChange={() => setSelected(current => { const next = new Set(current); next.has(item.infoHash) ? next.delete(item.infoHash) : next.add(item.infoHash); return next; })} /><span className="min-w-0 flex-1"><span className="block break-words font-medium">{item.originalName || "Unnamed item"}</span><span className="block text-muted-foreground">{item.reason}</span></span><span className="text-xs">{item.effectiveStatus.replaceAll("_", " ")}</span></label>)}</div>
      <p className="text-xs text-muted-foreground">Preview expires at {new Date(plan.expiresAt).toLocaleTimeString()}. The target is checked again before each addition.</p>
    </div>}
    <div className="flex flex-wrap items-center gap-3"><Button disabled={!plan || !selected.size || busy || active} onClick={() => setConfirm(true)}>Execute Migration</Button><span className="text-sm text-muted-foreground">{plan ? "Only selected eligible items will be added after confirmation." : "Load the provider preview and select eligible items first."}</span></div>
    <ConfirmationDialog open={confirm} onOpenChange={setConfirm} title="Execute provider migration?" description="The selected references will be added to the target provider. The source is kept unchanged. This starts a real migration job." context={<p>{source} → {target} · {selected.size} selected items</p>} confirmLabel="Start selected migration" onConfirm={execute} />
    <section aria-label="Migration jobs" className="rounded-lg border p-5 space-y-3"><h2 className="font-semibold">Jobs and results</h2>{!history.length && <p className="text-sm text-muted-foreground">No migration jobs recorded.</p>}{history.map(item => <details key={item.id} className="rounded border p-3" open={item.id === job?.id}><summary className="cursor-pointer text-sm">{item.sourceProvider} → {item.targetProvider} · {item.status} · {item.processed}/{item.total}</summary><p className="mt-2 text-sm">Imported {item.imported} · skipped {item.skipped} · failed {item.failed}</p>{item.error && <p className="text-sm text-destructive">{item.error}</p>}{item.result?.results?.map((result: any, index: number) => <p key={index} className="mt-1 text-xs">{result.status} · {result.reason || result.providerItemId || ""}</p>)}</details>)}</section>
  </section>;
}
