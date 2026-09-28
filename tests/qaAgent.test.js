import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  runQA,
  parseQAResponse,
  qaAgentNode,
} from "../server/agents/qaAgent.js";
import {
  runTests,
  parseTestOutput,
  runTargetedTests,
  applyPatchAndTest,
  safeRevert,
} from "../server/tools/testTools.js";
import {
  getSystemPrompt,
  getUserPrompt,
} from "../server/prompts/qaPrompt.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const discountRepo = path.join(projectRoot, "test-repositories", "discount-bug");

// ── TEST 1: Test output parsing (Success) ─────────────────────
test("TEST 1: parseTestOutput() parses successful test output correctly", () => {
  // 1. Node test runner format
  const nodeOutput = `
✔ calculate_discount calculates basic discount (1.2ms)
✔ calculate_discount applies bulk tier (0.8ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 42.1
`;
  const nodeParsed = parseTestOutput({ stdout: nodeOutput, exitCode: 0 });
  assert.equal(nodeParsed.passed, true);
  assert.equal(nodeParsed.testCount, 2);
  assert.equal(nodeParsed.passedCount, 2);
  assert.equal(nodeParsed.failedCount, 0);
  assert.equal(nodeParsed.failures.length, 0);

  // 2. Pytest format
  const pytestOutput = `
============================= test session starts =============================
tests/test_discount.py ...                                               [100%]
============================== 3 passed in 0.05s ==============================
`;
  const pyParsed = parseTestOutput({ stdout: pytestOutput, exitCode: 0 });
  assert.equal(pyParsed.passed, true);
  assert.equal(pyParsed.testCount, 3);
  assert.equal(pyParsed.passedCount, 3);
  assert.equal(pyParsed.failedCount, 0);

  // 3. Python unittest format
  const unittestOutput = `
...
----------------------------------------------------------------------
Ran 3 tests in 0.002s

OK
`;
  const unitParsed = parseTestOutput({ stdout: unittestOutput, exitCode: 0 });
  assert.equal(unitParsed.passed, true);
  assert.equal(unitParsed.testCount, 3);
  assert.equal(unitParsed.passedCount, 3);
  assert.equal(unitParsed.failedCount, 0);
});

// ── TEST 2: Failure output parsing ────────────────────────────
test("TEST 2: parseTestOutput() detects failures and extracts names/messages", () => {
  // 1. Node test runner format
  const nodeFail = `
✖ test_large_bulk_discount (2.5ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 900
  - 800
ℹ tests 3
ℹ pass 2
ℹ fail 1
`;
  const nodeRes = parseTestOutput({ stdout: nodeFail, exitCode: 1 });
  assert.equal(nodeRes.passed, false);
  assert.equal(nodeRes.failedCount, 1);
  assert.equal(nodeRes.passedCount, 2);
  assert.ok(nodeRes.failures.length >= 1);
  assert.equal(nodeRes.failures[0].test, "test_large_bulk_discount");

  // 2. Pytest format
  const pytestFail = `
=================================== FAILURES ===================================
___________________________ test_large_bulk_discount ___________________________
    def test_large_bulk_discount():
>       assert calculate_discount(10, 100) == 800.0
E       assert 900.0 == 800.0
FAILED tests/test_discount.py::test_large_bulk_discount - assert 900.0 == 800.0
========================= 1 failed, 2 passed in 0.08s =========================
`;
  const pyRes = parseTestOutput({ stdout: pytestFail, exitCode: 1 });
  assert.equal(pyRes.passed, false);
  assert.equal(pyRes.failedCount, 1);
  assert.equal(pyRes.passedCount, 2);
  assert.equal(pyRes.failures[0].test, "tests/test_discount.py::test_large_bulk_discount");
  assert.match(pyRes.failures[0].message, /assert 900\.0 == 800\.0/);

  // 3. Timeout handling
  const timeoutRes = parseTestOutput({ stdout: "", exitCode: 124, timedOut: true });
  assert.equal(timeoutRes.passed, false);
  assert.match(timeoutRes.summary, /timed out/i);
});

