/** Persistent review queue for Organizer identity decisions. */

import type { ParsedMediaIdentity } from "./mediaParser";
import { getDb } from "../core/db";
import { createHash } from "node:crypto";
import { clearManualIdentityOverride, manualOverrideFromReview, saveManualIdentityOverride, saveManualIdentityOverrideForSource, clearManualIdentityOverrideForSource, sourceOverrideKey } from "./manualIdentity";

export type ReviewDecision = "pending" | "accepted" | "dismissed";

export interface OrganizerReviewEntry {
  id: string;
  sourcePath: string;
  sourceBasename: string;
  parsed: ParsedMediaIdentity;
  decision: ReviewDecision;
  createdAt: string;
  updatedAt: string;
  override?: ReviewOverride;
}

export interface ReviewOverride {
  title?: string;
  originalTitle?: string;
  year?: number;
  season?: number;
  episode?: number;
  kind?: "movie" | "episode";
  tmdbId?: string;
  imdbId?: string;
  tvdbId?: string;
  originalLanguage?: string;
}

export function validateReviewOverride(value: unknown): ReviewOverride | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("override must be an object");
  const input = value as Record<string, unknown>;
  const result: ReviewOverride = {};
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || input.title.trim().length < 1 || input.title.length > 300) {
      throw new Error("override.title must be a non-empty string of at most 300 characters");
    }
    result.title = input.title.trim();
  }
  for (const key of ["originalTitle", "tmdbId", "imdbId", "tvdbId", "originalLanguage"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string" || input[key].trim().length < 1 || input[key].length > 300) {
        throw new Error(`override.${key} must be a non-empty string of at most 300 characters`);
      }
      result[key] = input[key].trim();
    }
  }
  for (const [key, min, max] of [["year", 1800, 2200], ["season", 0, 99], ["episode", 0, 9999]] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "number" || !Number.isInteger(input[key]) || input[key] < min || input[key] > max) {
        throw new Error(`override.${key} is outside the supported range`);
      }
      result[key] = input[key];
    }
  }
  if (input.kind !== undefined) {
    if (input.kind !== "movie" && input.kind !== "episode") throw new Error("override.kind is invalid");
    result.kind = input.kind;
  }
  if (Object.keys(result).length === 0) throw new Error("override must contain a supported field");
  return result;
}

function keyFor(sourcePath: string): string {
  return `review_${createHash("sha256").update(sourcePath, "utf8").digest("hex")}`;
}

/** Returns the persisted review decision for one source path, if present. */
export function getOrganizerReview(sourcePath: string): OrganizerReviewEntry | undefined {
  return listOrganizerReviews(true).find((entry) => entry.id === keyFor(sourcePath));
}

function parseStoredJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; }
  catch { return undefined; }
}

