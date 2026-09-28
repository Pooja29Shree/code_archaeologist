/**
 * Patch Tools — utilities for diff generation, patch application, and reversion.
 *
 * Member 3 component. Uses only Node.js built-ins.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TEST_PATTERNS = [
  /test_/i,
  /_test\./i,
  /\.test\./i,
  /\.spec\./i,
  /(?:^|[\\/])tests?(?:[\\/]|$)/i,
  /(?:^|[\\/])__tests__?(?:[\\/]|$)/i,
];

/**
 * Check whether a file path points to a test file or directory.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isTestPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  return TEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Safely resolve a relative file path within a repository root.
 * Throws an error if the path traverses outside the repository.
 *
 * @param {string} repoPath — absolute path to repository root
 * @param {string} relativePath — relative path to target file
 * @returns {string} — resolved absolute path
 */
export function resolveRepoPath(repoPath, relativePath) {
  if (!repoPath || typeof repoPath !== "string") {
    throw new Error("Invalid repository path");
  }
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("Invalid relative file path");
  }

  const root = path.resolve(repoPath);
  const target = path.resolve(root, relativePath);
  const rel = path.relative(root, target);

  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path traversal detected: "${relativePath}" escapes repository root`);
  }

  return target;
}

/**
 * Normalize file path to POSIX forward-slash format for diffs.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function normalizePath(filePath) {
  return filePath.split(path.sep).join("/").replace(/^\.\//, "");
}

/**
 * Generate a unified diff string between original and modified content.
 *
 * @param {string} originalContent
 * @param {string} modifiedContent
 * @param {string} filePath — relative path to file
 * @returns {string} — unified diff formatted string
 */
export function generateDiff(originalContent, modifiedContent, filePath) {
  const normPath = normalizePath(filePath || "file");
  const origNorm = (originalContent || "").replace(/\r\n/g, "\n");
  const modNorm = (modifiedContent || "").replace(/\r\n/g, "\n");

  if (origNorm === modNorm) {
    return "";
  }

  const origLines = origNorm.length > 0 ? origNorm.split("\n") : [];
  const modLines = modNorm.length > 0 ? modNorm.split("\n") : [];

  // Compute LCS edit script
  const edits = computeLineEdits(origLines, modLines);

  // Group edits into hunks with context
  const hunks = buildHunks(edits, 3);
  if (hunks.length === 0) {
    return "";
  }

  const header = `--- a/${normPath}\n+++ b/${normPath}`;
  const hunkTexts = hunks.map((hunk) => formatHunk(hunk));

  return `${header}\n${hunkTexts.join("\n")}\n`;
}

/**
 * Apply a proposed patch to files within the repository.
 *
 * @param {string} repoPath — absolute repository path
 * @param {object} patch — patch object containing changes or modifiedFiles
 * @returns {Promise<{ success: boolean, modifiedFiles: string[], error?: string }>}
 */
export async function applyPatch(repoPath, patch) {
  if (!repoPath) {
    return { success: false, modifiedFiles: [], error: "Repository path is required" };
  }
  if (!patch) {
    return { success: false, modifiedFiles: [], error: "Patch object is required" };
  }

  const changes = Array.isArray(patch.changes)
    ? patch.changes
    : patch.file && patch.originalCode && patch.fixedCode
    ? [patch]
    : [];

  if (changes.length === 0) {
    return { success: false, modifiedFiles: [], error: "No valid changes specified in patch" };
  }

  // Pre-validate all changes before applying any modification
  for (const change of changes) {
    const relFile = change.file;
    if (!relFile) {
      return { success: false, modifiedFiles: [], error: "Change entry missing file path" };
    }

    if (isTestPath(relFile)) {
      return {
        success: false,
        modifiedFiles: [],
        error: `Refusing to modify test file: ${relFile}`,
      };
    }

    let absPath;
    try {
      absPath = resolveRepoPath(repoPath, relFile);
    } catch (err) {
      return { success: false, modifiedFiles: [], error: err.message };
    }

    let fileContent;
    try {
      fileContent = await fs.readFile(absPath, "utf-8");
    } catch (err) {
      return {
        success: false,
        modifiedFiles: [],
        error: `Target file not found or unreadable: ${relFile}`,
      };
    }

    const normContent = fileContent.replace(/\r\n/g, "\n");
    const normOriginal = (change.originalCode || "").replace(/\r\n/g, "\n");

    if (!normOriginal) {
      return {
        success: false,
        modifiedFiles: [],
        error: `Change for ${relFile} has empty originalCode`,
      };
    }

    if (!normContent.includes(normOriginal)) {
      return {
        success: false,
        modifiedFiles: [],
        error: `Original code not found in ${relFile}. Patch cannot be safely applied.`,
      };
    }
  }

  // Apply changes to files
  const modifiedFiles = [];
  try {
    for (const change of changes) {
      const absPath = resolveRepoPath(repoPath, change.file);
      const fileContent = await fs.readFile(absPath, "utf-8");

      // Preserve existing line endings style
      const hasCrlf = fileContent.includes("\r\n");
      const normContent = fileContent.replace(/\r\n/g, "\n");
      const normOriginal = change.originalCode.replace(/\r\n/g, "\n");
      const normFixed = change.fixedCode.replace(/\r\n/g, "\n");

      let updated = normContent.replace(normOriginal, normFixed);
      if (hasCrlf) {
        updated = updated.replace(/\n/g, "\r\n");
      }

      await fs.writeFile(absPath, updated, "utf-8");
      modifiedFiles.push(normalizePath(change.file));
    }

    return { success: true, modifiedFiles };
  } catch (err) {
    return {
      success: false,
      modifiedFiles,
      error: `Failed to write patch changes: ${err.message}`,
    };
  }
}

/**
 * Revert a previously applied patch by restoring original content.
 * Safe to call from a finally block.
 *
 * @param {string} repoPath
 * @param {object} patch
 * @returns {Promise<{ success: boolean, revertedFiles: string[], error?: string }>}
 */
export async function revertPatch(repoPath, patch) {
  if (!repoPath || !patch) {
    return { success: false, revertedFiles: [], error: "Invalid parameters for revert" };
  }

  const changes = Array.isArray(patch.changes)
    ? patch.changes
    : patch.file && patch.originalCode && patch.fixedCode
    ? [patch]
    : [];

  if (changes.length === 0) {
    return { success: false, revertedFiles: [], error: "No changes found to revert" };
  }

  const revertedFiles = [];
  try {
    for (const change of changes) {
      if (!change.file) continue;
      let absPath;
      try {
        absPath = resolveRepoPath(repoPath, change.file);
      } catch {
        continue;
      }

      let content;
      try {
        content = await fs.readFile(absPath, "utf-8");
      } catch {
        continue;
      }

      const hasCrlf = content.includes("\r\n");
      const normContent = content.replace(/\r\n/g, "\n");
      const normFixed = (change.fixedCode || "").replace(/\r\n/g, "\n");
      const normOriginal = (change.originalCode || "").replace(/\r\n/g, "\n");

      let restored;
      if (normFixed && normContent.includes(normFixed)) {
        restored = normContent.replace(normFixed, normOriginal);
      } else if (!normContent.includes(normOriginal)) {
        // Fallback: If full original file is recorded, restore it
        if (patch.originalFileContents && patch.originalFileContents[change.file]) {
          restored = patch.originalFileContents[change.file];
        } else {
          continue;
        }
      } else {
        // File already has original code
        revertedFiles.push(normalizePath(change.file));
        continue;
      }

      if (hasCrlf) {
        restored = restored.replace(/\n/g, "\r\n");
      }

      await fs.writeFile(absPath, restored, "utf-8");
      revertedFiles.push(normalizePath(change.file));
    }

    return { success: true, revertedFiles };
  } catch (err) {
    return {
      success: false,
      revertedFiles,
      error: `Revert encountered error: ${err.message}`,
    };
  }
}

/**
 * Execute `git diff` inside the target repository.
 *
 * @param {string} repoPath
 * @returns {Promise<string>} — git diff output string or empty string on error
 */
export async function getGitDiff(repoPath) {
  if (!repoPath) return "";

  try {
    const { stdout } = await execFileAsync("git", ["diff"], {
      cwd: repoPath,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout || "";
  } catch (err) {
    // If not a git repository or git is unavailable, return empty string safely
    return "";
  }
}

// ── Internal diff algorithms (Node built-in LCS) ────────────

function computeLineEdits(origLines, modLines) {
  const m = origLines.length;
  const n = modLines.length;

  // Build DP table for LCS
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (origLines[i] === modLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Backtrack to produce edits
  const edits = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === modLines[j - 1]) {
      edits.push({ type: "common", text: origLines[i - 1], origLine: i, modLine: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.push({ type: "add", text: modLines[j - 1], origLine: i, modLine: j });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      edits.push({ type: "remove", text: origLines[i - 1], origLine: i, modLine: j });
      i--;
    }
  }

  edits.reverse();
  return edits;
}

function buildHunks(edits, contextLines = 3) {
  const hunks = [];
  let currentHunk = null;

  for (let idx = 0; idx < edits.length; idx++) {
    const edit = edits[idx];
    if (edit.type !== "common") {
      const startIdx = Math.max(0, idx - contextLines);
      const endIdx = Math.min(edits.length - 1, idx + contextLines);

      if (!currentHunk) {
        currentHunk = { startIdx, endIdx, edits: [] };
      } else if (startIdx <= currentHunk.endIdx + 1) {
        currentHunk.endIdx = Math.max(currentHunk.endIdx, endIdx);
      } else {
        hunks.push(currentHunk);
        currentHunk = { startIdx, endIdx, edits: [] };
      }
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks.map((hunk) => {
    const slice = edits.slice(hunk.startIdx, hunk.endIdx + 1);
    let origStart = 0;
    let origCount = 0;
    let modStart = 0;
    let modCount = 0;

    for (const e of slice) {
      if (e.type === "common") {
        if (!origStart) origStart = e.origLine;
        if (!modStart) modStart = e.modLine;
        origCount++;
        modCount++;
      } else if (e.type === "remove") {
        if (!origStart) origStart = e.origLine;
        origCount++;
      } else if (e.type === "add") {
        if (!modStart) modStart = e.modLine;
        modCount++;
      }
    }

    return {
      origStart: origStart || 1,
      origCount,
      modStart: modStart || 1,
      modCount,
      lines: slice.map((e) => {
        if (e.type === "add") return `+${e.text}`;
        if (e.type === "remove") return `-${e.text}`;
        return ` ${e.text}`;
      }),
    };
  });
}

function formatHunk(hunk) {
  const header = `@@ -${hunk.origStart},${hunk.origCount} +${hunk.modStart},${hunk.modCount} @@`;
  return `${header}\n${hunk.lines.join("\n")}`;
}
