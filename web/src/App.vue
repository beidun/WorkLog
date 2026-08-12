<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "./api";
import AppIcon from "./components/AppIcon.vue";
import AttentionRail from "./components/AttentionRail.vue";
import EvidenceModal from "./components/EvidenceModal.vue";
import MetricStrip from "./components/MetricStrip.vue";
import ProjectDetail from "./components/ProjectDetail.vue";
import ProjectTable from "./components/ProjectTable.vue";
import Sidebar from "./components/Sidebar.vue";
import type { EvidenceRef, Overview, ProjectDetailResponse, ProjectSummary, TimelineEvent } from "./types";

const overview = ref<Overview | null>(null);
const activeSection = ref("overview");
const filter = ref("all");
const query = ref("");
const loading = ref(true);
const error = ref("");
const scanning = ref(false);
const scanLabel = ref("扫描新记录");
const detail = ref<ProjectDetailResponse | null>(null);
const detailLoading = ref(false);
const evidence = ref<Record<string, any> | null>(null);
const evidenceOpen = ref(false);
const evidenceLoading = ref(false);
const dailyReport = ref<Record<string, any> | null>(null);

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
  } finally {
    scanning.value = false;
    scanLabel.value = "扫描新记录";
  }
}

async function openProject(project: ProjectSummary) {
  detailLoading.value = true;
  detail.value = await api.project(project.id);
  detailLoading.value = false;
}

async function openEvidence(event: Pick<TimelineEvent, "id"> | Pick<EvidenceRef, "id">) {
  evidenceOpen.value = true;
  evidenceLoading.value = true;
  evidence.value = await api.evidence(event.id);
  evidenceLoading.value = false;
}

async function navigate(section: string) {
  activeSection.value = section;
  if (section === "reports") dailyReport.value = await api.daily();
}

onMounted(loadOverview);
</script>

<template>
  <div class="app-shell">
    <Sidebar :active="activeSection" :source-counts="overview?.sourceCounts ?? []" @navigate="navigate" />
    <main class="main-area">
      <header class="topbar">
        <div class="search-box"><AppIcon name="search" /><input v-model="query" aria-label="搜索项目" placeholder="搜索项目或工作事项" /></div>
        <button class="scan-button" :disabled="scanning" @click="startScan"><AppIcon name="scan" /><span>{{ scanLabel }}</span></button>
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
            </section>
            <AttentionRail v-if="activeSection === 'overview'" :items="overview.attention" :status-labels="overview.statusLabels" :scan="overview.scan" />
          </div>
        </section>

        <section v-else-if="activeSection === 'reports'" class="report-page">
          <div class="page-intro"><div><h1>今日工作总结</h1><p>按项目汇总今天发生的工作与验证结果。</p></div><time>{{ dailyReport?.date }}</time></div>
          <div class="report-sheet">
            <header><div><span>{{ dailyReport?.projectCount ?? 0 }}</span><p>今日涉及项目</p></div><div><span>{{ dailyReport?.items?.length ?? 0 }}</span><p>工作事项</p></div></header>
            <section v-for="item in dailyReport?.items ?? []" :key="item.id" class="report-entry">
              <p>{{ item.project_name }}</p><h2>{{ item.title }}</h2><span>{{ item.summary }}</span><small>下一步：{{ item.next_step }}</small>
              <div class="citation-list">
                <button v-for="(citation, index) in item.evidence ?? []" :key="citation.id" @click="openEvidence(citation)">[{{ Number(index) + 1 }}] {{ citation.source === 'codex' ? 'Codex' : 'Claude Code' }} · L{{ citation.source_line }}</button>
              </div>
            </section>
            <div v-if="!dailyReport?.items?.length" class="report-empty">今天尚未发现可以汇总的工作事项。</div>
          </div>
        </section>

        <section v-else class="placeholder-page">
          <h1>{{ activeSection === 'review' ? '待确认' : '设置' }}</h1>
          <p>{{ activeSection === 'review' ? '自动合并与项目归属的人工确认入口将在下一个原型迭代开放。' : '数据源排除规则与模型 Provider 配置将在这里管理。' }}</p>
        </section>
      </template>
    </main>

    <ProjectDetail v-if="detail" :detail="detail" :loading="detailLoading" @close="detail = null" @evidence="openEvidence" />
    <EvidenceModal v-if="evidenceOpen" :data="evidence" :loading="evidenceLoading" @close="evidenceOpen = false; evidence = null" />
  </div>
</template>
