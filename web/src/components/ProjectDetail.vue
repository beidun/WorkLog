<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { api } from "../api";
import type { EvidenceRef, ProjectCorrectionPayload, ProjectDetailResponse, ProjectWorkstream, TimelineEvent, WorkItem, WorkItemCorrectionPayload, WorkItemFeedbackType } from "../types";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{ detail: ProjectDetailResponse; focusWorkItemId: string | null; loading: boolean }>();
const emit = defineEmits<{ close: []; evidence: [event: TimelineEvent | EvidenceRef]; changed: [] }>();
const editingId = ref<string | null>(null);
const savingId = ref<string | null>(null);
const correctionError = ref("");
const correctionForm = ref<WorkItemCorrectionPayload>({ title: "", summary: "", status: "planned", nextStep: "" });
const projectForm = ref<ProjectCorrectionPayload>({ projectId: "" });
const feedbackSavingId = ref<string | null>(null);
const feedbackError = ref("");
const feedbackNotes = ref<Record<string, string>>({});

async function focusWorkItem(): Promise<void> {
  if (!props.focusWorkItemId) return;
  await nextTick();
  const target = document.getElementById(`work-item-${props.focusWorkItemId}`);
  target?.scrollIntoView({ block: "center" });
  target?.focus({ preventScroll: true });
}

onMounted(focusWorkItem);
watch(() => [props.detail.project.id, props.focusWorkItemId], focusWorkItem);

const feedbackOptions: Array<{ type: WorkItemFeedbackType; label: string; title: string }> = [
  { type: "accurate", label: "准确", title: "当前事项判断准确" },
  { type: "title_wrong", label: "标题不准", title: "标题没有准确概括工作目标" },
  { type: "split_needed", label: "应拆分", title: "同一事项包含多个不同工作目标" },
  { type: "merge_needed", label: "应合并", title: "应该和其他事项合并" },
  { type: "status_wrong", label: "状态错", title: "完成状态判断不正确" },
  { type: "summary_wrong", label: "摘要缺项", title: "摘要缺少关键进展" },
  { type: "citation_wrong", label: "引用不对", title: "引用没有支撑当前结论" },
];

function beginCorrection(item: WorkItem): void {
  editingId.value = item.id;
  correctionError.value = "";
  correctionForm.value = { title: item.title, summary: item.summary, status: item.status, nextStep: item.next_step ?? "" };
  projectForm.value = { projectId: item.projectCorrection?.targetProjectId ?? props.detail.project.id };
}

function cancelCorrection(): void {
  editingId.value = null;
  correctionError.value = "";
}

async function saveCorrection(item: WorkItem): Promise<void> {
  savingId.value = item.id;
  correctionError.value = "";
  try {
    await api.saveWorkItemCorrection(item.id, correctionForm.value);
    if (item.projectCorrection && projectForm.value.projectId === item.projectCorrection.sourceProjectId) {
      await api.clearProjectCorrection(item.id);
    } else if (projectForm.value.projectId !== props.detail.project.id) {
      await api.saveProjectCorrection(item.id, projectForm.value);
    }
    editingId.value = null;
    emit("changed");
  } catch (error) {
    correctionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    savingId.value = null;
  }
}

async function restoreAutomatic(item: WorkItem): Promise<void> {
  savingId.value = item.id;
  correctionError.value = "";
  try {
    await api.clearWorkItemCorrection(item.id);
    editingId.value = null;
    emit("changed");
  } catch (error) {
    correctionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    savingId.value = null;
  }
}

async function restoreProjectAutomatic(item: WorkItem): Promise<void> {
  savingId.value = item.id;
  correctionError.value = "";
  try {
    await api.clearProjectCorrection(item.id);
    editingId.value = null;
    emit("changed");
  } catch (error) {
    correctionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    savingId.value = null;
  }
}

function hasFeedback(item: WorkItem, type: WorkItemFeedbackType): boolean {
  return item.feedback?.some((feedback) => feedback.type === type) ?? false;
}

