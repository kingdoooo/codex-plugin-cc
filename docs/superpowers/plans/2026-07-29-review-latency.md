# Review Latency Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut adversarial-review wall time from 60–100 min to ~15–35 min cold / ~10–20 min re-review, without lowering investigation effort or model tier.

**Architecture:** Four independent changes: (A) feed the full diff into the multi-turn investigate prompt via a new 1MB "investigation inline" budget; (B) run the finalize turn at medium effort; (C) port PR #375/#557 resumable-thread mechanics onto the multi-turn runner; (D) raise timeout defaults to match measured xhigh turn times. Spec: `docs/superpowers/specs/2026-07-28-review-latency-design.md`.

**Tech Stack:** Node ESM (`.mjs`), `node --test`, fake-codex fixture (`tests/fake-codex-fixture.mjs`).

## Global Constraints

- **Two-branch strategy.** Tasks 1–4 run in `/Users/kentpeng/projects/codex-plugin-cc` (branch `feat/codex-self-collect-multiturn` — PR #328 source, no foreign code). Tasks 6–10 run in `/Users/kentpeng/projects/codex-plugin-cc/.claude/worktrees/integrate-broker-prs` (branch `feat/integrate-broker-stability-prs`). Verify with `git branch --show-current` before each task.
- **Test invocation.** Always `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test <file>` — the session leaks these env vars and they cause known false failures. Full suite: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID npm test` (takes ~12 min; run only at the checkpoints that say so).
- **Env vars are read at call time, never at module import** (import-time reads are frozen before the companion sets them — the PR #376 lesson).
- **No-flag behavior must stay byte-identical** for existing review invocations (prompts, thread ephemerality, exit codes).
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never `git push` here (Task 10 pushes with `--no-verify`).
- Line numbers below are approximate anchors — locate by the quoted code, not the number.

---

### Task 1: D-idle — raise review idle default to 1200s (clean branch)

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs` (`DEFAULT_TURN_IDLE_TIMEOUT_MS`, ~line 68)
- Modify: `plugins/codex/commands/adversarial-review.md` (timeout bullet, ~line 47)
- Test: `tests/codex-lib.test.mjs` (or wherever `resolveReviewTurnIdleTimeoutMs` is already tested — find with `grep -rn resolveReviewTurnIdleTimeoutMs tests/`)

**Interfaces:**
- Produces: `resolveReviewTurnIdleTimeoutMs(undefined) === 1_200_000`.

- [ ] **Step 1: Find existing default-value assertions**

Run: `grep -rn "180_000\|180000\|resolveReviewTurnIdleTimeoutMs" tests/ plugins/codex/`
Note every test asserting the 180s default and every doc line mentioning it.

- [ ] **Step 2: Write/update the failing test**

In the test file that covers `resolveReviewTurnIdleTimeoutMs` (create `tests/codex-lib.test.mjs` if none exists):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveReviewTurnIdleTimeoutMs } from "../plugins/codex/scripts/lib/codex.mjs";

test("review idle timeout defaults to 1200s", () => {
  assert.equal(resolveReviewTurnIdleTimeoutMs(undefined), 1_200_000);
  assert.equal(resolveReviewTurnIdleTimeoutMs(null), 1_200_000);
});