export function recordOrganizerReview(sourcePath: string, parsed: ParsedMediaIdentity): OrganizerReviewEntry {
  const id = keyFor(sourcePath);
  const now = new Date().toISOString();
  const database = getDb();
  const old = database.prepare("SELECT * FROM organizer_reviews WHERE id = ?").get(id) as any;
  const oldOverride = parseStoredJson<ReviewOverride>(old?.override_json);
  const entry: OrganizerReviewEntry = old
    ? { id, sourcePath: old.source_path, sourceBasename: old.source_basename, parsed, decision: old.decision, createdAt: old.created_at, updatedAt: now, ...(oldOverride ? { override: oldOverride } : {}) }
    : { id, sourcePath, sourceBasename: parsed.sourceBasename, parsed, decision: "pending", createdAt: now, updatedAt: now };
  database.prepare(`INSERT INTO organizer_reviews
    (id, source_path, source_basename, parsed_json, decision, override_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET parsed_json=excluded.parsed_json, updated_at=excluded.updated_at`).run(
    entry.id, entry.sourcePath, entry.sourceBasename, JSON.stringify(entry.parsed), entry.decision,
    entry.override ? JSON.stringify(entry.override) : null, entry.createdAt, entry.updatedAt,
  );
  database.prepare("INSERT INTO organizer_review_audit (review_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(id, "recorded", JSON.stringify(parsed), now);
  return entry;
}

/**
 * Marks a persisted review as resolved by an authoritative reconciliation
 * pass. This is deliberately distinct from a manual acceptance: it does not
 * create an identity override and remains auditable.
 */
export function resolveOrganizerReviewAutomatically(sourcePath: string, reason: string): OrganizerReviewEntry | undefined {
  const database = getDb();
  const id = keyFor(sourcePath);
  const row = database.prepare("SELECT * FROM organizer_reviews WHERE id = ?").get(id) as any;
  if (!row || row.decision !== "pending") return undefined;
  const updatedAt = new Date().toISOString();
  database.prepare("UPDATE organizer_reviews SET decision = 'accepted', updated_at = ? WHERE id = ?")
    .run(updatedAt, id);
  database.prepare("INSERT INTO organizer_review_audit (review_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(id, "auto_reconciled", JSON.stringify({ reason }), updatedAt);
  const parsed = parseStoredJson<ParsedMediaIdentity>(row.parsed_json);
  if (!parsed) return undefined;
  const override = parseStoredJson<ReviewOverride>(row.override_json);
  return {
    id, sourcePath: row.source_path, sourceBasename: row.source_basename,
    parsed, decision: "accepted", createdAt: row.created_at, updatedAt,
    ...(override ? { override } : {}),
  };
}

/** True only for the exact provider/organizer path still awaiting a decision. */
export function isOrganizerReviewPending(sourcePath: string): boolean {
  const row = getDb().prepare("SELECT decision FROM organizer_reviews WHERE id = ?").get(keyFor(sourcePath)) as { decision?: ReviewDecision } | undefined;
  return row?.decision === "pending";
}

export function listOrganizerReviews(includeResolved = false, status?: ReviewDecision): OrganizerReviewEntry[] {
  const decision = status || (includeResolved ? undefined : "pending");
  const query = decision
    ? "SELECT * FROM organizer_reviews WHERE decision = ? ORDER BY updated_at DESC"
    : "SELECT * FROM organizer_reviews ORDER BY updated_at DESC";
  const rows = (decision ? getDb().prepare(query).all(decision) : getDb().prepare(query).all()) as any[];
  return rows.flatMap((row) => {
    const parsed = parseStoredJson<ParsedMediaIdentity>(row.parsed_json);
    if (!parsed) return [];
    const override = parseStoredJson<ReviewOverride>(row.override_json);
    return [{
      id: row.id, sourcePath: row.source_path, sourceBasename: row.source_basename,
      parsed, decision: row.decision,
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(override ? { override } : {}),
    }];
  });
}

export type ReviewParserStatus = ParsedMediaIdentity["status"];

export function filterOrganizerReviewsByParserStatus(entries: OrganizerReviewEntry[], status?: ReviewParserStatus): OrganizerReviewEntry[] {
  return status ? entries.filter((entry) => entry.parsed.status === status) : entries;
}

export function decideOrganizerReview(
  id: string,
  decision: Exclude<ReviewDecision, "pending">,
  override?: ReviewOverride,
): OrganizerReviewEntry | undefined {
  const database = getDb();
  const row = database.prepare("SELECT * FROM organizer_reviews WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  const updatedAt = new Date().toISOString();
  const effectiveOverride = override || parseStoredJson<ReviewOverride>(row.override_json);
  // Reject unsupported paths before changing the review state.
  if (decision === "accepted" && effectiveOverride?.kind === "episode" && effectiveOverride.episode !== undefined) {
    const provider = /\/(alldebrid)\//i.exec(row.source_path)?.[1];
    if (!provider || !sourceOverrideKey(provider, row.source_path)) throw new Error("Cannot safely identify the provider source for this episode");
  }
  database.prepare("UPDATE organizer_reviews SET decision = ?, override_json = ?, updated_at = ? WHERE id = ?")
    .run(decision, effectiveOverride ? JSON.stringify(effectiveOverride) : null, updatedAt, id);
  if (decision === "accepted" && effectiveOverride) {
    const parsed = parseStoredJson<ParsedMediaIdentity>(row.parsed_json);
    if (parsed && effectiveOverride.kind === "episode" && effectiveOverride.episode !== undefined) {
      const provider = /\/(alldebrid)\//i.exec(row.source_path)?.[1];
      if (!provider) throw new Error("Cannot safely identify the provider source for this episode");
      saveManualIdentityOverrideForSource(provider, row.source_path, manualOverrideFromReview(effectiveOverride));
    } else if (parsed) saveManualIdentityOverride(parsed, manualOverrideFromReview(effectiveOverride));
  }
  database.prepare("INSERT INTO organizer_review_audit (review_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(id, decision, effectiveOverride ? JSON.stringify(effectiveOverride) : null, updatedAt);
  const updated: OrganizerReviewEntry = {
    id, sourcePath: row.source_path, sourceBasename: row.source_basename,
    parsed: parseStoredJson<ParsedMediaIdentity>(row.parsed_json) || { status: "unmatched", extension: "", sourceBasename: row.source_basename, confidence: 0, reason: "stored review record was malformed" }, decision, createdAt: row.created_at, updatedAt,
    ...(effectiveOverride ? { override: effectiveOverride } : {}),
  };
  return updated;
}

/** Re-queues an item for another organizer pass without changing provider files. */
export function retryOrganizerReview(id: string): OrganizerReviewEntry | undefined {
  const database = getDb();
  const row = database.prepare("SELECT * FROM organizer_reviews WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  const now = new Date().toISOString();
  database.prepare("UPDATE organizer_reviews SET decision = 'pending', updated_at = ? WHERE id = ?").run(now, id);
  database.prepare("INSERT INTO organizer_review_audit (review_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(id, "retry", JSON.stringify({ previousDecision: row.decision }), now);
  const parsed = parseStoredJson<ParsedMediaIdentity>(row.parsed_json);
  if (!parsed) return undefined;
  const override = parseStoredJson<ReviewOverride>(row.override_json);
  return { id, sourcePath: row.source_path, sourceBasename: row.source_basename, parsed, decision: "pending", createdAt: row.created_at, updatedAt: now, ...(override ? { override } : {}) };
}

/** Clears a manual identity match and returns the item to automatic review. */
export function clearOrganizerReviewOverride(id: string): OrganizerReviewEntry | undefined {
  const database = getDb();
  const row = database.prepare("SELECT * FROM organizer_reviews WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  const now = new Date().toISOString();
  database.prepare("UPDATE organizer_reviews SET decision = 'pending', override_json = NULL, updated_at = ? WHERE id = ?").run(now, id);
  const parsed = parseStoredJson<ParsedMediaIdentity>(row.parsed_json);
  const provider = /\/(alldebrid)\//i.exec(row.source_path)?.[1];
  if (provider) clearManualIdentityOverrideForSource(provider, row.source_path);
  if (parsed) clearManualIdentityOverride(parsed);
  database.prepare("INSERT INTO organizer_review_audit (review_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)").run(id, "cleared_override", null, now);
  if (!parsed) return undefined;
  return { id, sourcePath: row.source_path, sourceBasename: row.source_basename, parsed, decision: "pending", createdAt: row.created_at, updatedAt: now };
}

export function clearOrganizerReviews(): void {
  const database = getDb();
  database.exec("DELETE FROM organizer_review_audit; DELETE FROM organizer_reviews;");
}

export function listOrganizerReviewAudit(reviewId: string): Array<{
  action: string;
  payload?: unknown;
  createdAt: string;
}> {
  const rows = getDb().prepare("SELECT action, payload_json, created_at FROM organizer_review_audit WHERE review_id = ? ORDER BY id ASC").all(reviewId) as any[];
  return rows.map((row) => ({
    action: row.action,
    ...(parseStoredJson(row.payload_json) !== undefined ? { payload: parseStoredJson(row.payload_json) } : {}),
    createdAt: row.created_at,
  }));
}
