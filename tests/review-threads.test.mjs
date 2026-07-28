import test from "node:test";
import assert from "node:assert/strict";

import { listJobs, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import {
  resolveLatestReviewThread,
  resolveReviewReuseWindowMs
} from "../plugins/codex/scripts/lib/review-threads.mjs";
import { makeTempDir } from "./helpers.mjs";

// Jobs are ranked by updatedAt, so seeds pin it explicitly rather than relying
// on insertion order plus same-millisecond timestamp collisions. `touchedAt`
// stands in for "when this job last changed": a finished job also reports it as
// completedAt, an unfinished one carries no completedAt at all — matching what
// runTrackedJob actually persists.
function seedJob(ws, { touchedAt = new Date(Date.now() - 30_000).toISOString(), ...overrides } = {}) {
  const finished = (overrides.status ?? "completed") === "completed";
  upsertJob(ws, {
    jobClass: "review",
    kind: "adversarial-review",
    status: "completed",
    threadId: "t-default",
    resumable: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: touchedAt,
    ...(finished ? { completedAt: touchedAt } : {}),
    ...overrides
  });
}

test("returns the newest completed resumable review thread", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-old", threadId: "t-old", touchedAt: new Date(Date.now() - 90_000).toISOString() });
  seedJob(ws, { id: "review-new", threadId: "t-new" });

  const hit = resolveLatestReviewThread(ws, { kind: "adversarial-review" });

  assert.equal(hit?.id, "t-new");
  assert.equal(hit?.jobId, "review-new");
});

test("a newest-but-unfinished resumable run blocks fallback to older threads", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-done", threadId: "t-done", touchedAt: new Date(Date.now() - 90_000).toISOString() });
  seedJob(ws, { id: "review-running", status: "running", threadId: null });

  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review" }), null);
});

// createJobProgressUpdater persists threadId as soon as the thread opens, so a
// run that later fails still has one on record. Resuming into it would continue
// a thread whose last turn errored out.
test("a failed run is not resumed even though it recorded a thread", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-failed", status: "failed", threadId: "t-failed" });

  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review" }), null);
});

// runTrackedJob writes `threadId: execution.threadId ?? null`, so "completed
// with no thread" is reachable and must not surface as a thread id of null.
test("a completed run that never recorded a thread yields no thread", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-nothread", threadId: null });

  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review" }), null);
});

test("kind scoping: adversarial never reuses a plain-review thread", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-plain", kind: "review", threadId: "t-plain" });

  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review" }), null);
});

test("recency window: an expired thread is not reused", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-stale", touchedAt: new Date(Date.now() - 4 * 3600_000).toISOString() });

  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review", withinMs: 3 * 3600_000 }), null);
});

test("non-resumable jobs are ignored", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-eph", resumable: false });

  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review" }), null);
});

test("excludeJobId skips the current job", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-self" });

  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review", excludeJobId: "review-self" }), null);
});

test("rescue/task jobs are never offered as review threads", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "task-1", jobClass: "task", kind: "rescue", threadId: "t-task" });

  assert.equal(resolveLatestReviewThread(ws, { kind: null }), null);
});

test("a workspace with no state dir yields no thread instead of throwing", () => {
  const ws = makeTempDir("rt-empty-");

  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review" }), null);
});

test("resolveLatestReviewThread reports the timestamp it judged recency by", () => {
  const ws = makeTempDir("rt-");
  const completedAt = new Date(Date.now() - 30_000).toISOString();
  seedJob(ws, { id: "review-ts", threadId: "t-ts", touchedAt: completedAt });

  const hit = resolveLatestReviewThread(ws, { kind: "adversarial-review", withinMs: 3 * 3600_000 });

  assert.equal(hit?.lastUsedAt, completedAt);
});

test("reuse window resolver defaults to 3h and accepts fractional hours", () => {
  assert.equal(resolveReviewReuseWindowMs(undefined), 3 * 3600_000);
  assert.equal(resolveReviewReuseWindowMs("abc"), 3 * 3600_000);
  assert.equal(resolveReviewReuseWindowMs(0.5), 30 * 60_000);
});

// Later tasks tag a review job resumable at creation and then patch only
// status/completedAt when the run finishes, so both fields must round-trip
// through the job store for reuse to ever trigger.
test("resumable and completedAt survive the job store round-trip", () => {
  const ws = makeTempDir("rt-persist-");
  upsertJob(ws, {
    id: "review-persist",
    jobClass: "review",
    kind: "adversarial-review",
    status: "running",
    resumable: true
  });

  const completedAt = new Date().toISOString();
  upsertJob(ws, { id: "review-persist", status: "completed", threadId: "t-persist", completedAt });

  const [stored] = listJobs(ws);
  assert.equal(stored.resumable, true);
  assert.equal(stored.completedAt, completedAt);
  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review" })?.id, "t-persist");
});