test("explicit idle timeout still wins over the default", () => {
  assert.equal(resolveReviewTurnIdleTimeoutMs(30_000), 30_000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/codex-lib.test.mjs`
Expected: FAIL — `1_200_000 !== 180_000`.

- [ ] **Step 4: Change the constant**

In `plugins/codex/scripts/lib/codex.mjs`:

```js
// Before
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 180_000;
// After — measured 2026-07-27: healthy Bedrock gpt-5.6 xhigh turns go silent
// for well over 600s while reasoning; 180s killed them routinely.
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 1_200_000;
```

- [ ] **Step 5: Update the command doc**

In `plugins/codex/commands/adversarial-review.md`, the bullet reading `…(default 180)…` becomes:

```
- If a turn stalls with no output for `--turn-idle-timeout SECONDS` (default 1200), the run aborts gracefully with a clear failure instead of hanging. Lower it to fail faster on a flaky connection; raise it for very slow turns.
```

- [ ] **Step 6: Run the test file + any files found in Step 1; verify green**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/codex-lib.test.mjs tests/runtime.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/codex/scripts/lib/codex.mjs plugins/codex/commands/adversarial-review.md tests/
git commit -m "feat(review): raise idle-watchdog default to 1200s for slow reasoning backends"
```

---

### Task 2: A — investigation inline budget + three-way routing (clean branch)

**Files:**
- Modify: `plugins/codex/scripts/lib/git.mjs` (`collectReviewContext`, `buildAdversarialCollectionGuidance`, constants block)
- Modify: `plugins/codex/scripts/codex-companion.mjs` (`executeReviewRun` self-collect branch — progress note only)
- Test: `tests/git.test.mjs`

**Interfaces:**
- Consumes: existing `collectReviewContext(cwd, target, options)` and its `options.includeDiff` override semantics (must be preserved: explicit `true` → inline-diff, explicit `false` → blind self-collect).
- Produces: context object gains `investigationInline: boolean`; `inputMode` unchanged in meaning (`"inline-diff"` = single-shot path, `"self-collect"` = multi-turn path); in fed mode `content` carries the full diff and `collectionGuidance` is the new fed-mode wording. New env knob `CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES` (default 1_048_576).

- [ ] **Step 1: Write failing tests**

Append to `tests/git.test.mjs` (follow the file's existing helpers for creating temp repos — see `collectReviewContext routes 2-file changes to self-collect (inline cap is 1)` as the template):

```js
test("mid-size branch diff self-collects WITH the full diff embedded (investigation inline)", () => {
  // Arrange exactly like the existing 2-file self-collect test: a repo with a
  // base commit, a branch with 2 small changed files, clean working tree.
  // (Copy that test's setup verbatim.)
  const context = collectReviewContext(cwd, target);
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.investigationInline, true);
  assert.match(context.content, /## Branch Diff/);
  assert.match(context.content, /diff --git/);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
});

test("diff above the investigation budget self-collects blind (lightweight summary)", () => {
  // Same 2-file setup; shrink the budget below the diff size via env.
  process.env.CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES = "10";
  try {
    const context = collectReviewContext(cwd, target);
    assert.equal(context.inputMode, "self-collect");
    assert.equal(context.investigationInline, false);
    assert.match(context.content, /## Changed Files/);
    assert.doesNotMatch(context.content, /diff --git/);
    assert.match(context.collectionGuidance, /lightweight summary/i);
  } finally {
    delete process.env.CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES;
  }
});

test("tiny single-file diff still routes to inline-diff (single-shot path unchanged)", () => {
  // Setup from the existing "keeps inline diffs for tiny adversarial reviews" test.
  const context = collectReviewContext(cwd, target);
  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.investigationInline, false);
  assert.match(context.collectionGuidance, /primary evidence/i);
});

test("explicit includeDiff:false still forces blind self-collect", () => {
  const context = collectReviewContext(cwd, target, { includeDiff: false });
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.investigationInline, false);
});

test("mid-size working-tree diff also gets investigation inline", () => {
  // Working-tree variant: 2 modified tracked files, small. Assert
  // investigationInline true and content contains "## Staged Diff" or
  // "## Unstaged Diff" with real diff text.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/git.test.mjs`
Expected: new tests FAIL (`investigationInline` undefined; content lacks diff).

- [ ] **Step 3: Implement in git.mjs**

Constants block (next to `DEFAULT_INLINE_DIFF_MAX_BYTES`):

```js
// Multi-turn investigation can tolerate a much larger inline payload than the
// single-shot path: the model reads the diff as evidence and still has
// follow-up turns for anything it needs beyond it. 1MB is a safe share of a
// 272K-token context window.
const DEFAULT_INVESTIGATION_INLINE_MAX_BYTES = 1024 * 1024;

function normalizeInvestigationInlineMaxBytes(value) {
  const raw = value ?? process.env.CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INVESTIGATION_INLINE_MAX_BYTES;
  }
  return Math.floor(parsed);
}
```

`buildAdversarialCollectionGuidance` becomes three-way:

```js
function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }
  if (options.investigationInline) {
    return "The full diff is embedded below as primary evidence — do not re-derive it with git commands. Run read-only commands only when you need context beyond the diff itself: surrounding code, callers, history, or tests.";
  }
  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}
```

`collectReviewContext` routing (both branches of the mode `if`). Branch mode:

```js
const investigationInlineMaxBytes = normalizeInvestigationInlineMaxBytes(options.investigationInlineMaxBytes);
const measureCap = Math.max(maxInlineDiffBytes, investigationInlineMaxBytes);
// ...
diffBytes = measureGitOutputBytes(repoRoot, [...same args...], measureCap);
const singleShotInline =
  options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
const investigationInline =
  options.includeDiff === undefined && !singleShotInline && diffBytes <= investigationInlineMaxBytes;
details = collectBranchContext(repoRoot, target.baseRef, {
  includeDiff: singleShotInline || investigationInline,
  comparison
});
```

Working-tree mode mirrors it (`measureCombinedGitOutputBytes` gets `measureCap`; `singleShotInline` keeps the existing untracked-content guard; `investigationInline` needs only the byte bound — skipped untracked files are fine because shell is available in multi-turn):

```js
const singleShotInline =
  options.includeDiff ??
  (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
    diffBytes <= maxInlineDiffBytes &&
    !hasSkippedUntrackedContent(repoRoot, state.untracked));
const investigationInline =
  options.includeDiff === undefined && !singleShotInline && diffBytes <= investigationInlineMaxBytes;
details = collectWorkingTreeContext(repoRoot, state, { includeDiff: singleShotInline || investigationInline });
```

Return object:

```js
inputMode: singleShotInline ? "inline-diff" : "self-collect",
investigationInline,
collectionGuidance: buildAdversarialCollectionGuidance({
  includeDiff: singleShotInline,
  investigationInline
}),
```

Rename the local `includeDiff` variables to `singleShotInline` throughout the function so the two concepts can't be conflated.

- [ ] **Step 4: Run tests to verify they pass**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/git.test.mjs`
Expected: ALL PASS (including the pre-existing routing tests — if any pre-existing test asserted blind content for a mid-size diff, update it to the new fed expectation; that is the intended behavior change).

- [ ] **Step 5: Add the over-budget progress note in the companion**

In `codex-companion.mjs` `executeReviewRun`, at the top of the `if (context.inputMode === "self-collect")` branch:

```js
if (!context.investigationInline) {
  request.onProgress?.(
    "Diff exceeds the investigation inline budget (CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES); Codex will re-derive it with read-only commands."
  );
}
```

(Cosmetic log line; covered by suite-green, no dedicated test.)

- [ ] **Step 6: Run investigation + runtime suites**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/git.test.mjs tests/investigation.test.mjs tests/runtime.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/codex/scripts/lib/git.mjs plugins/codex/scripts/codex-companion.mjs tests/git.test.mjs
git commit -m "feat(review): embed the full diff in multi-turn investigation up to a 1MB budget"
```

---

### Task 3: B — finalize turn at medium effort (clean branch)

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs` (finalize loop inside `runAppServerInvestigation`; new resolver near `resolveTurnStallMs` — note: on the clean branch there is no `resolveTurnStallMs`; put the resolver just above `runAppServerInvestigation`)
- Test: `tests/investigation.test.mjs`

**Interfaces:**
- Produces: `resolveFinalizeEffort(callerEffort)` — reads `CODEX_COMPANION_FINALIZE_EFFORT` at call time; `"inherit"` → `callerEffort ?? null`; any of `none|minimal|low|medium|high|xhigh` → that value; unset/invalid → `"medium"`. Finalize (and its retry) `turn/start` sends this; investigation turns keep sending `options.effort ?? null`.

- [ ] **Step 1: Write failing tests**

Append to `tests/investigation.test.mjs`:

```js
test("finalize turn downgrades to medium effort while investigation keeps caller effort", async () => {
  const cwd = makeTempDir("codex-inv-effort-");
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({ commands: [], finalAnswer: { text: "Investigation done." } });
    fake.queueTurnResponse({ finalAnswer: { text: APPROVE_REVIEW } });

    await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] },
      effort: "xhigh"
    });

    const starts = fake.requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 2);
    assert.equal(starts[0].params.effort, "xhigh", "investigation turn keeps caller effort");
    assert.equal(starts[1].params.effort, "medium", "finalize turn downgrades to medium");
  } finally {
    fake.close();
  }
});