async function toggleFeedback(item: WorkItem, type: WorkItemFeedbackType): Promise<void> {
  feedbackSavingId.value = item.id;
  feedbackError.value = "";
  try {
    if (hasFeedback(item, type)) await api.clearWorkItemFeedback(item.id, type);
    else await api.saveWorkItemFeedback(item.id, type, feedbackNotes.value[item.id] ?? "");
    emit("changed");
  } catch (error) {
    feedbackError.value = error instanceof Error ? error.message : String(error);
  } finally {
    feedbackSavingId.value = null;
  }
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

function preview(event: TimelineEvent): string {
  return (event.command || event.content || event.tool_name || "事件").slice(0, 180);
}

function repositoryState(state: ProjectDetailResponse["repository"]): string {
  if (!state) return "尚未扫描";
  if (!state.available) return state.state === "missing" ? "目录不存在" : "非 Git 仓库";
  if (state.state === "empty") return "空仓库";
  return state.state === "dirty" ? "存在未提交修改" : "工作区干净";
}

function shortCommit(value: string | null): string {
  return value?.slice(0, 8) ?? "无提交";
}

function workstreamEvidence(stream: ProjectWorkstream): EvidenceRef[] {
  const ids = new Set(stream.evidenceIds);
  return (props.detail.progress?.evidence ?? []).filter((citation) => ids.has(citation.id)).slice(0, 3);
}

function projectWorkstreams(progress: ProjectDetailResponse["progress"]): ProjectWorkstream[] {
  // Keep an already-open page usable while the local service is being restarted.
  return progress?.workstreams ?? [];
}

const factLabels = { finding: "结论", change: "变更", validation: "验证", risk: "风险", next_step: "下一步" };
</script>

<template>
  <div class="drawer-backdrop" @click.self="emit('close')">
    <aside class="detail-drawer" aria-label="项目详情">
      <header class="drawer-header">
        <div><p>项目进度</p><h2>{{ detail.project.name }}</h2><span>{{ detail.project.root_path }}</span></div>
        <button class="icon-button" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button>
      </header>
      <div class="drawer-body">
        <section v-if="detail.progress" class="project-progress-section">
          <div class="project-progress-heading">
            <div><span class="progress-kicker">项目级判断</span><h3>{{ detail.progress.headline }}</h3></div>
            <div class="project-stage-stack">
              <span :class="['project-stage', detail.progress.stage]">统计：{{ detail.progress.stageLabel }}</span>
              <span v-if="detail.progress.agentStageLabel" :class="['project-stage', detail.progress.agentStage]">Agent：{{ detail.progress.agentStageLabel }}</span>
            </div>
          </div>
          <p class="project-progress-summary">{{ detail.progress.summary }}</p>
          <p v-if="detail.progress.agent" class="agent-provenance">
            Agent 判断 · {{ detail.progress.agent.provider }} · {{ new Date(detail.progress.agent.updatedAt).toLocaleString('zh-CN') }}
          </p>
          <div v-if="detail.progress.agent && (detail.progress.agent.completed.length || detail.progress.agent.validations.length || detail.progress.agent.blockers.length || detail.progress.agent.remaining.length)" class="agent-facts">
            <span v-for="fact in detail.progress.agent.completed.slice(0, 2)" :key="`completed:${fact}`"><b>Agent 完成</b>{{ fact }}</span>
            <span v-for="fact in detail.progress.agent.validations.slice(0, 2)" :key="`validation:${fact}`"><b>Agent 验证</b>{{ fact }}</span>
            <span v-for="fact in detail.progress.agent.blockers.slice(0, 2)" :key="`blocker:${fact}`" class="danger"><b>Agent 阻塞</b>{{ fact }}</span>
            <span v-for="fact in detail.progress.agent.remaining.slice(0, 2)" :key="`remaining:${fact}`" class="warning"><b>Agent 待处理</b>{{ fact }}</span>
          </div>
          <div class="project-progress-metrics">
            <span><strong>{{ detail.progress.counts.completed }}</strong>已完成</span>
            <span><strong>{{ detail.progress.counts.active }}</strong>推进中</span>
            <span><strong>{{ detail.progress.counts.unverified }}</strong>待验证</span>
            <span><strong>{{ detail.progress.counts.blocked }}</strong>受阻</span>
            <span><strong>{{ Math.round(detail.progress.confidence * 100) }}%</strong>置信度</span>
          </div>
          <div v-if="projectWorkstreams(detail.progress).length" class="workstreams-section">
            <div class="workstreams-heading">
              <div><strong>自动识别工作主线</strong><span>按标题、摘要、文件与时间关系归并</span></div>
              <em>仅供参考</em>
            </div>
            <article v-for="stream in projectWorkstreams(detail.progress).slice(0, 3)" :key="stream.id" class="workstream-card">
              <div class="workstream-top">
                <div><strong>{{ stream.title }}</strong><span>{{ stream.counts.total }} 个相关事项 · {{ Math.round(stream.confidence * 100) }}% 置信度</span></div>
                <span :class="['project-stage', stream.stage]">{{ stream.stageLabel }}</span>
              </div>
              <p>{{ stream.summary }}</p>
              <div class="workstream-metrics">
                <span v-if="stream.counts.active"><b>{{ stream.counts.active }}</b>推进中</span>
                <span v-if="stream.counts.completed"><b>{{ stream.counts.completed }}</b>已完成</span>
                <span v-if="stream.counts.unverified"><b>{{ stream.counts.unverified }}</b>待验证</span>
                <span v-if="stream.counts.blocked"><b>{{ stream.counts.blocked }}</b>受阻</span>
                <span v-if="stream.counts.planned"><b>{{ stream.counts.planned }}</b>计划中</span>
              </div>
              <div v-if="stream.items.length > 1" class="workstream-items">
                <span v-for="item in stream.items.slice(0, 4)" :key="item.id">{{ item.title }}</span>
                <span v-if="stream.items.length > 4">另有 {{ stream.items.length - 4 }} 项</span>
              </div>
              <div v-if="workstreamEvidence(stream).length" class="workstream-citations">
                <button v-for="(citation, index) in workstreamEvidence(stream)" :key="citation.id" @click="emit('evidence', citation)">[{{ index + 1 }}] {{ citation.source === 'codex' ? 'Codex' : 'Claude Code' }} · L{{ citation.source_line }}</button>
              </div>
            </article>
            <p v-if="projectWorkstreams(detail.progress).length > 3" class="workstreams-more">另有 {{ projectWorkstreams(detail.progress).length - 3 }} 条主线，完整事项见下方。</p>
          </div>
          <div v-if="detail.progress.blocked.length" class="project-progress-list danger-list">
            <strong>当前阻塞</strong>
            <p v-for="item in detail.progress.blocked.slice(0, 3)" :key="item.id">{{ item.title }}<span>{{ item.summary }}</span></p>
          </div>
          <div v-if="detail.progress.active.length" class="project-progress-list">
            <strong>当前推进</strong>
            <p v-for="item in detail.progress.active.slice(0, 3)" :key="item.id">{{ item.title }}<span>{{ item.summary }}</span></p>
          </div>
          <div v-if="detail.progress.completed.length" class="project-progress-list">
            <strong>已完成</strong>
            <p v-for="item in detail.progress.completed.slice(0, 3)" :key="item.id">{{ item.title }}<span>{{ item.summary }}</span></p>
          </div>
          <div v-if="detail.progress.nextSteps.length" class="project-progress-list">
            <strong>下一步</strong>
            <p v-for="step in detail.progress.nextSteps.slice(0, 3)" :key="`${step.workItemId}:${step.text}`">{{ step.text }}</p>
          </div>
          <div v-if="detail.progress.evidence.length" class="project-progress-citations">
            <span>项目判断引用</span>
            <button v-for="(citation, index) in detail.progress.evidence" :key="citation.id" @click="emit('evidence', citation)">[{{ index + 1 }}] {{ citation.source === 'codex' ? 'Codex' : 'Claude Code' }} · L{{ citation.source_line }}</button>
          </div>
        </section>
        <section class="repository-section">
          <div class="drawer-section-title"><h3>仓库证据</h3><span>{{ repositoryState(detail.repository) }}</span></div>
          <div v-if="detail.repository" :class="['repository-panel', detail.repository.state]">
            <div class="repository-heading">
              <div><strong>{{ detail.repository.branch || '未识别分支' }}</strong><span>{{ detail.repository.upstream || '无上游分支' }}</span></div>
              <code>{{ shortCommit(detail.repository.headCommit) }}</code>
            </div>
            <p v-if="detail.repository.headSubject">{{ detail.repository.headSubject }}</p>
            <div v-if="detail.repository.available" class="repository-metrics">
              <span><strong>{{ detail.repository.stagedCount }}</strong>暂存</span>
              <span><strong>{{ detail.repository.modifiedCount }}</strong>修改</span>
              <span><strong>{{ detail.repository.untrackedCount }}</strong>未跟踪</span>
              <span :class="{ danger: detail.repository.conflictedCount > 0 }"><strong>{{ detail.repository.conflictedCount }}</strong>冲突</span>
            </div>
            <div v-if="detail.repository.changedFiles.length" class="repository-files">
              <code v-for="file in detail.repository.changedFiles.slice(0, 6)" :key="file">{{ file }}</code>
              <span v-if="detail.repository.changedFiles.length > 6">另有 {{ detail.repository.changedFiles.length - 6 }} 个文件</span>
            </div>
          </div>
          <p v-else class="repository-empty">下一次扫描后生成仓库快照。</p>
        </section>
        <section class="work-section">
          <div class="drawer-section-title"><h3>工作事项</h3><span>{{ detail.workItems.length }}</span></div>
          <article v-for="item in detail.workItems" :id="`work-item-${item.id}`" :key="item.id" :class="['work-item', { focused: focusWorkItemId === item.id }]" tabindex="-1">
            <div class="work-item-top">
              <span :class="['status-mark', item.status]"></span><strong>{{ item.title }}</strong>
              <span class="work-item-actions"><span class="work-status">{{ detail.statusLabels[item.status] }}</span><button class="edit-work-item" :aria-label="`编辑事项：${item.title}`" title="编辑人工纠正" @click="beginCorrection(item)"><AppIcon name="edit" /></button></span>
            </div>
            <p v-if="item.agent" class="work-item-agent">事项 Agent · {{ item.agent.provider }} · {{ new Date(item.agent.updatedAt).toLocaleString('zh-CN') }} · {{ item.agent.evidenceIds.length }} 条引用</p>
            <div v-if="item.correction || item.projectCorrection" class="correction-note">
              <span><AppIcon name="edit" />人工纠正<span v-if="item.projectCorrection"> · 项目归属已调整</span><span v-if="item.correction"> · {{ date(item.correction.updatedAt) }}</span></span>
              <span class="correction-restore-actions"><button v-if="item.projectCorrection" :disabled="savingId === item.id" @click="restoreProjectAutomatic(item)"><AppIcon name="restore" />恢复自动归属</button><button v-if="item.correction" :disabled="savingId === item.id" @click="restoreAutomatic(item)"><AppIcon name="restore" />恢复自动内容</button></span>
            </div>
            <form v-if="editingId === item.id" class="correction-form" @submit.prevent="saveCorrection(item)">
              <label class="correction-title"><span>事项标题</span><input v-model="correctionForm.title" aria-label="事项标题" maxlength="120" required /></label>
              <label><span>状态</span><select v-model="correctionForm.status" aria-label="事项状态"><option v-for="(label, status) in detail.statusLabels" :key="status" :value="status">{{ label }}</option></select></label>
              <label class="correction-wide"><span>项目归属</span><select v-model="projectForm.projectId" aria-label="项目归属"><option v-for="option in detail.projectOptions" :key="option.id" :value="option.id">{{ option.name }}{{ option.id === detail.project.id ? '（当前）' : '' }} · {{ option.root_path }}</option></select></label>
              <label class="correction-wide"><span>进展摘要</span><textarea v-model="correctionForm.summary" aria-label="进展摘要" maxlength="2000" rows="3"></textarea></label>
              <label class="correction-wide"><span>下一步</span><textarea v-model="correctionForm.nextStep" aria-label="下一步" maxlength="1000" rows="2"></textarea></label>
              <p v-if="correctionError" class="correction-error" role="alert">{{ correctionError }}</p>
              <div class="correction-actions"><button type="button" class="secondary-action" @click="cancelCorrection">取消</button><button type="submit" class="primary-action" :disabled="savingId === item.id"><AppIcon name="save" />{{ savingId === item.id ? '保存中' : '保存纠正' }}</button></div>
            </form>
            <p v-else>{{ item.summary }}</p>
            <div class="work-evidence"><span>{{ item.session_count }} 个会话</span><span>{{ item.evidence_count }} 条关键证据</span><span>置信度 {{ Math.round(item.confidence * 100) }}%</span></div>
            <div class="feedback-panel">
              <div class="feedback-heading"><span>帮助改进识别</span><small>标注后可导出真实评测样本</small></div>
              <div class="feedback-options">
                <button v-for="option in feedbackOptions" :key="option.type" type="button" :title="option.title" :class="['feedback-chip', { selected: hasFeedback(item, option.type) }]" :disabled="feedbackSavingId === item.id" @click="toggleFeedback(item, option.type)">{{ option.label }}</button>
              </div>
              <input v-model="feedbackNotes[item.id]" class="feedback-note" maxlength="1000" placeholder="可选：补充哪里不准确" aria-label="反馈备注" />
              <p v-if="feedbackError && feedbackSavingId === null" class="feedback-error" role="alert">{{ feedbackError }}</p>
            </div>
            <div v-if="item.progress" class="progress-facts">
              <button v-for="fact in item.progress.facts.slice(0, 5)" :key="`${fact.kind}:${fact.id}:${fact.text}`" class="fact-row" @click="emit('evidence', fact)">
                <strong>{{ factLabels[fact.kind] }}</strong><span>{{ fact.text }}</span><small>[引用]</small>
              </button>
              <p v-if="!item.progress.facts.length && item.progress.completed.length"><strong>已完成</strong>{{ item.progress.completed[0] }}</p>
              <p v-if="!item.progress.facts.length && item.progress.validations.length"><strong>验证</strong>{{ item.progress.validations.slice(0, 2).join('；') }}</p>
              <p v-if="!item.progress.facts.length && item.progress.blockers.length"><strong>阻塞</strong>{{ item.progress.blockers[0] }}</p>
              <p v-if="!item.progress.facts.length && item.progress.remaining.length"><strong>待处理</strong>{{ item.progress.remaining[0] }}</p>
            </div>
            <div class="citation-list">
              <button v-for="(citation, index) in item.evidence" :key="citation.id" @click="emit('evidence', citation)">[{{ index + 1 }}] {{ citation.source === 'codex' ? 'Codex' : 'Claude Code' }} · L{{ citation.source_line }}</button>
            </div>
            <div v-if="editingId !== item.id && item.next_step" class="next-step"><span>下一步</span>{{ item.next_step }}</div>
          </article>
        </section>
        <section class="timeline-section">
          <div class="drawer-section-title"><h3>证据时间线</h3><span>点击查看原始上下文</span></div>
          <button v-for="event in detail.timeline" :key="event.id" class="timeline-event" @click="emit('evidence', event)">
            <span :class="['event-node', { error: event.is_error }]" ></span>
            <span class="event-copy"><span><strong>{{ event.tool_name || (event.event_type === 'user_message' ? '用户请求' : 'Agent 记录') }}</strong><time>{{ date(event.timestamp) }}</time></span><p>{{ preview(event) }}</p><small>{{ event.source === 'codex' ? 'Codex' : 'Claude Code' }} · {{ event.session_title }}</small></span>
          </button>
        </section>
      </div>
    </aside>
  </div>
</template>
