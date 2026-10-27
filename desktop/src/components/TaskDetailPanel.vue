<template>
  <div class="modal" @click.self="$emit('close')">
    <div class="modal-content">
      <header class="header">
        <div>
          <p class="eyebrow">TASK INSPECTOR</p>
          <h3>{{ detail?.id || taskId }}</h3>
        </div>
        <button class="ghost" @click="$emit('close')">关闭</button>
      </header>

      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="error" class="error">{{ error }}</div>

      <template v-else-if="detail">
        <section class="status-strip">
          <span class="status" :class="detail.status">{{ detail.statusLabel || detail.status }}</span>
          <span :class="['health', detail.runtimeHealth]">心跳 {{ detail.runtimeHealth || 'unknown' }}</span>
          <span>{{ detail.live ? 'Runtime live' : 'Runtime stopped' }}</span>
          <span>Round {{ detail.roundCount }}</span>
          <span v-if="detail.lastRound?.roundId || detail.roundId" class="mono">
            {{ (detail.lastRound?.roundId || detail.roundId).slice(-12) }}
          </span>
        </section>

        <div v-if="detail.manualActionRequired" class="danger-note">
          存在无法验证归属的残留 Runtime（PID {{ detail.runtime?.pid }}）。工作区锁已保留，请先人工确认该进程。
        </div>
        <div v-if="detail.reworkBlockedReason" class="warning-note">
          {{ detail.reworkBlockedReason }}
        </div>

        <section class="detail-section">
          <h4>工作区租约</h4>
          <div class="info-grid">
            <div><span>模式</span>{{ detail.workspaceLabel || detail.workspaceMode || 'legacy' }}</div>
            <div><span>租约</span>{{ detail.worktreeStatus || '-' }}</div>
            <div class="wide"><span>执行目录</span><code>{{ detail.workspace }}</code></div>
            <div v-if="detail.sourceWorkspace" class="wide"><span>来源目录</span><code>{{ detail.sourceWorkspace }}</code></div>
            <div><span>分支</span><code>{{ detail.branch || '-' }}</code></div>
            <div><span>基准提交</span><code>{{ detail.baseCommit ? detail.baseCommit.slice(0, 12) : '-' }}</code></div>
            <div><span>Provider</span>{{ detail.provider || '-' }}</div>
            <div><span>模型</span>{{ detail.model || '-' }}</div>
          </div>
        </section>

        <section v-if="detail.usage" class="detail-section">
          <h4>用量</h4>
          <div class="metric-row">
            <div><strong>{{ detail.usage.requests ?? 0 }}</strong><span>请求</span></div>
            <div><strong>{{ detail.usage.inputTokens ?? 0 }}</strong><span>输入 tokens</span></div>
            <div><strong>{{ detail.usage.outputTokens ?? 0 }}</strong><span>输出 tokens</span></div>
            <div>
              <strong>{{ detail.usage.estimatedCostCny === null ? '—' : `¥${detail.usage.estimatedCostCny.toFixed(4)}` }}</strong>
              <span>估算费用</span>
            </div>
          </div>
        </section>

        <section class="detail-section">
          <div class="tab-row">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              :class="{ active: activeTab === tab.id }"
              @click="selectTab(tab.id)"
            >
              {{ tab.label }}
            </button>
          </div>
          <div class="page-toolbar">
            <span>{{ page.totalChars }} 字符 · 当前 {{ page.offset }}</span>
            <div>
              <button class="ghost" :disabled="page.offset === 0 || pageLoading" @click="previousPage">上一页</button>
              <button class="ghost" :disabled="page.nextOffset === null || pageLoading" @click="nextPage">下一页</button>
            </div>
          </div>
          <pre v-if="page.text" class="paged-content">{{ page.text }}</pre>
          <div v-else class="empty-page">{{ pageLoading ? '读取中…' : '这个视图目前为空。' }}</div>
        </section>

        <section v-if="detail.canRework || detail.status === 'failed'" class="detail-section action-panel">
          <h4>返工</h4>
          <textarea v-model="rework.prompt" rows="3" placeholder="写明具体修正要求，不要只写“再试一次”" />
          <div class="inline-actions">
            <input v-model="rework.maxTokens" inputmode="numeric" placeholder="输出预算（可选）" />
            <button class="primary" :disabled="working || !rework.prompt.trim()" @click="submitRework">发送返工</button>
          </div>
        </section>

        <section v-if="detail.status === 'awaiting_review' || detail.accepted" class="detail-section action-panel">
          <h4>独立验收</h4>
          <textarea v-model="evidence" rows="3" placeholder="记录 Delegating Agent 实际执行的检查、命令、输出与结论" />
          <div class="inline-actions end">
            <button class="primary" :disabled="working || !evidence.trim() || detail.accepted" @click="acceptTask">记录验收</button>
          </div>
        </section>

        <section class="detail-section action-panel">
          <h4>生命周期</h4>
          <div class="inline-actions">
            <button v-if="['running', 'awaiting_review', 'failed'].includes(detail.status)" class="danger" @click="cancelTask">取消</button>
            <button v-if="detail.status !== 'closed'" class="ghost" @click="closeTask">关闭</button>
            <button
              v-if="detail.status === 'closed' && detail.workspaceMode === 'worktree' && detail.worktreeStatus !== 'removed'"
              class="ghost"
              @click="cleanWorktree"
            >
              清理干净 Worktree
            </button>
            <span class="hint">关闭只停止 Runtime；Worktree 与分支会保留。</span>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';

