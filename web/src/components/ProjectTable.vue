<script setup lang="ts">
import type { ProjectSummary } from "../types";
import AppIcon from "./AppIcon.vue";

defineProps<{ projects: ProjectSummary[]; statusLabels: Record<string, string> }>();
const emit = defineEmits<{ select: [project: ProjectSummary] }>();

function relativeTime(value: string | null): string {
  if (!value) return "暂无时间";
  const delta = Date.now() - new Date(value).getTime();
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 1) return "刚刚";
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} 天前` : new Date(value).toLocaleDateString("zh-CN");
}
</script>

<template>
  <div class="project-table">
    <div class="project-table-head">
      <span>项目与当前工作</span><span>进展</span><span>最近活动</span><span></span>
    </div>
    <button v-for="project in projects" :key="project.id" class="project-row" @click="emit('select', project)">
      <span class="project-identity">
        <span class="project-monogram">{{ project.name.slice(0, 2).toUpperCase() }}</span>
        <span><strong>{{ project.name }}</strong><small>{{ project.current_focus || '尚未提取工作主题' }}</small></span>
      </span>
      <span class="progress-cells">
        <span v-if="Number(project.active_count)" class="status-text active">{{ project.active_count }} 进行中</span>
        <span v-if="Number(project.unverified_count)" class="status-text unverified">{{ project.unverified_count }} 待验证</span>
        <span v-if="Number(project.blocked_count)" class="status-text blocked">{{ project.blocked_count }} 阻塞</span>
        <span v-if="!Number(project.active_count) && !Number(project.unverified_count) && !Number(project.blocked_count)" class="status-text verified">{{ project.verified_count }} 已验证</span>
      </span>
      <span class="activity-cell"><strong>{{ relativeTime(project.last_activity_at) }}</strong><small>{{ project.sources?.replace('claude_code', 'Claude Code').replace('codex', 'Codex') }}</small></span>
      <span class="row-arrow"><AppIcon name="arrow" /></span>
    </button>
    <div v-if="projects.length === 0" class="empty-table">
      <strong>还没有项目记录</strong>
      <p>运行首次扫描后，这里会按项目整理 Codex 和 Claude Code 的工作历史。</p>
    </div>
  </div>
</template>
