<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "./api";
import AppIcon from "./components/AppIcon.vue";
import AttentionRail from "./components/AttentionRail.vue";
import EvidenceModal from "./components/EvidenceModal.vue";
import MetricStrip from "./components/MetricStrip.vue";
import ProjectDetail from "./components/ProjectDetail.vue";
import ProjectTable from "./components/ProjectTable.vue";
import ProviderSettings from "./components/ProviderSettings.vue";
import ReviewQueue from "./components/ReviewQueue.vue";
import Sidebar from "./components/Sidebar.vue";
import WorkReportView from "./components/WorkReport.vue";
import type { EvidenceRef, Overview, ProjectDetailResponse, ProjectSummary, ReviewQueueItem, TimelineEvent, WorkItemEvalScore, WorkReport, WorkReportRange } from "./types";

const overview = ref<Overview | null>(null);
const activeSection = ref("overview");
const filter = ref("all");
const query = ref("");
const loading = ref(true);
const error = ref("");
const scanning = ref(false);
const scanLabel = ref("扫描新记录");
const detail = ref<ProjectDetailResponse | null>(null);
const detailFocusId = ref<string | null>(null);
const detailLoading = ref(false);
const evidence = ref<Record<string, any> | null>(null);
const evidenceOpen = ref(false);
const evidenceLoading = ref(false);
const workReport = ref<WorkReport | null>(null);
const reportRange = ref<WorkReportRange>("today");
const reportLoading = ref(false);
const reportError = ref("");
const reviewItems = ref<ReviewQueueItem[]>([]);
const reviewScore = ref<WorkItemEvalScore | null>(null);
const reviewLoading = ref(false);
const reviewError = ref("");
const reviewExporting = ref(false);
const reviewExportMessage = ref("");

const filteredProjects = computed(() => {
  if (!overview.value) return [];
  return overview.value.projects.filter((project) => {
    const matchesQuery = !query.value || `${project.name} ${project.current_focus ?? ""}`.toLowerCase().includes(query.value.toLowerCase());
    if (!matchesQuery) return false;
    if (filter.value === "active") return Number(project.active_count) > 0;
    if (filter.value === "attention") return Number(project.blocked_count) > 0 || Number(project.unverified_count) > 0;
    if (filter.value === "verified") return Number(project.verified_count) > 0;
    return true;
  });
});

async function loadOverview() {
  try {
    overview.value = await api.overview();
    error.value = "";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    loading.value = false;
  }
}

async function startScan() {
  scanning.value = true;
  scanLabel.value = "正在扫描";
  try {
    await api.scan();
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const state = await api.scanStatus();
      if (state.stats) scanLabel.value = `${state.stats.filesScanned}/${state.stats.filesDiscovered}`;
      if (!state.running) break;
    }
    await loadOverview();
    if (activeSection.value === "reports") await loadWorkReport(reportRange.value);
  } finally {
    scanning.value = false;
    scanLabel.value = "扫描新记录";
  }
}

async function openProject(project: ProjectSummary, focusWorkItemId: string | null = null) {
  detailFocusId.value = focusWorkItemId;
  detailLoading.value = true;
  detail.value = await api.project(project.id);
  detailLoading.value = false;
}

async function refreshProject() {
  const projectId = detail.value?.project.id;
  if (!projectId) return;
  detailLoading.value = true;
  try {
    detail.value = await api.project(projectId);
    workReport.value = null;
    await Promise.all([loadOverview(), activeSection.value === "review" ? loadReviewQueue() : Promise.resolve()]);
  } finally {
    detailLoading.value = false;
  }
}

async function openEvidence(event: Pick<TimelineEvent, "id"> | Pick<EvidenceRef, "id">) {
  evidenceOpen.value = true;
  evidenceLoading.value = true;
  evidence.value = await api.evidence(event.id);
  evidenceLoading.value = false;
}

async function navigate(section: string) {
  activeSection.value = section;
  if (section === "reports" && !workReport.value) await loadWorkReport(reportRange.value);
  if (section === "review") await loadReviewQueue();
}

async function loadReviewQueue() {
  reviewLoading.value = true;
  reviewError.value = "";
  try {
    const [queue, score] = await Promise.all([api.reviewQueue(), api.evalScore()]);
    reviewItems.value = queue.items;
    reviewScore.value = score;
  } catch (reason) {
    reviewError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    reviewLoading.value = false;
  }
}

async function openReviewProject(projectId: string, workItemId: string) {
  const project = overview.value?.projects.find((item) => item.id === projectId);
  if (project) await openProject(project, workItemId);
}

async function openAttentionProject(projectId: string, workItemId: string) {
  const project = overview.value?.projects.find((item) => item.id === projectId);
  if (project) await openProject(project, workItemId);
}

async function openProgressChange(change: { projectId: string; workItemId: string }) {
  const project = overview.value?.projects.find((item) => item.id === change.projectId);
  if (project) await openProject(project, change.workItemId);
}

async function openReportProject(target: { projectId: string; workItemId: string }) {
  const project = overview.value?.projects.find((item) => item.id === target.projectId);
  if (project) await openProject(project, target.workItemId);
}

