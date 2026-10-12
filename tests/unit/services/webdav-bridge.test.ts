import { describe, expect, test } from "bun:test";
import { registry } from "../../../src/providers";
import { WebDAVBridge } from "../../../src/services/webdavBridge";

describe("WebDAV bridge refresh coalescing", () => {
  test("ten concurrent directory requests perform one provider refresh", async () => {
    let calls = 0;
    const provider = {
      id: "fixture-webdav-coalescing",
      displayName: "Fixture WebDAV",
      isConfigured: () => true,
      isRateLimited: () => false,
      getWaitTime: () => 0,
      listTorrents: async () => [],
      fetchDirectories: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return [{ id: "fixture", name: "Fixture", originalName: "Fixture", files: [] }];
      },
      addMagnet: async () => ({ id: "fixture" }),
      checkExisting: async () => false,
      isTorrentDead: () => false,
      deleteTorrent: async () => {},
      resolveDownloadUrl: async () => null,
    } as any;
    registry.register(provider);
    const bridge = new WebDAVBridge({ provider: provider.id, port: 0 });
    await Promise.all(Array.from({ length: 10 }, () => (bridge as any).getDirectories()));
    expect(calls).toBe(1);
  });

  test("restores the last directory inventory and refreshes in the background", async () => {
    const providerId = `fixture-webdav-persistent-${Date.now()}`;
    let calls = 0;
    const provider = {
      id: providerId,
      displayName: "Fixture Persistent WebDAV",
      isConfigured: () => true,
      isRateLimited: () => false,
      getWaitTime: () => 0,
      listTorrents: async () => [],
      fetchDirectories: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return [{ id: "fixture", name: "Fixture", originalName: "Fixture", files: [] }];
      },
      addMagnet: async () => ({ id: "fixture" }),
      checkExisting: async () => false,
      isTorrentDead: () => false,
      deleteTorrent: async () => {},
      resolveDownloadUrl: async () => null,
    } as any;
    registry.register(provider);

    const first = new WebDAVBridge({ provider: providerId, port: 0 });
    await (first as any).getDirectories();
    expect(calls).toBe(1);

    const second = new WebDAVBridge({ provider: providerId, port: 0 });
    const started = Date.now();
    const restored = await (second as any).getDirectories();
    expect(Date.now() - started).toBeLessThan(100);
    expect(restored).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(2);
  });
});
