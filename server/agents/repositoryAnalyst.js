/**
 * Repository Analyst Agent — Member 1's component.
 *
 * This agent is the first node in the Code Archaeologist LangGraph
 * workflow. It receives a repository path and a bug report, scans
 * the repository for structure and code metadata, then uses an LLM
 * to identify the files, functions, classes, tests, and dependencies
 * most relevant to the reported bug.
 *
 * Usage as a standalone script:
 *
 *   GOOGLE_API_KEY=<key> node server/agents/repositoryAnalyst.js \
 *     --repo /path/to/repo \
 *     --bug "Customers purchasing exactly 10 items are not receiving the bulk discount."
 *
 * Usage as a LangGraph node:
 *
 *   import { repositoryAnalystNode } from "./agents/repositoryAnalyst.js";
 *   graph.addNode("repository_analyst", repositoryAnalystNode);
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  buildRepositorySummary,
  readFiles,
} from "../tools/repositoryTools.js";
import {
  getSystemPrompt,
  getUserPrompt,
} from "../prompts/repositoryPrompt.js";

// ── Configuration ───────────────────────────────────────────

const LLM_MODEL = process.env.ANALYST_MODEL || "gemini-3.8-flash";
const LLM_TEMPERATURE = 0.2;

// ── Core analysis function ──────────────────────────────────

/**
 * Run the Repository Analyst on a given repository and bug report.
 *
 * Steps:
 *   1. Scan the repository — collect file list, function signatures,
 *      imports, and class declarations (no full source sent).
 *   2. Send the structural summary + bug report to the LLM.
 *   3. Parse the LLM's JSON response into a structured analysis.
 *
 * @param {string} repositoryPath — absolute path to the target repo
 * @param {string} bugReport — free-text description of the bug
 * @returns {Promise<object>} — the repository_analysis object
 */
export async function analyzeRepository(repositoryPath, bugReport) {
  // Step 1 — Collect repository metadata
  console.log("[Repository Analyst] Scanning repository...");
  const repoSummary = await buildRepositorySummary(repositoryPath);
  console.log(
    `[Repository Analyst] Found ${repoSummary.length} source files.`
  );

  if (repoSummary.length === 0) {
    return {
      relevant_files: [],
      relevant_functions: [],
      relevant_classes: [],
      relevant_tests: [],
      dependencies: [],
      repository_summary: "No source files found in the repository.",
    };
  }

  // Step 2 — Ask the LLM to identify relevant code
  console.log("[Repository Analyst] Analyzing with LLM...");
  const llm = new ChatGoogleGenerativeAI({
    model: LLM_MODEL,
    temperature: LLM_TEMPERATURE,
  });

  const response = await llm.invoke([
    { role: "system", content: getSystemPrompt() },
    { role: "user", content: getUserPrompt(repoSummary, bugReport) },
  ]);

  // Step 3 — Parse the response
  const analysis = parseAnalysisResponse(response.content);

  // Attach the raw file contents for relevant files so the Diagnosis Agent
  // has the actual code to reason about (not just signatures).
  const relevantPaths = [
    ...analysis.relevant_files.map((f) => f.path),
    ...analysis.relevant_tests.map((f) => f.path),
  ];
  const uniquePaths = [...new Set(relevantPaths)];
  const fileContents = await readFiles(repositoryPath, uniquePaths);
  analysis.file_contents = fileContents;

  console.log("[Repository Analyst] Analysis complete.");
  return analysis;
}

// ── LangGraph node wrapper ──────────────────────────────────

/**
 * LangGraph-compatible node function.
 *
 * Reads `repository_path` and `bug_report` from state,
 * writes `repository_analysis` back to state.
 *
 * @param {object} state — CodeArchaeologistState
 * @returns {Promise<object>} — partial state update
 */
export async function repositoryAnalystNode(state) {
  try {
    const analysis = await analyzeRepository(
      state.repository_path,
      state.bug_report
    );
    return { repository_analysis: analysis };
  } catch (err) {
    console.error("[Repository Analyst] Error:", err.message);
    return {
      repository_analysis: null,
      error: `Repository Analyst failed: ${err.message}`,
    };
  }
}

// ── Response parsing ────────────────────────────────────────

/**
 * Extract and validate the JSON analysis from the LLM response.
 * Handles common issues like markdown code fences around JSON.
 *
 * @param {string} raw — raw LLM response text
 * @returns {object}
 */
function parseAnalysisResponse(raw) {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  const defaultResult = {
    relevant_files: [],
    relevant_functions: [],
    relevant_classes: [],
    relevant_tests: [],
    dependencies: [],
    repository_summary: "",
  };

  try {
    const parsed = JSON.parse(cleaned);

    // Validate / normalise each expected field
    return {
      relevant_files: Array.isArray(parsed.relevant_files)
        ? parsed.relevant_files
        : [],
      relevant_functions: Array.isArray(parsed.relevant_functions)
        ? parsed.relevant_functions
        : [],
      relevant_classes: Array.isArray(parsed.relevant_classes)
        ? parsed.relevant_classes
        : [],
      relevant_tests: Array.isArray(parsed.relevant_tests)
        ? parsed.relevant_tests
        : [],
      dependencies: Array.isArray(parsed.dependencies)
        ? parsed.dependencies
        : [],
      repository_summary:
        typeof parsed.repository_summary === "string"
          ? parsed.repository_summary
          : "",
    };
  } catch (e) {
    console.error(
      "[Repository Analyst] Failed to parse LLM response as JSON:",
      e.message
    );
    console.error("[Repository Analyst] Raw response:", raw);
    return defaultResult;
  }
}

// ── CLI entry point ─────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const repoIdx = args.indexOf("--repo");
  const bugIdx = args.indexOf("--bug");

  if (repoIdx === -1 || bugIdx === -1) {
    console.error(
      "Usage: node server/agents/repositoryAnalyst.js --repo <path> --bug <description>"
    );
    process.exit(1);
  }

  const repoPath = args[repoIdx + 1];
  const bugReport = args[bugIdx + 1];

  if (!repoPath || !bugReport) {
    console.error("Both --repo and --bug must have values.");
    process.exit(1);
  }

  const analysis = await analyzeRepository(repoPath, bugReport);
  // Print the analysis without file_contents (too verbose for terminal)
  const { file_contents, ...printable } = analysis;
  console.log("\n=== REPOSITORY ANALYSIS ===");
  console.log(JSON.stringify(printable, null, 2));
  console.log(
    `\n[Attached ${Object.keys(file_contents || {}).length} file(s) content for Diagnosis Agent]`
  );
}

// Run if executed directly
const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
