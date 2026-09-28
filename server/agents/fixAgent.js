/**
 * Fix Agent — Member 3 component.
 *
 * Converts a root-cause diagnosis and bug report into the smallest safe
 * code repair (patch), explanation, and modified file list.
 *
 * Does not mutate the repository on generation. Use applyPatch() to apply.
 */

import fs from "node:fs/promises";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  getSystemPrompt,
  getUserPrompt,
} from "../prompts/fixPrompt.js";
import {
  generateDiff,
  isTestPath,
  normalizePath,
  resolveRepoPath,
} from "../tools/patchTools.js";

const LLM_MODEL = process.env.FIX_MODEL || process.env.DIAGNOSIS_MODEL || "gemini-3.8-flash";
const LLM_TEMPERATURE = 0.1;

/**
 * Generate a minimal safe code repair patch from bug diagnosis.
 *
 * @param {string} repoPath — absolute path to target repository
 * @param {string} bugReport — bug description
 * @param {object} diagnosis — root cause diagnosis from Member 2
 * @param {object} options — optional configuration ({ llm, model })
 * @returns {Promise<object>} — patch object
 */
export async function generateFix(repoPath, bugReport, diagnosis, options = {}) {
  // 1. Validate inputs
  if (!repoPath || typeof repoPath !== "string") {
    throw new Error("repository_path is required");
  }
  if (!bugReport || typeof bugReport !== "string") {
    throw new Error("bug_report is required");
  }
  if (!diagnosis || typeof diagnosis !== "object") {
    throw new Error("diagnosis is required");
  }

  // 2. Validate diagnosis fields
  const { suspectedFile, rootCause, expectedBehavior, actualBehavior } = diagnosis;
  if (!suspectedFile || typeof suspectedFile !== "string") {
    throw new Error("diagnosis.suspectedFile is required");
  }
  if (!rootCause) {
    throw new Error("diagnosis.rootCause is required");
  }
  if (!expectedBehavior) {
    throw new Error("diagnosis.expectedBehavior is required");
  }
  if (!actualBehavior) {
    throw new Error("diagnosis.actualBehavior is required");
  }

  // 3. Ensure suspected file is not a test
  if (isTestPath(suspectedFile)) {
    throw new Error(`Refusing to target test file for repair: ${suspectedFile}`);
  }

  // 4. Resolve file safely inside repoPath and read content
  const absFilePath = resolveRepoPath(repoPath, suspectedFile);
  let originalFileContent;
  try {
    originalFileContent = await fs.readFile(absFilePath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read target source file "${suspectedFile}": ${err.message}`);
  }

  // 5. Build prompt
  const systemPrompt = getSystemPrompt();
  const userPrompt = getUserPrompt(bugReport, diagnosis, {
    [suspectedFile]: originalFileContent,
  });

  // 6. Invoke LLM (or injected mock)
  const llm = options.llm || new ChatGoogleGenerativeAI({
    model: options.model || LLM_MODEL,
    temperature: LLM_TEMPERATURE,
  });

  const response = await llm.invoke([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  // 7. Parse response
  const rawContent = response?.content !== undefined ? response.content : response;
  const parsed = parseFixResponse(rawContent);

  // 8. Validate parsed fix structure
  if (!Array.isArray(parsed.modifiedFiles) || parsed.modifiedFiles.length === 0) {
    throw new Error("Fix response missing valid modifiedFiles array");
  }
  if (!Array.isArray(parsed.changes) || parsed.changes.length === 0) {
    throw new Error("Fix response missing valid changes array");
  }

  const normSuspected = normalizePath(suspectedFile);
  const diffs = [];
  const originalFileContents = {};

  // 9. Validate each change entry
  for (const change of parsed.changes) {
    const { file, originalCode, fixedCode, reason } = change;
    if (!file || typeof file !== "string") {
      throw new Error("Each change must specify a file path");
    }
    if (typeof originalCode !== "string" || !originalCode) {
      throw new Error(`Change for ${file} missing originalCode`);
    }
    if (typeof fixedCode !== "string") {
      throw new Error(`Change for ${file} missing fixedCode`);
    }

    const normFile = normalizePath(file);

    // Rule: Never modify tests
    if (isTestPath(normFile)) {
      throw new Error(`Fix response attempted to modify test file: ${normFile}`);
    }

    // Rule: Must only modify relevant files (must match diagnosis suspectedFile)
    if (normFile !== normSuspected) {
      throw new Error(
        `Fix response attempted to modify unapproved file: "${normFile}" (expected: "${normSuspected}")`
      );
    }

    // Rule: Verify originalCode exists in actual file
    const fileNormalized = originalFileContent.replace(/\r\n/g, "\n");
    const origNormalized = originalCode.replace(/\r\n/g, "\n");

    if (!fileNormalized.includes(origNormalized)) {
      throw new Error(
        `Original code snippet to replace was not found in ${normFile}. Fix cannot be safely applied.`
      );
    }

    // Generate modified content in-memory to build diff
    const fixedNormalized = fixedCode.replace(/\r\n/g, "\n");
    const modifiedContent = fileNormalized.replace(origNormalized, fixedNormalized);

    const fileDiff = generateDiff(originalFileContent, modifiedContent, normFile);
    if (fileDiff) {
      diffs.push(fileDiff);
    }

    originalFileContents[normFile] = originalFileContent;
  }

  return {
    explanation: parsed.explanation || "",
    modifiedFiles: parsed.modifiedFiles.map(normalizePath),
    diff: diffs.join("\n"),
    changes: parsed.changes,
    originalCode: parsed.changes.map((c) => ({ file: c.file, code: c.originalCode })),
    fixedCode: parsed.changes.map((c) => ({ file: c.file, code: c.fixedCode })),
    originalFileContents,
    status: "PROPOSED",
  };
}

/**
 * Robustly parse the raw LLM response into structured JSON.
 *
 * @param {any} raw
 * @returns {object}
 */
export function parseFixResponse(raw) {
  const text = extractResponseText(raw).trim();
  if (!text) {
    throw new Error("Empty response from Fix Agent LLM");
  }

  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Fix Agent response was not valid JSON: ${err.message}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Fix Agent response must be a JSON object");
  }

  return {
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
    modifiedFiles: Array.isArray(parsed.modifiedFiles) ? parsed.modifiedFiles : [],
    changes: Array.isArray(parsed.changes) ? parsed.changes : [],
  };
}

/**
 * LangGraph-compatible node wrapper for Fix Agent.
 *
 * Consumes:
 * - state.repository_path
 * - state.bug_report
 * - state.diagnosis
 *
 * Produces:
 * - { patch, error: null } on success
 * - { patch: null, error } on failure
 *
 * @param {object} state
 * @returns {Promise<object>} partial state update
 */
export async function fixAgentNode(state) {
  try {
    if (!state.repository_path) {
      throw new Error("state.repository_path is missing");
    }
    if (!state.bug_report) {
      throw new Error("state.bug_report is missing");
    }
    if (!state.diagnosis) {
      throw new Error("state.diagnosis is missing");
    }

    const patch = await generateFix(
      state.repository_path,
      state.bug_report,
      state.diagnosis
    );

    return { patch, error: null };
  } catch (err) {
    console.error("[Fix Agent] Error:", err.message);
    return {
      patch: null,
      error: `Fix Agent failed: ${err.message}`,
    };
  }
}

function extractResponseText(raw) {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    if (typeof raw.text === "string") return raw.text;
    if (typeof raw.content === "string") return raw.content;
    if (Array.isArray(raw.content)) {
      return raw.content
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .join("");
    }
  }
  return String(raw || "");
}

// ── Standalone CLI runner ───────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const repoIdx = args.indexOf("--repo");
  const bugIdx = args.indexOf("--bug");
  const fileIdx = args.indexOf("--file");

  if (repoIdx === -1 || bugIdx === -1) {
    console.error(
      "Usage: node server/agents/fixAgent.js --repo <path> --bug <description> [--file <suspectedFile>]"
    );
    process.exit(1);
  }

  const repoPath = args[repoIdx + 1];
  const bugReport = args[bugIdx + 1];
  const suspectedFile = fileIdx !== -1 ? args[fileIdx + 1] : "src/pricing/discount.py";

  const diagnosis = {
    suspectedFile,
    suspectedFunction: "calculate_discount",
    suspectedLocation: "if quantity > 10",
    rootCause: "Boundary condition excludes 10",
    expectedBehavior: "10 or more items receive 20% discount",
    actualBehavior: "10 items receive 10% discount",
    evidence: [],
    confidence: 0.95,
  };

  const patch = await generateFix(repoPath, bugReport, diagnosis);
  console.log("\n=== PROPOSED PATCH ===");
  console.log(JSON.stringify(patch, null, 2));
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
