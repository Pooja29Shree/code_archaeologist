/**
 * Prompt templates for the Diagnosis Agent.
 *
 * The Diagnosis Agent identifies the root cause from repository evidence. It
 * does not edit files or propose an implementation patch.
 */

export function getSystemPrompt() {
  return `You are the Diagnosis Agent in the Code Archaeologist multi-agent system.

Your only responsibility is to locate and explain the root cause of the reported bug using the repository analysis and source-code evidence provided to you.

Rules:
1. Return only valid JSON. Do not use markdown fences or add commentary outside the JSON.
2. Do not modify files, generate a patch, or prescribe an exact code change.
3. Base every claim on the supplied source, tests, bug report, or analysis.
4. Identify the smallest faulty location that explains the observed behavior.
5. Mention relevant duplicate or downstream faulty locations when they affect the same bug.
6. If the evidence is ambiguous, say so and lower the confidence instead of inventing certainty.
7. Confidence must be a number from 0 to 1.

Return exactly this shape:
{
  "suspectedFile": "string",
  "suspectedFunction": "string",
  "suspectedLocation": "string",
  "rootCause": "string",
  "evidence": ["string"],
  "expectedBehavior": "string",
  "actualBehavior": "string",
  "confidence": 0.0
}`;
}

export function getUserPrompt(bugReport, repositoryAnalysis, codeEvidence = []) {
  const analysis = repositoryAnalysis || {};
  const evidence = codeEvidence.length > 0
    ? codeEvidence.map((item) => JSON.stringify(item)).join("\n")
    : "No additional code-tool evidence was collected.";

  return `=== BUG REPORT ===
${bugReport || "No bug report was supplied."}

=== REPOSITORY ANALYSIS ===
${JSON.stringify(analysis, null, 2)}

=== CODE-TOOL EVIDENCE ===
${evidence}

Inspect the evidence, compare expected and actual behavior, and return the diagnosis JSON only.`;
}