interface TaskDetail {
  id: string;
  status: string;
  statusLabel?: string;
  roundCount: number;
  roundId?: string;
  provider?: string;
  model?: string;
  workspace: string;
  sourceWorkspace?: string;
  workspaceMode?: string;
  workspaceLabel?: string;
  worktreeStatus?: string;
  branch?: string;
  baseCommit?: string;
  live: boolean;
  accepted: boolean;
  canRework?: boolean;
  manualActionRequired?: boolean;
  runtimeHealth?: string;
  runtime?: { pid?: number };
  reworkBlockedReason?: string;
  lastRound?: { roundId?: string };
  usage?: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostCny: number | null;
  };
}

interface Page {
  text: string;
  offset: number;
  totalChars: number;
  nextOffset: number | null;
}

const props = defineProps<{ taskId: string }>();
const emit = defineEmits<{ close: []; refresh: [] }>();
const detail = ref<TaskDetail | null>(null);
const loading = ref(true);
const pageLoading = ref(false);
const error = ref('');
const working = ref(false);
const evidence = ref('');
const rework = reactive({ prompt: '', maxTokens: '' });
const activeTab = ref('result');
const page = reactive<Page>({ text: '', offset: 0, totalChars: 0, nextOffset: null });
const pageLimit = 4000;
let pollTimer: number | undefined;

const tabs = [
  { id: 'result', label: '结果' },
  { id: 'report', label: '报告' },
  { id: 'workspace', label: '工作区' },
  { id: 'diff', label: 'Diff' },
  { id: 'log', label: '日志' },
];

async function loadDetail(initial = false) {
  if (initial) loading.value = true;
  try {
    detail.value = await invoke<TaskDetail>('get_task_detail', { id: props.taskId });
    error.value = '';
  } catch (value) {
    error.value = String(value);
  } finally {
    if (initial) loading.value = false;
  }
}

async function loadPage(view = activeTab.value, offset = 0) {
  pageLoading.value = true;
  try {
    const result = await invoke<Page>('get_task_view', {
      id: props.taskId,
      view,
      offset,
      limit: pageLimit,
    });
    Object.assign(page, result);
  } catch (value) {
    error.value = String(value);
  } finally {
    pageLoading.value = false;
  }
}

function selectTab(view: string) {
  activeTab.value = view;
  loadPage(view, 0);
}

