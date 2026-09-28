import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  diagnoseBug,
  parseDiagnosisResponse,
} from "../server/agents/diagnosisAgent.js";
import {
  findFunction,
  searchCode,
} from "../server/tools/codeTools.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryPath = path.join(projectRoot, "test-repositories", "discount-bug");
const discountFile = path.join(repositoryPath, "src", "pricing", "discount.py");
const bugReport = "Customers buying exactly 10 items are not receiving the bulk discount.";
const repositoryAnalysis = {
  relevant_files: [
    { path: "src/pricing/discount.py", reason: "Contains discount calculation" },
  ],
  relevant_functions: [
    { file: "src/pricing/discount.py", name: "calculate_discount", line: 7 },
    { file: "src/pricing/discount.py", name: "get_discount_rate", line: 28 },
  ],
  relevant_tests: [
    { path: "tests/test_discount.py", reason: "Tests discount behavior" },
  ],
};

const modelResponse = {
  content: JSON.stringify({
    suspectedFile: "src/pricing/discount.py",
    suspectedFunction: "calculate_discount",
    suspectedLocation: "if quantity > 10",
    rootCause: "The strict comparison excludes exactly 10 from the 20% discount.",
    evidence: [
      "The documentation says 10 or more items receive 20%.",
      "Both discount functions use quantity > 10.",
      "The existing large-discount test only uses quantity 15.",
    ],
    expectedBehavior: "Quantity 10 receives a 20% discount.",
    actualBehavior: "Quantity 10 receives a 10% discount.",
    confidence: 0.98,
  }),
};

const fakeLlm = {
  async invoke() {
    return modelResponse;
  },
};

test("code tools locate the seeded boundary-condition bug", async () => {
  const matches = await searchCode(repositoryPath, "quantity > 10");
  assert.equal(matches.length, 2);
  assert.equal(matches[0].file, "src/pricing/discount.py");

  const functions = await findFunction(repositoryPath, "calculate_discount");
  assert.equal(functions.length, 1);
  assert.equal(functions[0].line, 7);
});

test("diagnosis returns the structured root-cause contract", async () => {
  const before = await readFile(discountFile, "utf8");
  const diagnosis = await diagnoseBug(
    repositoryPath,
    bugReport,
    repositoryAnalysis,
    { llm: fakeLlm }
  );
  const after = await readFile(discountFile, "utf8");

  assert.equal(diagnosis.suspectedFile, "src/pricing/discount.py");
  assert.equal(diagnosis.suspectedFunction, "calculate_discount");
  assert.match(diagnosis.rootCause, /exactly 10/);
  assert.equal(diagnosis.evidence.length, 3);
  assert.equal(diagnosis.confidence, 0.98);
  assert.equal(after, before);
});

test("parser normalizes confidence and evidence", () => {
  const diagnosis = parseDiagnosisResponse(JSON.stringify({
    suspectedFile: "discount.py",
    evidence: ["source evidence", 42],
    confidence: 2,
  }));

  assert.deepEqual(diagnosis.evidence, ["source evidence"]);
  assert.equal(diagnosis.confidence, 1);
});
