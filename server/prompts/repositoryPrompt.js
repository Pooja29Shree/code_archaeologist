/**
 * Prompt template for the Repository Analyst Agent.
 *
 * The prompt receives a pre-collected repository summary (file list,
 * function signatures, imports, classes) and the bug report.
 * It asks the LLM to identify which parts of the codebase are most
 * relevant to the reported bug — without ever seeing the full source.
 */

/**
 * Build the system prompt for the Repository Analyst.
 *
 * @returns {string}
 */
export function getSystemPrompt() {
  return `You are the Repository Analyst agent in the Code Archaeologist multi-agent system.

Your sole job is to analyze a software repository and determine which files, functions, classes, and tests are most relevant to a given bug report.

RULES:
1. You must return ONLY valid JSON — no markdown fences, no explanation outside the JSON.
2. For every item you list, include a short "reason" explaining why it is relevant.
3. Be selective. Only include items with a plausible connection to the bug.
4. If you find test files that cover the relevant code, include them.
5. If you find import/dependency relationships between relevant files, include them.
6. Do not guess at a fix or root cause — that is the Diagnosis Agent's job.

OUTPUT SCHEMA (return exactly this structure):

{
  "relevant_files": [
    { "path": "<relative path>", "reason": "<why relevant>" }
  ],
  "relevant_functions": [
    { "file": "<relative path>", "name": "<function name>", "line": <number>, "reason": "<why relevant>" }
  ],
  "relevant_classes": [
    { "file": "<relative path>", "name": "<class name>", "line": <number>, "reason": "<why relevant>" }
  ],
  "relevant_tests": [
    { "path": "<relative path>", "reason": "<why relevant>" }
  ],
  "dependencies": [
    { "source": "<file A>", "depends_on": "<file B>", "reason": "<why relevant>" }
  ],
  "repository_summary": "<1-3 sentence summary of what this repository does and its overall structure>"
}`;
}

/**
 * Build the user prompt containing the repository summary and bug report.
 *
 * @param {object[]} repoSummary — output of buildRepositorySummary()
 * @param {string} bugReport — the user-supplied bug description
 * @returns {string}
 */
export function getUserPrompt(repoSummary, bugReport) {
  // Separate source files and test files for clarity
  const sourceFiles = repoSummary.filter((f) => !f.is_test);
  const testFiles = repoSummary.filter((f) => f.is_test);

  const formatFile = (f) => {
    const parts = [`  Path: ${f.path}`, `  Lines: ${f.line_count}`];
    if (f.imports.length > 0) {
      parts.push(`  Imports:\n${f.imports.map((i) => `    ${i}`).join("\n")}`);
    }
    if (f.functions.length > 0) {
      parts.push(
        `  Functions:\n${f.functions.map((fn) => `    L${fn.line}: ${fn.signature}`).join("\n")}`
      );
    }
    if (f.classes.length > 0) {
      parts.push(
        `  Classes:\n${f.classes.map((c) => `    L${c.line}: ${c.name}`).join("\n")}`
      );
    }
    return parts.join("\n");
  };

  let prompt = `=== BUG REPORT ===\n${bugReport}\n\n`;

  prompt += `=== SOURCE FILES (${sourceFiles.length}) ===\n`;
  for (const f of sourceFiles) {
    prompt += `\n${formatFile(f)}\n`;
  }

  prompt += `\n=== TEST FILES (${testFiles.length}) ===\n`;
  for (const f of testFiles) {
    prompt += `\n${formatFile(f)}\n`;
  }

  prompt += `\nAnalyze the repository above and identify all code relevant to the bug report. Return your answer as JSON matching the required schema.`;

  return prompt;
}
