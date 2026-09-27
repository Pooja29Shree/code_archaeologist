/**
 * Repository Tools — filesystem scanning and code extraction utilities.
 *
 * These tools collect repository metadata WITHOUT sending entire files
 * to the LLM. They gather structure, function signatures, imports,
 * and test files so the LLM can reason about relevance.
 */

import fs from "fs/promises";
import path from "path";

// ── Configuration ───────────────────────────────────────────

/** Directories to always skip when scanning. */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv",
  "dist", "build", ".next", ".cache", ".tox", ".mypy_cache",
  ".pytest_cache", "coverage", ".nyc_output", "egg-info",
]);

/** Extensions we can meaningfully read as source code. */
const SOURCE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".pyw",
  ".java", ".kt", ".scala",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".go",
  ".rb",
  ".rs",
  ".php",
  ".cs",
  ".swift",
  ".sh", ".bash",
]);

/** Extensions that look like test files (by name pattern). */
const TEST_PATTERNS = [
  /test_/i, /_test\./i, /\.test\./i, /\.spec\./i,
  /tests\//i, /__tests__\//i,
];

/** Max bytes to read from a single file for extraction. */
const MAX_FILE_BYTES = 64 * 1024; // 64 KB

// ── Public API ──────────────────────────────────────────────

/**
 * Scan a repository and return its file tree (relative paths).
 * Skips ignored directories and binary files.
 *
 * @param {string} repoPath — absolute path to the repository root
 * @returns {Promise<string[]>} — sorted list of relative file paths
 */
export async function scanRepository(repoPath) {
  const files = [];
  await _walk(repoPath, repoPath, files);
  files.sort();
  return files;
}

/**
 * Determine whether a file path looks like a test file.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isTestFile(filePath) {
  return TEST_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Determine whether a file path is a recognised source file.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Read a source file safely (returns null for unreadable / too-large files).
 *
 * @param {string} absolutePath
 * @returns {Promise<string|null>}
 */
export async function readFileSafe(absolutePath) {
  try {
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_BYTES) return null;
    const content = await fs.readFile(absolutePath, "utf-8");
    // Quick binary check: if there are control chars (except common ones), skip.
    if (/[\x00-\x08\x0E-\x1F]/.test(content)) return null;
    return content;
  } catch {
    return null;
  }
}

/**
 * Extract lightweight metadata from a source file:
 *   - import/require statements
 *   - function/method signatures
 *   - class declarations
 *
 * This is intentionally simple regex-based extraction — not a full AST.
 * It works well enough for Python and JS/TS, which are the primary
 * languages in the project spec.
 *
 * @param {string} content — file content
 * @param {string} filePath — for language detection
 * @returns {{ imports: string[], functions: string[], classes: string[] }}
 */
export function extractCodeMetadata(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const lines = content.split("\n");

  const imports = [];
  const functions = [];
  const classes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // ── Imports ───────────────────────────────────────────
    if (/^\s*(import |from .+ import )/.test(line)) {
      imports.push(line.trim());
    } else if (/^\s*(const|let|var)\s+.+=\s*require\(/.test(line)) {
      imports.push(line.trim());
    } else if (/^\s*import\s+/.test(line)) {
      imports.push(line.trim());
    }

    // ── Functions ─────────────────────────────────────────
    if (ext === ".py" || ext === ".pyw") {
      const pyFunc = line.match(/^(\s*)def\s+(\w+)\s*\(([^)]*)\)/);
      if (pyFunc) {
        functions.push({
          name: pyFunc[2],
          signature: pyFunc[0].trim(),
          line: lineNum,
        });
      }
    } else {
      // JS/TS style
      const jsFunc = line.match(
        /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/
      );
      if (jsFunc) {
        functions.push({
          name: jsFunc[1],
          signature: line.trim().replace(/\{.*$/, "").trim(),
          line: lineNum,
        });
      }
      // Arrow / method shorthand
      const arrow = line.match(
        /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/
      );
      if (arrow) {
        functions.push({
          name: arrow[1],
          signature: line.trim().replace(/\{.*$/, "").trim(),
          line: lineNum,
        });
      }
    }

    // ── Classes ───────────────────────────────────────────
    const cls = line.match(/^\s*(?:export\s+)?class\s+(\w+)/);
    if (cls) {
      classes.push({ name: cls[1], line: lineNum });
    }
  }

  return { imports, functions, classes };
}

/**
 * Build a structured summary of the entire repository.
 *
 * Returns one object per source file containing path, size, metadata,
 * and whether it looks like a test file.
 *
 * @param {string} repoPath
 * @returns {Promise<object[]>}
 */
export async function buildRepositorySummary(repoPath) {
  const relativePaths = await scanRepository(repoPath);
  const summaries = [];

  for (const relPath of relativePaths) {
    if (!isSourceFile(relPath)) continue;

    const absPath = path.join(repoPath, relPath);
    const content = await readFileSafe(absPath);
    if (content === null) continue;

    const meta = extractCodeMetadata(content, relPath);
    summaries.push({
      path: relPath,
      is_test: isTestFile(relPath),
      line_count: content.split("\n").length,
      imports: meta.imports,
      functions: meta.functions,
      classes: meta.classes,
    });
  }

  return summaries;
}

/**
 * Read specified files and return their contents (keyed by relative path).
 * Skips files that are unreadable.
 *
 * @param {string} repoPath
 * @param {string[]} relativePaths
 * @returns {Promise<Record<string, string>>}
 */
export async function readFiles(repoPath, relativePaths) {
  const results = {};
  for (const relPath of relativePaths) {
    const absPath = path.join(repoPath, relPath);
    const content = await readFileSafe(absPath);
    if (content !== null) {
      results[relPath] = content;
    }
  }
  return results;
}

// ── Internal helpers ────────────────────────────────────────

async function _walk(base, current, files) {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return; // permission denied, symlink loops, etc.
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue; // skip hidden files/dirs

    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await _walk(base, fullPath, files);
    } else if (entry.isFile()) {
      files.push(path.relative(base, fullPath));
    }
  }
}
