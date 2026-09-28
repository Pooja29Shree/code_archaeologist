/**
 * Test Tools — utilities for test execution, output parsing, targeted testing,
 * and safe patch lifecycle management for Member 4 (QA Agent).
 *
 * Uses Node.js built-ins and integrates with patchTools.js.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  applyPatch,
  revertPatch,
  resolveRepoPath,
  normalizePath,
} from "./patchTools.js";
import { scanRepository, isTestFile } from "./repositoryTools.js";

// ── Default Configuration ─────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Execute a subprocess safely, capturing stdout, stderr, and exit code.
 * Does not throw on non-zero exit codes.
 *
 * @param {string} command - executable name or path
 * @param {string[]} args - arguments array
 * @param {object} options - execution options
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, durationMs: number, timedOut: boolean, error?: string }>}
 */
async function executeProcess(command, args = [], options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const env = { ...process.env, ...options.env };

  const startTime = Date.now();

  return new Promise((resolve) => {
    let stdoutData = "";
    let stderrData = "";
    let timedOut = false;
    let timer = null;

    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore kill errors
        }
      }, timeoutMs);
    }

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutData += chunk.toString("utf-8");
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrData += chunk.toString("utf-8");
      });
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolve({
        stdout: stdoutData,
        stderr: (stderrData ? `${stderrData}\n` : "") + err.message,
        exitCode: 1,
        durationMs,
        timedOut,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolve({
        stdout: stdoutData,
        stderr: stderrData,
        exitCode: code === null ? (timedOut ? 124 : 1) : code,
        durationMs,
        timedOut,
      });
    });
  });
}

/**
 * Detect the test command and arguments appropriate for a given repository.
 *
 * @param {string} repoPath
 * @returns {Promise<{ command: string, args: string[], type: string }>}
 */
async function detectTestRunner(repoPath) {
  // 1. Check for package.json (Node.js)
  try {
    const pkgPath = path.join(repoPath, "package.json");
    const pkgContent = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);

    if (pkg.scripts && pkg.scripts.test) {
      return { command: "npm", args: ["test"], type: "npm" };
    }
  } catch {
    // Not a Node package or unreadable package.json
  }

  // 2. Check for Python repository
  try {
    const files = await scanRepository(repoPath);
    const hasPyFiles = files.some((f) => f.endsWith(".py"));
    const hasTestPyFiles = files.some(
      (f) => f.endsWith(".py") && (f.includes("test") || isTestFile(f))
    );

    if (hasPyFiles || hasTestPyFiles) {
      // Check if pytest or python -m unittest
      return { command: "python", args: ["-m", "unittest", "discover", "-s", "tests"], type: "python" };
    }
  } catch {
    // Filesystem error
  }

  // Default fallback
  return { command: "npm", args: ["test"], type: "default" };
}

/**
 * Run the repository's existing test suite.
 *
 * @param {string} repoPath — absolute path to the repository
 * @param {object} options — optional custom runner, command, args, timeout
 * @returns {Promise<object>} — structured test execution result
 */
export async function runTests(repoPath, options = {}) {
  if (!repoPath || typeof repoPath !== "string") {
    throw new Error("repoPath is required");
  }

  // Allow custom test runner injection for testing/mocking
  if (typeof options.runner === "function") {
    const runnerRes = await options.runner({ repoPath, options });
    const parsed = parseTestOutput(runnerRes, options);
    return {
      passed: parsed.passed,
      exitCode: runnerRes.exitCode !== undefined ? runnerRes.exitCode : (parsed.passed ? 0 : 1),
      stdout: runnerRes.stdout || "",
      stderr: runnerRes.stderr || "",
      durationMs: runnerRes.durationMs || 0,
      timedOut: Boolean(runnerRes.timedOut),
      command: options.command || "custom-runner",
      testCount: parsed.testCount,
      passedCount: parsed.passedCount,
      failedCount: parsed.failedCount,
      failures: parsed.failures,
      summary: parsed.summary,
    };
  }

  let command = options.command;
  let args = options.args;

  if (!command) {
    const detected = await detectTestRunner(repoPath);
    command = detected.command;
    args = detected.args;
  } else if (!args) {
    args = [];
  }

  const execRes = await executeProcess(command, args, {
    cwd: repoPath,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    env: options.env,
  });

  const parsed = parseTestOutput(
    {
      stdout: execRes.stdout,
      stderr: execRes.stderr,
      exitCode: execRes.exitCode,
      timedOut: execRes.timedOut,
    },
    options
  );

  return {
    passed: parsed.passed,
    exitCode: execRes.exitCode,
    stdout: execRes.stdout,
    stderr: execRes.stderr,
    durationMs: execRes.durationMs,
    timedOut: execRes.timedOut,
    command: `${command} ${args.join(" ")}`.trim(),
    testCount: parsed.testCount,
    passedCount: parsed.passedCount,
    failedCount: parsed.failedCount,
    failures: parsed.failures,
    summary: parsed.summary,
  };
}

