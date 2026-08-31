<script setup lang="ts">
import AppIcon from "./AppIcon.vue";

defineProps<{ data: Record<string, any> | null; loading: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="evidence-modal" role="dialog" aria-modal="true" aria-label="原始证据">
      <header><div><p>原始证据</p><h2>{{ data?.event?.tool_name || data?.event?.event_type || '加载中' }}</h2></div><button class="icon-button" aria-label="关闭证据" @click="emit('close')"><AppIcon name="close" /></button></header>
      <div v-if="loading" class="modal-loading">正在读取本地证据…</div>
      <template v-else-if="data">
        <div class="evidence-location"><span>{{ data.event.source }}</span><code>{{ data.event.source_file }}:{{ data.event.source_line }}</code></div>
        <div class="raw-context-label">原始 JSONL 上下文（敏感信息已遮蔽）</div>
        <div v-if="data.rawContext?.length" class="context-list">
          <article v-for="item in data.rawContext" :key="item.source_line" :class="['context-row', { selected: item.source_line === data.event.source_line }]">
            <span>{{ item.source_line }}</span>
            <div><pre>{{ item.raw }}</pre></div>
          </article>
        </div>
        <div v-else class="context-list">
          <article v-for="item in data.context" :key="item.id" :class="['context-row', { selected: item.id === data.event.id }]">
            <span>{{ item.source_line }}</span>
            <div><strong>{{ item.tool_name || item.event_type }}</strong><pre>{{ item.command || item.content || '无文本内容' }}</pre></div>
          </article>
          <p class="context-fallback">原始文件当前不可读，以上为本地索引中保留的脱敏上下文。</p>
        </div>
      </template>
    </section>
  </div>
</template>
