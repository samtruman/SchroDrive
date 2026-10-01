import { describe, expect, test } from "bun:test";
import { buildUnifiedReviewQueue } from "../../../src/services/unifiedReview";
import type { OrganizerReviewEntry } from "../../../src/services/organizerReview";
import type { VersionGroup } from "../../../src/services/versionManager";

function group(overrides: Partial<VersionGroup> = {}): VersionGroup {
  const identity = {
    title: "Example",
    normalizedTitle: "example",
    year: 2024,
    kind: "movie" as const,
    confidence: 0.98,
    source: "provider" as const,
    resolutionStatus: "resolved" as const,
    ...overrides.identity,
  };
  const version: any = {
    id: `${identity.title}-version`,
    decision: "REVIEW",
    fingerprint: {
      identity,
      storage: { provider: "fixture", torrentId: "fixture-item", infoHash: undefined, recoverability: { status: "UNKNOWN", source: "UNKNOWN" } },
    },
    reasons: [{ code: "recoverability_unknown", message: "Recoverability could not be established", facts: {} }],
    evaluations: [],
  };
  return { id: `group-${identity.title}`, identity, versions: [version], ...overrides } as VersionGroup;
}

function organizer(overrides: Partial<OrganizerReviewEntry> = {}): OrganizerReviewEntry {
  return {
    id: "review-fixture",
    sourcePath: "/fixture/Example.mkv",
    sourceBasename: "Example.mkv",
    parsed: { status: "ambiguous", kind: "movie", title: "Example", year: 2024, confidence: 0.45, reason: "ambiguous title" } as any,
    decision: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("unified Media Manager review queue", () => {
  test("includes Organizer-only identity issues with Organizer actions", () => {
    const result = buildUnifiedReviewQueue([], [organizer()]);
    expect(result.summary).toEqual({ total: 1, identityIssues: 1, policyReviews: 0, recoverabilityIssues: 0 });
    expect(result.entries[0].issueTypes).toEqual(["IDENTITY_ISSUE"]);
    expect(result.entries[0].allowedActions).toContain("RESOLVE_IDENTITY");
  });

  test("classifies policy-only and recoverability-only reviews separately", () => {
    const policy = group({ identity: { title: "Policy", normalizedTitle: "policy", year: 2024, kind: "movie", confidence: 0.98, source: "provider", resolutionStatus: "resolved" }, versions: [{ ...(group().versions[0] as any), id: "policy-v", reasons: [{ code: "hard_requirement_failed", message: "Requirement failed", facts: {} }] }] as any });
    const recoverability = group({ identity: { title: "Recovery", normalizedTitle: "recovery", year: 2024, kind: "movie", confidence: 0.98, source: "provider", resolutionStatus: "resolved" }, versions: [{ ...(group().versions[0] as any), id: "recovery-v" }] as any });
    const result = buildUnifiedReviewQueue([policy, recoverability]);
    expect(result.entries.find((entry) => entry.title === "Policy")?.issueTypes).toEqual(["POLICY_REVIEW"]);
    expect(result.entries.find((entry) => entry.title === "Policy")?.versions).toHaveLength(1);
    expect(result.entries.find((entry) => entry.title === "Recovery")?.issueTypes).toEqual(["RECOVERABILITY_ISSUE"]);
  });

  test("does not expose fallback metadata as an identity action when the blocker is recovery", () => {
    const fallback = group({ identity: { title: "Fallback", normalizedTitle: "fallback", year: 2024, kind: "movie", confidence: 0.8, source: "provider", resolutionStatus: "fallback" } });
    const result = buildUnifiedReviewQueue([fallback]);
    expect(result.entries[0].issueTypes).toEqual(["RECOVERABILITY_ISSUE"]);
    expect(result.entries[0].allowedActions).toEqual(["DETAILS"]);
  });

  test("deduplicates Organizer and policy issues for the same canonical identity", () => {
    const identity = { title: "Example", normalizedTitle: "example", year: 2024, kind: "movie" as const, confidence: 0.98, source: "provider" as const, resolutionStatus: "resolved" as const, tmdbId: "100" };
    const policy = group({ identity, versions: [{ ...(group().versions[0] as any), id: "same-v", fingerprint: { ...(group().versions[0] as any).fingerprint, identity }, reasons: [{ code: "recoverability_unknown", message: "Recoverability unknown", facts: {} }] }] as any });
    const result = buildUnifiedReviewQueue([policy], [organizer({ override: { title: "Example", year: 2024, kind: "movie", tmdbId: "100" } })]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].issueTypes).toEqual(["IDENTITY_ISSUE", "RECOVERABILITY_ISSUE"]);
    expect(result.entries[0].organizerReview?.id).toBe("review-fixture");
  });

  test("joins a legacy Organizer title/year fallback to a canonical policy identity", () => {
    const identity = { title: "Example", normalizedTitle: "example", year: 2024, kind: "movie" as const, confidence: 0.98, source: "provider" as const, resolutionStatus: "resolved" as const, tmdbId: "100" };
    const policy = group({ identity, versions: [{ ...(group().versions[0] as any), id: "same-fallback-v", fingerprint: { ...(group().versions[0] as any).fingerprint, identity } }] as any });
    const parsed = organizer({ parsed: { status: "ambiguous", kind: "movie", title: "Example 2024", confidence: 0.45, reason: "ambiguous title" } as any });
    const result = buildUnifiedReviewQueue([policy], [parsed]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].issueTypes).toContain("IDENTITY_ISSUE");
    expect(result.entries[0].issueTypes).toContain("RECOVERABILITY_ISSUE");
  });

  test("does not merge same-title content with different canonical identities", () => {
    const first = group({ identity: { title: "Same Title", normalizedTitle: "same title", year: 2024, kind: "movie", confidence: 0.98, source: "provider", resolutionStatus: "resolved", tmdbId: "101" } });
    const second = group({ identity: { title: "Same Title", normalizedTitle: "same title", year: 2024, kind: "movie", confidence: 0.98, source: "provider", resolutionStatus: "resolved", tmdbId: "202" }, id: "second" });
    expect(buildUnifiedReviewQueue([first, second]).entries).toHaveLength(2);
  });

  test("keeps episodes with the same series identity in separate review entries", () => {
    const episode3 = group({ identity: { title: "Tehran", normalizedTitle: "tehran", year: 2020, kind: "episode", season: 2, episode: 3, confidence: 0.98, source: "provider", resolutionStatus: "resolved", tmdbId: "123" } });
    const episode4 = group({ identity: { title: "Tehran", normalizedTitle: "tehran", year: 2020, kind: "episode", season: 2, episode: 4, confidence: 0.98, source: "provider", resolutionStatus: "resolved", tmdbId: "123" }, id: "episode-4" });
    const entries = buildUnifiedReviewQueue([episode3, episode4]).entries;
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.episode).sort()).toEqual([3, 4]);
  });

  test("excludes KEEP and DELETE_CANDIDATE-only groups", () => {
    const keep = group({ id: "keep", versions: [{ ...(group().versions[0] as any), decision: "KEEP", reasons: [] }] as any });
    const candidate = group({ id: "candidate", versions: [{ ...(group().versions[0] as any), decision: "DELETE_CANDIDATE", reasons: [{ code: "no_profile_slot", message: "Not selected", facts: {} }] }] as any });
    expect(buildUnifiedReviewQueue([keep, candidate]).entries).toHaveLength(0);
  });

  test("dismissed Organizer entries remain restorable and are not mixed into pending", () => {
    const dismissed = organizer({ decision: "dismissed" });
    expect(buildUnifiedReviewQueue([], [dismissed], "pending").entries).toHaveLength(0);
    expect(buildUnifiedReviewQueue([], [dismissed], "dismissed").entries[0].allowedActions).toEqual(["RESTORE_TO_REVIEW", "DETAILS"]);
  });
});