// ── TEST 3: runTests() subprocess execution ───────────────────
test("TEST 3: runTests() executes subprocess and captures output and exit code", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-test-runner-"));

  try {
    // Test passing subprocess execution
    const isWin = process.platform === "win32";
    const passCmd = isWin ? "cmd" : "sh";
    const passArgs = isWin
      ? ["/c", "echo ✔ test_sample (1ms) & echo ℹ pass 1 & echo ℹ tests 1 & exit 0"]
      : ["-c", "echo '✔ test_sample (1ms)'; echo 'ℹ pass 1'; echo 'ℹ tests 1'; exit 0"];

    const passResult = await runTests(tempDir, {
      command: passCmd,
      args: passArgs,
    });

    assert.equal(passResult.passed, true);
    assert.equal(passResult.exitCode, 0);
    assert.ok(passResult.stdout.includes("test_sample"));
    assert.equal(passResult.failedCount, 0);

    // Test failing subprocess execution
    const failCmd = isWin ? "cmd" : "sh";
    const failArgs = isWin
      ? ["/c", "echo ✖ test_fail (2ms) & echo ℹ fail 1 & echo ℹ tests 1 & exit 1"]
      : ["-c", "echo '✖ test_fail (2ms)'; echo 'ℹ fail 1'; echo 'ℹ tests 1'; exit 1"];

    const failResult = await runTests(tempDir, {
      command: failCmd,
      args: failArgs,
    });

    assert.equal(failResult.passed, false);
    assert.equal(failResult.exitCode, 1);
    assert.ok(failResult.stdout.includes("test_fail"));
    assert.equal(failResult.failedCount, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// ── TEST 4: Targeted test execution ───────────────────────────
test("TEST 4: runTargetedTests() routes to targeted tests and falls back gracefully", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-targeted-"));

  try {
    let capturedOptions = null;
    const mockRunner = async ({ repoPath, options }) => {
      capturedOptions = options;
      return {
        stdout: "✔ test_specific (1ms)\nℹ pass 1\nℹ tests 1",
        exitCode: 0,
      };
    };

    // 1. With explicit target
    const targetedRes = await runTargetedTests(
      tempDir,
      { testFile: "tests/test_discount.py", testName: "test_large_bulk_discount" },
      { runner: mockRunner }
    );

    assert.equal(targetedRes.passed, true);
    assert.deepEqual(capturedOptions.target, {
      testFile: "tests/test_discount.py",
      testName: "test_large_bulk_discount",
    });

    // 2. Graceful fallback when target is empty
    const fallbackRes = await runTargetedTests(tempDir, {}, { runner: mockRunner });
    assert.equal(fallbackRes.passed, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// ── TEST 5: Regression detection ──────────────────────────────
test("TEST 5: Regression detection flags newly failing tests when patch introduces broken behavior", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-regression-"));
  const srcDir = path.join(tempDir, "src");
  await fs.mkdir(srcDir, { recursive: true });

  const codeFile = path.join(srcDir, "logic.py");
  await fs.writeFile(codeFile, "def compute(x):\n    return x * 2\n", "utf-8");

  // Breaking patch that breaks another feature
  const regressivePatch = {
    modifiedFiles: ["src/logic.py"],
    changes: [
      {
        file: "src/logic.py",
        originalCode: "    return x * 2",
        fixedCode: "    return x + 2", // Incorrect regression
        reason: "Fix compute",
      },
    ],
    status: "PROPOSED",
  };

  const diagnosis = {
    suspectedFile: "src/logic.py",
    suspectedFunction: "compute",
    rootCause: "Computation error",
    expectedBehavior: "x * 2",
    actualBehavior: "wrong",
  };

  // Mock runner that simulates existing test failure (regression)
  const mockRunner = async () => ({
    stdout: `
✖ test_existing_multiplication (2ms)
  AssertionError: Expected 20 but received 12
ℹ tests 2
ℹ pass 1
ℹ fail 1
`,
    exitCode: 1,
  });

  const qaResult = await runQA(
    tempDir,
    "Fix computation",
    diagnosis,
    regressivePatch,
    { runner: mockRunner }
  );

  assert.equal(qaResult.status, "FAIL");
  assert.equal(qaResult.regressionsDetected, true);
  assert.equal(qaResult.fullTests.passed, false);
  assert.ok(qaResult.failures.length > 0);

  await fs.rm(tempDir, { recursive: true, force: true });
});

// ── TEST 6: Repository immutability ───────────────────────────
test("TEST 6: Repository immutability ensures files are restored cleanly after QA", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-immutability-"));
  const srcDir = path.join(tempDir, "src");
  await fs.mkdir(srcDir, { recursive: true });

  const testFile = path.join(srcDir, "calculator.py");
  const originalCode = "def add(a, b):\n    return a - b\n";
  await fs.writeFile(testFile, originalCode, "utf-8");

  const patch = {
    modifiedFiles: ["src/calculator.py"],
    changes: [
      {
        file: "src/calculator.py",
        originalCode: "    return a - b",
        fixedCode: "    return a + b",
        reason: "Fix addition",
      },
    ],
    originalFileContents: {
      "src/calculator.py": originalCode,
    },
    status: "PROPOSED",
  };

  const diagnosis = {
    suspectedFile: "src/calculator.py",
    rootCause: "Subtraction instead of addition",
    expectedBehavior: "a + b",
    actualBehavior: "a - b",
  };

  // Mock runner that verifies file was temporarily modified DURING test execution
  let codeDuringTest = null;
  const mockRunner = async () => {
    codeDuringTest = await fs.readFile(testFile, "utf-8");
    return {
      stdout: "ℹ pass 1\nℹ tests 1",
      exitCode: 0,
    };
  };

  const qaResult = await runQA(
    tempDir,
    "Fix addition",
    diagnosis,
    patch,
    { runner: mockRunner }
  );

  assert.equal(qaResult.status, "PASS");
  assert.equal(qaResult.applied, true);
  assert.equal(qaResult.restored, true);

  // 1. Verify patch was active during test run
  assert.ok(codeDuringTest.includes("return a + b"), "Patch was not applied during tests");

  // 2. Verify file was completely restored after QA finished
  const codeAfterQA = await fs.readFile(testFile, "utf-8");
  assert.equal(codeAfterQA, originalCode, "Repository was not cleanly restored after QA!");

  await fs.rm(tempDir, { recursive: true, force: true });
});

// ── TEST 7: Mock LLM execution ────────────────────────────────
test("TEST 7: runQA() with mock LLM returns structured evaluation without real API calls", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-mock-llm-"));
  const srcDir = path.join(tempDir, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(path.join(srcDir, "app.py"), "value = 1\n", "utf-8");

  const patch = {
    modifiedFiles: ["src/app.py"],
    changes: [
      {
        file: "src/app.py",
        originalCode: "value = 1",
        fixedCode: "value = 2",
        reason: "Update value",
      },
    ],
    status: "PROPOSED",
  };

  const diagnosis = {
    suspectedFile: "src/app.py",
    rootCause: "Wrong value",
    expectedBehavior: "2",
    actualBehavior: "1",
  };

  const mockLLMResponse = {
    content: JSON.stringify({
      status: "PASS",
      summary: "The patch fixes the value and all tests pass with no regressions.",
      originalBugVerified: true,
      regressionsDetected: false,
      targetedTests: { passed: true, details: "Targeted verification succeeded" },
      fullTests: { passed: true, details: "Full test suite passed" },
      failures: [],
      confidence: 0.99,
    }),
  };

  const fakeLlm = {
    async invoke() {
      return mockLLMResponse;
    },
  };

  const mockRunner = async () => ({
    stdout: "ℹ pass 5\nℹ tests 5",
    exitCode: 0,
  });

  const qaResult = await runQA(
    tempDir,
    "Fix value",
    diagnosis,
    patch,
    { llm: fakeLlm, runner: mockRunner }
  );

  assert.equal(qaResult.status, "PASS");
  assert.equal(qaResult.originalBugVerified, true);
  assert.equal(qaResult.regressionsDetected, false);
  assert.equal(qaResult.confidence, 0.99);
  assert.match(qaResult.summary, /patch fixes the value/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});

// ── TEST 8: Malformed LLM output handling ─────────────────────
test("TEST 8: parseQAResponse() throws clean descriptive error on malformed LLM response", () => {
  assert.throws(
    () => parseQAResponse("NOT VALID JSON"),
    /not valid JSON/i
  );

  assert.throws(
    () => parseQAResponse(""),
    /Empty response/i
  );

  // Markdown code fences should be cleanly stripped
  const fenced = "```json\n{\"status\":\"PASS\",\"summary\":\"ok\",\"originalBugVerified\":true}\n```";
  const parsed = parseQAResponse(fenced);
  assert.equal(parsed.status, "PASS");
  assert.equal(parsed.summary, "ok");
  assert.equal(parsed.originalBugVerified, true);
});

// ── TEST 9: Patch application failure ─────────────────────────
test("TEST 9: runQA() handles patch application failure cleanly without throwing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-bad-patch-"));
  const srcDir = path.join(tempDir, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(path.join(srcDir, "valid.py"), "def real_code(): pass\n", "utf-8");

  // Invalid patch targeting nonexistent original code
  const invalidPatch = {
    modifiedFiles: ["src/valid.py"],
    changes: [
      {
        file: "src/valid.py",
        originalCode: "NON_EXISTENT_CODE_BLOCK",
        fixedCode: "NEW_CODE",
        reason: "Mismatch test",
      },
    ],
    status: "PROPOSED",
  };

  const diagnosis = {
    suspectedFile: "src/valid.py",
    rootCause: "Test",
    expectedBehavior: "None",
    actualBehavior: "None",
  };

  const qaResult = await runQA(
    tempDir,
    "Fix code",
    diagnosis,
    invalidPatch
  );

  assert.equal(qaResult.status, "FAIL");
  assert.equal(qaResult.applied, false);
  assert.equal(qaResult.restored, true);
  assert.match(qaResult.summary, /Patch application failed/i);
  assert.equal(qaResult.failures[0].test, "patch_application");

  await fs.rm(tempDir, { recursive: true, force: true });
});

// ── TEST 10: qaAgentNode LangGraph wrapper ────────────────────
test("TEST 10: qaAgentNode() returns partial state update compatible with LangGraph", async () => {
  // 1. Missing state parameters produce structured error without throwing
  const failResult = await qaAgentNode({});
  assert.equal(failResult.test_results, null);
  assert.match(failResult.error, /missing/i);

  // 2. Complete state execution returns test_results
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-node-"));
  const srcDir = path.join(tempDir, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(path.join(srcDir, "item.py"), "x = 10\n", "utf-8");

  const state = {
    repository_path: tempDir,
    bug_report: "Value must be 20",
    diagnosis: {
      suspectedFile: "src/item.py",
      rootCause: "Value is 10",
      expectedBehavior: "20",
      actualBehavior: "10",
    },
    patch: {
      modifiedFiles: ["src/item.py"],
      changes: [
        {
          file: "src/item.py",
          originalCode: "x = 10",
          fixedCode: "x = 20",
          reason: "Set to 20",
        },
      ],
      status: "PROPOSED",
    },
  };

  const successResult = await qaAgentNode(state);
  assert.ok(successResult.test_results !== null, "test_results should be populated");
  assert.equal(successResult.error, null);

  await fs.rm(tempDir, { recursive: true, force: true });
});

// ── TEST 11: Real Discount-Bug Repository Verification ─────────
test("TEST 11: Real discount-bug repository is validated and cleanly restored", async () => {
  const discountFile = path.join(discountRepo, "src", "pricing", "discount.py");
  const contentBefore = await fs.readFile(discountFile, "utf-8");

  const member3Patch = {
    explanation: "Fix boundary condition so quantity 10 receives bulk discount",
    modifiedFiles: ["src/pricing/discount.py"],
    diff: "",
    changes: [
      {
        file: "src/pricing/discount.py",
        originalCode: "    if quantity > 10:",
        fixedCode: "    if quantity >= 10:",
        reason: "Include boundary 10 in 20% discount tier",
      },
    ],
    originalFileContents: {
      "src/pricing/discount.py": contentBefore,
    },
    status: "PROPOSED",
  };

  const diagnosis = {
    suspectedFile: "src/pricing/discount.py",
    suspectedFunction: "calculate_discount",
    suspectedLocation: "if quantity > 10",
    rootCause: "Strict inequality excludes 10",
    expectedBehavior: "Quantity 10 receives 20% discount",
    actualBehavior: "Quantity 10 receives 10% discount",
  };

  // Mock runner simulating successful test execution of test_discount.py
  const mockRunner = async () => ({
    stdout: `
test_no_discount ... ok
test_small_bulk_discount ... ok
test_large_bulk_discount ... ok
test_discount_rate ... ok
test_order_checkout ... ok
----------------------------------------------------------------------
Ran 5 tests in 0.004s

OK
`,
    exitCode: 0,
  });

  const qaResult = await runQA(
    discountRepo,
    "Customers purchasing 10 items not receiving bulk discount",
    diagnosis,
    member3Patch,
    { runner: mockRunner }
  );

  // Verify QA validated the repair
  assert.equal(qaResult.status, "PASS");
  assert.equal(qaResult.applied, true);
  assert.equal(qaResult.restored, true);

  // Guarantee target repository is pristine after test execution
  const contentAfter = await fs.readFile(discountFile, "utf-8");
  assert.equal(contentAfter, contentBefore, "discount-bug repository was not cleanly restored!");
});
