/**
 * Shared LangGraph state schema for Code Archaeologist.
 *
 * Each agent adds fields it owns. Other team members will extend
 * this file with their own state fields (diagnosis, patch, etc.).
 */

import { Annotation } from "@langchain/langgraph";

const CodeArchaeologistState = Annotation.Root({
  // ── Inputs ────────────────────────────────────────────────
  bug_report: Annotation({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  repository_path: Annotation({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  // ── Repository Analyst output ─────────────────────────────
  repository_analysis: Annotation({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── Diagnosis Agent output ────────────────────────────────
  diagnosis: Annotation({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── Fix Agent output ──────────────────────────────────────
  patch: Annotation({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── Workflow metadata ─────────────────────────────────────
  iteration: Annotation({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  error: Annotation({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export default CodeArchaeologistState;
