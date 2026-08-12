<script setup lang="ts">
defineProps<{ metrics: { projects: number; active: number; verifiedToday: number; needsAttention: number } }>();
</script>

<template>
  <section class="metric-strip" aria-label="进度概览">
    <div class="metric-main">
      <span class="metric-value">{{ metrics.projects }}</span>
      <div><strong>个项目有记录</strong><p>跨 Codex 与 Claude Code 汇总</p></div>
    </div>
    <div class="metric"><span>{{ metrics.active }}</span><p>正在推进</p></div>
    <div class="metric"><span>{{ metrics.verifiedToday }}</span><p>今日已验证</p></div>
    <div class="metric attention"><span>{{ metrics.needsAttention }}</span><p>需要关注</p></div>
  </section>
</template>
