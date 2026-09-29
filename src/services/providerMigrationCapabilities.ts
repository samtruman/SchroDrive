import type { DebridProvider } from "../providers";

export type MigrationCapability = "inventory" | "fileTree" | "infohash" | "magnetExport" | "recoverability" | "cacheLookup" | "importMagnet" | "importTorrent" | "duplicateLookup" | "postImportVerification" | "delete" | "status";
export type CapabilitySupportLevel = "IMPLEMENTED" | "CONTRACT_TESTED" | "INTEGRATION_TESTED" | "E2E_VALIDATED" | "UNVALIDATED" | "UNSUPPORTED";
export type CapabilitySupport = "SUPPORTED" | "PARTIAL" | "UNSUPPORTED" | "UNKNOWN";

export interface ProviderCapabilityStatus {
  capability: MigrationCapability;
  support: CapabilitySupport;
  validation: CapabilitySupportLevel;
  note?: string;
}

export interface ProviderMigrationCapabilities {
  providerId: string;
  displayName: string;
  configured: boolean;
  capabilities: ProviderCapabilityStatus[];
}

const ALLDEBRID: ProviderCapabilityStatus[] = [
  { capability: "inventory", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "fileTree", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "infohash", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "magnetExport", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "recoverability", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "cacheLookup", support: "UNKNOWN", validation: "UNVALIDATED" },
  { capability: "importMagnet", support: "SUPPORTED", validation: "E2E_VALIDATED", note: "Single reverse restore validated; bulk import remains separately controlled." },
  { capability: "importTorrent", support: "SUPPORTED", validation: "CONTRACT_TESTED" },
  { capability: "duplicateLookup", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "postImportVerification", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "delete", support: "SUPPORTED", validation: "IMPLEMENTED", note: "Provider method exists; Delete Executor remains disabled." },
  { capability: "status", support: "SUPPORTED", validation: "E2E_VALIDATED" },
];

const REAL_DEBRID: ProviderCapabilityStatus[] = [
  { capability: "inventory", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "fileTree", support: "SUPPORTED", validation: "INTEGRATION_TESTED" },
  { capability: "infohash", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "magnetExport", support: "SUPPORTED", validation: "E2E_VALIDATED", note: "A canonical magnet was reconstructed from the validated infohash; the original magnet URI is not guaranteed." },
  { capability: "recoverability", support: "SUPPORTED", validation: "E2E_VALIDATED", note: "Restore recoverability is validated via infohash/magnet reconstruction; file-tree completeness is separate." },
  { capability: "cacheLookup", support: "UNKNOWN", validation: "UNVALIDATED" },
  { capability: "importMagnet", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "importTorrent", support: "SUPPORTED", validation: "CONTRACT_TESTED" },
  { capability: "duplicateLookup", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "postImportVerification", support: "SUPPORTED", validation: "E2E_VALIDATED" },
  { capability: "delete", support: "SUPPORTED", validation: "IMPLEMENTED", note: "Provider method exists; Delete Executor remains disabled." },
  { capability: "status", support: "SUPPORTED", validation: "E2E_VALIDATED" },
];

const TORBOX: ProviderCapabilityStatus[] = [
  ...(["inventory", "fileTree", "infohash", "magnetExport", "recoverability", "cacheLookup", "importMagnet", "importTorrent", "duplicateLookup", "postImportVerification", "delete", "status"] as MigrationCapability[])
    .map((capability) => ({ capability, support: (capability === "recoverability" || capability === "magnetExport" ? "PARTIAL" : "SUPPORTED") as CapabilitySupport, validation: "UNVALIDATED" as const, note: "API access is unavailable on the current Free account." })),
];

const UNSUPPORTED: ProviderCapabilityStatus[] = (["inventory", "fileTree", "infohash", "magnetExport", "recoverability", "cacheLookup", "importMagnet", "importTorrent", "duplicateLookup", "postImportVerification", "delete", "status"] as MigrationCapability[])
  .map((capability) => ({ capability, support: "UNKNOWN" as const, validation: "UNVALIDATED" as const, note: "No migration capability declaration or validation." }));

const declarations: Record<string, ProviderCapabilityStatus[]> = { alldebrid: ALLDEBRID, realdebrid: REAL_DEBRID, torbox: TORBOX };

export function providerMigrationCapabilities(provider: DebridProvider): ProviderMigrationCapabilities {
  return { providerId: provider.id, displayName: provider.displayName, configured: provider.isConfigured(), capabilities: declarations[provider.id] || UNSUPPORTED };
}

export function migrationCapability(provider: ProviderMigrationCapabilities | undefined, capability: MigrationCapability): ProviderCapabilityStatus | undefined {
  return provider?.capabilities.find((item) => item.capability === capability);
}

/** Backward-compatible validation projection used by the route selector. */
export function capabilityValidation(provider: ProviderMigrationCapabilities | undefined, capability: MigrationCapability): CapabilitySupportLevel {
  return migrationCapability(provider, capability)?.validation || "UNVALIDATED";
}

const levelRank: Record<CapabilitySupportLevel, number> = { UNSUPPORTED: 0, UNVALIDATED: 1, IMPLEMENTED: 2, CONTRACT_TESTED: 3, INTEGRATION_TESTED: 4, E2E_VALIDATED: 5 };

export function migrationRouteLevel(source: ProviderMigrationCapabilities, target: ProviderMigrationCapabilities): { level: CapabilitySupportLevel; supported: boolean; reason?: string } {
  const required: Array<[ProviderMigrationCapabilities, MigrationCapability]> = [
    [source, "inventory"], [source, "magnetExport"], [source, "recoverability"],
    [target, "inventory"], [target, "importMagnet"], [target, "infohash"],
  ];
  const missing = required.filter(([provider, capability]) => {
    const item = migrationCapability(provider, capability);
    return !item || item.support === "UNSUPPORTED" || item.support === "UNKNOWN";
  });
  if (missing.length) return { level: "UNSUPPORTED", supported: false, reason: missing.map(([provider, capability]) => `${provider.providerId}.${capability}`).join(", ") };
  const level = required.reduce<CapabilitySupportLevel>((current, [provider, capability]) => {
    const candidate = migrationCapability(provider, capability)?.validation || "UNVALIDATED";
    return levelRank[candidate] < levelRank[current] ? candidate : current;
  }, "E2E_VALIDATED");
  return { level, supported: true };
}
