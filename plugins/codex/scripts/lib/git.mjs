import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
// Inline-diff embeds full file contents into the prompt and pins outputSchema
// on a single turn — there is no recovery if the model wants to investigate
// before producing the verdict. Keep this path narrow: only single-file
// reviews of small diffs use it. Anything larger falls through to the
// two-phase self-collect path which can tolerate exploratory turns.
const DEFAULT_INLINE_DIFF_MAX_FILES = 1;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
// Multi-turn investigation can tolerate a much larger inline payload than the
// single-shot path: the model reads the diff as evidence and still has
// follow-up turns for anything it needs beyond it. 1MB is a safe share of a
// 272K-token context window.
const DEFAULT_INVESTIGATION_INLINE_MAX_BYTES = 1024 * 1024;
// Aggregate ceiling on embedded untracked content for the blind self-collect
// path. The fed and single-shot paths bound untracked bytes through their own
// budgets (see collectReviewContext), but the blind path has no diff budget to
// borrow — and it still embeds untracked bodies, because untracked files are
// invisible to the git commands the model would otherwise run. Without a cap,
// an arbitrarily large untracked payload rides the fallback that over-budget
// reviews route to.
const DEFAULT_UNTRACKED_INLINE_MAX_BYTES = 256 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function normalizeInvestigationInlineMaxBytes(value) {
  const raw = value ?? process.env.CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INVESTIGATION_INLINE_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function normalizeUntrackedInlineMaxBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_UNTRACKED_INLINE_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

// Single source of truth for whether an untracked file's contents can be
// embedded into the inline prompt. Returns either a `skipped` reason (the file
// is a directory, too large, binary, or unreadable) or the file `content`.
function classifyUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return { skipped: "broken symlink or unreadable file" };
  }
  if (stat.isDirectory()) {
    return { skipped: "directory" };
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return { skipped: `${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit` };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return { skipped: "broken symlink or unreadable file" };
  }
  if (!isProbablyText(buffer)) {
    return { skipped: "binary file" };
  }

  return { content: buffer.toString("utf8").trimEnd() };
}

// Classifies every untracked file exactly once and returns everything the rest
// of a working-tree review needs: the per-file verdicts (so the formatter never
// re-reads the tree), the aggregate embeddable size, and whether anything was
// skipped. Three consumers used to each walk the untracked set independently;
// funnelling them through one result keeps the review to a single stat/read pass
// no matter how many untracked files the tree holds.
//
// `embeddableBytes` counts only content that will actually be embedded. Skipped
// files contribute a short `(skipped: ...)` marker instead, bounded by the path
// length, which the budgets treat as free.
function summarizeUntrackedFiles(cwd, untracked) {
  const entries = untracked.map((relativePath) => ({
    relativePath,
    ...classifyUntrackedFile(cwd, relativePath)
  }));

  let embeddableBytes = 0;
  let hasSkipped = false;
  for (const entry of entries) {
    if (entry.skipped) {
      // An untracked file never appears in `git diff`, so a single skipped
      // untracked file otherwise looks like a 1-file, 0-byte diff and slips onto
      // the inline path — where the prompt embeds only a `(skipped: ...)` marker
      // and forbids shell, leaving the reviewer nothing to inspect.
      hasSkipped = true;
      continue;
    }
    embeddableBytes += Buffer.byteLength(entry.content, "utf8");
  }

  return { entries, embeddableBytes, hasSkipped };
}

