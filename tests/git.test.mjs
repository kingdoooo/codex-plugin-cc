import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/codex/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

// Runs the exact git command collectReviewContext measures for a branch diff, so
// boundary tests can pin the caps to a real byte count instead of crafting one.
function measureBranchDiffBytes(cwd, baseRef) {
  const mergeBase = run("git", ["merge-base", "HEAD", baseRef], { cwd }).stdout.trim();
  const diff = run("git", ["diff", "--binary", "--no-ext-diff", "--submodule=diff", `${mergeBase}..HEAD`], { cwd });
  return Buffer.byteLength(diff.stdout, "utf8");
}

// Single-file branch diff of a non-trivial size, committed so the tree is clean
// and resolveReviewTarget picks branch mode.
function seedSingleFileBranchDiff(cwd) {
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(400)}';\n`);
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });
}

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext routes 2-file changes to self-collect (inline cap is 1)", () => {
  // Regression guard: a 2-file change used to slip into inline-diff because
  // the cap was 2, embedding both files into a single-turn schema-pinned
  // prompt — and the model often responded with a tool-call stub instead
  // of the review JSON. Two files now go through the two-phase self-collect
  // path which tolerates exploratory turns.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "doc-one.md"), "# planning doc\n".repeat(50));
  fs.writeFileSync(path.join(cwd, "doc-two.md"), "# spec doc\n".repeat(50));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.fileCount, 2);
  assert.equal(context.inputMode, "self-collect",
    "2-file changes must NOT be inlined; they hit the schema-pinned single-turn bug otherwise");
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("collectReviewContext routes larger adversarial reviews to self-collect with the diff fed", () => {
  // Routing guard: >1 changed file must never take the single-shot inline path.
  // The diff itself is still embedded — it is well under the investigation
  // budget, and re-deriving it would cost the reviewer an expensive first turn.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.equal(context.investigationInline, true);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
  assert.match(context.content, /SELF_COLLECT_MARKER_A/);
});

test("collectReviewContext falls back to self-collect for oversized single-file diffs", () => {
  // The two budgets are independent: exceeding the single-shot byte cap moves
  // the review off the inline-diff path, but the diff still fits the (much
  // larger) investigation budget, so it is fed to the multi-turn prompt.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.equal(context.investigationInline, true);
  assert.match(context.content, /xxx/);
});

test("collectReviewContext keeps untracked file content in lightweight working tree context", () => {
  // Blind working-tree path (diff over the investigation budget): untracked
  // files never appear in `git diff`, so their contents must still be embedded
  // or the summary hides them entirely.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { investigationInlineMaxBytes: 10 });

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.equal(context.investigationInline, false);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

test("collectReviewContext routes a single oversized untracked file to self-collect", () => {
  // An untracked file never shows up in `git diff`, so its size does not count
  // toward diffBytes. A single untracked file >24 KiB therefore looked like a
  // 1-file, 0-byte diff and slipped onto the inline path — where the prompt
  // embeds only a `(skipped: ...)` marker AND forbids shell. The reviewer could
  // then only approve/guess. Skipped untracked content must fall through to
  // self-collect so Codex can read the file with read-only commands.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  // One untracked file, contents exceed MAX_UNTRACKED_BYTES (24 KiB).
  fs.writeFileSync(path.join(cwd, "big-untracked.txt"), "x".repeat(30 * 1024));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect",
    "a skipped untracked file must NOT be inlined; the prompt would embed only a (skipped) marker while forbidding shell");
});

test("collectReviewContext routes a single binary untracked file to self-collect", () => {
  // Same hazard as the oversized case: a small binary untracked file is within
  // the byte/file caps but its contents are skipped as `(skipped: binary file)`,
  // so the inline prompt would show nothing useful while forbidding shell.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  // Untracked binary file: NUL bytes make isProbablyText() false.
  fs.writeFileSync(path.join(cwd, "blob.bin"), Buffer.from([0, 1, 2, 0, 3, 4, 0]));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect",
    "a binary untracked file must NOT be inlined; its contents are skipped in the embedded prompt");
});

test("collectReviewContext still inlines a single small text untracked file", () => {
  // Guard the fix from over-reaching: an untracked file whose contents ARE
  // embeddable (small, text) must stay on the inline path.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "small-new.js"), "export const v = 'INLINE_UNTRACKED_MARKER';\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "inline-diff");
  assert.match(context.content, /INLINE_UNTRACKED_MARKER/);
});