/**
 * Parse the output of a test runner defensively.
 *
 * @param {string|object} output — raw stdout string or { stdout, stderr, exitCode, timedOut }
 * @param {object} options
 * @returns {object} — structured counts and failure details
 */
export function parseTestOutput(output, options = {}) {
  const stdout = typeof output === "string" ? output : (output?.stdout || "");
  const stderr = typeof output === "object" && output?.stderr ? output.stderr : "";
  const exitCode = typeof output === "object" && output?.exitCode !== undefined ? output.exitCode : 0;
  const timedOut = typeof output === "object" && Boolean(output?.timedOut);

  const combined = `${stdout}\n${stderr}`.trim();
  const lines = combined.split(/\r?\n/);

  let testCount = 0;
  let passedCount = 0;
  let failedCount = 0;
  const failures = [];
  const failureNames = new Set();

  if (timedOut) {
    return {
      passed: false,
      testCount: 1,
      passedCount: 0,
      failedCount: 1,
      failures: [{ test: "timeout", message: "Test execution timed out" }],
      summary: "Test execution timed out",
    };
  }

  // 1. Node.js built-in test runner / TAP patterns
  // Examples: "✔ test name (1.2ms)", "✖ test name (3.4ms)", "ℹ pass 5", "ℹ fail 1", "ℹ tests 6"
  let nodeTestsFound = false;
  for (const line of lines) {
    const passSummary = line.match(/^ℹ\s+pass\s+(\d+)/i);
    const failSummary = line.match(/^ℹ\s+fail\s+(\d+)/i);
    const countSummary = line.match(/^ℹ\s+tests\s+(\d+)/i);

    if (passSummary) {
      passedCount = parseInt(passSummary[1], 10);
      nodeTestsFound = true;
    }
    if (failSummary) {
      failedCount = parseInt(failSummary[1], 10);
      nodeTestsFound = true;
    }
    if (countSummary) {
      testCount = parseInt(countSummary[1], 10);
      nodeTestsFound = true;
    }

    const checkFail = line.match(/^✖\s+(.+?)(?:\s+\([\d.]+m?s\))?$/);
    if (checkFail) {
      const testName = checkFail[1].trim();
      failureNames.add(testName);
    }
  }

  // 2. Pytest patterns
  // Example: "=== 1 failed, 2 passed in 0.12s ===", "FAILED tests/test_foo.py::test_bar - AssertionError"
  let pytestFound = false;
  for (const line of lines) {
    const summaryMatch = line.match(/=+ (?:(\d+) failed,?\s*)?(?:(\d+) passed,?\s*)?(?:in [\d.]+s)? =+/i);
    if (summaryMatch) {
      const f = summaryMatch[1] ? parseInt(summaryMatch[1], 10) : 0;
      const p = summaryMatch[2] ? parseInt(summaryMatch[2], 10) : 0;
      if (f > 0 || p > 0) {
        failedCount = f;
        passedCount = p;
        testCount = f + p;
        pytestFound = true;
      }
    }

    const failedLine = line.match(/^FAILED\s+([^:]+::\S+)(?:\s+-\s+(.+))?/);
    if (failedLine) {
      failureNames.add(failedLine[1].trim());
      failures.push({
        test: failedLine[1].trim(),
        message: failedLine[2] ? failedLine[2].trim() : "Pytest failure",
      });
    }
  }

  // 3. Python unittest patterns
  // Example: "Ran 3 tests in 0.001s", "FAILED (failures=1, errors=1)", "OK"
  let unittestFound = false;
  for (const line of lines) {
    const ranMatch = line.match(/^Ran (\d+) tests? in [\d.]+s/i);
    if (ranMatch) {
      testCount = parseInt(ranMatch[1], 10);
      unittestFound = true;
    }

    const failedMatch = line.match(/^FAILED \((?:failures=(\d+))?(?:, )?(?:errors=(\d+))?\)/i);
    if (failedMatch) {
      const f = failedMatch[1] ? parseInt(failedMatch[1], 10) : 0;
      const e = failedMatch[2] ? parseInt(failedMatch[2], 10) : 0;
      failedCount = f + e;
      passedCount = Math.max(0, testCount - failedCount);
      unittestFound = true;
    } else if (/^OK\s*$/i.test(line.trim())) {
      passedCount = testCount;
      failedCount = 0;
      unittestFound = true;
    }

    // Capture ERROR: or FAIL: test names in unittest
    const unitFailLine = line.match(/^(?:FAIL|ERROR):\s+(\S+)/);
    if (unitFailLine) {
      failureNames.add(unitFailLine[1].trim());
    }
  }

  // 4. Jest / Mocha patterns
  // Example: "Tests: 1 failed, 2 passed, 3 total"
  for (const line of lines) {
    const jestMatch = line.match(/Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) passed,\s*)?(\d+) total/i);
    if (jestMatch) {
      const f = jestMatch[1] ? parseInt(jestMatch[1], 10) : 0;
      const p = jestMatch[2] ? parseInt(jestMatch[2], 10) : 0;
      const t = jestMatch[3] ? parseInt(jestMatch[3], 10) : f + p;
      failedCount = f;
      passedCount = p;
      testCount = t;
    }
  }

  // If failureNames were collected and not yet in failures array
  for (const name of failureNames) {
    if (!failures.some((f) => f.test === name)) {
      // Find following lines for message
      let message = "Test failed";
      const idx = lines.findIndex((l) => l.includes(name));
      if (idx !== -1 && idx + 1 < lines.length) {
        const nextLine = lines[idx + 1].trim();
        if (nextLine && !nextLine.startsWith("✔") && !nextLine.startsWith("✖")) {
          message = nextLine;
        }
      }
      failures.push({ test: name, message });
    }
  }

  // Generic heuristic fallback
  if (!nodeTestsFound && !pytestFound && !unittestFound) {
    if (exitCode === 0) {
      passedCount = testCount > 0 ? testCount : 1;
      failedCount = 0;
      testCount = Math.max(testCount, passedCount);
    } else {
      failedCount = Math.max(1, failures.length);
      passedCount = Math.max(0, testCount - failedCount);
      testCount = Math.max(testCount, passedCount + failedCount);
      if (failures.length === 0) {
        failures.push({
          test: "test_suite",
          message: stderr.trim() || stdout.trim() || `Process exited with code ${exitCode}`,
        });
      }
    }
  }

  if (testCount === 0) {
    testCount = passedCount + failedCount;
  }

  const passed = exitCode === 0 && failedCount === 0;
  const summary = `${passedCount} passed, ${failedCount} failed (${testCount} total)`;

  return {
    passed,
    testCount,
    passedCount,
    failedCount,
    failures,
    summary,
  };
}

