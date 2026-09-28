import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  findFunction,
  readRelevantFiles,
  searchCode,
} from "../tools/codeTools.js";
import {
  getSystemPrompt,
  getUserPrompt,
} from "../prompts/diagnosisPrompt.js";

const LLM_MODEL = process.env.DIAGNOSIS_MODEL || "gemini-3.8-flash";
const LLM_TEMPERATURE = 0.1;

const EMPTY_DIAGNOSIS = {
  suspectedFile: "",
  suspectedFunction: "",
  suspectedLocation: "",
  rootCause: "",
  evidence: [],
  expectedBehavior: "",
  actualBehavior: "",
  confidence: 0,
};

/**
 * Diagnose a bug using Member 1's analysis and read-only source evidence.
 *
 * @param {string} repositoryPath
 * @param {string} bugReport
 * @param {object} repositoryAnalysis
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function diagnoseBug(
  repositoryPath,
  bugReport,
  repositoryAnalysis,
  options = {}
) {
  if (!repositoryPath) throw new Error("repositoryPath is required");
  if (!bugReport) throw new Error("bugReport is required");
  if (!repositoryAnalysis) throw new Error("repositoryAnalysis is required");

  const codeEvidence = await collectEvidence(
    repositoryPath,
    bugReport,
    repositoryAnalysis
  );
  const llm = options.llm || new ChatGoogleGenerativeAI({
    model: options.model || LLM_MODEL,
    temperature: LLM_TEMPERATURE,
  });

  const response = await llm.invoke([
    { role: "system", content: getSystemPrompt() },
    {
      role: "user",
      content: getUserPrompt(bugReport, repositoryAnalysis, codeEvidence),
    },
  ]);

  return parseDiagnosisResponse(response.content);
}

/** LangGraph-compatible node wrapper. */
export async function diagnosisAgentNode(state) {
  try {
    const diagnosis = await diagnoseBug(
      state.repository_path,
      state.bug_report,
      state.repository_analysis
    );
    return { diagnosis, error: null };
  } catch (err) {
    console.error("[Diagnosis Agent] Error:", err.message);
    return {
      diagnosis: null,
      error: `Diagnosis Agent failed: ${err.message}`,
    };
  }
}

async function collectEvidence(repositoryPath, bugReport, repositoryAnalysis) {
  const evidence = [];
  const relevantFiles = await readRelevantFiles(repositoryPath, repositoryAnalysis);

  for (const [file, content] of Object.entries(relevantFiles)) {
    evidence.push({ file, source: content });
  }

  const functionItems = repositoryAnalysis.relevant_functions || [];
  for (const item of functionItems) {
    const functionName = item.name || item;
    if (!functionName) continue;
    evidence.push({
      function: functionName,
      declarations: await findFunction(repositoryPath, functionName),
    });
  }

  const searchTerms = new Set(functionItems.map((item) => item.name || item));
  for (const term of bugReport.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
    if (term.length >= 5) searchTerms.add(term);
  }

  for (const term of [...searchTerms].slice(0, 12)) {
    const matches = await searchCode(repositoryPath, term);
    if (matches.length > 0) evidence.push({ query: term, matches });
  }

  return evidence;
}

/** Parse and validate the model response against the Member 2 contract. */
export function parseDiagnosisResponse(raw) {
  const text = extractText(raw).trim();
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    const parsed = JSON.parse(cleaned);
    return {
      suspectedFile: stringValue(parsed.suspectedFile),
      suspectedFunction: stringValue(parsed.suspectedFunction),
      suspectedLocation: stringValue(parsed.suspectedLocation),
      rootCause: stringValue(parsed.rootCause),
      evidence: Array.isArray(parsed.evidence)
        ? parsed.evidence.filter((item) => typeof item === "string")
        : [],
      expectedBehavior: stringValue(parsed.expectedBehavior),
      actualBehavior: stringValue(parsed.actualBehavior),
      confidence: clampConfidence(parsed.confidence),
    };
  } catch (err) {
    throw new Error(`Diagnosis response was not valid JSON: ${err.message}`);
  }
}

function extractText(raw) {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return raw?.text || "";
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampConfidence(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return EMPTY_DIAGNOSIS.confidence;
  return Math.max(0, Math.min(1, number));
}

async function main() {
  const args = process.argv.slice(2);
  const repoIndex = args.indexOf("--repo");
  const bugIndex = args.indexOf("--bug");
  if (repoIndex === -1 || bugIndex === -1) {
    console.error("Usage: node server/agents/diagnosisAgent.js --repo <path> --bug <description>");
    process.exit(1);
  }

  const diagnosis = await diagnoseBug(
    args[repoIndex + 1],
    args[bugIndex + 1],
    { relevant_files: [], relevant_functions: [], relevant_tests: [] }
  );
  console.log(JSON.stringify(diagnosis, null, 2));
}

const isDirectRun = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
