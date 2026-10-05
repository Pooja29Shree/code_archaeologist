# Code Archaeologist

Code Archaeologist is a multi-agent system for investigating and repairing bugs in existing software repositories. It separates repository understanding, diagnosis, repair, testing, and final validation so every stage produces evidence for the next stage.

The project is designed as a five-agent pipeline. Each agent has a focused responsibility and communicates with the next agent through structured shared state.

## Workflow

```text
Bug report
    |
    v
1. Repository Analyst -> repository structure and relevant code
    |
    v
2. Diagnosis Agent -> faulty location, root cause, and evidence
    |
    v
3. Fix Agent -> minimal, reversible patch
    |
    v
4. QA Agent -> targeted tests and regression results
    |
    v
5. Review Agent -> final validation and workflow routing
```

The shared LangGraph state carries each stage's result. If QA fails, the workflow can route feedback back to the Fix Agent, subject to an iteration limit.

## Agent Responsibilities

| Agent | Responsibility | Output |
| --- | --- | --- |
| Repository Analyst | Understand the repository and execution path | Relevant files, functions, tests, dependencies, and summary |
| Diagnosis Agent | Locate and explain the root cause | Suspected location, root cause, evidence, and confidence |
| Fix Agent | Create the smallest appropriate repair | Modified files, patch, explanation, and reversibility |
| QA Agent | Test the proposed repair | Passed tests, failures, regressions, and feedback |
| Review Agent | Validate the complete repair and coordinate retries | Verification status and routing decision |

## Project Struct

```text
server/
  agents/       Agent implementations
  graph/        Shared state and workflow graph
  prompts/      LLM prompt templates
    tools/        Repository, analysis, patch, and testing tools
test-repositories/  Small repositories containing seeded bugs
tests/              Unit tests for agent components
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

## Shared State

Agents communicate through a shared state containing values such as:

```json
{
    "bug_report": "",
    "repository_path": "",
    "repository_analysis": null,
    "diagnosis": null,
    "patch": null,
    "test_results": null,
    "validation": null,
    "iteration": 0
}
```

Each agent should preserve the evidence it receives and only update the fields it owns.

## Component Contracts

The Diagnosis Agent consumes the bug report and repository analysis, then returns:

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

The Diagnosis Agent does not modify source files or generate patches. The Fix Agent owns code changes. Other agents follow the corresponding responsibilities in the table above.

## Demo Repository

The seeded demo is in `test-repositories/discount-bug`. Its requirement says that quantities of 10 or more receive a 20% discount, while the intentionally faulty implementation uses `quantity > 10`. This gives the complete pipeline a small, reproducible boundary-condition bug to investigate, repair, test, and validate.

## Tests

Run the available automated tests without an API key:

```powershell
npm run diagnosis:test
```

The tests verify code search, function localization, diagnosis parsing, evidence handling, and that diagnosis leaves the target repository unchanged. Add focused tests for each agent as its implementation is added.

## Current Commands

Run the Repository Analyst against a repository:

```powershell
npm run analyst -- --repo <path> --bug "<bug description>"
```

The Diagnosis Agent can also be invoked directly when supplied with a repository path and bug report:

```powershell
node server/agents/diagnosisAgent.js --repo <path> --bug "<bug description>"
```

The full workflow command will be added when the remaining agent nodes and graph routing are implemented.

## Contribution Flow

Create a focused branch, make small commits, run the relevant tests, and open a pull request into `main`. Keep agent responsibilities separate and preserve structured evidence between workflow stages.
