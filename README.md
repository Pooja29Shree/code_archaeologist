# Code Archaeologist

Code Archaeologist is a multi-agent system for investigating and repairing bugs in existing repositories. It separates repository understanding, diagnosis, repair, testing, and final validation so every stage produces evidence for the next stage.

## Workflow

```text
Bug report
    |
    v
1. Repository Analyst -> relevant files, functions, tests, and execution flow
    |
    v
2. Diagnosis Agent -> faulty location, root cause, evidence, and confidence
    |
    v
3. Fix Agent -> minimal reversible patch
    |
    v
4. QA Agent -> targeted and regression test results
    |
    v
5. Review Agent -> final validation and routing
```

The shared LangGraph state carries each stage's result. If QA fails, the workflow can route feedback back to the Fix Agent, subject to an iteration limit.

## Project Structure

```text
server/
  agents/       Agent implementations
  graph/        Shared state and workflow graph
  prompts/      LLM prompt templates
  tools/        Read-only analysis and repository tools
test-repositories/  Small repositories with seeded bugs
tests/              Agent tests
```

## Requirements

- Node.js 20 or newer
- A Google Generative AI API key for live LLM execution

Install dependencies:

```powershell
npm install
```

Set the API key before running an LLM-backed agent:

```powershell
$env:GOOGLE_API_KEY = "your-api-key"
```

## Diagnosis Agent

Member 2 owns the Diagnosis Agent. It consumes the bug report and Member 1's `repository_analysis`, then returns this read-only diagnosis contract:

```json
{
  "suspectedFile": "string",
  "suspectedFunction": "string",
  "suspectedLocation": "string",
  "rootCause": "string",
  "evidence": ["string"],
  "expectedBehavior": "string",
  "actualBehavior": "string",
  "confidence": 0.0
}
```

The Diagnosis Agent does not modify source files and does not generate patches. The Fix Agent owns code changes.

## Demo Repository

The seeded demo is in `test-repositories/discount-bug`. Its requirement says that quantities of 10 or more receive a 20% discount. The intentionally faulty implementation uses `quantity > 10`, allowing the Diagnosis Agent to demonstrate boundary-condition analysis.

## Tests

Run the Member 2 tests without an API key:

```powershell
npm run diagnosis:test
```

The tests verify code search, function localization, diagnosis parsing, evidence handling, and that diagnosis leaves the target repository unchanged.

## Agent Commands

Run the Repository Analyst against a repository:

```powershell
npm run analyst -- --repo <path> --bug "<bug description>"
```

The Diagnosis Agent can be invoked directly when supplied with a repository path and bug report:

```powershell
node server/agents/diagnosisAgent.js --repo <path> --bug "<bug description>"
```

## Contribution Flow

Create a focused branch, make small commits, run the relevant tests, and open a pull request into `main`. Keep agent responsibilities separate and preserve structured evidence between workflow stages.