test("mid-size branch diff self-collects WITH the full diff embedded (investigation inline)", () => {
  // The multi-turn path used to be handed a stat-only summary, so the reviewer
  // burned its first (very expensive) reasoning turns re-deriving the diff with
  // `git diff`. Anything under the investigation budget is now fed inline while
  // still routing to the multi-turn path.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "doc-one.md"), "# planning doc\n".repeat(50));
  fs.writeFileSync(path.join(cwd, "doc-two.md"), "# spec doc\n".repeat(50));
  run("git", ["add", "doc-one.md", "doc-two.md"], { cwd });
  run("git", ["commit", "-m", "docs"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.fileCount, 2);
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.investigationInline, true);
  assert.match(context.content, /## Branch Diff/);
  assert.match(context.content, /diff --git/);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
});

test("diff above the investigation budget self-collects blind (lightweight summary)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "doc-one.md"), "# planning doc\n".repeat(50));
  fs.writeFileSync(path.join(cwd, "doc-two.md"), "# spec doc\n".repeat(50));
  run("git", ["add", "doc-one.md", "doc-two.md"], { cwd });
  run("git", ["commit", "-m", "docs"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  process.env.CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES = "10";
  try {
    const context = collectReviewContext(cwd, target);
    assert.equal(context.inputMode, "self-collect");
    assert.equal(context.investigationInline, false);
    assert.match(context.content, /## Changed Files/);
    assert.doesNotMatch(context.content, /diff --git/);
    assert.match(context.collectionGuidance, /lightweight summary/i);
    assert.match(context.collectionGuidance, /read-only git commands/i);
  } finally {
    delete process.env.CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES;
  }
});

test("tiny single-file diff still routes to inline-diff (single-shot path unchanged)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.investigationInline, false);
  assert.match(context.collectionGuidance, /primary evidence/i);
});

test("explicit includeDiff:false still forces blind self-collect", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('OVERRIDE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { includeDiff: false });

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.investigationInline, false);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.doesNotMatch(context.content, /OVERRIDE_MARKER/);
});

test("mid-size working-tree diff also gets investigation inline", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "STAGED_FED_MARKER";\n');
  run("git", ["add", "a.js"], { cwd });
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "UNSTAGED_FED_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.equal(context.fileCount, 2);
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.investigationInline, true);
  assert.match(context.content, /## Staged Diff/);
  assert.match(context.content, /## Unstaged Diff/);
  assert.match(context.content, /diff --git/);
  assert.match(context.content, /STAGED_FED_MARKER/);
  assert.match(context.content, /UNSTAGED_FED_MARKER/);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
  // Nothing was skipped, so the guidance must NOT hedge about untracked files.
  assert.doesNotMatch(context.collectionGuidance, /could not be embedded/i);
});

test("fed working-tree guidance warns when untracked content could not be embedded", () => {
  // An untracked file never appears in `git diff`, and oversized/binary ones are
  // reduced to a `(skipped: ...)` marker. Telling the model "the full diff is
  // embedded — do not re-derive it" would then assert complete evidence while
  // discouraging the one action that recovers the missing content: reading the
  // file. The fed wording must own that gap.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SKIPPED_CASE_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SKIPPED_CASE_MARKER_B";\n');
  // Untracked and over MAX_UNTRACKED_BYTES (24 KiB), so its contents are skipped.
  fs.writeFileSync(path.join(cwd, "big-untracked.txt"), "x".repeat(30 * 1024));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.investigationInline, true, "routing is unchanged: this still takes the fed path");
  assert.match(context.content, /SKIPPED_CASE_MARKER_A/);
  assert.match(context.content, /skipped: 30720 bytes/);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
  assert.match(context.collectionGuidance, /read them directly with read-only commands/i);
});

test("fed branch-mode guidance keeps the unqualified wording (no untracked concept)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "doc-one.md"), "# planning doc\n".repeat(50));
  fs.writeFileSync(path.join(cwd, "doc-two.md"), "# spec doc\n".repeat(50));
  run("git", ["add", "doc-one.md", "doc-two.md"], { cwd });
  run("git", ["commit", "-m", "docs"], { cwd });
  // An untracked file that WOULD be skipped in working-tree mode. A branch diff
  // does not consider the working tree at all, so the wording must not hedge.
  fs.writeFileSync(path.join(cwd, "big-untracked.txt"), "x".repeat(30 * 1024));

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(context.investigationInline, true);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
  assert.doesNotMatch(context.collectionGuidance, /could not be embedded/i);
});

