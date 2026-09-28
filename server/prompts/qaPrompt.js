/**
 * Prompt templates for the QA Agent (Member 4).
 *
 * The QA Agent analyzes test results and evaluates whether the proposed fix
 * resolves the diagnosed issue without introducing regressions.
 */

/**
 * Build the system prompt strictly constraining the QA Agent to test evaluation
 * and regression analysis without modifying code or tests.
 *
 * @returns {string}
 */
export function getSystemPrompt() {
  return `You are the QA Agent in the Code Archaeologist multi-agent system.

Your sole responsibility is to evaluate test execution results against a proposed code repair, determine whether the original bug is verified as fixed, and identify any regressions.

STRICT RULES:
1. You are a QA / verification agent. You do NOT write code fixes, generate patches, or modify source code.
2. You do NOT modify or delete tests under any circumstances.
3. You do NOT invent test failures or make speculative claims without execution evidence.
4. Base every conclusion strictly on the supplied bug report, diagnosis, patch, and test output.
5. Distinguish the original bug from unrelated test failures:
   - If an existing test failed for a reason completely unrelated to the patch, note it accurately.
   - If a test that previously passed now fails, flag it as a regression.
6. A passing test suite does NOT automatically prove correctness if the diagnosis-specific boundary/behavior was never exercised by tests.
7. Return VALID JSON ONLY. Do NOT wrap JSON in markdown code fences (\`\`\`json). Do NOT include commentary outside the JSON.

REQUIRED JSON OUTPUT SCHEMA:
{
  "status": "PASS" | "FAIL" | "INCONCLUSIVE",
  "summary": "concise explanation of the QA outcome",
  "originalBugVerified": boolean,
  "regressionsDetected": boolean,
  "targetedTests": {
    "passed": boolean,
    "details": "explanation of targeted test results"
  },
  "fullTests": {
    "passed": boolean,
    "details": "explanation of full test suite results"
  },
  "failures": [
    {
      "test": "name of failing test",
      "reason": "why the test failed",
      "relatedToPatch": boolean
    }
  ],
  "confidence": number from 0.0 to 1.0
}`;
}

/**
 * Build the user prompt supplying the bug report, diagnosis, proposed patch,
 * and test execution results.
 *
 * @param {string} bugReport — original bug description
 * @param {object} diagnosis — Member 2 diagnosis object
 * @param {object} patch — Member 3 patch object
 * @param {object} testResults — execution results from testTools
 * @param {object} options — optional metadata
 * @returns {string}
 */
export function getUserPrompt(bugReport, diagnosis, patch, testResults, options = {}) {
  const diag = diagnosis || {};
  const ptch = patch || {};
  const results = testResults || {};

  const diagEvidence = Array.isArray(diag.evidence)
    ? diag.evidence.map((e) => `- ${e}`).join("\n")
    : "None recorded";

  const modifiedList = Array.isArray(ptch.modifiedFiles)
    ? ptch.modifiedFiles.join(", ")
    : "None";

  let testSummarySection = "";
  if (results.fullTests || results.stdout || results.testCount !== undefined) {
    const full = results.fullTests || results;
    testSummarySection = `Exit Code: ${full.exitCode !== undefined ? full.exitCode : "Unknown"}
Passed: ${Boolean(full.passed)}
Test Count: ${full.testCount !== undefined ? full.testCount : "Unknown"}
Passed Count: ${full.passedCount !== undefined ? full.passedCount : "Unknown"}
Failed Count: ${full.failedCount !== undefined ? full.failedCount : "Unknown"}
Timed Out: ${Boolean(full.timedOut)}

Failures Detected:
${
  Array.isArray(full.failures) && full.failures.length > 0
    ? full.failures.map((f) => `- [${f.test}]: ${f.message}`).join("\n")
    : "None"
}

Raw Test Output (stdout):
${full.stdout ? full.stdout.trim() : "No stdout"}

Raw Error Output (stderr):
${full.stderr ? full.stderr.trim() : "No stderr"}`;
  } else {
    testSummarySection = "No test execution output available.";
  }

  let targetedSection = "Targeted tests not executed separately.";
  if (results.targetedTests) {
    targetedSection = `Targeted Tests Exit Code: ${results.targetedTests.exitCode}
Targeted Passed: ${Boolean(results.targetedTests.passed)}
Targeted Output:
${results.targetedTests.stdout || "None"}`;
  }

  return `=== BUG REPORT ===
${bugReport || "No bug report supplied."}

=== DIAGNOSIS ===
- Suspected File: ${diag.suspectedFile || "Unknown"}
- Suspected Function: ${diag.suspectedFunction || "Unknown"}
- Suspected Location: ${diag.suspectedLocation || "Unknown"}
- Root Cause: ${diag.rootCause || "Unknown"}
- Expected Behavior: ${diag.expectedBehavior || "Unknown"}
- Actual Behavior: ${diag.actualBehavior || "Unknown"}
- Confidence: ${diag.confidence !== undefined ? diag.confidence : "Unknown"}
Evidence:
${diagEvidence}

=== PROPOSED PATCH ===
- Explanation: ${ptch.explanation || "None"}
- Modified Files: ${modifiedList}
- Diff:
${ptch.diff || "No diff provided"}

=== TEST EXECUTION RESULTS ===
${testSummarySection}

=== TARGETED TEST RESULTS ===
${targetedSection}

Analyze the diagnosis, the patch, and the test results. Determine if the proposed patch genuinely resolves the diagnosed root cause without introducing regressions. Return the JSON response only.`;
}
