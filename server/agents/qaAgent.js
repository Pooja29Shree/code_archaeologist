/**
 * QA Agent — Member 4 component.
 *
 * Validates the code repair produced by Fix Agent (Member 3).
 * Safely applies the proposed patch, runs regression and targeted tests,
 * analyzes failures/regressions, and guarantees repository state is restored.
 */

import {
  applyPatchAndTest,
  runTests,
  runTargetedTests,
  safeRevert,
} from "../tools/testTools.js";
import {
  getSystemPrompt,
  getUserPrompt,
} from "../prompts/qaPrompt.js";

// Optional/resilient LangChain import for offline test compatibility
let ChatGoogleGenerativeAI;
try {
  const mod = await import("@langchain/google-genai");
  ChatGoogleGenerativeAI = mod.ChatGoogleGenerativeAI;
} catch {
  // Will be injected via options.llm in test environments
}

const LLM_MODEL = process.env.QA_MODEL || process.env.FIX_MODEL || "gemini-3.8-flash";
const LLM_TEMPERATURE = 0.1;

/**
 * Execute the complete QA workflow on a target repository and proposed patch.
 *
 * @param {string} repoPath — absolute path to repository under test
 * @param {string} bugReport — bug description
 * @param {object} diagnosis — root-cause diagnosis from Member 2
 * @param {object} patch — proposed patch object from Member 3
 * @param {object} options — optional custom runner, LLM, or targeted config
 * @returns {Promise<object>} — structured QA result
 */
export async function runQA(repoPath, bugReport, diagnosis, patch, options = {}) {
  // 1. Validate required inputs
  if (!repoPath || typeof repoPath !== "string") {
    throw new Error("repository_path is required");
  }
  if (!bugReport || typeof bugReport !== "string") {
    throw new Error("bug_report is required");
  }
  if (!diagnosis || typeof diagnosis !== "object") {
    throw new Error("diagnosis is required");
  }
  if (!patch || typeof patch !== "object") {
    throw new Error("patch is required");
  }

  // 2. Safely apply patch and execute tests (patch is automatically reverted in finally)
  const testExecution = await applyPatchAndTest(repoPath, patch, {
    ...options,
    diagnosis,
  });

  // 3. Handle immediate patch application failure
  if (!testExecution.applied) {
    return {
      status: "FAIL",
      summary: `Patch application failed: ${testExecution.error || "Unknown error"}`,
      originalBugVerified: false,
      regressionsDetected: false,
      targetedTests: {
        passed: false,
        details: "Not run because patch application failed",
      },
      fullTests: {
        passed: false,
        details: "Not run because patch application failed",
      },
      failures: [
        {
          test: "patch_application",
          reason: testExecution.error || "Failed to apply patch to target files",
          relatedToPatch: true,
        },
      ],
      confidence: 1.0,
      applied: false,
      restored: Boolean(testExecution.restored),
    };
  }

  // 4. If LLM is provided or live execution is possible, evaluate with LLM
  if (options.llm || ChatGoogleGenerativeAI) {
    const llm = options.llm || new ChatGoogleGenerativeAI({
      model: options.model || LLM_MODEL,
      temperature: LLM_TEMPERATURE,
    });

    const systemPrompt = getSystemPrompt();
    const userPrompt = getUserPrompt(bugReport, diagnosis, patch, testExecution);

    const response = await llm.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);

    const rawContent = response?.content !== undefined ? response.content : response;
    const parsed = parseQAResponse(rawContent);

    return {
      ...parsed,
      applied: testExecution.applied,
      restored: testExecution.restored,
      rawExecution: {
        passed: testExecution.passed,
        summary: testExecution.summary,
      },
    };
  }

  // 5. Deterministic fallback evaluation if no LLM is configured
  const passed = Boolean(testExecution.passed);
  const failureList = testExecution.fullTests?.failures || [];

  return {
    status: passed ? "PASS" : "FAIL",
    summary: testExecution.summary || (passed ? "All tests passed successfully" : "Tests failed"),
    originalBugVerified: passed,
    regressionsDetected: !passed,
    targetedTests: {
      passed: Boolean(testExecution.targetedTests ? testExecution.targetedTests.passed : passed),
      details: testExecution.targetedTests?.summary || "Targeted execution evaluated",
    },
    fullTests: {
      passed,
      details: testExecution.fullTests?.summary || (passed ? "All tests passed" : "Test suite failures detected"),
    },
    failures: failureList.map((f) => ({
      test: f.test,
      reason: f.message,
      relatedToPatch: true,
    })),
    confidence: passed ? 0.95 : 0.85,
    applied: testExecution.applied,
    restored: testExecution.restored,
  };
}

