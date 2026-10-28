import { describe, expect, test } from 'bun:test';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb } from '../../src/core/db';
import {
  ProviderReconciliationIntake,
  InMemoryIntakeStateStore,
  SqliteIntakeStateStore,
  type ProviderSnapshot,
  type ArrClient,
  type ArrCommandResult,
  type DirectFileEvent,
  isMediaFile,
  ProviderSnapshotSource,
  ProviderReconciliationWorker,
  HttpArrClient,
} from '../../src/services/providerReconciliation';

function snapshot(id: string, name: string, files = [{ path: `${name}.mkv`, size: 10 }]): ProviderSnapshot {
  return { providerItemId: id, name, status: 'finished', files, observedAt: '2026-09-17T00:00:00.000Z' };
}

class SequenceSource {
  constructor(private readonly rounds: ProviderSnapshot[][]) {}
  async listSnapshot(): Promise<ProviderSnapshot[]> { return this.rounds.shift() || []; }
}

class FakeArr implements ArrClient {
  submitted: Array<{ kind: string; event: DirectFileEvent }> = [];
  polled: string[] = [];
  async submitScan(route: any, event: DirectFileEvent): Promise<ArrCommandResult> {
    this.submitted.push({ kind: route.kind, event });
    return { commandId: `${route.kind}-${this.submitted.length}`, status: 'queued' };
  }
  async getCommand(_route: any, commandId: string): Promise<ArrCommandResult> {
    this.polled.push(commandId);
    return { commandId, status: 'completed', result: 'successful' };
  }
}

const routeFor = (category: 'Movies' | 'Shows') => ({
  kind: category === 'Movies' ? 'radarr' as const : 'sonarr' as const,
  baseUrl: `http://${category.toLowerCase()}.test`,
  apiKey: 'fixture-key',
});

