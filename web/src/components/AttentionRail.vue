<script setup lang="ts">
import type { AttentionItem } from "../types";

defineProps<{
  items: AttentionItem[];
  statusLabels: Record<string, string>;
  scan: Array<{ source: string; files: number; errors: number; last_scan: string }>;
}>();

function when(value: string): string {
  return new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}
</script>

<template>
  <aside class="attention-rail">
    <section>
      <div class="section-heading"><h2>需要关注</h2><span>{{ items.length }}</span></div>
      <div v-if="items.length" class="attention-list">
        <article v-for="item in items" :key="item.id" class="attention-item">
          <div class="attention-meta"><span :class="['tiny-status', item.status]">{{ statusLabels[item.status] }}</span><time>{{ when(item.last_activity_at) }}</time></div>
          <h3>{{ item.title }}</h3>
          <p>{{ item.project_name }} · {{ item.next_step }}</p>
        </article>
      </div>
      <p v-else class="quiet-empty">当前没有阻塞或待验证事项。</p>
    </section>
    <section class="scan-summary">
      <div class="section-heading"><h2>历史扫描</h2></div>
      <div v-for="source in scan" :key="source.source" class="scan-source">
        <span class="source-dot" :class="source.source"></span>
        <span><strong>{{ source.source === 'codex' ? 'Codex' : 'Claude Code' }}</strong><small>{{ source.files }} 个历史文件</small></span>
        <span :class="['scan-health', { error: source.errors }]">{{ source.errors ? `${source.errors} 错误` : '正常' }}</span>
      </div>
      <p class="privacy-note">原始对话仅在本机读取与保存。</p>
    </section>
  </aside>
</template>
