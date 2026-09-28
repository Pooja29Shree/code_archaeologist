import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  generateFix,
  parseFixResponse,
  fixAgentNode,
} from "../server/agents/fixAgent.js";
import {
  generateDiff,
  applyPatch,
  revertPatch,
  getGitDiff,
} from "../server/tools/patchTools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const discountRepo = path.join(projectRoot, "test-repositories", "discount-bug");

// ── TEST 1: generateDiff() ──────────────────────────────────
test("generateDiff() generates standard unified diff with target file, additions, and removals", () => {
  const original = "if quantity > 10:\n    discount = 0.20";
  const modified = "if quantity >= 10:\n    discount = 0.20";
  const targetFile = "src/pricing/discount.py";

  const diff = generateDiff(original, modified, targetFile);

  assert.ok(diff.includes("--- a/src/pricing/discount.py"), "Diff missing --- header");
  assert.ok(diff.includes("+++ b/src/pricing/discount.py"), "Diff missing +++ header");
  assert.ok(diff.includes("-if quantity > 10:"), "Diff missing removed line");
  assert.ok(diff.includes("+if quantity >= 10:"), "Diff missing added line");
});

// ── TEST 2 & 3: applyPatch() and revertPatch() ──────────────
test("applyPatch() and revertPatch() correctly modify and restore files in a repository", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "patch-test-"));
  const testSubdir = path.join(tempDir, "src");
  await fs.mkdir(testSubdir, { recursive: true });

  const testFile = path.join(testSubdir, "sample.py");
  const originalContent = "def calc():\n    if quantity > 10:\n        return 0.2\n";
  await fs.writeFile(testFile, originalContent, "utf-8");

  const patch = {
    modifiedFiles: ["src/sample.py"],
    changes: [
      {
        file: "src/sample.py",
        originalCode: "    if quantity > 10:",
        fixedCode: "    if quantity >= 10:",
        reason: "Include boundary 10",
      },
    ],
  };

  // 1. Apply patch
  const applyRes = await applyPatch(tempDir, patch);
  assert.equal(applyRes.success, true);
  assert.deepEqual(applyRes.modifiedFiles, ["src/sample.py"]);

  const modifiedContent = await fs.readFile(testFile, "utf-8");
  assert.ok(modifiedContent.includes("if quantity >= 10:"));
  assert.ok(!modifiedContent.includes("if quantity > 10:"));

  // 2. Revert patch
  const revertRes = await revertPatch(tempDir, patch);
  assert.equal(revertRes.success, true);
  assert.deepEqual(revertRes.revertedFiles, ["src/sample.py"]);

  const restoredContent = await fs.readFile(testFile, "utf-8");
  assert.equal(restoredContent, originalContent);

  // Clean up
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ── TEST 4: Path traversal protection ───────────────────────
test("applyPatch() rejects path traversal attempts outside repository", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "traversal-test-"));
  const outsideFile = path.join(os.tmpdir(), "outside-secret.txt");
  await fs.writeFile(outsideFile, "secret content", "utf-8");

  const traversalPatch = {
    modifiedFiles: ["../outside-secret.txt"],
    changes: [
      {
        file: "../outside-secret.txt",
        originalCode: "secret content",
        fixedCode: "compromised content",
        reason: "Malicious edit",
      },
    ],
  };

  const result = await applyPatch(tempDir, traversalPatch);
  assert.equal(result.success, false);
  assert.match(result.error, /escapes repository root/i);

  const outsideAfter = await fs.readFile(outsideFile, "utf-8");
  assert.equal(outsideAfter, "secret content", "Outside file was modified!");

  // Clean up
  await fs.rm(outsideFile, { force: true });
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ── TEST 5: Mock LLM Fix Agent with Member 2 diagnosis ──────
test("generateFix() produces minimal safe repair using diagnosis and mock LLM", async () => {
  const diagnosis = {
    suspectedFile: "src/pricing/discount.py",
    suspectedFunction: "calculate_discount",
    suspectedLocation: "if quantity > 10",
    rootCause: "The strict comparison excludes exactly 10 from the 20% discount.",
    expectedBehavior: "Quantity 10 receives a 20% discount.",
    actualBehavior: "Quantity 10 receives a 10% discount.",
    evidence: ["The documentation says 10 or more items receive 20%."],
    confidence: 0.98,
  };

  const bugReport = "Customers buying exactly 10 items are not receiving the bulk discount.";

  const mockResponse = {
    content: JSON.stringify({
      explanation: "The large-bulk discount boundary must include quantity 10.",
      modifiedFiles: ["src/pricing/discount.py"],
      changes: [
        {
          file: "src/pricing/discount.py",
          originalCode: "    if quantity > 10:",
          fixedCode: "    if quantity >= 10:",
          reason: "The requirement states that 10 or more items receive 20% discount.",
        },
      ],
    }),
  };

  const fakeLlm = {
    async invoke() {
      return mockResponse;
    },
  };

  const discountFilePath = path.join(discountRepo, "src", "pricing", "discount.py");
  const fileBefore = await fs.readFile(discountFilePath, "utf-8");

  // 1. Generate fix (must NOT mutate repository)
  const patch = await generateFix(discountRepo, bugReport, diagnosis, { llm: fakeLlm });

  const fileAfterGen = await fs.readFile(discountFilePath, "utf-8");
  assert.equal(fileAfterGen, fileBefore, "generateFix() must not mutate files on disk");

  // Verify patch object contract
  assert.equal(patch.status, "PROPOSED");
  assert.deepEqual(patch.modifiedFiles, ["src/pricing/discount.py"]);
  assert.ok(patch.diff.includes("-    if quantity > 10:"));
  assert.ok(patch.diff.includes("+    if quantity >= 10:"));
  assert.match(patch.explanation, /boundary/i);

  // 2. Test apply and revert with try/finally to guarantee discountRepo immutability
  try {
    const applyRes = await applyPatch(discountRepo, patch);
    assert.equal(applyRes.success, true);

    const patchedContent = await fs.readFile(discountFilePath, "utf-8");
    assert.ok(patchedContent.includes("if quantity >= 10:"));
  } finally {
    const revertRes = await revertPatch(discountRepo, patch);
    assert.equal(revertRes.success, true);
    const restoredContent = await fs.readFile(discountFilePath, "utf-8");
    assert.equal(restoredContent, fileBefore, "discountRepo was not cleanly restored!");
  }
});

