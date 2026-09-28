/**
 * Prompt templates for the Fix Agent (Member 3).
 *
 * The Fix Agent creates the smallest possible safe code repair
 * based on the bug report, diagnosis, and relevant source code.
 */

/**
 * System prompt strictly constraining the Fix Agent to minimal,
 * safe, and non-destructive repairs.
 *
 * @returns {string}
 */
export function getSystemPrompt() {
  return `You are the Fix Agent in the Code Archaeologist multi-agent system.

Your sole responsibility is to convert a bug diagnosis into a minimal, safe, and precise code repair.

STRICT RULES:
1. Act as a software repair agent. Fix ONLY the diagnosed problem.
2. Make the smallest possible change. Prefer single-line edits or minimal replacements.
3. Modify only the relevant source file(s) identified in the diagnosis.
4. Do NOT modify tests or test files under any circumstances.
5. Do NOT rewrite unrelated code or make stylistic/formatting adjustments.
6. Preserve existing function signatures, return types, and class interfaces.
7. Preserve existing behavior outside the bug.
8. Do NOT introduce new external dependencies or libraries.
9. Do NOT make speculative improvements, refactorings, or fix unrelated bugs.
10. Return VALID JSON ONLY. Do NOT wrap the JSON in markdown code fences (\`\`\`json). Do NOT include commentary outside the JSON.

REQUIRED JSON OUTPUT SCHEMA:
{
  "explanation": "string explaining why this fix resolves the issue",
  "modifiedFiles": ["relative/path/to/file"],
  "changes": [
    {
      "file": "relative/path/to/file",
      "originalCode": "exact snippet of existing code to replace",
      "fixedCode": "exact replacement code snippet",
      "reason": "why this exact change fixes the diagnosed issue"
    }
  ]
}`;
}

/**
 * User prompt supplying the bug report, diagnosis details, and current source code.
 *
 * @param {string} bugReport
 * @param {object} diagnosis
 * @param {string|Record<string, string>} sourceCode
 * @returns {string}
 */
export function getUserPrompt(bugReport, diagnosis, sourceCode) {
  const diag = diagnosis || {};

  let formattedSource = "";
  if (typeof sourceCode === "string") {
    const file = diag.suspectedFile || "target_file";
    formattedSource = `=== SOURCE FILE: ${file} ===\n${sourceCode}\n=== END SOURCE FILE ===`;
  } else if (sourceCode && typeof sourceCode === "object") {
    formattedSource = Object.entries(sourceCode)
      .map(
        ([file, content]) =>
          `=== SOURCE FILE: ${file} ===\n${content}\n=== END SOURCE FILE ===`
      )
      .join("\n\n");
  } else {
    formattedSource = "No source code provided.";
  }

  const evidenceList = Array.isArray(diag.evidence)
    ? diag.evidence.map((e) => `- ${e}`).join("\n")
    : "None provided";

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
${evidenceList}

=== RELEVANT SOURCE CODE ===
${formattedSource}

Carefully review the diagnosis and source code. Propose the minimal code patch that resolves the bug while strictly obeying all system rules. Return the JSON response only.`;
}
