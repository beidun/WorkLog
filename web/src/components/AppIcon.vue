<script setup lang="ts">
defineProps<{ name: "overview" | "projects" | "report" | "review" | "settings" | "search" | "scan" | "close" | "arrow" | "source" | "edit" | "save" | "restore" }>();
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <template v-if="name === 'overview'">
      <path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z" />
    </template>
    <template v-else-if="name === 'projects'">
      <path d="M3.5 7.5h6l2-2h9v13h-17v-11Z" />
    </template>
    <template v-else-if="name === 'report'">
      <path d="M6 3.5h9l3 3v14H6v-17Z" /><path d="M9 11h6M9 15h6M15 3.5v3h3" />
    </template>
    <template v-else-if="name === 'review'">
      <path d="M4 12.5 9 17l11-11" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A8 8 0 0 0 15 6.2L14.7 3h-4l-.3 3.2a8 8 0 0 0-1.5.9l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 1.5.9l.3 3.2h4l.3-3.2a8 8 0 0 0 1.5-.9l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4 4" />
    </template>
    <template v-else-if="name === 'scan'">
      <path d="M20 7v5h-5M4 17v-5h5" /><path d="M18.5 11a7 7 0 0 0-12-4M5.5 13a7 7 0 0 0 12 4" />
    </template>
    <template v-else-if="name === 'close'">
      <path d="m6 6 12 12M18 6 6 18" />
    </template>
    <template v-else-if="name === 'arrow'">
      <path d="m9 5 7 7-7 7" />
    </template>
    <template v-else-if="name === 'edit'">
      <path d="m4 20 4.2-1 10.6-10.6-3.2-3.2L5 15.8 4 20Z" /><path d="m13.8 7 3.2 3.2" />
    </template>
    <template v-else-if="name === 'save'">
      <path d="M5 4h12l2 2v14H5V4Z" /><path d="M8 4v6h8V4M8 20v-6h8v6" />
    </template>
    <template v-else-if="name === 'restore'">
      <path d="M4 8V4m0 0h4M4.6 4.6A9 9 0 1 1 3 14" />
    </template>
    <template v-else>
      <path d="M12 3.5 19.5 8v8L12 20.5 4.5 16V8L12 3.5Z" /><path d="m4.8 8.2 7.2 4.3 7.2-4.3M12 12.5v8" />
    </template>
  </svg>
</template>