// ── TEST 6: Malformed LLM output handling ───────────────────
test("parseFixResponse() throws clean error on malformed or invalid LLM response", () => {
  assert.throws(
    () => parseFixResponse("NOT JSON AT ALL"),
    /not valid JSON/i
  );

  assert.throws(
    () => parseFixResponse(""),
    /Empty response/i
  );

  // Valid JSON wrapped in markdown code fences should parse cleanly
  const fenced = "```json\n{\"explanation\":\"ok\",\"modifiedFiles\":[\"a.py\"],\"changes\":[]}\n```";
  const parsed = parseFixResponse(fenced);
  assert.equal(parsed.explanation, "ok");
  assert.deepEqual(parsed.modifiedFiles, ["a.py"]);
});

// ── TEST 7: Test modification rejection ─────────────────────
test("generateFix() rejects LLM attempts to modify test files", async () => {
  const diagnosis = {
    suspectedFile: "src/pricing/discount.py",
    suspectedFunction: "calculate_discount",
    suspectedLocation: "if quantity > 10",
    rootCause: "Boundary bug",
    expectedBehavior: ">= 10",
    actualBehavior: "> 10",
    evidence: [],
    confidence: 0.9,
  };

  const maliciousLlm = {
    async invoke() {
      return {
        content: JSON.stringify({
          explanation: "Modify the test to expect the buggy value instead",
          modifiedFiles: ["tests/test_discount.py"],
          changes: [
            {
              file: "tests/test_discount.py",
              originalCode: "assert result == 1200.0",
              fixedCode: "assert result == 1000.0",
              reason: "Make tests pass without fixing code",
            },
          ],
        }),
      };
    },
  };

  await assert.rejects(
    () => generateFix(discountRepo, "bug", diagnosis, { llm: maliciousLlm }),
    /test file/i
  );
});

// ── TEST 8: Original code mismatch rejection ────────────────
test("generateFix() rejects patch if originalCode is not found in file", async () => {
  const diagnosis = {
    suspectedFile: "src/pricing/discount.py",
    suspectedFunction: "calculate_discount",
    suspectedLocation: "if quantity > 10",
    rootCause: "Boundary bug",
    expectedBehavior: ">= 10",
    actualBehavior: "> 10",
    evidence: [],
    confidence: 0.9,
  };

  const mismatchLlm = {
    async invoke() {
      return {
        content: JSON.stringify({
          explanation: "Replace non-existent code",
          modifiedFiles: ["src/pricing/discount.py"],
          changes: [
            {
              file: "src/pricing/discount.py",
              originalCode: "NON_EXISTENT_CODE_LINE_12345",
              fixedCode: "REPLACEMENT_LINE",
              reason: "Invalid patch test",
            },
          ],
        }),
      };
    },
  };

  await assert.rejects(
    () => generateFix(discountRepo, "bug", diagnosis, { llm: mismatchLlm }),
    /Original code snippet to replace was not found/i
  );
});

// ── TEST 9: fixAgentNode LangGraph wrapper ───────────────────
test("fixAgentNode() returns partial state update compatible with LangGraph", async () => {
  // Test failure on missing state
  const failResult = await fixAgentNode({});
  assert.equal(failResult.patch, null);
  assert.match(failResult.error, /missing/i);
});

// ── TEST 10: getGitDiff() ────────────────────────────────────
test("getGitDiff() executes without throwing and returns a string", async () => {
  const diff = await getGitDiff(projectRoot);
  assert.equal(typeof diff, "string");
});
