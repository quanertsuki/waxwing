<template>
    <div>
        <div class="header">
            <h2>任务列表</h2>
            <div class="header-actions">
                <button class="new-task" @click="showCreate = true">新建任务</button>
                <button @click="loadTasks" :disabled="loading">刷新</button>
            </div>
        </div>

        <div v-if="!managerRunning" class="manager-warning">
            <div class="warning-content">
                <span class="warning-icon">⚠️</span>
                <span>Manager 未运行</span>
                <button class="btn-start" @click="startManager">启动 Manager</button>
            </div>
        </div>

        <div v-if="loading" class="loading">加载中...</div>
        <div v-else-if="error" class="error">{{ error }}</div>

        <div v-else class="task-list">
            <div v-if="tasks.length === 0" class="empty">暂无任务</div>
            <div v-for="task in tasks" :key="task.id" class="task-card" @click="selectTask(task)">
                <div class="task-header">
                    <span class="task-id">{{ task.id }}</span>
                    <span class="status" :class="task.status">{{ task.statusLabel || task.status }}</span>
                    <span v-if="task.live" class="live-badge">LIVE</span>
                    <span v-if="task.runtimeHealth === 'unhealthy'" class="health-badge">HEARTBEAT STALE</span>
                </div>
                <div class="task-info">
                    <span>Provider: {{ task.provider || '默认' }}</span>
                    <span>模型: {{ task.model || '-' }}</span>
                    <span>轮数: {{ task.roundCount }}</span>
                    <span>工作区: {{ task.workspaceMode || 'legacy' }}</span>
                    <span v-if="task.usage && task.usage.estimatedCostCny !== null">
                        费用: {{ task.usage.estimatedCostCny?.toFixed(4) }} 元
                    </span>
                </div>
                <div class="task-summary">{{ task.summary }}</div>
            </div>
        </div>

        <TaskDetailPanel
            v-if="selectedTask"
            :task-id="selectedTask.id"
            @close="selectedTask = null"
            @refresh="loadTasks"
        />
        <CreateTask
            v-if="showCreate"
            @close="showCreate = false"
            @created="loadTasks"
        />
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import TaskDetailPanel from '../components/TaskDetailPanel.vue';
import CreateTask from '../components/CreateTask.vue';

interface TaskUsage {
    requests: number;
    estimatedCostCny: number | null;
    costComplete: boolean;
}

interface Task {
    id: string;
    status: string;
    statusLabel?: string;
    roundCount: number;
    provider?: string;
    model?: string;
    workspace: string;
    summary: string;
    live: boolean;
    accepted: boolean;
    maxTokens?: number;
    usage?: TaskUsage;
    workspaceMode?: string;
    workspaceLabel?: string;
    runtimeHealth?: string;
    createdAt?: string;
    updatedAt?: string;
}

const tasks = ref<Task[]>([]);
const loading = ref(true);
const error = ref('');
const selectedTask = ref<Task | null>(null);
const managerRunning = ref(true);
const showCreate = ref(false);
let pollTimer: number | undefined;

function selectTask(task: Task) {
    selectedTask.value = task;
}

async function startManager() {
    try {
        const success = await invoke<boolean>('start_manager');
        if (success) {
            managerRunning.value = true;
            await loadTasks();
        } else {
            alert('Manager 启动失败，请手动检查');
        }
    } catch (e) {
        alert('启动 Manager 失败: ' + e);
    }
}

async function loadTasks(silent = false) {
    if (silent !== true) loading.value = true;
    error.value = '';
    try {
        const running = await invoke<boolean>('is_manager_running');
        managerRunning.value = running;
        if (!running) {
            tasks.value = [];
            return;
        }
        tasks.value = await invoke<Task[]>('get_tasks');
    } catch (e) {
        error.value = String(e);
    } finally {
        if (silent !== true) loading.value = false;
    }
}

onMounted(() => {
    loadTasks();
    pollTimer = window.setInterval(() => loadTasks(true), 4000);
});
onUnmounted(() => {
    if (pollTimer !== undefined) window.clearInterval(pollTimer);
});
</script>

<style scoped>
.header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
}

.header h2 {
    color: #d81b60;
    font-size: 22px;
    font-weight: 600;
}

.header-actions button {
    padding: 8px 20px;
    border: none;
    border-radius: 20px;
    cursor: pointer;
    background: linear-gradient(135deg, #f8bbd0 0%, #f48fb1 100%);
    color: #fff;
    font-size: 14px;
    transition: transform 0.1s;
}
.header-actions .new-task {
    background: linear-gradient(135deg, #d92d6f 0%, #b51d55 100%);
}

.header-actions button:hover {
    transform: scale(1.05);
}

.header-actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
}

.manager-warning {
    background: #fff3e0;
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 16px;
    border: 1px solid #ffe0b2;
}

.warning-content {
    display: flex;
    align-items: center;
    gap: 12px;
    color: #e65100;
    font-size: 14px;
}

.warning-icon {
    font-size: 18px;
}

.btn-start {
    margin-left: auto;
    padding: 8px 20px;
    border: none;
    border-radius: 20px;
    cursor: pointer;
    background: linear-gradient(135deg, #ffab91 0%, #ff8a65 100%);
    color: #fff;
    font-size: 14px;
}

.btn-start:hover {
    transform: scale(1.05);
}

.loading, .empty {
    text-align: center;
    padding: 60px;
    color: #c9a6b8;
    font-size: 15px;
}

.task-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.task-card {
    background: #fff;
    border-radius: 16px;
    padding: 18px 20px;
    cursor: pointer;
    transition: all 0.2s;
    border: 1px solid #fce4ec;
    box-shadow: 0 2px 8px rgba(244, 143, 177, 0.08);
}

.task-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 16px rgba(244, 143, 177, 0.15);
}

.task-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}

.task-id {
    font-family: 'SF Mono', Monaco, monospace;
    color: #c9a6b8;
    font-size: 13px;
}

.status {
    padding: 4px 14px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
}

.status.running { background: #e3f2fd; color: #1976d2; }
.status.awaiting_review { background: #fff3e0; color: #f57c00; }
.status.failed { background: #ffebee; color: #e53935; }
.status.accepted { background: #e8f5e9; color: #43a047; }
.status.closed { background: #f5f5f5; color: #757575; }
.status.cancelled { background: #f3e5f5; color: #8e24aa; }
.status.created { background: #e0f2f1; color: #00897b; }

.live-badge {
    background: linear-gradient(135deg, #a5d6a7 0%, #81c784 100%);
    color: #fff;
    padding: 2px 8px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: bold;
}
.health-badge {
    background: #fff1d6;
    color: #b35b00;
    padding: 2px 8px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 700;
}

.task-info {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    font-size: 13px;
    color: #b8a0ac;
    margin-bottom: 8px;
}

.task-summary {
    font-size: 14px;
    color: #7a5c6c;
    line-height: 1.5;
}

.error {
    color: #e91e63;
    margin-top: 16px;
    text-align: center;
    padding: 40px;
}
</style>
