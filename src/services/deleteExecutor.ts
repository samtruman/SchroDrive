import type { DebridProvider } from "../providers";
import { buildDeleteImpact, type DeleteImpact } from "./deleteImpact";
import type { VersionGroup } from "./versionManager";

export interface DeleteExecutionRequest {
  groups: VersionGroup[];
  provider: DebridProvider;
  providerItemId: string;
  dryRun: boolean;
  confirmation?: string;
}

export interface DeleteExecutionResult {
  status: "VALIDATED" | "DELETED";
  executed: boolean;
  provider: string;
  providerItemId: string;
  impact: DeleteImpact;
}

/** Revalidates the physical unit immediately before optionally deleting it. */
export async function executeVersionManagerDelete(request: DeleteExecutionRequest): Promise<DeleteExecutionResult> {
  const impact = buildDeleteImpact(request.groups, "", "candidates").find((item) => item.provider === request.provider.id && item.providerItemId === request.providerItemId);
  if (!impact) throw new Error("ProviderItem is no longer physically eligible for deletion");
  if (impact.state !== "READY" || impact.onlyCopy || impact.protectedByKeep) throw new Error("ProviderItem failed the final safety check");
  const current = await request.provider.listTorrents();
  if (!current.some((item) => String(item.id) === request.providerItemId)) throw new Error("ProviderItem no longer exists at the provider");
  if (request.dryRun) return { status: "VALIDATED", executed: false, provider: request.provider.id, providerItemId: request.providerItemId, impact };
  if (request.confirmation !== request.providerItemId) throw new Error("Live deletion confirmation does not match the ProviderItem");
  await request.provider.deleteTorrent(request.providerItemId);
  return { status: "DELETED", executed: true, provider: request.provider.id, providerItemId: request.providerItemId, impact };
}