test("CODEX_COMPANION_FINALIZE_EFFORT=inherit keeps caller effort on finalize", async () => {
  process.env.CODEX_COMPANION_FINALIZE_EFFORT = "inherit";
  const cwd = makeTempDir("codex-inv-effort-inherit-");
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({ commands: [], finalAnswer: { text: "Investigation done." } });
    fake.queueTurnResponse({ finalAnswer: { text: APPROVE_REVIEW } });

    await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] },
      effort: "xhigh"
    });

    const starts = fake.requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.at(-1).params.effort, "xhigh");
  } finally {
    delete process.env.CODEX_COMPANION_FINALIZE_EFFORT;
    fake.close();
  }
});

test("finalize retry also uses the downgraded effort", async () => {
  const cwd = makeTempDir("codex-inv-effort-retry-");
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({ commands: [], finalAnswer: { text: "Investigation done." } });
    // First finalize violates (empty) → retry
    fake.queueTurnResponse({ finalAnswer: null });
    fake.queueTurnResponse({ finalAnswer: { text: APPROVE_REVIEW } });

    await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] },
      effort: "xhigh"
    });

    const starts = fake.requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 3);
    assert.equal(starts[1].params.effort, "medium");
    assert.equal(starts[2].params.effort, "medium");
  } finally {
    fake.close();
  }
});
```

(`APPROVE_REVIEW` already exists at the top of the file. If `queueTurnResponse({ finalAnswer: null })` is not how the fixture models an empty turn, check how the existing "retry finalize once when the turn completes with no message" test queues it and copy that.)

- [ ] **Step 2: Run to verify failures**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/investigation.test.mjs`
Expected: the three new tests FAIL (finalize effort is `"xhigh"`/`null`).

- [ ] **Step 3: Implement**

Above `runAppServerInvestigation` in `codex.mjs`:

```js
const DEFAULT_FINALIZE_EFFORT = "medium";
const FINALIZE_EFFORT_VALUES = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

// The finalize turn translates already-formed conclusions into schema JSON —
// mechanical work that does not benefit from a reasoning-heavy effort. Read at
// call time (not import time) so the env override always takes effect.
function resolveFinalizeEffort(callerEffort) {
  const raw = String(process.env.CODEX_COMPANION_FINALIZE_EFFORT ?? "").trim().toLowerCase();
  if (raw === "inherit") {
    return callerEffort ?? null;
  }
  if (FINALIZE_EFFORT_VALUES.has(raw)) {
    return raw;
  }
  return DEFAULT_FINALIZE_EFFORT;
}
```

In the finalize loop, the `turn/start` params change one line:

```js
// Before
effort: options.effort ?? null,
// After
effort: resolveFinalizeEffort(options.effort ?? null),
```

(Only in the finalize `captureTurn` call — the investigation-loop `turn/start` keeps `options.effort ?? null`.)

- [ ] **Step 4: Run to verify green**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/investigation.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/lib/codex.mjs tests/investigation.test.mjs
git commit -m "feat(review): run the finalize turn at medium effort (CODEX_COMPANION_FINALIZE_EFFORT to override)"
```

---

### Task 4: Clean-branch checkpoint — full suite + push prep

**Files:** none new.

- [ ] **Step 1: Full suite on the clean branch**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID npm test 2>&1 | tail -15`
Expected: `# fail 0`. If orphan processes linger afterwards: `pkill -9 -f fake-codex; pkill -9 -f app-server-broker`.

- [ ] **Step 2: No commit** — this is a verification gate only.

---

### Task 5: Merge clean branch into integration branch

**Files:** merge commit only.

- [ ] **Step 1: Merge**

```bash
cd /Users/kentpeng/projects/codex-plugin-cc/.claude/worktrees/integrate-broker-prs
git merge feat/codex-self-collect-multiturn --no-edit
```

