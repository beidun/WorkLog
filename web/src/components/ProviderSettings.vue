<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../api";
import type { LlmMode, LlmSettings, LlmSettingsPayload, ProviderConnectionTest } from "../types";

const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const settings = ref<LlmSettings | null>(null);
const apiKey = ref("");
const clearApiKey = ref(false);
const feedback = ref<{ kind: "success" | "error"; message: string } | null>(null);
const testResult = ref<ProviderConnectionTest | null>(null);

const form = reactive<LlmSettingsPayload>({
  mode: "off",
  baseUrl: "",
  model: "",
  allowRemote: false,
  timeoutMs: 60_000,
  maxInputChars: 24_000,
  maxSessionsPerScan: 20,
  retryFailed: false,
});

const sourceLabel = computed(() => ({
  default: "默认配置",
  file: "本地配置文件",
  env: "环境变量覆盖",
}[settings.value?.source ?? "default"]));

const activeModeLabel = computed(() => ({
  off: "离线确定性摘要",
  local: "本机模型",
  remote: "远程模型",
}[settings.value?.mode ?? "off"]));

function applySettings(next: LlmSettings) {
  settings.value = next;
  form.mode = next.mode;
  form.baseUrl = next.baseUrl;
  form.model = next.model;
  form.allowRemote = next.allowRemote;
  form.timeoutMs = next.timeoutMs;
  form.maxInputChars = next.maxInputChars;
  form.maxSessionsPerScan = next.maxSessionsPerScan;
  form.retryFailed = next.retryFailed;
  apiKey.value = "";
  clearApiKey.value = false;
}

function payload(): LlmSettingsPayload {
  return {
    ...form,
    apiKey: apiKey.value,
    clearApiKey: clearApiKey.value,
  };
}

