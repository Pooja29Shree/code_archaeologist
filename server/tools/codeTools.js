import fs from "fs/promises";
import path from "path";
import {
  isSourceFile,
  readFileSafe,
  scanRepository,
} from "./repositoryTools.js";

const FUNCTION_PATTERN = /(?:^|\s)(?:async\s+)?(?:function\s+([\w$]+)|def\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\()/;
const CLASS_PATTERN = /(?:^|\s)(?:export\s+)?class\s+([\w$]+)/;

function repositoryFile(repositoryPath, relativePath) {
  const root = path.resolve(repositoryPath);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the repository: ${relativePath}`);
  }

  return target;
}

function lineResult(relativePath, lineNumber, text) {
  return { file: relativePath, line: lineNumber, text: text.trim() };
}

/** Search source files for a literal string or regular expression. */
export async function searchCode(repositoryPath, query, options = {}) {
  if (!query || typeof query !== "string") return [];

  const files = options.files || await scanRepository(repositoryPath);
  const matcher = options.regex
    ? new RegExp(query, options.flags || "i")
    : null;
  const results = [];

  for (const relativePath of files) {
    if (!isSourceFile(relativePath)) continue;
    const content = await readFileSafe(repositoryFile(repositoryPath, relativePath));
    if (content === null) continue;

    content.split("\n").forEach((text, index) => {
      const matches = matcher ? matcher.test(text) : text.toLowerCase().includes(query.toLowerCase());
      if (matches) results.push(lineResult(relativePath, index + 1, text));
      if (matcher) matcher.lastIndex = 0;
    });
  }

  return results;
}

/** Find function and class declarations in source files. */
export async function findFunction(repositoryPath, name) {
  if (!name || typeof name !== "string") return [];

  const matches = [];
  const files = await scanRepository(repositoryPath);
  for (const relativePath of files) {
    if (!isSourceFile(relativePath)) continue;
    const content = await readFileSafe(repositoryFile(repositoryPath, relativePath));
    if (content === null) continue;

    content.split("\n").forEach((text, index) => {
      const functionMatch = text.match(FUNCTION_PATTERN);
      const classMatch = text.match(CLASS_PATTERN);
      const declarationName = functionMatch?.[1] || functionMatch?.[2] || functionMatch?.[3] || classMatch?.[1];
      if (declarationName === name) {
        matches.push(lineResult(relativePath, index + 1, text));
      }
    });
  }

  return matches;
}

/** Find references to a symbol, excluding its declaration when possible. */
export async function findReferences(repositoryPath, symbol) {
  const results = await searchCode(repositoryPath, symbol, { regex: false });
  return results.filter((result) => !new RegExp(`(?:function|def|class)\\s+${escapeRegExp(symbol)}\\b`).test(result.text));
}

/** Read one function-sized region around a known declaration. */
export async function readFunction(repositoryPath, relativePath, functionName) {
  const absolutePath = repositoryFile(repositoryPath, relativePath);
  const content = await readFileSafe(absolutePath);
  if (content === null) return null;

  const lines = content.split("\n");
  const declaration = lines.findIndex((line) => {
    const match = line.match(FUNCTION_PATTERN);
    return (match?.[1] || match?.[2] || match?.[3]) === functionName;
  });
  if (declaration === -1) return null;

  const baseIndent = lines[declaration].match(/^\s*/)[0].length;
  let end = declaration + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && line.match(/^\s*/)[0].length <= baseIndent) break;
    end += 1;
  }

  return {
    file: relativePath,
    function: functionName,
    startLine: declaration + 1,
    endLine: end,
    content: lines.slice(declaration, end).join("\n"),
  };
}

/** Load files selected by Member 1, without allowing paths outside the repo. */
export async function readRelevantFiles(repositoryPath, repositoryAnalysis = {}) {
  const selected = [
    ...(repositoryAnalysis.relevant_files || []).map((item) => item.path || item),
    ...(repositoryAnalysis.relevant_tests || []).map((item) => item.path || item),
  ];
  const uniquePaths = [...new Set(selected)].filter(Boolean);
  const contents = {};

  for (const relativePath of uniquePaths) {
    const content = await readFileSafe(repositoryFile(repositoryPath, relativePath));
    if (content !== null) contents[relativePath] = content;
  }

  return contents;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { repositoryFile };