// Untracked files are the one kind of change `git diff` never reports, so their
// embedded bodies are invisible to any budget measured from diff output. Seeds a
// one-line tracked edit (a ~130 byte diff) plus `count` untracked files of
// exactly `bytes` embeddable bytes each — every file under MAX_UNTRACKED_BYTES
// (24 KiB) so none is skipped, and each carrying a unique body marker so a test
// can tell an embedded body from the file's name in `## Git Status`.
function seedUntrackedBulk(cwd, count, bytes) {
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v2';\n");
  for (let index = 0; index < count; index += 1) {
    const marker = `BODY_MARKER_${index}_`;
    // No trailing whitespace: classifyUntrackedFile trimEnd()s the content, so
    // this keeps embeddable bytes exactly equal to `bytes` for budget math.
    fs.writeFileSync(path.join(cwd, `note-${index}.txt`), marker + "u".repeat(bytes - marker.length));
  }
}

test("many small untracked files push a working-tree review off the fed path", () => {
  // Each file is under the per-file 24 KiB cap, so nothing is skipped and the
  // old gate saw only the 130-byte tracked diff — passing a 64 KiB budget while
  // embedding 320 KiB of untracked bodies.
  const cwd = makeTempDir();
  seedUntrackedBulk(cwd, 40, 8 * 1024);

  const target = resolveReviewTarget(cwd, {});
  const budget = 64 * 1024;
  // maxInlineDiffBytes: 0 forces the single-shot path to lose, isolating the
  // investigation budget as the only decision under test.
  const options = { maxInlineDiffBytes: 0, investigationInlineMaxBytes: budget };
  const context = collectReviewContext(cwd, target, options);

  assert.equal(target.mode, "working-tree");
  assert.ok(context.diffBytes <= budget, "the tracked diff alone is well inside the budget");
  assert.equal(context.investigationInline, false,
    "embedded untracked bodies must count against the investigation budget");

  // Counterfactual: the same tracked diff with no untracked files IS fed, so the
  // routing flip above is attributable to the untracked bytes and nothing else.
  for (let index = 0; index < 40; index += 1) {
    fs.rmSync(path.join(cwd, `note-${index}.txt`));
  }
  const withoutUntracked = collectReviewContext(cwd, target, options);
  assert.equal(withoutUntracked.investigationInline, true);
});

test("untracked bytes exactly at the investigation budget are still fed", () => {
  // Inclusive (`<=`) semantics, matching the diff-only boundary tests: the sum
  // landing exactly on the budget must stay on the fed path.
  const cwd = makeTempDir();
  seedUntrackedBulk(cwd, 3, 4096);
  const untrackedBytes = 3 * 4096;

  const target = resolveReviewTarget(cwd, {});
  // The default 1 MiB budget dwarfs this diff, so probe.diffBytes is the real
  // measured size rather than the over-budget sentinel.
  const probe = collectReviewContext(cwd, target);

  const atBudget = collectReviewContext(cwd, target, {
    investigationInlineMaxBytes: probe.diffBytes + untrackedBytes
  });
  assert.equal(atBudget.diffBytes, probe.diffBytes, "budget must be pinned to the real measured diff size");
  assert.equal(atBudget.investigationInline, true, "exactly at the budget is within budget");
  assert.match(atBudget.content, /BODY_MARKER_0_/);

  const overBudget = collectReviewContext(cwd, target, {
    investigationInlineMaxBytes: probe.diffBytes + untrackedBytes - 1
  });
  assert.equal(overBudget.investigationInline, false, "one byte over the total must stop feeding the diff");
});

test("the blind working-tree summary caps aggregate untracked content", () => {
  // The blind path embeds untracked bodies too (they are invisible to the git
  // commands the model would run), so without an aggregate cap the same
  // unbounded payload rides the fallback and the budget is bypassed anyway.
  const cwd = makeTempDir();
  seedUntrackedBulk(cwd, 20, 8 * 1024);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, {
    // Pins the review to the blind path without relying on diff size.
    investigationInlineMaxBytes: 10,
    untrackedInlineMaxBytes: 16 * 1024
  });

  assert.equal(context.investigationInline, false);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /BODY_MARKER_0_/, "content up to the cap is still embedded");
  assert.doesNotMatch(context.content, /BODY_MARKER_19_/, "bodies past the cap must not be embedded");
  assert.match(context.content, /omitted: 18 more untracked files, \d+ bytes/);
  // The names still appear in `## Git Status`, so the model knows what exists.
  assert.match(context.content, /note-19\.txt/);
  assert.ok(Buffer.byteLength(context.content, "utf8") < 64 * 1024,
    `capped blind context must stay small, got ${Buffer.byteLength(context.content, "utf8")} bytes`);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /omitted/i);
});