async function load() {
  loading.value = true;
  try {
    applySettings(await api.settings());
  } catch (error) {
    feedback.value = { kind: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  feedback.value = null;
  try {
    applySettings(await api.saveSettings(payload()));
    testResult.value = null;
    feedback.value = { kind: "success", message: "设置已安全保存，将从下一次扫描开始生效。" };
  } catch (error) {
    feedback.value = { kind: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    saving.value = false;
  }
}

async function testConnection() {
  testing.value = true;
  feedback.value = null;
  testResult.value = null;
  try {
    testResult.value = await api.testProvider(payload());
  } catch (error) {
    feedback.value = { kind: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    testing.value = false;
  }
}

function chooseMode(mode: LlmMode) {
  form.mode = mode;
  testResult.value = null;
  feedback.value = null;
  if (mode === "local" && !form.baseUrl) form.baseUrl = "http://127.0.0.1:11434/v1";
}

onMounted(load);
</script>

<template>
  <section class="settings-page">
    <div class="page-intro settings-intro">
      <div><h1>摘要设置</h1><p>选择工作进度摘要方式；不配置模型时，全部处理保持在本机。</p></div>
      <span class="settings-save-state">保存后下次扫描生效</span>
    </div>

    <div v-if="loading" class="settings-loading">正在读取本地设置…</div>
    <form v-else class="settings-layout" @submit.prevent="save">
      <div class="settings-main">
        <section class="settings-card">
          <header class="settings-card-title"><div><span>01</span><div><h2>摘要方式</h2><p>原始对话默认不会离开本机。</p></div></div></header>
          <div class="provider-modes" role="radiogroup" aria-label="摘要方式">
            <label v-for="option in [
              { id: 'off', title: '离线确定性', detail: '默认 · 无网络调用' },
              { id: 'local', title: '本机模型', detail: 'Ollama / LM Studio 等' },
              { id: 'remote', title: '远程模型', detail: '需要明确隐私授权' },
            ]" :key="option.id" :class="['provider-mode', { active: form.mode === option.id }]">
              <input v-model="form.mode" type="radio" name="llm-mode" :value="option.id" @change="chooseMode(option.id as LlmMode)" />
              <span class="mode-radio"></span><span><strong>{{ option.title }}</strong><small>{{ option.detail }}</small></span>
            </label>
          </div>
        </section>

        <section class="settings-card">
          <header class="settings-card-title"><div><span>02</span><div><h2>Provider 连接</h2><p>兼容 OpenAI Chat Completions 接口。</p></div></div></header>
          <fieldset class="settings-fields" :disabled="form.mode === 'off'">
            <label class="field-row field-wide"><span>Base URL<small>本机模式只允许 localhost / loopback</small></span><input v-model="form.baseUrl" type="url" placeholder="http://127.0.0.1:11434/v1" spellcheck="false" /></label>
            <label class="field-row"><span>Model<small>Provider 中的模型标识</small></span><input v-model="form.model" type="text" placeholder="qwen3:8b" spellcheck="false" /></label>
            <label class="field-row"><span>API Key<small>{{ settings?.hasApiKey ? '已安全保存；留空将保留' : '本机模型通常不需要' }}</small></span><input v-model="apiKey" :disabled="clearApiKey || form.mode === 'off'" type="password" autocomplete="new-password" :placeholder="settings?.hasApiKey ? '••••••••（已配置）' : '可选'" /></label>
          </fieldset>
          <label v-if="settings?.hasApiKey && form.mode !== 'off'" class="inline-check danger-check"><input v-model="clearApiKey" type="checkbox" />显式清除已保存的 API Key</label>
          <label v-if="form.mode === 'remote'" class="remote-consent"><input v-model="form.allowRemote" type="checkbox" /><span><strong>允许向远程 Provider 发送脱敏后的摘要输入</strong><small>这是远程模式的强制授权；连接测试只发送固定探针，不读取任何历史对话。</small></span></label>
          <div class="connection-actions">
            <button class="secondary-action" type="button" :disabled="form.mode === 'off' || testing" @click="testConnection">{{ testing ? '正在测试…' : '测试连接' }}</button>
            <p>测试只验证网络、模型和结构化响应，不会访问工作记录。</p>
          </div>
          <div v-if="testResult" :class="['connection-result', testResult.ok ? 'success' : 'error']" role="status">
            <strong>{{ testResult.ok ? '连接成功' : '连接失败' }}</strong><span>{{ testResult.message }}</span><small>{{ testResult.model }} · {{ testResult.latencyMs }} ms</small>
          </div>
        </section>

        <section class="settings-card">
          <header class="settings-card-title"><div><span>03</span><div><h2>资源限制</h2><p>限制发送长度、扫描用量和失败重试。</p></div></div></header>
          <div class="limit-grid">
            <label><span>请求超时 <small>毫秒</small></span><input v-model.number="form.timeoutMs" type="number" min="1000" max="300000" step="1000" /></label>
            <label><span>最大输入 <small>字符</small></span><input v-model.number="form.maxInputChars" type="number" min="2000" max="200000" step="1000" /></label>
            <label><span>每次扫描增强 <small>会话数</small></span><input v-model.number="form.maxSessionsPerScan" type="number" min="1" max="200" /></label>
          </div>
          <label class="inline-check"><input v-model="form.retryFailed" type="checkbox" />下次扫描重试之前失败的模型摘要</label>
        </section>

        <div class="settings-footer">
          <div v-if="feedback" :class="['settings-feedback', feedback.kind]" role="status">{{ feedback.message }}</div>
          <span v-else>配置仅写入本机 <code>.worklog/settings.json</code></span>
          <button class="primary-action" type="submit" :disabled="saving">{{ saving ? '正在保存…' : '保存设置' }}</button>
        </div>
      </div>

      <aside class="settings-aside">
        <section class="settings-status-card">
          <span class="status-kicker">当前生效</span><strong>{{ activeModeLabel }}</strong>
          <p>{{ settings?.mode === 'off' ? '使用可复现的本地规则生成摘要。' : `${settings?.model || '未配置模型'} · ${settings?.mode === 'local' ? '本机' : '远程'}` }}</p>
          <dl><div><dt>配置来源</dt><dd>{{ sourceLabel }}</dd></div><div><dt>API Key</dt><dd>{{ settings?.hasApiKey ? '已配置' : '未配置' }}</dd></div><div><dt>单次扫描</dt><dd>{{ settings?.maxSessionsPerScan }} 会话</dd></div></dl>
          <div v-if="settings?.environmentOverrides.length" class="override-note">环境变量覆盖：{{ settings.environmentOverrides.join('、') }}</div>
        </section>
        <section class="privacy-card"><span>隐私边界</span><ul><li>Provider 默认关闭</li><li>远程模式必须单独授权</li><li>发送前再次脱敏并限制长度</li><li>每条进展仍需本地证据引用</li><li>连接测试只使用固定合成事件</li></ul></section>
      </aside>
    </form>
  </section>
</template>