Conflict guidance: `codex.mjs` will likely conflict where the clean branch's new `resolveFinalizeEffort` block lands near the integration branch's `resolveTurnStallMs`/`resolveTurnCeilingMs` — keep BOTH blocks. The finalize-loop conflict: integration branch has the retry loop with `MAX_FINALIZE_ATTEMPTS`; apply the one-line `effort:` change inside it, preserving the loop.
**Defect-B trap check (from memory):** the merge must NOT reintroduce a stall guard that refreshes on foreign notifications — if `captureTurn` conflicts, keep the integration branch's belonging-gated re-arm and rerun the Defect B test.

- [ ] **Step 2: Verify merged behavior**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/investigation.test.mjs tests/git.test.mjs tests/runtime.test.mjs`
Expected: PASS (finalize-effort tests pass against the integration branch's retry loop too).

- [ ] **Step 3: Commit** (merge commit already created; nothing else).

---

### Task 6: D-ceiling — raise stall/ceiling defaults (integration branch)

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs` (`DEFAULT_TURN_STALL_MS` ~line 79, `DEFAULT_TURN_CEILING_MS` ~line 80)
- Modify: `plugins/codex/commands/adversarial-review.md` (ceiling bullets, ~lines 48–49)
- Test: whichever file covers the stall/ceiling defaults — find with `grep -rn "DEFAULT_TURN_STALL\|TURN_TIMEOUT_MS\|1_800_000\|600_000" tests/`

**Interfaces:**
- Produces: stall default 1_200_000 ms, ceiling default 7_200_000 ms. Env overrides `CODEX_COMPANION_TURN_STALL_MS` / `CODEX_COMPANION_TURN_TIMEOUT_MS` unchanged.

- [ ] **Step 1: Find assertions on the old defaults**

Run: `grep -rn "1_800_000\|1800000\|600_000\|600000\|exceeded the .*ceiling\|no activity for" tests/ | grep -v node_modules`
Note tests that assert default values (tests that set explicit env overrides are unaffected — the Defect B test uses explicit overrides and must stay green).

- [ ] **Step 2: Update/write the default-value test**

If a test asserts the defaults, update it to 1_200_000 / 7_200_000; otherwise add to the file that tests these resolvers:

```js
test("turn stall default is 1200s and ceiling default is 7200s", () => {
  // resolveTurnStallMs / resolveTurnCeilingMs are module-internal; assert via
  // the documented env-override path instead if they are not exported:
  // run a captureTurn scenario with no env overrides and assert the timeout
  // message mentions the new default. If that is impractical, export the two
  // resolvers and assert directly:
  assert.equal(resolveTurnStallMs(undefined), 1_200_000);
  assert.equal(resolveTurnCeilingMs(), 7_200_000);
});
```

(Prefer exporting the resolvers — one-word change each — over a slow integration test.)

- [ ] **Step 3: Run to verify failure, then change the constants**

```js
// Before
const DEFAULT_TURN_STALL_MS = 600_000;
const DEFAULT_TURN_CEILING_MS = 1_800_000;
// After — measured 2026-07-27: healthy xhigh turns exceeded both old values
// (silent >600s while reasoning; one healthy turn ran past 3600s).
const DEFAULT_TURN_STALL_MS = 1_200_000;
const DEFAULT_TURN_CEILING_MS = 7_200_000;
```

- [ ] **Step 4: Rewrite the doc bullets**

In `adversarial-review.md`, replace the two ceiling bullets (48–49) with:

```
- There is ALSO an absolute per-turn ceiling (default 7200s) with no CLI flag — override with the `CODEX_COMPANION_TURN_TIMEOUT_MS` env var. The multi-turn stall watchdog defaults to 1200s (`CODEX_COMPANION_TURN_STALL_MS`). Defaults are sized for slow reasoning backends (Bedrock gpt-5.6 xhigh); most runs need no overrides.
- If a run failed with "exceeded the …s ceiling", raise `CODEX_COMPANION_TURN_TIMEOUT_MS`; if it failed with "Turn idle" or "no activity", raise `--turn-idle-timeout` / `CODEX_COMPANION_TURN_STALL_MS`. A retry starts a fresh thread unless you pass `--resume`.
```

