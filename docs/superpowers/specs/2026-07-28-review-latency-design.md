# Adversarial-review latency: inline context, finalize effort, resumable threads, timeout defaults

**Date:** 2026-07-28
**Status:** Approved (design review with user, this session)
**Branches:** A+B+D(idle) → `feat/codex-self-collect-multiturn` (PR #328 source, keep clean); C+D(ceiling) → `feat/integrate-broker-stability-prs` (self-use integration)

## Problem

Adversarial reviews on Bedrock gpt-5.6-sol xhigh take 60–100+ minutes. Measured 2026-07-27 (three parallel slices on the integration branch): an average xhigh investigation turn costs ~10 minutes; one pathological turn exceeded 60 minutes. Total time ≈ (investigation turns + finalize turns) × ~10 min. The user's constraints: effort stays xhigh, model stays the best available; latency must come down anyway.

Root causes, in order of leverage:

1. **Reconnaissance turns.** Any diff over 1 file/256KB routes to `self-collect`, which feeds Codex only a lightweight summary (commit log + diff stat + file list). The first 2–4 xhigh turns are spent re-deriving the diff via read-only git commands.
2. **xhigh finalize.** The finalize turn translates already-formed conclusions into schema JSON — mechanical work — yet runs at the config-default xhigh (~10 min; ~20 with the empty-retry).
3. **Cold re-reviews.** Every review → fix → re-review pass restarts from a fresh ephemeral thread and re-explores the repo from zero.
4. **Timeout defaults tuned for fast backends.** Review idle default 180s and stall default 600s both killed healthy turns in the 2026-07-27 test (turns silent >600s); the 1800s ceiling killed a healthy 60+ min turn.

## Non-goals

- Lowering investigation effort or model tier (user constraint: quality is not negotiable).
- Merging PR #488 (fanout/council layer): heavy, and its quota step-down conflicts with the no-downgrade constraint. Multi-perspective runs can be orchestrated from Claude Code with subagents instead.
- Making resume the default (stays opt-in, matching upstream #375 semantics).
- A turn-based resumable path for plain `/codex:review` (#375 ships one; unused here, YAGNI).
- Unifying the single-shot and multi-turn runners.

## A. Feed the diff into the multi-turn investigation

All on the clean branch. Mechanism: carry the full diff in the investigate prompt; keep the multi-turn loop for verification-depth, timeouts, and digest backfill.

1. New investigation-inline budget, independent of the single-shot inline caps: `CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES`, default **1MB** (safe share of gpt-5.6's 272K context). No file-count cap — bytes are the real constraint.
2. `collectReviewContext` (git.mjs) routes three ways:
   - ≤ 1 file and ≤ 256KB → `inline-diff` single-shot path, **unchanged**;
   - ≤ 1MB → `self-collect` with details carrying the **full diff** (Commit Log + Diff Stat + full Diff);
   - \> 1MB → `self-collect` with the current lightweight summary (blind-recon fallback), plus a progress note that the inline budget was exceeded.
3. Collection guidance becomes three-way: inline single-shot unchanged; fed mode says "the full diff is below as primary evidence; run read-only commands only for context beyond the diff (callers, history, tests)"; blind mode keeps the current wording.
4. Convergence contract, timeouts, digest backfill, finalize flow: untouched.

Expected effect: 5–8 investigation turns → 1–3. Working-tree targets use the same three-way routing (the working-tree branch of `collectReviewContext` already measures combined staged+unstaged bytes).

Tests: three-way routing unit tests including boundaries (exactly 256KB, exactly 1MB); assertion that the investigate prompt contains the diff in fed mode; existing investigation tests stay green.

## B. Finalize turn at medium effort

Clean branch, all inside the finalize loop in `codex.mjs`.

1. New resolver: `CODEX_COMPANION_FINALIZE_EFFORT` env var, default `"medium"`; accepts the existing effort enum plus `"inherit"` (pass `null`, i.e. old behavior).
2. Finalize `turn/start` sends the resolved effort. Investigation turns keep `options.effort ?? null` (global xhigh).
3. The retry attempt (strict/empty reminder) also uses medium — the empty-finalize case is an upstream Message-item drop, not under-thinking; escalating effort there buys nothing.

Expected effect: finalize ~10 min → 2–3 min; empty-retry worst case ~20 min → ~5 min.

Tests: fake-codex fixture asserts finalize `turn/start` receives `effort: "medium"` while investigation turns receive the caller's effort; `inherit` restores old behavior.

## C. Semantic port of #375/#557 resume onto the multi-turn runner

Integration branch only (external-PR integration, same policy as #361). Why a port instead of a merge: #375 predates the multi-turn runner — it wires resume into single-shot `runAppServerTurn` only, so merged verbatim it would never touch the slow path. Verified against the PR diff (base v1.0.4, `runAppServerInvestigation` absent).

Ported mechanisms:

1. **Thread lookup** — `resolveLatestReviewThread` moves in nearly verbatim: newest `resumable: true`, `completed`, thread-id-bearing review job in this worktree's job records; kind-scoped (adversarial never reuses a plain-review thread); recency-bounded (default 3h, `--within-hours <n>`); its concurrency guard (a newest-but-unfinished run blocks fallback to older runs, preventing two runs from interleaving one thread) is kept.
2. **Runner** — `runAppServerInvestigation` gains `resumeThreadId` / `persistThread` / `threadName` options. In session mode threads start `ephemeral: false` (#557) and named `Codex Companion Review: <label>`. Resume failure (thread pruned by Codex) falls back to a fresh thread instead of failing the run (#375 fallback semantics).
3. **Command** — `adversarial-review` gains `--resume` / `--fresh` / `--within-hours`. On a resume hit, #375's `<continuation>` note is prepended to the investigate prompt (reuse prior exploration; focus on what changed; re-check earlier findings).

Behavior contracts:

- **No-flag path byte-identical** — ephemeral threads, current prompts, existing tests untouched.
- **Interplay with A:** a resumed run still carries the current full diff (per A) plus the continuation note. Thread memory covers "skip re-exploring the codebase"; the fresh diff covers "what changed this pass". This is the mechanism that turns re-reviews into 10–20 min runs.
- Scope: adversarial-review only.

Tests (one fixture case each): resume hit reuses prior threadId; `--fresh` forces new; expired window → new thread; resume failure → fallback new thread; continuation note injected only on a true resume; `ephemeral: false` only in session mode.

## D. Timeout defaults and docs

Code (measured justification: 2026-07-27 slices died at idle 600s on healthy turns and ceiling 3600s on a healthy turn):

1. `DEFAULT_TURN_IDLE_TIMEOUT_MS` 180s → **1200s** (clean branch; review-only default, task path unaffected).
2. `DEFAULT_TURN_CEILING_MS` 1800s → **7200s** (integration branch — the ceiling is #361-integration code and exists only there). `DEFAULT_TURN_STALL_MS` 600s → **1200s** (multi-turn idle backstop; aligned with the review idle default so it doesn't silently undercut it).

Docs:

3. `adversarial-review.md` timeout section rewritten for the new defaults + how to raise them when hit.
4. Memory `adversarial-review-timeout-ops` updated: the "must manually raise both timeouts" rule becomes "defaults now suffice; raise only for pathological turns". Global CLAUDE.md's review invocation recipe updated to match (user-maintained file — show the diff to the user separately).

Accepted trade-off: a genuinely dead review now takes 20 min to fail. Reviews run in the background in this workflow, so a late failure blocks nothing; in exchange, healthy slow turns stop getting killed.

## Rollout order

1. A + B + D(idle/stall) on `feat/codex-self-collect-multiturn`, tests green (suite must run with `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID` to avoid the known session-env false failures).
2. Merge clean branch → `feat/integrate-broker-stability-prs`.
3. C + D(ceiling) on the integration branch, full suite green.
4. Redeploy changed files into `~/.claude/plugins/cache/openai-codex/codex/1.0.6/` (files = `git diff --name-only origin/main HEAD -- plugins/codex/`), backup dir convention `.bak-preIntegration-<date>/`.
5. Timed real-review comparison: cold run (expect ~15–35 min) and `--resume` re-review (expect ~10–20 min) against the 60–100 min baseline.

## Expected outcomes

| Scenario | Before | After |
|---|---|---|
| Cold full review | 60–100 min | ~15–35 min (1–3 investigation turns + cheap finalize) |
| Re-review after fixes (`--resume`) | 60–100 min | ~10–20 min (incremental turns) |
| Healthy slow turn killed by timeout | frequent (idle 180–600s / ceiling 1800s) | rare (idle 1200s / ceiling 7200s) |

Escape hatches: `CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES`, `CODEX_COMPANION_FINALIZE_EFFORT=inherit`, `--fresh`, and the existing timeout env vars/flags all restore prior behavior piecewise.
