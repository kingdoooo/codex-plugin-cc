import { sortJobsNewestFirst } from "./job-control.mjs";
import { listJobs } from "./state.mjs";

const DEFAULT_REVIEW_REUSE_WINDOW_HOURS = 3;

export const REVIEW_RESUME_CONTINUATION_NOTE = [
  "<continuation>",
  "You already reviewed this worktree earlier in this same thread.",
  "Reuse what you already learned about the codebase; do not re-read files you have already seen unless they changed.",
  "The working tree may have moved on since then. Concentrate on what changed, and re-check whether your earlier findings are now resolved or still open.",
  "</continuation>"
].join("\n");

export function resolveReviewReuseWindowMs(hours) {
  const parsed = Number(hours);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REVIEW_REUSE_WINDOW_HOURS * 60 * 60 * 1000;
  }
  return parsed * 60 * 60 * 1000;
}

function resolveFiniteWindowMs(withinMs) {
  const parsed = Number(withinMs);
  return Number.isFinite(parsed) ? parsed : resolveReviewReuseWindowMs();
}

// Reuse is keyed by git worktree (the per-worktree state dir already scopes
// jobs) and bounded by recency. Only the NEWEST resumable review job is
// considered — even before it records a thread id — otherwise two concurrent
// runs could resume the same thread and interleave turns. A cancelled, failed,
// or still-running newest run therefore means: start fresh.
export function resolveLatestReviewThread(
  workspaceRoot,
  { withinMs = null, excludeJobId = null, kind = null } = {}
) {
  const candidate = sortJobsNewestFirst(listJobs(workspaceRoot)).find(
    (job) =>
      job.id !== excludeJobId &&
      job.jobClass === "review" &&
      (kind === null || job.kind === kind) &&
      job.resumable === true
  );
  if (!candidate || candidate.status !== "completed" || !candidate.threadId) {
    return null;
  }
  // withinMs arrives from CLI flags and env vars as a string, and
  // Number.isFinite does not coerce — guarding on it directly would let
  // "10800000" skip the recency check entirely. null/undefined still means "no
  // window"; anything else that fails to coerce falls back to the default
  // window, so a caller that asked for a bound never silently gets unbounded
  // reuse.
  const windowMs = withinMs == null ? null : resolveFiniteWindowMs(withinMs);
  if (windowMs !== null) {
    const lastUsed = Date.parse(candidate.completedAt ?? candidate.createdAt ?? "");
    if (!Number.isFinite(lastUsed) || Date.now() - lastUsed > windowMs) {
      return null;
    }
  }
  return {
    id: candidate.threadId,
    jobId: candidate.id,
    lastUsedAt: candidate.completedAt ?? candidate.createdAt ?? null
  };
}
