<script setup lang="ts">
import type { EvidenceRef, ProjectDetailResponse, TimelineEvent } from "../types";
import AppIcon from "./AppIcon.vue";

defineProps<{ detail: ProjectDetailResponse; loading: boolean }>();
const emit = defineEmits<{ close: []; evidence: [event: TimelineEvent | EvidenceRef] }>();

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

function preview(event: TimelineEvent): string {
  return (event.command || event.content || event.tool_name || "事件").slice(0, 180);
}
</script>

<template>
  <div class="drawer-backdrop" @click.self="emit('close')">
    <aside class="detail-drawer" aria-label="项目详情">
      <header class="drawer-header">
        <div><p>项目进度</p><h2>{{ detail.project.name }}</h2><span>{{ detail.project.root_path }}</span></div>
        <button class="icon-button" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button>
      </header>
      <div class="drawer-body">
        <section class="work-section">
          <div class="drawer-section-title"><h3>工作事项</h3><span>{{ detail.workItems.length }}</span></div>
          <article v-for="item in detail.workItems" :key="item.id" class="work-item">
            <div class="work-item-top"><span :class="['status-mark', item.status]"></span><strong>{{ item.title }}</strong><span class="work-status">{{ detail.statusLabels[item.status] }}</span></div>
            <p>{{ item.summary }}</p>
            <div class="work-evidence"><span>{{ item.session_count }} 个会话</span><span>{{ item.evidence_count }} 条关键证据</span><span>置信度 {{ Math.round(item.confidence * 100) }}%</span></div>
            <div class="citation-list">
              <button v-for="(citation, index) in item.evidence" :key="citation.id" @click="emit('evidence', citation)">[{{ index + 1 }}] {{ citation.source === 'codex' ? 'Codex' : 'Claude Code' }} · L{{ citation.source_line }}</button>
            </div>
            <div class="next-step"><span>下一步</span>{{ item.next_step }}</div>
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
