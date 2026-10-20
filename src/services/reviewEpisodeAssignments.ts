/** Validate a complete, explicit per-review episode mapping before saving anything. */
export function validateReviewEpisodeAssignments(
  entries: Array<{ id: string; sourcePath: string }>,
  assignments: Array<{ id: string; episode: number }>,
): Map<string, number> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length || assignments.length !== entries.length) throw new Error("Every review item needs one episode assignment");
  const mapped = new Map<string, number>();
  const sourceEpisodes = new Map<string, number>();
  for (const assignment of assignments) {
    const entry = byId.get(assignment.id);
    if (!entry || mapped.has(assignment.id) || !Number.isInteger(assignment.episode) || assignment.episode < 0 || assignment.episode > 9999) {
      throw new Error("Invalid or duplicate review episode assignment");
    }
    // Provider views expose the same relative source under different roots.
    // Only normalize known AllDebrid views; do not infer identity from a basename.
    const source = entry.sourcePath.replace(/\/alldebrid\/(?:__all__|shows|movies)\//i, "/alldebrid/__provider__/ ".trim());
    const existing = sourceEpisodes.get(source);
    if (existing !== undefined && existing !== assignment.episode) throw new Error("Different episode numbers assigned to the same provider file");
    sourceEpisodes.set(source, assignment.episode);
    mapped.set(assignment.id, assignment.episode);
  }
  return mapped;
}