/**
 * Robustly parse raw LLM output into structured QA result JSON.
 *
 * @param {any} raw
 * @returns {object}
 */
export function parseQAResponse(raw) {
  const text = extractResponseText(raw).trim();
  if (!text) {
    throw new Error("Empty response from QA Agent LLM");
  }

  // Strip markdown fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`QA Agent response was not valid JSON: ${err.message}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("QA Agent response must be a JSON object");
  }

  const rawStatus = String(parsed.status || "").toUpperCase();
  const status = ["PASS", "FAIL", "INCONCLUSIVE"].includes(rawStatus)
    ? rawStatus
    : "INCONCLUSIVE";

  const failures = Array.isArray(parsed.failures)
    ? parsed.failures.map((f) => ({
        test: typeof f.test === "string" ? f.test : "unknown_test",
        reason: typeof f.reason === "string" ? f.reason : "unknown_reason",
        relatedToPatch: Boolean(f.relatedToPatch),
      }))
    : [];

  return {
    status,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    originalBugVerified: Boolean(parsed.originalBugVerified),
    regressionsDetected: Boolean(parsed.regressionsDetected),
    targetedTests: {
      passed: Boolean(parsed.targetedTests?.passed),
      details: typeof parsed.targetedTests?.details === "string" ? parsed.targetedTests.details : "",
    },
    fullTests: {
      passed: Boolean(parsed.fullTests?.passed),
      details: typeof parsed.fullTests?.details === "string" ? parsed.fullTests.details : "",
    },
    failures,
    confidence: clampConfidence(parsed.confidence),
  };
}

/**
 * LangGraph-compatible node wrapper for QA Agent.
 *
 * Consumes:
 * - state.repository_path
 * - state.bug_report
 * - state.diagnosis
 * - state.patch
 *
 * Produces:
 * - { test_results, error: null } on success
 * - { test_results: null, error } on failure
 *
 * @param {object} state
 * @returns {Promise<object>} partial state update
 */
export async function qaAgentNode(state) {
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
    if (!state.patch) {
      throw new Error("state.patch is missing");
    }

    const testResults = await runQA(
      state.repository_path,
      state.bug_report,
      state.diagnosis,
      state.patch
    );

    return { test_results: testResults, error: null };
  } catch (err) {
    console.error("[QA Agent] Error:", err.message);
    return {
      test_results: null,
      error: `QA Agent failed: ${err.message}`,
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

function clampConfidence(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0.0;
  return Math.max(0, Math.min(1, number));
}

// ── Standalone CLI runner ─────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const repoIdx = args.indexOf("--repo");
  const bugIdx = args.indexOf("--bug");

  if (repoIdx === -1 || bugIdx === -1) {
    console.error(
      "Usage: node server/agents/qaAgent.js --repo <path> --bug <description>"
    );
    process.exit(1);
  }

  const repoPath = args[repoIdx + 1];
  const bugReport = args[bugIdx + 1];

  const diagnosis = {
    suspectedFile: "src/pricing/discount.py",
    suspectedFunction: "calculate_discount",
    suspectedLocation: "if quantity > 10",
    rootCause: "Boundary condition excludes 10",
    expectedBehavior: "10 or more items receive 20% discount",
    actualBehavior: "10 items receive 10% discount",
    evidence: [],
    confidence: 0.95,
  };

  const patch = {
    explanation: "Fix discount boundary",
    modifiedFiles: ["src/pricing/discount.py"],
    diff: "",
    changes: [
      {
        file: "src/pricing/discount.py",
        originalCode: "    if quantity > 10:",
        fixedCode: "    if quantity >= 10:",
        reason: "Include boundary 10",
      },
    ],
    status: "PROPOSED",
  };

  const qaResult = await runQA(repoPath, bugReport, diagnosis, patch);
  console.log("\n=== QA RESULT ===");
  console.log(JSON.stringify(qaResult, null, 2));
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
