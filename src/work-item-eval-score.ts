import type { WorklogDatabase } from "./db";
import { getWorkItemFeedback, type StoredWorkItemFeedback } from "./work-item-feedback";
import type { WorkItemFeedbackType } from "./types";

export const EVAL_ERROR_TYPES = [
  "title_wrong",
  "split_needed",
  "merge_needed",
  "status_wrong",
  "summary_wrong",
  "citation_wrong",
] as const satisfies readonly WorkItemFeedbackType[];

export type EvalErrorType = typeof EVAL_ERROR_TYPES[number];

export const FEEDBACK_LABELS: Record<WorkItemFeedbackType, string> = {
  accurate: "整体准确",
  title_wrong: "标题不准",
  split_needed: "应该拆分",
  merge_needed: "应该合并",
  status_wrong: "状态错误",
  summary_wrong: "摘要缺项",
  citation_wrong: "引用不对",
};

export interface WorkItemEvalScore {
  version: 1;
  generatedAt: string;
  totalItems: number;
  reviewedItems: number;
  unreviewedItems: number;
  coverage: number;
  confirmedAccurate: number;
  errorCounts: Record<EvalErrorType, number>;
  errorRates: Record<EvalErrorType, number>;
  topErrors: Array<{ type: EvalErrorType; label: string; count: number; rate: number }>;
}

function emptyCounts(): Record<EvalErrorType, number> {
  return Object.fromEntries(EVAL_ERROR_TYPES.map((type) => [type, 0])) as Record<EvalErrorType, number>;
}

function feedbackTypes(feedback: StoredWorkItemFeedback[]): Set<WorkItemFeedbackType> {
  return new Set(feedback.map((entry) => entry.type));
}

export function scoreWorkItemEval(database: WorklogDatabase): WorkItemEvalScore {
  const ids = (database.db.query("SELECT id FROM work_items").all() as Array<{ id: string }>).map((row) => row.id);
  const errorCounts = emptyCounts();
  let reviewedItems = 0;
  let confirmedAccurate = 0;

  for (const id of ids) {
    const types = feedbackTypes(getWorkItemFeedback(database, id));
    if (types.size === 0) continue;
    reviewedItems += 1;
    if (types.has("accurate")) confirmedAccurate += 1;
    for (const type of EVAL_ERROR_TYPES) if (types.has(type)) errorCounts[type] += 1;
  }

  const denominator = reviewedItems || 1;
  const errorRates = Object.fromEntries(EVAL_ERROR_TYPES.map((type) => [type, errorCounts[type] / denominator])) as Record<EvalErrorType, number>;
  const topErrors = EVAL_ERROR_TYPES
    .map((type) => ({ type, label: FEEDBACK_LABELS[type], count: errorCounts[type], rate: errorRates[type] }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count || EVAL_ERROR_TYPES.indexOf(left.type) - EVAL_ERROR_TYPES.indexOf(right.type));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    totalItems: ids.length,
    reviewedItems,
    unreviewedItems: Math.max(0, ids.length - reviewedItems),
    coverage: ids.length === 0 ? 0 : reviewedItems / ids.length,
    confirmedAccurate,
    errorCounts,
    errorRates,
    topErrors,
  };
}