test("untracked bytes count against the single-shot inline cap too", () => {
  // Only reachable with a raised file cap: at the default cap of 1 a tracked
  // edit and an untracked file cannot both be present, so diffBytes is 0
  // whenever untracked content is embedded. The gate must still be total-aware
  // because the single-shot prompt forbids shell — whatever the caps let
  // through is all the evidence the reviewer will ever get.
  const cwd = makeTempDir();
  seedUntrackedBulk(cwd, 2, 4096);
  const untrackedBytes = 2 * 4096;

  const target = resolveReviewTarget(cwd, {});
  const probe = collectReviewContext(cwd, target, { maxInlineFiles: 5 });
  assert.equal(probe.inputMode, "inline-diff", "everything fits the default 256 KiB single-shot cap");

  const atCap = collectReviewContext(cwd, target, {
    maxInlineFiles: 5,
    maxInlineDiffBytes: probe.diffBytes + untrackedBytes
  });
  assert.equal(atCap.inputMode, "inline-diff", "exactly at the cap is within budget");

  const overCap = collectReviewContext(cwd, target, {
    maxInlineFiles: 5,
    maxInlineDiffBytes: probe.diffBytes + untrackedBytes - 1
  });
  assert.equal(overCap.inputMode, "self-collect",
    "untracked bodies must count against the single-shot byte cap");
});

test("a diff of exactly the single-shot byte cap still routes to inline-diff", () => {
  // Both budgets are inclusive (`<=`). Pin the cap to the diff's real measured
  // size: equal-to-cap must stay inline, so an off-by-one tightening to `<`
  // shows up here rather than silently pushing borderline reviews off the cheap
  // single-turn path.
  const cwd = makeTempDir();
  seedSingleFileBranchDiff(cwd);

  const target = resolveReviewTarget(cwd, { base: "main" });
  const diffBytes = measureBranchDiffBytes(cwd, "main");
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: diffBytes });

  assert.equal(context.fileCount, 1);
  assert.equal(context.diffBytes, diffBytes, "cap must be pinned to the real measured diff size");
  assert.equal(context.inputMode, "inline-diff", "exactly at the cap is within budget");
});

test("one byte over the single-shot cap flips to self-collect", () => {
  const cwd = makeTempDir();
  seedSingleFileBranchDiff(cwd);

  const target = resolveReviewTarget(cwd, { base: "main" });
  const diffBytes = measureBranchDiffBytes(cwd, "main");
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: diffBytes - 1 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.diffBytes, diffBytes);
  assert.equal(context.inputMode, "self-collect", "one byte over the cap must leave the inline path");
  // Still well under the (much larger) default investigation budget, so the diff
  // is fed to the multi-turn prompt rather than dropped.
  assert.equal(context.investigationInline, true);
});

test("a diff of exactly the investigation budget is still fed inline", () => {
  // maxInlineDiffBytes: 0 forces the single-shot path to lose, isolating the
  // investigation budget as the only decision under test.
  const cwd = makeTempDir();
  seedSingleFileBranchDiff(cwd);

  const target = resolveReviewTarget(cwd, { base: "main" });
  const diffBytes = measureBranchDiffBytes(cwd, "main");
  const context = collectReviewContext(cwd, target, {
    maxInlineDiffBytes: 0,
    investigationInlineMaxBytes: diffBytes
  });

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.diffBytes, diffBytes, "budget must be pinned to the real measured diff size");
  assert.equal(context.investigationInline, true, "exactly at the budget is within budget");
  assert.match(context.content, /## Branch Diff/);
  assert.match(context.content, /diff --git/);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
});

test("one byte over the investigation budget falls back to a blind summary", () => {
  const cwd = makeTempDir();
  seedSingleFileBranchDiff(cwd);

  const target = resolveReviewTarget(cwd, { base: "main" });
  const diffBytes = measureBranchDiffBytes(cwd, "main");
  const context = collectReviewContext(cwd, target, {
    maxInlineDiffBytes: 0,
    investigationInlineMaxBytes: diffBytes - 1
  });

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.diffBytes, diffBytes);
  assert.equal(context.investigationInline, false, "one byte over the budget must stop feeding the diff");
  assert.match(context.content, /## Changed Files/);
  assert.doesNotMatch(context.content, /diff --git/);
  assert.match(context.collectionGuidance, /lightweight summary/i);
});