function nextPage() {
  if (page.nextOffset !== null) loadPage(activeTab.value, page.nextOffset);
}

function previousPage() {
  loadPage(activeTab.value, Math.max(0, page.offset - pageLimit));
}

async function refreshAll() {
  await loadDetail();
  await loadPage();
  emit('refresh');
}

async function submitRework() {
  working.value = true;
  try {
    const args: Record<string, unknown> = { id: props.taskId, prompt: rework.prompt };
    if (rework.maxTokens.trim()) {
      const parsed = Number(rework.maxTokens);
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('输出预算必须是正整数');
      args.maxTokens = parsed;
    }
    await invoke('rework_task', { args });
    rework.prompt = '';
    rework.maxTokens = '';
    await refreshAll();
  } catch (value) {
    error.value = String(value);
  } finally {
    working.value = false;
  }
}

async function acceptTask() {
  working.value = true;
  try {
    await invoke('accept_task', { id: props.taskId, evidence: evidence.value });
    evidence.value = '';
    await refreshAll();
  } catch (value) {
    error.value = String(value);
  } finally {
    working.value = false;
  }
}

async function closeTask() {
  if (!confirm('关闭任务并停止 Runtime？Worktree 和分支会保留。')) return;
  working.value = true;
  try {
    await invoke('close_task', { id: props.taskId });
    await refreshAll();
  } catch (value) {
    error.value = String(value);
  } finally {
    working.value = false;
  }
}

async function cancelTask() {
  if (!confirm('取消当前任务？')) return;
  working.value = true;
  try {
    await invoke('cancel_task', { id: props.taskId });
    await refreshAll();
  } catch (value) {
    error.value = String(value);
  } finally {
    working.value = false;
  }
}

async function cleanWorktree() {
  if (!confirm('仅删除干净 Worktree，分支会保留。继续？')) return;
  working.value = true;
  try {
    await invoke('cleanup_worktree', { id: props.taskId });
    await refreshAll();
  } catch (value) {
    error.value = String(value);
  } finally {
    working.value = false;
  }
}

watch(() => props.taskId, () => {
  loadDetail(true);
  loadPage();
});

