<script setup lang="ts">
import AppIcon from "./AppIcon.vue";

defineProps<{ active: string; sourceCounts: Array<{ source: string; count: number }> }>();
const emit = defineEmits<{ navigate: [section: string] }>();

const items = [
  { id: "overview", label: "总览", icon: "overview" as const },
  { id: "projects", label: "项目", icon: "projects" as const },
  { id: "reports", label: "工作总结", icon: "report" as const },
  { id: "review", label: "待确认", icon: "review" as const },
];
</script>

<template>
  <aside class="sidebar">
    <button class="brand" @click="emit('navigate', 'overview')">
      <span class="brand-mark"><span></span><span></span><span></span></span>
      <span>Worklog</span>
    </button>
    <nav class="primary-nav" aria-label="主导航">
      <button v-for="item in items" :key="item.id" :class="['nav-item', { active: active === item.id }]" @click="emit('navigate', item.id)">
        <AppIcon :name="item.icon" />
        <span>{{ item.label }}</span>
      </button>
    </nav>
    <div class="sidebar-spacer"></div>
    <div class="source-block">
      <p class="sidebar-label">数据源</p>
      <div v-for="source in sourceCounts" :key="source.source" class="source-row">
        <span class="source-dot" :class="source.source"></span>
        <span>{{ source.source === 'codex' ? 'Codex' : 'Claude Code' }}</span>
        <span class="source-count">{{ source.count }}</span>
      </div>
    </div>
    <button class="nav-item settings" @click="emit('navigate', 'settings')">
      <AppIcon name="settings" /><span>设置</span>
    </button>
  </aside>
</template>
