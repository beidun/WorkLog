<script setup lang="ts">
import type { ReviewQueueItem, WorkItemEvalScore, WorkItemFeedbackType } from "../types";

defineProps<{ items: ReviewQueueItem[]; score: WorkItemEvalScore | null; loading: boolean; error: string; message: string }>();
const emit = defineEmits<{ project: [projectId: string, workItemId: string]; export: [] }>();

const labels: Record<WorkItemFeedbackType, string> = {
  accurate: "准确",
  title_wrong: "标题不准",
  split_needed: "应拆分",
  merge_needed: "应合并",
  status_wrong: "状态错",
  summary_wrong: "摘要缺项",
  citation_wrong: "引用不对",
};

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "暂无时间";
}
</script>

<template>
  <section class="review-page">
    <div class="page-intro review-intro">
      <div><h1>待确认</h1><p>给自动识别结果打标签，积累真实评测样本，下一轮专门修正高频错误。</p></div>
      <button class="primary-action review-export" :disabled="loading" @click="emit('export')">导出评测集</button>
    </div>
    <div v-if="loading" class="review-state"><span></span><p>正在读取待确认事项…</p></div>
    <div v-else-if="error" class="review-state error"><strong>待确认列表读取失败</strong><p>{{ error }}</p></div>
    <template v-else>
      <p v-if="message" class="review-notice">{{ message }}</p>
      <div class="review-guide"><strong>怎么标注</strong><span>打开事项后，在“帮助改进识别”区域选择标签；需要更具体的目标、摘要或状态，可继续使用事项编辑。</span><small>已标注 {{ items.filter((item) => item.feedback.length > 0).length }} / {{ items.length }}</small></div>
      <div v-if="score" class="review-score" aria-label="评测概览">
        <div class="review-score-card"><strong>{{ score.reviewedItems }} / {{ score.totalItems }}</strong><span>评测覆盖</span><small>{{ Math.round(score.coverage * 100) }}%</small></div>
        <div class="review-score-card"><strong>{{ score.confirmedAccurate }}</strong><span>人工确认准确</span><small>共 {{ score.reviewedItems }} 条</small></div>
        <div class="review-score-card"><strong>{{ Math.round(score.errorRates.title_wrong * 100) }}%</strong><span>标题错误</span><small>{{ score.errorCounts.title_wrong }} 条</small></div>
        <div class="review-score-card"><strong>{{ Math.round(score.errorRates.status_wrong * 100) }}%</strong><span>状态错误</span><small>{{ score.errorCounts.status_wrong }} 条</small></div>
        <div class="review-score-card"><strong>{{ Math.round(score.errorRates.citation_wrong * 100) }}%</strong><span>引用错误</span><small>{{ score.errorCounts.citation_wrong }} 条</small></div>
      </div>
      <div v-if="score?.topErrors.length" class="review-top-errors"><strong>下一轮优先修正</strong><span v-for="error in score.topErrors.slice(0, 3)" :key="error.type">{{ error.label }} {{ Math.round(error.rate * 100) }}%</span></div>
      <div v-if="items.length" class="review-list">
        <button v-for="item in items" :key="item.id" class="review-row" @click="emit('project', item.projectId, item.id)">
          <span class="review-row-copy"><span><strong>{{ item.title }}</strong><small>{{ item.projectName }} · {{ date(item.lastActivityAt) }}</small></span><p>{{ item.summary }}</p></span>
          <span class="review-row-meta"><span :class="['review-badge', { done: item.feedback.length > 0 }]">{{ item.feedback.length ? `${item.feedback.length} 条标注` : '待确认' }}</span><span>{{ Math.round(item.confidence * 100) }}%</span></span>
          <span v-if="item.feedback.length" class="review-tags"><em v-for="feedback in item.feedback" :key="feedback.type">{{ labels[feedback.type] }}</em></span>
        </button>
      </div>
      <div v-else class="review-empty"><strong>暂无工作事项</strong><p>完成一次扫描后，这里会列出自动识别的工作事项。</p></div>
    </template>
  </section>
</template>