onMounted(() => {
  loadDetail(true);
  loadPage();
  pollTimer = window.setInterval(() => loadDetail(false), 2500);
});
onUnmounted(() => {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
});
</script>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 22px;
  background: rgba(68, 30, 47, 0.3);
  backdrop-filter: blur(5px);
}
.modal-content {
  width: min(920px, 100%);
  max-height: 92vh;
  overflow-y: auto;
  padding: 28px;
  border: 1px solid #f4c4d4;
  border-radius: 24px;
  background:
    radial-gradient(circle at 100% 0, rgba(248, 187, 208, 0.25), transparent 30%),
    #fffafc;
  box-shadow: 0 24px 80px rgba(106, 36, 64, 0.24);
}
.header,
.status-strip,
.page-toolbar,
.inline-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.header {
  justify-content: space-between;
  margin-bottom: 18px;
}
.header h3 {
  margin: 2px 0 0;
  color: #b91c5c;
  font-family: ui-monospace, 'Cascadia Code', monospace;
  font-size: 20px;
}
.eyebrow {
  margin: 0;
  color: #cf7392;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
}
.status-strip {
  flex-wrap: wrap;
  padding: 12px 14px;
  border: 1px solid #f5d3de;
  border-radius: 14px;
  color: #816070;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.72);
}
.status,
.health {
  padding: 4px 10px;
  border-radius: 999px;
  font-weight: 700;
}
.status.running { color: #1c64a5; background: #e2f1ff; }
.status.awaiting_review { color: #a45700; background: #fff0d8; }
.status.failed,
.status.cancelled { color: #ad284b; background: #ffe6ed; }
.status.accepted { color: #247544; background: #ddf6e6; }
.status.closed { color: #6c6470; background: #eeeaf0; }
.health.healthy { color: #247544; background: #ddf6e6; }
.health.unhealthy { color: #a45700; background: #fff0d8; }
.health.starting { color: #6c6470; background: #eeeaf0; }
.danger-note,
.warning-note {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  font-size: 12px;
  line-height: 1.55;
}
.danger-note { color: #9c173d; background: #ffe8ef; }
.warning-note { color: #955100; background: #fff2dc; }
.detail-section {
  margin-top: 22px;
}
.detail-section h4 {
  margin: 0 0 10px;
  color: #bd2b62;
  font-size: 13px;
  letter-spacing: 0.03em;
}
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 9px;
  color: #6d4b59;
  font-size: 12px;
}
.info-grid > div {
  min-width: 0;
  padding: 10px 12px;
  border-radius: 11px;
  background: #fff2f6;
}
.info-grid span {
  display: block;
  margin-bottom: 4px;
  color: #b48698;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.info-grid .wide {
  grid-column: 1 / -1;
}
code,
.mono {
  font-family: ui-monospace, 'Cascadia Code', monospace;
  word-break: break-all;
}
.metric-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.metric-row > div {
  padding: 12px;
  border-radius: 12px;
  background: #fff2f6;
}
.metric-row strong,
.metric-row span {
  display: block;
}
.metric-row strong { color: #a52254; font-size: 15px; }
.metric-row span { margin-top: 4px; color: #a77d8d; font-size: 10px; }
.tab-row {
  display: flex;
  gap: 6px;
  padding: 5px;
  border-radius: 13px;
  background: #fff0f5;
}
.tab-row button {
  flex: 1;
  padding: 8px 10px;
  border-radius: 9px;
  color: #9f657c;
  background: transparent;
}
.tab-row button.active {
  color: #fff;
  background: linear-gradient(135deg, #e55086, #c62a64);
  box-shadow: 0 5px 13px rgba(198, 42, 100, 0.2);
}
.page-toolbar {
  justify-content: space-between;
  margin: 10px 0 8px;
  color: #a17c8b;
  font-size: 11px;
}
.paged-content,
.empty-page {
  box-sizing: border-box;
  min-height: 150px;
  max-height: 300px;
  overflow: auto;
  margin: 0;
  padding: 14px;
  border: 1px solid #f4d6df;
  border-radius: 13px;
  color: #59414b;
  background: #fff;
  font: 12px/1.65 ui-monospace, 'Cascadia Code', monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
.empty-page {
  display: grid;
  place-items: center;
  color: #b28f9d;
  font-family: inherit;
}
textarea,
input {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #f0cbd7;
  border-radius: 11px;
  padding: 10px 12px;
  color: #533844;
  background: #fff;
  font: inherit;
  font-size: 12px;
  outline: none;
}
textarea:focus,
input:focus {
  border-color: #e66c98;
  box-shadow: 0 0 0 3px rgba(230, 108, 152, 0.12);
}
textarea {
  resize: vertical;
  margin-bottom: 8px;
}
.inline-actions {
  flex-wrap: wrap;
}
.inline-actions input {
  width: 180px;
}
.inline-actions.end {
  justify-content: flex-end;
}
.hint {
  color: #a17c8b;
  font-size: 11px;
  line-height: 1.5;
}
button {
  border: 0;
  padding: 8px 14px;
  border-radius: 999px;
  cursor: pointer;
  color: #a6486d;
  background: #fff0f5;
  font: inherit;
  font-size: 12px;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.primary {
  color: #fff;
  background: linear-gradient(135deg, #e94f87, #c92b67);
}
.danger {
  color: #a51d43;
  background: #ffe4ec;
}
.ghost {
  color: #9c6077;
  background: #fff0f5;
}
.loading,
.error {
  padding: 40px;
  text-align: center;
}
.error { color: #b4234d; }
@media (max-width: 720px) {
  .info-grid,
  .metric-row {
    grid-template-columns: 1fr 1fr;
  }
  .tab-row {
    flex-wrap: wrap;
  }
}
</style>