/**
 * Run only tests relevant to the diagnosed/modified area when possible.
 * Falls back gracefully to runTests() if no targeted test can be determined.
 *
 * @param {string} repoPath
 * @param {object|string} target — { testFile, testName, suspectedFile, modifiedFiles, diagnosis }
 * @param {object} options
 * @returns {Promise<object>} — structured test execution result
 */
export async function runTargetedTests(repoPath, target = {}, options = {}) {
  if (!repoPath) {
    throw new Error("repoPath is required");
  }

  // If a mock runner is provided, route through it
  if (typeof options.runner === "function") {
    return runTests(repoPath, { ...options, target });
  }

  // Normalise target input
  const targetObj = typeof target === "string" ? { testFile: target } : target || {};
  let targetTestFile = targetObj.testFile;
  let targetTestName = targetObj.testName;

  // Infer test file from diagnosis or modifiedFiles if not explicitly given
  if (!targetTestFile) {
    const candidateFiles = [
      targetObj.suspectedFile,
      ...(Array.isArray(targetObj.modifiedFiles) ? targetObj.modifiedFiles : []),
      targetObj.diagnosis?.suspectedFile,
    ].filter(Boolean);

    if (candidateFiles.length > 0) {
      try {
        const repoFiles = await scanRepository(repoPath);
        for (const cand of candidateFiles) {
          const base = path.basename(cand, path.extname(cand));
          const matchedTest = repoFiles.find(
            (f) => isTestFile(f) && f.includes(base)
          );
          if (matchedTest) {
            targetTestFile = matchedTest;
            break;
          }
        }
      } catch {
        // Fall back to full test suite
      }
    }
  }

  // If still no targeted test file could be determined, fall back safely
  if (!targetTestFile && !targetTestName) {
    return runTests(repoPath, options);
  }

  const detected = await detectTestRunner(repoPath);

  // Construct targeted command
  let targetedCommand = detected.command;
  let targetedArgs = [...detected.args];

  if (detected.type === "python") {
    if (targetTestFile && targetTestName) {
      targetedArgs = ["-m", "unittest", `${targetTestFile.replace(/[/\\]/g, ".").replace(/\.py$/, "")}.${targetTestName}`];
    } else if (targetTestFile) {
      targetedArgs = ["-m", "unittest", targetTestFile];
    }
  } else if (detected.type === "npm" || detected.command === "node") {
    if (targetTestFile) {
      targetedCommand = "node";
      targetedArgs = ["--test", targetTestFile];
      if (targetTestName) {
        targetedArgs.push(`--test-name-pattern=${targetTestName}`);
      }
    }
  }

  return runTests(repoPath, {
    ...options,
    command: options.command || targetedCommand,
    args: options.args || targetedArgs,
    target: { testFile: targetTestFile, testName: targetTestName },
  });
}