describe('provider reconciliation direct intake', () => {
  test('uses the common provider contract for a non-AllDebrid provider', async () => {
    const source = new ProviderSnapshotSource({
      id: 'realdebrid',
      async listTorrents() { return [{ id: 'rd-1', name: 'Example.Show S01E01', status: 'seeding', progress: 100, bytes: 10, files: [{ id: 'f1', name: 'Example.Show.S01E01.mkv', path: 'Example.Show.S01E01.mkv', size: 10, selected: true }] } as any]; },
      async fetchDirectories() { return [{ id: 'rd-1', name: 'Example.Show.S01E01', originalName: 'Example.Show S01E01', files: [{ id: 'f1', name: 'Example.Show.S01E01.mkv', size: 10 }] }]; },
    });
    const snapshots = await source.listSnapshot();
    expect(snapshots[0]).toMatchObject({ provider: 'realdebrid', providerItemId: 'realdebrid:rd-1', status: 'seeding' });
    expect(snapshots[0].files).toEqual([{ path: 'Example.Show.S01E01.mkv', size: 10 }]);
  });

  test('uses the existing AllDebrid client for bounded recent and full snapshots', async () => {
    const recentRequests: string[][] = [];
    let fullCalls = 0;
    const provider = {
      async listTorrents() {
        return [
          { id: 'old', name: 'Old Movie', filename: 'Old Movie', status: 'finished', progress: 100, bytes: 1, files: [], addedAt: new Date('2026-09-16T00:00:00Z') },
          { id: 'new', name: 'New Movie', filename: 'New Movie', status: 'finished', progress: 100, bytes: 1, files: [], addedAt: new Date('2026-09-17T00:00:00Z') },
        ];
      },
      async fetchDirectories() {
        fullCalls++;
        return [{ id: 'old', name: 'Old Movie', originalName: 'Old Movie', files: [{ id: 'old.mkv', name: 'old.mkv', size: 1 }] }, { id: 'new', name: 'New Movie', originalName: 'New Movie', files: [{ id: 'new.mkv', name: 'new.mkv', size: 1 }] }];
      },
      async fetchDirectoriesForIds(items: Array<{ id: string }>) {
        recentRequests.push(items.map((item) => item.id));
        return items.map((item) => ({ id: item.id, name: item.id, originalName: item.id, files: [{ id: `${item.id}.mkv`, name: `${item.id}.mkv`, size: 1 }] }));
      },
    };
    const source = new ProviderSnapshotSource(provider as any, false);
    const recent = await source.listRecentSnapshot!(1);
    const full = await source.listSnapshot();
    expect(recent.map((item) => item.providerItemId)).toEqual(['old', 'new']);
    expect(recentRequests).toEqual([['new']]);
    expect(full.map((item) => item.providerItemId)).toEqual(['old', 'new']);
    expect(fullCalls).toBe(1);

    const arr = new FakeArr();
    const intake = new ProviderReconciliationIntake(
      new ProviderSnapshotSource(provider as any, false), arr, new InMemoryIntakeStateStore(), { routeFor },
    );
    const events = await intake.reconcile('recent', 1);
    expect(events).toHaveLength(1);
    expect(events[0].provider).toBe('alldebrid');
    expect(arr.submitted[0].kind).toBe('radarr');
  });

  test('includes known older provider items in the recent diff scan', async () => {
    const requested: string[][] = [];
    const provider = {
      async listTorrents() {
        return [
          { id: 'old', name: 'Old Movie', filename: 'Old Movie', status: 'finished', progress: 100, bytes: 1, files: [], addedAt: new Date('2020-01-01T00:00:00Z') },
          { id: 'new', name: 'New Movie', filename: 'New Movie', status: 'finished', progress: 100, bytes: 1, files: [], addedAt: new Date('2026-09-17T00:00:00Z') },
        ];
      },
      async fetchDirectories() {
        return ['old', 'new'].map((id) => ({ id, name: id, originalName: id, files: [{ id: `${id}.mkv`, name: `${id}.mkv`, size: 1 }] }));
      },
      async fetchDirectoriesForIds(items: Array<{ id: string }>) {
        requested.push(items.map((item) => item.id));
        return items.map((item) => ({ id: item.id, name: item.id, originalName: item.id, files: [{ id: `${item.id}.mkv`, name: `${item.id}.mkv`, size: 1 }] }));
      },
    };
    const store = new InMemoryIntakeStateStore();
    const arr = new FakeArr();
    const intake = new ProviderReconciliationIntake(new ProviderSnapshotSource(provider as any), arr, store, { routeFor });
    await intake.reconcile('full');
    requested.length = 0;
    await intake.reconcile('recent', 1);
    expect(requested).toEqual([[]]);
    expect(arr.submitted.some((item) => item.event.providerItemId === 'alldebrid:old' && item.event.action === 'changed')).toBe(false);
  });

  test('detects provider removals during the recent ID-only scan', async () => {
    let round = 0;
    const provider = {
      id: 'alldebrid',
      async listTorrents() {
        const items = [
          { id: 'old', name: 'Old Movie', status: 'finished', progress: 100, bytes: 1, files: [], addedAt: new Date('2026-09-16T00:00:00Z') },
          { id: 'new', name: 'New Movie', status: 'finished', progress: 100, bytes: 1, files: [], addedAt: new Date('2026-09-17T00:00:00Z') },
        ];
        return round++ === 0 ? items : items.slice(1);
      },
      async fetchDirectoriesForIds(items: Array<{ id: string }>) {
        return items.map((item) => ({ id: item.id, name: item.id, originalName: item.id, files: [{ id: `${item.id}.mkv`, name: `${item.id}.mkv`, size: 1 }] }));
      },
    };
    const store = new InMemoryIntakeStateStore();
    const arr = new FakeArr();
    const intake = new ProviderReconciliationIntake(new ProviderSnapshotSource(provider as any), arr, store, { routeFor });
    await intake.reconcile('recent', 30);
    const events = await intake.reconcile('recent', 30);
    expect(events.some((event) => event.providerItemId === 'alldebrid:old' && event.action === 'deleted')).toBe(true);
    expect(events.find((event) => event.providerItemId === 'alldebrid:old')?.tree).toEqual([{ path: 'old.mkv', size: 1 }]);
  });

  test('emits add and routes Movies to Radarr and Shows to Sonarr', async () => {
    const arr = new FakeArr();
    const intake = new ProviderReconciliationIntake(
      new SequenceSource([[snapshot('m-1', 'Movie (2026)'), snapshot('s-1', 'Show S01E02')]]),
      arr,
      new InMemoryIntakeStateStore(),
      { routeFor },
    );

    const events = await intake.reconcile();
    expect(events.map((event) => event.action)).toEqual(['added', 'added']);
    expect(events.map((event) => event.sourceCategory)).toEqual(['Movies', 'Shows']);
    expect(arr.submitted.map((item) => item.kind)).toEqual(['radarr', 'sonarr']);
    expect(arr.submitted[0].event.path).toBe('Movie (2026).mkv');
  });

  test('emits changed when a completed file tree changes, even after a missed round', async () => {
    const store = new InMemoryIntakeStateStore();
    const arr = new FakeArr();
    const intake = new ProviderReconciliationIntake(
      new SequenceSource([
        [snapshot('m-1', 'Movie (2026)', [{ path: 'Movie.mkv', size: 10 }])],
        [snapshot('m-1', 'Movie (2026)', [{ path: 'Movie.mkv', size: 20 }])],
      ]),
      arr, store, { routeFor },
    );
    await intake.reconcile();
    const second = await intake.reconcile();
    expect(second).toHaveLength(1);
    expect(second[0].action).toBe('changed');
    expect(second[0].stableDedupeKey).not.toBe((await intake.reconcile())[0]?.stableDedupeKey);
  });

  test('suppresses duplicate delivery and emits deletion from a missing status item', async () => {
    const store = new InMemoryIntakeStateStore();
    const arr = new FakeArr();
    const intake = new ProviderReconciliationIntake(
      new SequenceSource([[snapshot('m-1', 'Movie (2026)')], [snapshot('m-1', 'Movie (2026)')], []]),
      arr, store, { routeFor },
    );
    expect((await intake.reconcile()).map((e) => e.action)).toEqual(['added']);
    expect(await intake.reconcile()).toEqual([]);
    expect((await intake.reconcile()).map((e) => e.action)).toEqual(['deleted']);
    expect(arr.submitted).toHaveLength(1);
  });

  test('reprocesses a provider item re-added after deletion even with the same fingerprint', async () => {
    const store = new InMemoryIntakeStateStore();
    const arr = new FakeArr();
    const intake = new ProviderReconciliationIntake(
      new SequenceSource([[snapshot('m-1', 'Movie (2026)')], [], [snapshot('m-1', 'Movie (2026)')]]),
      arr, store, { routeFor },
    );
    expect((await intake.reconcile()).map((event) => event.action)).toEqual(['added']);
    expect((await intake.reconcile()).map((event) => event.action)).toEqual(['deleted']);
    expect((await intake.reconcile()).map((event) => event.action)).toEqual(['added']);
    expect(arr.submitted).toHaveLength(2);
  });

  test('dry-run persists state without submitting to Arr', async () => {
    const arr = new FakeArr();
    const store = new InMemoryIntakeStateStore();
    const intake = new ProviderReconciliationIntake(
      new SequenceSource([[snapshot('m-1', 'Movie (2026)')]]), arr, store,
      { routeFor, dryRun: true },
    );
    const events = await intake.reconcile();
    expect(events).toHaveLength(1);
    expect(arr.submitted).toHaveLength(0);
    expect(store.getItem('m-1')?.lastAction).toBe('added');
  });

  test('keeps all supported subtitles and attachments in the event tree', async () => {
    const names = ['video.mkv', 'captions.srt', 'captions.ass', 'captions.ssa', 'captions.sub', 'captions.vtt', 'captions.idx', 'captions.sup', 'captions.sbv', 'captions.mpsub', 'cover.jpg'];
    const arr = new FakeArr();
    const intake = new ProviderReconciliationIntake(
      new SequenceSource([[snapshot('m-1', 'Movie (2026)', names.map((path) => ({ path, size: 1 })))]]) ,
      arr, new InMemoryIntakeStateStore(), { routeFor },
    );
    const events = await intake.reconcile();
    expect(names.filter(isMediaFile)).toHaveLength(10);
    expect(events[0].tree.map((file) => file.path)).toEqual(names.slice(0, 10));
  });

  test('restarts from persisted state and polls the pending Arr command', async () => {
    const store = new InMemoryIntakeStateStore();
    const firstArr = new FakeArr();
    await new ProviderReconciliationIntake(
      new SequenceSource([[snapshot('m-1', 'Movie (2026)')]]), firstArr, store, { routeFor },
    ).reconcile();
    const secondArr = new FakeArr();
    const events = await new ProviderReconciliationIntake(
      new SequenceSource([[snapshot('m-1', 'Movie (2026)')]]), secondArr, store, { routeFor },
    ).reconcile();
    expect(events).toEqual([]);
    expect(secondArr.polled).toEqual(['radarr-1']);
    expect(store.getItem('m-1')?.terminalStatus).toBe('completed');
  });

  test('persists the direct event and cursor across a SQLite store restart', async () => {
    const itemId = `sqlite-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const firstArr = new FakeArr();
    const firstStore = new SqliteIntakeStateStore();
    const source = new SequenceSource([[snapshot(itemId, 'Movie (2026)')]]);
    const first = new ProviderReconciliationIntake(source, firstArr, firstStore, { routeFor });
    const events = await first.reconcile('full');
    expect(events.some((event) => event.providerItemId === itemId && event.action === 'added')).toBe(true);
    expect(firstStore.getCursor().fullAt).toBeDefined();
    expect(firstStore.hasEvent(events[0].stableDedupeKey)).toBe(true);

    closeDb();
    const secondStore = new SqliteIntakeStateStore();
    const secondArr = new FakeArr();
    const second = new ProviderReconciliationIntake(
      new SequenceSource([[snapshot(itemId, 'Movie (2026)')]]), secondArr, secondStore, { routeFor },
    );
    expect(await second.reconcile('full')).toEqual([]);
    expect(secondArr.submitted).toHaveLength(0);
    expect(secondStore.getItem(itemId)?.lastAction).toBe('added');
    closeDb();
  });

  test('retries transient Arr submission failures and preserves one correlation', async () => {
    let attempts = 0;
    const arr: ArrClient = {
      async submitScan() {
        attempts++;
        if (attempts < 3) throw new Error('temporary');
        return { commandId: 'sonarr-1', status: 'queued' };
      },
      async getCommand(_route, commandId) { return { commandId, status: 'completed' }; },
    };
    const intake = new ProviderReconciliationIntake(
      new SequenceSource([[snapshot('s-1', 'Show S01E02')]]), arr, new InMemoryIntakeStateStore(),
      { routeFor, maxAttempts: 3 },
    );
    await intake.reconcile();
    expect(attempts).toBe(3);
  });

  test('hands permanent Arr failure to Review after bounded retries', async () => {
    const reviewed: DirectFileEvent[] = [];
    const arr: ArrClient = {
      async submitScan() { throw new Error('permanent'); },
      async getCommand(_route, commandId) { return { commandId, status: 'failed' }; },
    };
    const intake = new ProviderReconciliationIntake(
      new SequenceSource([[snapshot('m-1', 'Movie (2026)')]]), arr, new InMemoryIntakeStateStore(),
      { routeFor, maxAttempts: 2, onReview: (event) => { reviewed.push(event); } },
    );
    await expect(intake.reconcile()).rejects.toThrow('permanent');
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0].action).toBe('added');
  });

  test('uses ARR title aliases before TMDB for year-suffixed Sonarr titles', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'provider-arr-title-'));
    const originalFetch = globalThis.fetch;
    try {
      const library = path.join(root, 'organized', 'TV', 'Brothers');
      let tmdbCalls = 0;
      let commandBody: Record<string, unknown> | undefined;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/v3/series')) {
          return new Response(JSON.stringify([{ id: 57, title: 'Brothers (2026)', year: 2026, path: library, tvdbId: 448114 }]), { status: 200 });
        }
        if (url.includes('api.themoviedb.org')) {
          tmdbCalls++;
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        if (url.endsWith('/api/v3/command')) {
          commandBody = JSON.parse(String(init?.body || '{}'));
          return new Response(JSON.stringify({ id: 91, status: 'queued' }), { status: 201 });
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch;

      const event: DirectFileEvent = {
        provider: 'alldebrid', providerItemId: 'alldebrid:brothers', action: 'added',
        path: 'shows/Brothers.2026.S01E05.mkv/Brothers.2026.S01E05.mkv', tree: [],
        sourceCategory: 'Shows', observedAt: new Date().toISOString(), stableDedupeKey: 'brothers',
      };
      const result = await new HttpArrClient().submitScan({
        kind: 'sonarr', baseUrl: 'http://sonarr.fixture', apiKey: 'fixture-key',
        sourcePathPrefix: path.join(root, 'provider'), symlinkLibraryPath: path.join(root, 'organized', 'TV'),
      }, event);

      expect(result.commandId).toBe('91');
      expect(tmdbCalls).toBe(0);
      expect(commandBody).toEqual({ name: 'RescanSeries', seriesId: 57 });
      expect((await lstat(path.join(library, 'Season 01', 'Brothers.2026.S01E05.mkv'))).isSymbolicLink()).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('calls onSuccess only after ARR accepts the event', async () => {
    const succeeded: DirectFileEvent[] = [];
    const intake = new ProviderReconciliationIntake(
      new SequenceSource([[snapshot('m-success', 'Movie (2026)')]]), new FakeArr(), new InMemoryIntakeStateStore(),
      { routeFor, onSuccess: (event) => { succeeded.push(event); } },
    );
    await intake.reconcile();
    expect(succeeded.map((event) => event.providerItemId)).toEqual(['m-success']);
  });

  test('retries one unchanged item when its exact organizer review is still pending', async () => {
    const source = new SequenceSource([[snapshot('s-pending', 'Brothers.2026.S01E05')], [snapshot('s-pending', 'Brothers.2026.S01E05')]]);
    const arr = new FakeArr();
    let pending = false;
    const succeeded: DirectFileEvent[] = [];
    const intake = new ProviderReconciliationIntake(source, arr, new InMemoryIntakeStateStore(), {
      routeFor,
      shouldRetry: () => pending,
      onSuccess: (event) => { succeeded.push(event); pending = false; },
    });

    await intake.reconcile('full');
    pending = true;
    const retried = await intake.reconcile('full');

    expect(retried).toHaveLength(1);
    expect(arr.submitted).toHaveLength(2);
    expect(succeeded).toHaveLength(2);
    expect(pending).toBe(false);
  });

  test('closes legacy reviews for intake items already persisted as deleted', async () => {
    const store = new InMemoryIntakeStateStore();
    store.saveItem({
      provider: 'alldebrid', providerItemId: 'alldebrid:gone', fingerprint: 'gone-fingerprint',
      path: 'shows/Gone.S01E01/Gone.S01E01.mkv', tree: [], sourceCategory: 'Shows',
      lastAction: 'deleted', terminalStatus: 'completed', updatedAt: new Date().toISOString(),
    });
    const deleted: DirectFileEvent[] = [];
    const intake = new ProviderReconciliationIntake(new SequenceSource([[]]), new FakeArr(), store, {
      routeFor,
      onDeleted: (event) => { deleted.push(event); },
    });

    expect(await intake.reconcile('full')).toEqual([]);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ providerItemId: 'alldebrid:gone', action: 'deleted' });
  });

  test('starts recent and full polling at configured intervals and stops cleanly', async () => {
    let calls = 0;
    const intake = { async reconcile() { calls++; return []; } };
    const worker = new ProviderReconciliationWorker(intake as any, { recentMs: 10, fullMs: 15, recentLimit: 2 });
    worker.start();
    expect(worker.isRunning()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    worker.stop();
    const stoppedAt = calls;
    expect(stoppedAt).toBeGreaterThanOrEqual(2);
    expect(worker.isRunning()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toBe(stoppedAt);
  });
});