// Embeds untracked bodies in order until `maxBytes` is exhausted, then reports
// the remainder as one manifest line instead. Stopping at the first file that
// does not fit (rather than packing later small ones) keeps the embedded set a
// predictable prefix, so "N more" is literally the tail.
//
// Dropping the overflow silently would hide entire new files from the review, so
// the omission line names the cost and the recovery. The reviewer can still see
// every filename in `## Git Status`, which lists untracked files exhaustively.
function formatUntrackedSection(entries, maxBytes) {
  const blocks = [];
  let usedBytes = 0;
  let omittedFiles = 0;
  let omittedBytes = 0;

  for (const entry of entries) {
    if (entry.skipped) {
      blocks.push(`### ${entry.relativePath}\n(skipped: ${entry.skipped})`);
      continue;
    }
    const contentBytes = Buffer.byteLength(entry.content, "utf8");
    if (omittedFiles === 0 && usedBytes + contentBytes <= maxBytes) {
      usedBytes += contentBytes;
      blocks.push([`### ${entry.relativePath}`, "```", entry.content, "```"].join("\n"));
      continue;
    }
    omittedFiles += 1;
    omittedBytes += contentBytes;
  }

  if (omittedFiles > 0) {
    blocks.push(
      `(omitted: ${omittedFiles} more untracked files, ${omittedBytes} bytes — read them directly with read-only commands)`
    );
  }

  return { body: blocks.join("\n\n"), omittedFiles };
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  const untrackedEntries = options.untrackedEntries ?? summarizeUntrackedFiles(cwd, state.untracked).entries;
  const untracked = formatUntrackedSection(untrackedEntries, options.untrackedMaxBytes ?? Infinity);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untracked.body)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untracked.body)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles,
    untrackedContentOmitted: untracked.omittedFiles > 0
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  if (options.investigationInline) {
    const fed =
      "The full diff is embedded below as primary evidence — do not re-derive it with git commands. Run read-only commands only when you need context beyond the diff itself: surrounding code, callers, history, or tests.";
    // Untracked files never appear in `git diff`, and oversized/binary ones are
    // reduced to a `(skipped: ...)` marker. Without this clause the fed wording
    // would claim complete evidence while telling the model not to go looking.
    if (options.hasSkippedUntracked) {
      return `${fed} Some untracked files could not be embedded — read them directly with read-only commands.`;
    }
    return fed;
  }

  const blind =
    "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
  // Untracked files are absent from every git diff, so the summary is the only
  // place they appear at all. If some bodies were omitted for size, say so — the
  // blind wording already sends the model to `git` commands that cannot surface
  // them, and it needs to know to read those files instead.
  if (options.untrackedContentOmitted) {
    return `${blind} Some untracked file contents were omitted for size — read those files directly with read-only commands.`;
  }
  return blind;
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  const investigationInlineMaxBytes = normalizeInvestigationInlineMaxBytes(options.investigationInlineMaxBytes);
  const untrackedInlineMaxBytes = normalizeUntrackedInlineMaxBytes(options.untrackedInlineMaxBytes);
  // Measure up to whichever budget is larger so a diff that overflows the
  // single-shot cap still yields a real byte count for the investigation check.
  const measureCap = Math.max(maxInlineDiffBytes, investigationInlineMaxBytes);
  let details;
  // singleShotInline decides inline-diff vs self-collect routing; investigationInline
  // decides whether the self-collect prompt carries the diff. Keep them distinct.
  let singleShotInline;
  let investigationInline;
  let diffBytes;
  // Only meaningful in working-tree mode; a branch diff ignores the working tree.
  let fedDiffOmitsUntracked = false;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    // Stats and reads every untracked file, and four things below consult the
    // result. Memoize so it runs at most once, and keep it lazy so nothing pays
    // for it when a cheaper conjunct already lost.
    let untrackedSummary = null;
    const summarizeUntracked = () => {
      if (untrackedSummary === null) {
        untrackedSummary = summarizeUntrackedFiles(repoRoot, state.untracked);
      }
      return untrackedSummary;
    };
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      measureCap
    );
    // Untracked files never appear in `git diff`, so diffBytes alone understates
    // an inline prompt that also embeds their bodies verbatim — by an unbounded
    // margin, since only a per-file cap applies to them. Both inline budgets
    // therefore weigh the total payload, not just the diff.
    singleShotInline =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes &&
        !summarizeUntracked().hasSkipped &&
        diffBytes + summarizeUntracked().embeddableBytes <= maxInlineDiffBytes);
    // Skipped untracked content does not block the fed path the way it blocks
    // single-shot: the multi-turn path still has read-only shell to inspect it.
    investigationInline =
      options.includeDiff === undefined &&
      !singleShotInline &&
      diffBytes <= investigationInlineMaxBytes &&
      diffBytes + summarizeUntracked().embeddableBytes <= investigationInlineMaxBytes;
    // The fed diff is then incomplete, so the guidance must say so rather than
    // claim the embedded diff is the whole change.
    fedDiffOmitsUntracked = investigationInline && summarizeUntracked().hasSkipped;
    details = collectWorkingTreeContext(repoRoot, state, {
      includeDiff: singleShotInline || investigationInline,
      untrackedEntries: summarizeUntracked().entries,
      // On the inline paths the gates above already proved the whole untracked
      // set fits, so this cap is inert there and truncation can only ever fire
      // on the blind fallback — the one path with no diff budget of its own.
      untrackedMaxBytes:
        singleShotInline || investigationInline ? Infinity : untrackedInlineMaxBytes
    });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      measureCap
    );
    singleShotInline = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    investigationInline =
      options.includeDiff === undefined && !singleShotInline && diffBytes <= investigationInlineMaxBytes;
    details = collectBranchContext(repoRoot, target.baseRef, {
      includeDiff: singleShotInline || investigationInline,
      comparison
    });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: singleShotInline ? "inline-diff" : "self-collect",
    investigationInline,
    collectionGuidance: buildAdversarialCollectionGuidance({
      includeDiff: singleShotInline,
      investigationInline,
      hasSkippedUntracked: fedDiffOmitsUntracked,
      untrackedContentOmitted: Boolean(details.untrackedContentOmitted)
    }),
    ...details
  };
}