- [ ] **Step 5: Run affected tests, then commit**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/investigation.test.mjs tests/runtime.test.mjs <file-from-step-1>`
Expected: PASS (Defect B test in particular).

```bash
git add plugins/codex/scripts/lib/codex.mjs plugins/codex/commands/adversarial-review.md tests/
git commit -m "feat(review): raise turn stall/ceiling defaults to 1200s/7200s for xhigh backends"
```

---

### Task 7: C1 — thread lookup module (integration branch)

**Files:**
- Create: `plugins/codex/scripts/lib/review-threads.mjs`
- Test: `tests/review-threads.test.mjs`

**Interfaces:**
- Consumes: `listJobs(cwd)`, `sortJobsNewestFirst(jobs)` from `./state.mjs` (verify `sortJobsNewestFirst` lives there — `grep -n sortJobsNewestFirst plugins/codex/scripts/lib/*.mjs`; import from wherever it is exported).
- Produces:
  - `resolveReviewReuseWindowMs(hours)` → ms; invalid/absent → 3h.
  - `resolveLatestReviewThread(workspaceRoot, { withinMs = null, excludeJobId = null, kind = null })` → `{ id, jobId, lastUsedAt } | null`.
  - `REVIEW_RESUME_CONTINUATION_NOTE` — the `<continuation>` block, ported verbatim from PR #375.

- [ ] **Step 1: Write failing tests**

`tests/review-threads.test.mjs` — jobs are written with `upsertJob` from `state.mjs` into a temp workspace (`makeTempDir` from helpers):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { resolveLatestReviewThread, resolveReviewReuseWindowMs } from "../plugins/codex/scripts/lib/review-threads.mjs";
import { makeTempDir } from "./helpers.mjs";

function seedJob(ws, overrides) {
  upsertJob(ws, {
    id: overrides.id,
    jobClass: "review",
    kind: "adversarial-review",
    status: "completed",
    threadId: "t-default",
    resumable: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date(Date.now() - 30_000).toISOString(),
    ...overrides
  });
}

test("returns the newest completed resumable review thread", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-old", threadId: "t-old", completedAt: new Date(Date.now() - 90_000).toISOString() });
  seedJob(ws, { id: "review-new", threadId: "t-new" });
  const hit = resolveLatestReviewThread(ws, { kind: "adversarial-review" });
  assert.equal(hit?.id, "t-new");
  assert.equal(hit?.jobId, "review-new");
});

test("a newest-but-unfinished resumable run blocks fallback to older threads", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-done", threadId: "t-done", completedAt: new Date(Date.now() - 90_000).toISOString() });
  seedJob(ws, { id: "review-running", status: "running", threadId: null });
  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review" }), null);
});

test("kind scoping: adversarial never reuses a plain-review thread", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-plain", kind: "review", threadId: "t-plain" });
  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review" }), null);
});

test("recency window: an expired thread is not reused", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-stale", completedAt: new Date(Date.now() - 4 * 3600_000).toISOString() });
  assert.equal(
    resolveLatestReviewThread(ws, { kind: "adversarial-review", withinMs: 3 * 3600_000 }),
    null
  );
});

test("non-resumable jobs are ignored", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-eph", resumable: false });
  assert.equal(resolveLatestReviewThread(ws, { kind: "adversarial-review" }), null);
});

test("excludeJobId skips the current job", () => {
  const ws = makeTempDir("rt-");
  seedJob(ws, { id: "review-self" });
  assert.equal(
    resolveLatestReviewThread(ws, { kind: "adversarial-review", excludeJobId: "review-self" }),
    null
  );
});

test("reuse window resolver defaults to 3h and accepts fractional hours", () => {
  assert.equal(resolveReviewReuseWindowMs(undefined), 3 * 3600_000);
  assert.equal(resolveReviewReuseWindowMs("abc"), 3 * 3600_000);
  assert.equal(resolveReviewReuseWindowMs(0.5), 30 * 60_000);
});
```

- [ ] **Step 2: Run to verify failure** — `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/review-threads.test.mjs` — FAIL (module missing).

- [ ] **Step 3: Implement `review-threads.mjs`** (port of #375, adjusted imports):

```js
import { listJobs, sortJobsNewestFirst } from "./state.mjs";

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

// Reuse is keyed by git worktree (the per-worktree state dir already scopes
// jobs) and bounded by recency. Only the NEWEST resumable review job is
// considered — even before it records a thread id — otherwise two concurrent
// runs could resume the same thread and interleave turns. A cancelled, failed,
// or still-running newest run therefore means: start fresh.
export function resolveLatestReviewThread(workspaceRoot, { withinMs = null, excludeJobId = null, kind = null } = {}) {
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
  if (Number.isFinite(withinMs)) {
    const lastUsed = Date.parse(candidate.completedAt ?? candidate.createdAt ?? "");
    if (!Number.isFinite(lastUsed) || Date.now() - lastUsed > withinMs) {
      return null;
    }
  }
  return {
    id: candidate.threadId,
    jobId: candidate.id,
    lastUsedAt: candidate.completedAt ?? candidate.createdAt ?? null
  };
}
```

If `sortJobsNewestFirst` is exported from a different module, adjust the import (do NOT reimplement it).

- [ ] **Step 4: Run to verify green, commit**

```bash
git add plugins/codex/scripts/lib/review-threads.mjs tests/review-threads.test.mjs
git commit -m "feat(review): worktree-scoped review-thread lookup (port of PR #375 resolver)"
```

---

### Task 8: C2 — resume support in the multi-turn runner (integration branch)

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs` (`runAppServerInvestigation` thread-start block, ~line 1456 anchor `const startResponse = await startThread(`)
- Modify (if needed): `tests/fake-codex-fixture.mjs` (`thread/resume` handler — must error on unknown thread ids)
- Test: `tests/investigation.test.mjs`

**Interfaces:**
- Consumes: existing `startThread(client, cwd, options)` / `resumeThread(client, threadId, cwd, options)` helpers in the same file.
- Produces: `runAppServerInvestigation` new options — `resumeThreadId?: string`, `persistThread?: boolean`, `threadName?: string`, `buildInvestigatePrompt?: ({resumed: boolean}) => string`. Resume failure always falls back to a fresh thread. Without these options, thread creation is byte-identical to today (`ephemeral: true`, `threadName: null`).

- [ ] **Step 1: Check the fixture's `thread/resume` behavior**

Read `tests/fake-codex-fixture.mjs` around the `case "thread/resume":` handler. Requirement: resuming a thread id the fixture has never seen must respond with a JSON-RPC error (so the runner's fallback path is exercisable). If it currently succeeds blindly, extend the handler:

```js
case "thread/resume": {
  const requestedId = message.params.threadId;
  const known = state.threads.find((t) => t.id === requestedId);
  if (!known) {
    send({ id: message.id, error: { code: -32000, message: `thread not found: ${requestedId}` } });
    break;
  }
  // ...existing success path...
}
```

(Adapt names to the fixture's actual state shape.)

- [ ] **Step 2: Write failing tests**

Append to `tests/investigation.test.mjs`:

```js
test("investigation resumes a prior thread and marks the prompt as resumed", async () => {
  const cwd = makeTempDir("codex-inv-resume-");
  const fake = setupFakeCodex({ cwd });
  try {
    // First run: persistent thread.
    fake.queueTurnResponse({ commands: [], finalAnswer: { text: "Done." } });
    fake.queueTurnResponse({ finalAnswer: { text: APPROVE_REVIEW } });
    const first = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] },
      persistThread: true,
      threadName: "Codex Companion Review: test"
    });
    assert.ok(first.threadId);
    const firstStart = fake.requests.find((r) => r.method === "thread/start");
    assert.equal(firstStart.params.ephemeral, false, "session mode threads persist");

    // Second run: resume.
    fake.queueTurnResponse({ commands: [], finalAnswer: { text: "Done again." } });
    fake.queueTurnResponse({ finalAnswer: { text: APPROVE_REVIEW } });
    const second = await runAppServerInvestigation(fake.cwd, {
      buildInvestigatePrompt: ({ resumed }) => (resumed ? "<continuation>resumed</continuation> Investigate." : "Investigate."),
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] },
      resumeThreadId: first.threadId,
      persistThread: true
    });
    assert.equal(second.threadId, first.threadId);
    const resumes = fake.requests.filter((r) => r.method === "thread/resume");
    assert.equal(resumes.length, 1);
    const secondInvestigate = fake.requests.filter((r) => r.method === "turn/start").at(-2);
    assert.match(JSON.stringify(secondInvestigate.params.input), /<continuation>resumed<\/continuation>/);
  } finally {
    fake.close();
  }
});

test("resume failure falls back to a fresh thread instead of failing the run", async () => {
  const cwd = makeTempDir("codex-inv-resume-fb-");
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({ commands: [], finalAnswer: { text: "Done." } });
    fake.queueTurnResponse({ finalAnswer: { text: APPROVE_REVIEW } });
    const result = await runAppServerInvestigation(fake.cwd, {
      buildInvestigatePrompt: ({ resumed }) => (resumed ? "RESUMED" : "FRESH"),
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] },
      resumeThreadId: "thread-that-was-pruned",
      persistThread: true
    });
    assert.equal(result.status, 0);
    assert.ok(fake.requests.some((r) => r.method === "thread/start"), "fell back to a fresh thread");
    const investigate = fake.requests.filter((r) => r.method === "turn/start")[0];
    assert.match(JSON.stringify(investigate.params.input), /FRESH/);
  } finally {
    fake.close();
  }
});

test("no-flag path still starts an ephemeral unnamed thread", async () => {
  const cwd = makeTempDir("codex-inv-eph-");
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({ commands: [], finalAnswer: { text: "Done." } });
    fake.queueTurnResponse({ finalAnswer: { text: APPROVE_REVIEW } });
    await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] }
    });
    const start = fake.requests.find((r) => r.method === "thread/start");
    assert.equal(start.params.ephemeral, true);
    assert.ok(!fake.requests.some((r) => r.method === "thread/name/set"));
  } finally {
    fake.close();
  }
});
```

(Verify how the fixture exposes `thread/start` params — if `ephemeral` rides in `params` directly this works; adapt to the fixture's `buildThreadParams` shape after reading it.)

- [ ] **Step 3: Run to verify failures** — new tests FAIL (unknown options ignored; no resume request).

- [ ] **Step 4: Implement in `runAppServerInvestigation`**

Replace the thread-start block:

```js
// Before
const startResponse = await startThread(client, cwd, {
  model: options.model,
  sandbox,
  ephemeral: true,
  threadName: null
});
const threadId = startResponse.thread.id;

// After
let threadId;
let resumedThread = false;
const startFreshThread = async () => {
  const response = await startThread(client, cwd, {
    model: options.model,
    sandbox,
    // Session mode (persistThread) keeps the thread resumable across runs and
    // broker restarts (#557); the default stays ephemeral/unnamed.
    ephemeral: options.persistThread ? false : true,
    threadName: options.persistThread ? options.threadName ?? null : null
  });
  return response.thread.id;
};
if (options.resumeThreadId) {
  emitProgress(options.onProgress, `Resuming review thread ${options.resumeThreadId}.`, "starting");
  try {
    const response = await resumeThread(client, options.resumeThreadId, cwd, {
      model: options.model,
      sandbox,
      ephemeral: false
    });
    threadId = response.thread.id;
    resumedThread = true;
  } catch {
    // A persisted thread can be pruned/expired by Codex. Resume fails before
    // any turn starts, so no tokens are wasted — fall back to a fresh thread.
    emitProgress(options.onProgress, `Could not resume thread ${options.resumeThreadId}; starting fresh.`, "starting");
    threadId = await startFreshThread();
  }
} else {
  threadId = await startFreshThread();
}
```

Prompt resolution — where the loop picks `promptText` for turn 1:

```js
// Before (inside the loop)
const promptText = i === 1 ? investigatePrompt : INVESTIGATION_CONTINUATION_CUE;
// After: resolve once before the loop
const effectiveInvestigatePrompt =
  typeof options.buildInvestigatePrompt === "function"
    ? String(options.buildInvestigatePrompt({ resumed: resumedThread }) ?? "").trim()
    : investigatePrompt;
// ...and in the loop:
const promptText = i === 1 ? effectiveInvestigatePrompt : INVESTIGATION_CONTINUATION_CUE;
```

Relax the top-of-function validation: `investigatePrompt` is required only when `buildInvestigatePrompt` is absent; add `if (!effectiveInvestigatePrompt) throw new Error("runAppServerInvestigation requires a non-empty investigate prompt.")` after resolution.

- [ ] **Step 5: Run to verify green**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/investigation.test.mjs`
Expected: ALL PASS including pre-existing tests (no-flag byte-identical).

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/lib/codex.mjs tests/investigation.test.mjs tests/fake-codex-fixture.mjs
git commit -m "feat(review): resumable persistent threads in the multi-turn runner (#375/#557 port)"
```

---

### Task 9: C3 — command flags, job wiring, docs (integration branch)

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs` (`handleReviewCommand`, `executeReviewRun`, `createCompanionJob`, usage text)
- Modify: `plugins/codex/commands/adversarial-review.md` (argument-hint + Context reuse section)
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `resolveLatestReviewThread`, `resolveReviewReuseWindowMs`, `REVIEW_RESUME_CONTINUATION_NOTE` (Task 7); runner options (Task 8); existing `createCompanionJob`, `resolveCommandWorkspace`.
- Produces: `adversarial-review` accepts `--resume` / `--fresh` (boolean) and `--within-hours <n>`; review job records carry `resumable: true` in session mode; plain `review` rejects the flags.

- [ ] **Step 1: Write failing CLI tests**

Append to `tests/runtime.test.mjs`, following the file's existing `run("node", [SCRIPT, "adversarial-review", ...])` + fake-codex pattern (copy the setup of an existing passing adversarial-review CLI test wholesale, including its fake queue and env):

```js
test("adversarial-review --resume with no prior thread starts fresh and records resumable", () => {
  // fake queue: 1 recon turn + 1 finalize (structured verdict)
  const result = run("node", [SCRIPT, "adversarial-review", "--resume", "--wait"], { /* fake env */ });
  assert.equal(result.status, 0);
  // job record: find the review job JSON in the state dir, assert job.resumable === true
  // fake request log: thread/start present, thread/resume absent, thread/start.ephemeral === false
});