/**
 * Safely revert a patch, wrapped to never throw. Safe to call in finally blocks.
 *
 * @param {string} repoPath
 * @param {object} patch
 * @returns {Promise<{ success: boolean, revertedFiles: string[], error?: string }>}
 */
export async function safeRevert(repoPath, patch) {
  if (!repoPath || !patch) {
    return { success: true, revertedFiles: [] };
  }

  try {
    return await revertPatch(repoPath, patch);
  } catch (err) {
    return {
      success: false,
      revertedFiles: [],
      error: `Safe revert encountered error: ${err.message}`,
    };
  }
}

/**
 * Apply a proposed patch, execute targeted and full tests, and revert cleanly in finally.
 * Verifies repository state is cleanly restored.
 *
 * @param {string} repoPath — absolute path to repository
 * @param {object} patch — patch object from Member 3
 * @param {object} options — options ({ target, command, runner, timeoutMs })
 * @returns {Promise<object>} — comprehensive QA execution result
 */
export async function applyPatchAndTest(repoPath, patch, options = {}) {
  if (!repoPath || typeof repoPath !== "string") {
    throw new Error("repoPath is required");
  }
  if (!patch || typeof patch !== "object") {
    throw new Error("patch is required");
  }

  // 1. Snapshot original contents if available to guarantee restoration verification
  const filesToVerify = Array.isArray(patch.modifiedFiles)
    ? patch.modifiedFiles
    : [];
  const beforeContents = {};

  for (const relFile of filesToVerify) {
    try {
      const absPath = resolveRepoPath(repoPath, relFile);
      beforeContents[relFile] = await fs.readFile(absPath, "utf-8");
    } catch {
      // File may not exist yet or unreadable
    }
  }

  // 2. Apply Member 3's patch
  const applyRes = await applyPatch(repoPath, patch);
  if (!applyRes.success) {
    return {
      applied: false,
      restored: true,
      passed: false,
      targetedTests: null,
      fullTests: null,
      error: applyRes.error || "Failed to apply patch",
      summary: `Patch application failed: ${applyRes.error || "Unknown error"}`,
    };
  }

  let targetedResults = null;
  let fullResults = null;
  let executionError = null;

  try {
    // 3. Run targeted tests if target is requested or inferrable
    if (options.target || options.diagnosis) {
      const targetParam = options.target || {
        diagnosis: options.diagnosis,
        modifiedFiles: patch.modifiedFiles,
      };
      targetedResults = await runTargetedTests(repoPath, targetParam, options);
    }

    // 4. Run full repository test suite
    fullResults = await runTests(repoPath, options);
  } catch (err) {
    executionError = err;
  } finally {
    // 5. Always revert patch in finally block
    const revertRes = await safeRevert(repoPath, patch);

    // 6. Verify repository has returned to its original state
    let stateRestored = revertRes.success;
    for (const [relFile, origContent] of Object.entries(beforeContents)) {
      try {
        const absPath = resolveRepoPath(repoPath, relFile);
        const currentContent = await fs.readFile(absPath, "utf-8");
        if (currentContent !== origContent) {
          stateRestored = false;
        }
      } catch {
        stateRestored = false;
      }
    }

    if (executionError) {
      return {
        applied: true,
        restored: stateRestored,
        passed: false,
        targetedTests: targetedResults,
        fullTests: fullResults,
        error: `Test execution failed with error: ${executionError.message}`,
        summary: `Execution error: ${executionError.message}`,
      };
    }

    const passed =
      Boolean(fullResults?.passed) &&
      (!targetedResults || Boolean(targetedResults.passed));

    return {
      applied: true,
      restored: stateRestored,
      passed,
      targetedTests: targetedResults,
      fullTests: fullResults,
      error: passed ? null : (fullResults?.failures?.[0]?.message || "Tests failed"),
      summary: passed
        ? "All tests passed successfully"
        : `Tests failed: ${fullResults?.failedCount || 1} failure(s)`,
    };
  }
}