function changeLabel(type: string): string {
  return ({
    started: "新事项",
    progress_updated: "进展更新",
    completed: "已完成",
    validation_added: "新增验证",
    blocker_added: "出现阻塞",
    blocker_resolved: "阻塞解除",
  } as Record<string, string>)[type] ?? "进度变化";
}

async function exportReviewSamples() {
  reviewExporting.value = true;
  reviewExportMessage.value = "";
  try {
    const suite = await api.exportEval();
    const blob = new Blob([JSON.stringify(suite, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `work-items-eval-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    reviewExportMessage.value = `已导出 ${suite.cases.length} 条已标注样本`;
  } catch (reason) {
    reviewExportMessage.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    reviewExporting.value = false;
  }
}

async function loadWorkReport(range: WorkReportRange) {
  reportRange.value = range;
  reportLoading.value = true;
  reportError.value = "";
  try {
    workReport.value = await api.workReport(range);
  } catch (reason) {
    reportError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    reportLoading.value = false;
  }
}

onMounted(loadOverview);
</script>

<template>
  <div class="app-shell">
    <Sidebar :active="activeSection" :source-counts="overview?.sourceCounts ?? []" @navigate="navigate" />
    <main class="main-area">
      <header class="topbar">
        <div class="search-box"><AppIcon name="search" /><input v-model="query" aria-label="搜索项目" placeholder="搜索项目或工作事项" /></div>
        <button class="scan-button" aria-label="扫描新记录" :disabled="scanning" @click="startScan"><AppIcon name="scan" /><span>{{ scanLabel }}</span></button>
      </header>

      <div v-if="loading" class="page-loading"><span></span><p>正在读取本地工作记录…</p></div>
      <div v-else-if="error" class="page-error"><strong>无法连接本地服务</strong><p>{{ error }}</p></div>
      <template v-else-if="overview">
        <section v-if="activeSection === 'overview' || activeSection === 'projects'" class="dashboard-page">
          <div class="page-intro">
            <div><h1>{{ activeSection === 'projects' ? '所有项目' : '项目进展' }}</h1><p>从 AI 对话与工具证据中还原真实工作状态。</p></div>
            <time>更新于 {{ new Date(overview.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</time>
          </div>
          <MetricStrip v-if="activeSection === 'overview'" :metrics="overview.metrics" />
          <div class="dashboard-grid">
            <section class="project-region">
              <div class="section-toolbar">
                <div><h2>{{ activeSection === 'projects' ? '项目列表' : '最近项目' }}</h2><span>{{ filteredProjects.length }}</span></div>
                <div class="filter-tabs">
                  <button v-for="option in [{id:'all',label:'全部'},{id:'active',label:'进行中'},{id:'attention',label:'需关注'},{id:'verified',label:'已验证'}]" :key="option.id" :class="{ active: filter === option.id }" @click="filter = option.id">{{ option.label }}</button>
                </div>
              </div>
              <ProjectTable :projects="filteredProjects" :status-labels="overview.statusLabels" @select="openProject" />
              <section v-if="activeSection === 'overview' && overview.recentChanges?.length" class="overview-changes">
                <div class="section-heading"><div><span>扫描对比</span><h2>最近变化</h2></div><small>最近一次完整扫描</small></div>
                <article v-for="change in overview.recentChanges" :key="change.id" tabindex="0" role="button"
                  @click="openProgressChange(change)"
                  @keydown.enter="openProgressChange(change)"
                  @keydown.space.prevent="openProgressChange(change)">
                  <span :class="['change-dot', change.changeType]"></span>
                  <div><strong>{{ changeLabel(change.changeType) }} · {{ change.title }}</strong><p>{{ change.projectName }} · {{ new Date(change.detectedAt).toLocaleString('zh-CN') }}</p></div>
                  <button v-if="change.evidenceIds[0]" @click.stop="openEvidence({ id: change.evidenceIds[0] })">证据</button>
                </article>
              </section>
            </section>
            <AttentionRail v-if="activeSection === 'overview'" :items="overview.attention" :status-labels="overview.statusLabels" :scan="overview.scan" @project="openAttentionProject" />
          </div>
        </section>

        <WorkReportView v-else-if="activeSection === 'reports'" :report="workReport" :range="reportRange" :loading="reportLoading" :error="reportError" @range="loadWorkReport" @evidence="openEvidence" @project="openReportProject" />

        <ProviderSettings v-else-if="activeSection === 'settings'" />

        <ReviewQueue v-else-if="activeSection === 'review'" :items="reviewItems" :score="reviewScore" :loading="reviewLoading || reviewExporting" :error="reviewError" :message="reviewExportMessage" @project="openReviewProject" @export="exportReviewSamples" />

        <section v-else class="placeholder-page">
          <h1>设置</h1>
          <p>数据源排除规则与模型 Provider 配置将在这里管理。</p>
        </section>
      </template>
    </main>

    <ProjectDetail v-if="detail" :detail="detail" :focus-work-item-id="detailFocusId" :loading="detailLoading" @close="detail = null; detailFocusId = null" @evidence="openEvidence" @changed="refreshProject" />
    <EvidenceModal v-if="evidenceOpen" :data="evidence" :loading="evidenceLoading" @close="evidenceOpen = false; evidence = null" />
  </div>
</template>