test("second adversarial-review --resume reuses the prior thread with a continuation note", () => {
  // Run #1 as above (completes, records threadId).
  // Run #2 with --resume: assert thread/resume was called with run #1's threadId
  // and the first turn/start input contains "<continuation>".
});

test("adversarial-review --fresh ignores the prior thread", () => {
  // Run #1 with --resume (completes). Run #2 with --fresh:
  // assert no thread/resume request; thread/start.ephemeral === false (still session mode).
});

test("--within-hours expires an old thread", () => {
  // Run #1 with --resume (completes). Rewrite the job file's completedAt to
  // 5 hours ago (fs.readFileSync/writeFileSync on the job JSON in the state dir).
  // Run #2 with --resume --within-hours 3: assert thread/start (fresh), no thread/resume.
});

test("plain review rejects --resume", () => {
  const result = run("node", [SCRIPT, "review", "--resume"], { /* fake env */ });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--resume.*adversarial-review|not supported/i);
});
```

(These are outlines by intent; the fixture wiring must be copied exactly from the neighboring adversarial-review CLI tests — they already solve fake-codex spawning, state-dir env, and request logging. The fake's request log location: see how existing tests assert on requests, e.g. via `fake.requests` file or fixture helper.)

- [ ] **Step 2: Run to verify failures** — unknown `--resume` flag error (flags not parsed).

- [ ] **Step 3: Implement companion wiring**

`handleReviewCommand` parse block:

```js
const { options, positionals } = parseCommandInput(argv, {
  valueOptions: ["base", "scope", "model", "cwd", "max-investigation-turns", "turn-idle-timeout", "within-hours"],
  booleanOptions: ["json", "background", "wait", "resume", "fresh"],
  aliasMap: { m: "model" }
});
```

Validation + session mode (after the existing flag validations):

```js
const resume = Boolean(options.resume);
const fresh = Boolean(options.fresh);
if (resume && fresh) {
  throw new Error("--resume and --fresh are mutually exclusive.");
}
const sessionMode = resume || fresh;
if (sessionMode && config.reviewName !== "Adversarial Review") {
  throw new Error("--resume/--fresh are only supported on adversarial-review.");
}
let reuseWindowMs = null;
if (options["within-hours"] !== undefined) {
  const parsed = Number(options["within-hours"]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--within-hours must be a positive number (got: ${options["within-hours"]})`);
  }
  reuseWindowMs = resolveReviewReuseWindowMs(parsed);
}
```

Job record gains the flag — extend `createCompanionJob` signature with `resumable = false` and include it in the record base; the review call site passes `resumable: sessionMode`. Pass through to the executor: add `resume`, `sessionMode`, `reuseWindowMs`, `jobId: job.id` to the `executeReviewRun({...})` request object.

`executeReviewRun` self-collect branch:

```js
let resumeThreadId = null;
if (request.resume) {
  const prior = resolveLatestReviewThread(resolveWorkspaceRoot(context.repoRoot), {
    withinMs: request.reuseWindowMs ?? resolveReviewReuseWindowMs(),
    excludeJobId: request.jobId ?? null,
    kind: "adversarial-review"
  });
  if (prior) {
    resumeThreadId = prior.id;
  }
}
result = await runAppServerInvestigation(context.repoRoot, {
  buildInvestigatePrompt: ({ resumed }) =>
    resumed ? `${REVIEW_RESUME_CONTINUATION_NOTE}\n\n${investigatePrompt}` : investigatePrompt,
  finalizePrompt,
  outputSchema: readOutputSchema(REVIEW_SCHEMA),
  model: request.model,
  sandbox: "read-only",
  maxInvestigationTurns: request.maxInvestigationTurns,
  turnIdleTimeoutMs: request.turnIdleTimeoutMs,
  resumeThreadId,
  persistThread: Boolean(request.sessionMode),
  threadName: request.sessionMode ? `Codex Companion Review: ${target.label}` : null,
  onProgress: request.onProgress
});
```

(`resolveWorkspaceRoot` — use whatever helper the file already uses to map repoRoot → workspace state dir; grep `resolveCommandWorkspace` / how `createCompanionJob` gets `workspaceRoot`. Import the three Task-7 exports at the top of the companion.)

Usage text: add `[--resume|--fresh] [--within-hours <n>]` to the adversarial-review usage line.

- [ ] **Step 4: Update the command doc**

`adversarial-review.md`: extend `argument-hint` with `[--resume|--fresh] [--within-hours <n>]`, and add the Context-reuse section (adapted from #375, adversarial-only):

```
Context reuse (faster re-reviews):
- `--resume` reuses-or-creates: it reuses this git worktree's recent adversarial review thread if one exists, otherwise starts a new resumable thread. Safe to pass on every review; it never fails just because no prior thread exists.
- Reuse keeps the exploration Codex already did, so a review → fix → re-review loop skips the cold re-investigation. The current diff is still collected fresh on every pass.
- Reuse is scoped to this worktree and bounded by recency (default 3h; override with `--within-hours <n>`).
- `--fresh` forces a new resumable thread, discarding prior context.
- Pass the flags through verbatim; do not treat them as focus text.
```

- [ ] **Step 5: Run the new CLI tests + full runtime file**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID node --test tests/runtime.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs plugins/codex/commands/adversarial-review.md tests/runtime.test.mjs
git commit -m "feat(adversarial-review): --resume/--fresh/--within-hours resumable review threads"
```

---

### Task 10: Integration checkpoint — full suite, deploy, memory/docs, push

**Files:**
- Modify: `~/.claude/projects/-Users-kentpeng-projects-codex-plugin-cc/memory/adversarial-review-timeout-ops.md`
- Modify: `~/.claude/CLAUDE.md` (user-maintained — show the diff, do not silently edit)
- Deploy: `~/.claude/plugins/cache/openai-codex/codex/1.0.6/`

- [ ] **Step 1: Full suite on the integration branch**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID npm test 2>&1 | tail -15`
Expected: `# fail 0`. Cleanup: `pkill -9 -f fake-codex; pkill -9 -f app-server-broker`.

- [ ] **Step 2: Deploy to the plugin cache**

```bash
cd /Users/kentpeng/projects/codex-plugin-cc/.claude/worktrees/integrate-broker-prs
NEW=~/.claude/plugins/cache/openai-codex/codex/1.0.6
git diff --name-only origin/main HEAD -- plugins/codex/ | while read -r f; do
  rel=${f#plugins/codex/}
  mkdir -p "$NEW/.bak-preIntegration-20260729/$(dirname "$rel")" "$NEW/$(dirname "$rel")"
  [ -f "$NEW/$rel" ] && cp "$NEW/$rel" "$NEW/.bak-preIntegration-20260729/$rel"
  cp "$f" "$NEW/$rel"
done
# Verify: re-run the loop with diff -q instead of cp; expect no MISMATCH lines.
```

- [ ] **Step 3: Update memory**

Rewrite `adversarial-review-timeout-ops.md` body: defaults are now idle 1200s / stall 1200s / ceiling 7200s on the deployed fork build — no override needed for normal runs; raise `CODEX_COMPANION_TURN_TIMEOUT_MS` only for pathological (>2h-turn) cases; `--resume` reuses the worktree's review thread within 3h. Update the `MEMORY.md` index hook line to match. Also update `branch-strategy-two-feat-branches.md`'s deployed-state line (new commits, deploy date).

- [ ] **Step 4: Propose the CLAUDE.md edit to the user**

Show a diff replacing the "Codex adversarial review" section's timeout recipe: the deployed fork no longer needs `CODEX_COMPANION_TURN_TIMEOUT_MS=3600000 ... --turn-idle-timeout 600` on every invocation; keep the "retry starts a fresh thread — unless you pass `--resume`" note. **Wait for user approval before editing this file.**

- [ ] **Step 5: Push both branches**

```bash
cd /Users/kentpeng/projects/codex-plugin-cc && git push --no-verify fork feat/codex-self-collect-multiturn
cd .claude/worktrees/integrate-broker-prs && git push --no-verify fork feat/integrate-broker-stability-prs
```

---

### Task 11: Timed real-review validation (manual, background)

- [ ] **Step 1: Cold run** — from the integration worktree, kick off a background adversarial review of a real diff (e.g. `--base origin/main --scope branch`), note wall time. Target: ≤ 35 min, verdict JSON present (`result` non-null).
- [ ] **Step 2: Resume run** — make a trivial change (or re-run as-is) with `--resume`; target ≤ 20 min, log shows `Resuming review thread`.
- [ ] **Step 3: Record outcomes** in the memory files (actuals vs targets); if targets are missed, capture per-turn timings from the job log for the next iteration.

---

## Self-review notes

- Spec coverage: A → Task 2; B → Task 3; C → Tasks 7–9; D → Tasks 1, 6, 10; rollout order → task order; timed validation → Task 11. Working-tree A-routing covered in Task 2 Step 3.
- Type consistency: `resolveLatestReviewThread` returns `{id, jobId, lastUsedAt}`; consumed as `prior.id` in Task 9. Runner options named identically in Tasks 8 (producer) and 9 (consumer). `resumable` written by Task 9, read by Task 7's resolver.
- Known unknowns called out in-place: fixture `thread/resume` unknown-id behavior (Task 8 Step 1), `sortJobsNewestFirst` export location (Task 7), fixture request-log access pattern (Task 9 Step 1) — each has an explicit verify step before use.
