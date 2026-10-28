<template>
    <div class="modal" @click.self="$emit('close')">
        <div class="modal-content large">
            <div class="header">
                <h3>任务详情</h3>
                <button @click="$emit('close')">关闭</button>
            </div>

            <div v-if="loading" class="loading">加载中...</div>
            <div v-else-if="error" class="error">{{ error }}</div>

            <template v-else-if="detail">
                <div class="detail-section">
                    <h4>基本信息</h4>
                    <div class="info-grid">
                        <div>ID: {{ detail.id }}</div>
                        <div>状态: {{ detail.status }}</div>
                        <div>轮数: {{ detail.roundCount }}</div>
                        <div>Provider: {{ detail.provider || '-' }}</div>
                        <div>模型: {{ detail.model || '-' }}</div>
                        <div>Live: {{ detail.live ? '是' : '否' }}</div>
                        <div>预算: {{ detail.maxTokens || '-' }}</div>
                        <div>已验收: {{ detail.accepted ? '是' : '否' }}</div>
                    </div>
                </div>

                <div class="detail-section" v-if="detail.usage">
                    <h4>用量</h4>
                    <div class="info-grid">
                        <div>请求数: {{ detail.usage.requests }}</div>
                        <div>输入 tokens: {{ detail.usage.inputTokens }}</div>
                        <div>输出 tokens: {{ detail.usage.outputTokens }}</div>
                        <div v-if="detail.usage.estimatedCostCny !== null">
                            估算费用: {{ detail.usage.estimatedCostCny?.toFixed(6) }} 元
                        </div>
                        <div v-if="detail.usage.cacheReadTokens">
                            缓存读取: {{ detail.usage.cacheReadTokens }}
                        </div>
                    </div>
                </div>

                <div class="detail-section">
                    <h4>工作区</h4>
                    <div class="path">{{ detail.workspace }}</div>
                </div>

                <div class="detail-section" v-if="detail.resultPreview">
                    <h4>结果预览</h4>
                    <pre class="result">{{ detail.resultPreview }}</pre>
                </div>

                <div class="detail-section" v-if="detail.reworkBlockedReason">
                    <h4>返工限制</h4>
                    <div class="warning-text">{{ detail.reworkBlockedReason }}</div>
                </div>

                <div class="detail-section actions" v-if="detail.status === 'awaiting_review'">
                    <h4>操作</h4>
                    <div class="action-buttons">
                        <button class="btn-primary" @click="acceptTask">验收</button>
                        <button @click="closeTask">关闭</button>
                    </div>
                </div>
                <div class="detail-section actions" v-if="detail.status === 'running'">
                    <h4>操作</h4>
                    <div class="action-buttons">
                        <button class="btn-danger" @click="cancelTask">取消</button>
                    </div>
                </div>
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';

interface TaskDetail {
    id: string;
    status: string;
    roundCount: number;
    provider?: string;
    model?: string;
    workspace: string;
    live: boolean;
    accepted: boolean;
    maxTokens?: number;
    resultPreview?: string;
    reworkBlockedReason?: string;
    usage?: {
        requests: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        estimatedCostCny: number | null;
    };
}

const props = defineProps<{ taskId: string }>();
const emit = defineEmits<{ close: []; refresh: [] }>();

const detail = ref<TaskDetail | null>(null);
const loading = ref(true);
const error = ref('');

async function loadDetail() {
    loading.value = true;
    error.value = '';
    try {
        detail.value = await invoke<TaskDetail>('get_task_detail', { id: props.taskId });
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

async function acceptTask() {
    const evidence = prompt('请输入验收证据：');
    if (!evidence) return;
    try {
        await invoke('accept_task', { id: props.taskId, evidence });
        emit('refresh');
        loadDetail();
    } catch (e) {
        alert('验收失败: ' + e);
    }
}

async function closeTask() {
    if (!confirm('确定关闭这个任务？')) return;
    try {
        await invoke('close_task', { id: props.taskId });
        emit('refresh');
        loadDetail();
    } catch (e) {
        alert('关闭失败: ' + e);
    }
}

async function cancelTask() {
    if (!confirm('确定取消这个任务？')) return;
    try {
        await invoke('cancel_task', { id: props.taskId });
        emit('refresh');
        loadDetail();
    } catch (e) {
        alert('取消失败: ' + e);
    }
}

onMounted(loadDetail);
</script>

<style scoped>
.modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.2);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
}

.modal-content {
    background: #fff;
    padding: 28px;
    border-radius: 20px;
    width: 600px;
    max-height: 80vh;
    overflow-y: auto;
    border: 1px solid #fce4ec;
    box-shadow: 0 8px 32px rgba(244, 143, 177, 0.2);
}

.modal-content.large {
    width: 720px;
}

.header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
}

.header h3 {
    color: #d81b60;
    font-size: 18px;
}

.detail-section {
    margin-bottom: 20px;
}

.detail-section h4 {
    margin-bottom: 10px;
    color: #d81b60;
    font-size: 14px;
    font-weight: 500;
}

.info-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    font-size: 13px;
    color: #7a5c6c;
}

.path {
    font-family: 'SF Mono', Monaco, monospace;
    font-size: 12px;
    color: #c9a6b8;
    background: #fff5f7;
    padding: 10px 14px;
    border-radius: 10px;
}

.result {
    background: #fff5f7;
    padding: 14px;
    border-radius: 12px;
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
    color: #5a4a52;
    line-height: 1.6;
}

.warning-text {
    color: #e65100;
    font-size: 13px;
    background: #fff3e0;
    padding: 12px 14px;
    border-radius: 10px;
}

.action-buttons {
    display: flex;
    gap: 10px;
}

.action-buttons button {
    padding: 8px 20px;
    border: none;
    border-radius: 16px;
    cursor: pointer;
    font-size: 13px;
    transition: transform 0.1s;
}

.action-buttons button:hover {
    transform: scale(1.05);
}

.action-buttons .btn-primary {
    background: linear-gradient(135deg, #f8bbd0 0%, #f48fb1 100%);
    color: #fff;
}

.action-buttons .btn-danger {
    background: linear-gradient(135deg, #ef9a9a 0%, #e57373 100%);
    color: #fff;
}

.loading, .error {
    text-align: center;
    padding: 40px;
}

.error {
    color: #e91e63;
}

button {
    padding: 8px 20px;
    border: none;
    border-radius: 16px;
    cursor: pointer;
    background: #fce4ec;
    color: #d81b60;
    font-size: 13px;
}

button:hover {
    background: #f8bbd0;
}
</style>
