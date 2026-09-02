<script setup lang="ts">
import type { EvidenceRef, WorkReport, WorkReportRange } from "../types";

defineProps<{
  report: WorkReport | null;
  range: WorkReportRange;
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  range: [range: WorkReportRange];
  evidence: [evidence: Pick<EvidenceRef, "id">];
  project: [target: { projectId: string; workItemId: string }];
}>();

const ranges: Array<{ id: WorkReportRange; label: string }> = [
  { id: "today", label: "今天" },
  { id: "yesterday", label: "昨天" },
  { id: "week", label: "本周" },
];

const categoryLabels = { active: "正在推进", completed: "已验证", unverified: "待验证", blocked: "阻塞" };
const changeLabels: Record<string, string> = {
  started: "新增事项",
  progress_updated: "进展更新",
  completed: "完成",
  validation_added: "新增验证",
  blocker_added: "出现阻塞",
  blocker_resolved: "解除阻塞",
};

function sourceName(source: string): string {
  return source === "codex" ? "Codex" : source === "claude_code" ? "Claude Code" : source;
}

function periodLabel(report: WorkReport): string {
  return report.startDate === report.endDate ? report.startDate : `${report.startDate} 至 ${report.endDate}`;
}
</script>

<template>
  <section class="report-page">
    <div class="page-intro report-intro">
      <div><h1>工作总结</h1><p>先展示该时间范围内真实发生的活动，再单独标出历史延续状态；每条结论都保留本地证据。</p></div>
      <time v-if="report">{{ periodLabel(report) }}</time>
    </div>

    <div class="report-range-tabs" role="tablist" aria-label="工作总结时间范围">
      <button v-for="option in ranges" :key="option.id" role="tab" :aria-selected="range === option.id" :class="{ active: range === option.id }" @click="emit('range', option.id)">{{ option.label }}</button>
    </div>

    <div v-if="loading" class="report-state"><span></span><p>正在生成本地工作总结…</p></div>
    <div v-else-if="error" class="report-state error"><strong>工作总结生成失败</strong><p>{{ error }}</p></div>
    <template v-else-if="report">
      <div class="report-metrics" aria-label="工作总结指标">
        <div><strong>{{ report.projectCount }}</strong><span>项目</span></div>
        <div><strong>{{ report.itemCount }}</strong><span>事项</span></div>
        <div><strong>{{ report.metrics.completed }}</strong><span>已验证</span></div>
        <div><strong>{{ report.metrics.unverified }}</strong><span>待验证</span></div>
        <div :class="{ danger: report.metrics.blocked > 0 }"><strong>{{ report.metrics.blocked }}</strong><span>阻塞</span></div>
      </div>
      <div class="report-trust-note">
        <span><strong>{{ report.metrics.changedItems }}</strong> 项有本时段对话活动</span>
        <span v-if="report.metrics.carryoverItems"><strong>{{ report.metrics.carryoverItems }}</strong> 项为历史延续状态，未计入本时段进展</span>
        <span v-else>没有把历史遗留事项误算成本时段进展</span>
      </div>

      <section v-if="report.changes.length" class="report-changes">
        <div class="report-section-title"><div><span>扫描对比</span><h2>最近变化</h2></div><p>来自前后两次完整扫描的差异</p></div>
        <div class="change-list">
          <article v-for="change in report.changes" :key="change.id" class="change-row">
            <span :class="['change-type', change.type]">{{ changeLabels[change.type] ?? change.type }}</span>
            <div><strong>{{ change.title }}</strong><p>{{ change.projectName }}</p></div>
            <div class="change-actions"><button @click="emit('project', { projectId: change.projectId, workItemId: change.workItemId })">定位事项</button><button v-if="change.evidence[0]" @click="emit('evidence', change.evidence[0])">查看证据</button></div>
          </article>
        </div>
      </section>

      <div v-if="report.projects.length" class="report-projects">
        <details v-for="project in report.projects" :key="project.id" class="report-project" open>
          <summary>
            <div><span>PROJECT</span><h2>{{ project.name }}</h2><p><b>本时段：</b>{{ project.todaySummary }} <em>当前：{{ project.currentSummary }}</em></p></div>
            <div class="project-report-counts"><span v-if="project.counts.active">{{ project.counts.active }} 推进</span><span v-if="project.counts.completed">{{ project.counts.completed }} 已验证</span><span v-if="project.counts.unverified">{{ project.counts.unverified }} 待验证</span><span v-if="project.counts.blocked" class="danger">{{ project.counts.blocked }} 阻塞</span></div>
          </summary>
          <div v-if="project.agent" class="report-agent-summary"><strong>Agent 判断</strong><span>{{ project.agent.summary }}</span><small>{{ project.agent.provider }} · {{ new Date(project.agent.updatedAt).toLocaleString('zh-CN') }}</small><div v-if="project.agent.evidence.length" class="report-agent-citations"><button v-for="(citation, index) in project.agent.evidence" :key="citation.id" @click="emit('evidence', citation)">证据 {{ index + 1 }} · L{{ citation.source_line }}</button></div></div>

          <div class="report-item-list">
            <article v-for="item in project.items" :key="item.id" class="report-item">
              <header>
                <div><span :class="['report-status', item.category]">{{ categoryLabels[item.category] }}</span><h3>{{ item.title }}</h3></div>
                <div class="report-item-header-actions"><time>{{ new Date(item.lastActivityAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</time><button class="report-item-open" @click="emit('project', { projectId: item.projectId, workItemId: item.id })">查看事项</button></div>
              </header>
              <p class="report-summary">{{ item.summary }}</p>
              <div v-if="item.changeSummary.length" class="report-change-summary">
                <strong>本时段变化</strong>
                <ul><li v-for="value in item.changeSummary" :key="value">{{ value }}</li></ul>
              </div>
              <div v-if="item.completed.length || item.validations.length || item.blockers.length || item.remaining.length" class="report-facts">
                <div v-if="item.completed.length"><strong>已完成</strong><ul><li v-for="value in item.completed" :key="value">{{ value }}</li></ul></div>
                <div v-if="item.validations.length"><strong>验证记录</strong><ul><li v-for="value in item.validations" :key="value">{{ value }}</li></ul></div>
                <div v-if="item.blockers.length" class="danger"><strong>阻塞</strong><ul><li v-for="value in item.blockers" :key="value">{{ value }}</li></ul></div>
                <div v-if="item.remaining.length"><strong>待处理</strong><ul><li v-for="value in item.remaining" :key="value">{{ value }}</li></ul></div>
              </div>
              <div v-if="item.nextStep" class="report-next"><span>下一步</span><p>{{ item.nextStep }}</p></div>
              <div class="citation-list">
                <button v-for="(citation, index) in item.evidence" :key="citation.id" @click="emit('evidence', citation)">[{{ Number(index) + 1 }}] {{ sourceName(citation.source) }} · L{{ citation.source_line }}</button>
              </div>
            </article>
          </div>
          <section v-if="project.carryoverItems.length" class="report-carryover">
            <header><div><span>CONTINUING</span><h3>历史延续事项</h3></div><p>本时段没有新的对话活动，仅展示当前仍未结束的状态</p></header>
            <article v-for="item in project.carryoverItems" :key="item.id" class="report-item carryover-item">
              <header>
                <div><span :class="['report-status', item.category]">{{ categoryLabels[item.category] }}</span><h3>{{ item.title }}</h3></div>
                <div class="report-item-header-actions"><time>上次活动 {{ new Date(item.lastActivityAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</time><button class="report-item-open" @click="emit('project', { projectId: item.projectId, workItemId: item.id })">查看事项</button></div>
              </header>
              <p class="report-summary">{{ item.summary }}</p>
              <div class="carryover-note">{{ item.changeSummary[0] }}</div>
              <div v-if="item.nextStep" class="report-next"><span>下一步</span><p>{{ item.nextStep }}</p></div>
              <div class="citation-list">
                <button v-for="(citation, index) in item.evidence" :key="citation.id" @click="emit('evidence', citation)">[{{ Number(index) + 1 }}] {{ sourceName(citation.source) }} · L{{ citation.source_line }}</button>
              </div>
            </article>
          </section>
        </details>
      </div>

      <div v-else class="report-empty-state">
        <strong>{{ report.label }}没有可汇总的对话活动</strong>
        <p>这里不会把此前仍处于“进行中”的事项误算成本时段进展。完成一次新工作后点击右上角“扫描新记录”即可更新。</p>
      </div>
    </template>
  </section>
</template>
