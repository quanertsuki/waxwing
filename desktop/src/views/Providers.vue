<template>
    <div>
        <div class="header">
            <h2>服务商管理</h2>
            <button class="btn-primary" @click="showAddForm = true">添加服务商</button>
        </div>

        <div v-if="loading" class="loading">加载中...</div>
        <div v-else-if="error" class="error">{{ error }}</div>

        <div v-else class="provider-list">
            <div v-if="providers.length === 0" class="empty">暂无服务商</div>
            <div v-for="provider in providers" :key="provider.name" class="provider-card">
                <div class="provider-header">
                    <h3>{{ provider.name }}</h3>
                    <span class="type-badge">{{ provider.type }}</span>
                </div>
                <div class="provider-info">
                    <div>模型: {{ provider.model }}</div>
                    <div v-if="provider.baseUrl">地址: {{ provider.baseUrl }}</div>
                    <div v-if="provider.type === 'openai-chat'">
                        最大模型请求数: {{ provider.maxToolRequests ? provider.maxToolRequests : '无上限' }}
                    </div>
                </div>
                <div class="provider-actions">
                    <button @click="editProvider(provider)">编辑</button>
                    <button class="btn-danger" @click="deleteProvider(provider.name)">删除</button>
                </div>
            </div>
        </div>

        <!-- Add/Edit Form Modal -->
        <div v-if="showAddForm || editingProvider" class="modal" @click.self="closeForm">
            <div class="modal-content">
                <h3>{{ editingProvider ? '编辑' : '添加' }}服务商</h3>
                <form @submit.prevent="saveProvider">
                    <label>
                        名称
                        <input v-model="form.name" required :disabled="!!editingProvider" />
                    </label>
                    <label>
                        类型
                        <select v-model="form.type" required>
                            <option value="openai-chat">OpenAI 兼容</option>
                            <option value="dsh-sdk">DSH SDK (DeepSeek)</option>
                        </select>
                    </label>
                    <label>
                        模型
                        <input v-model="form.model" required />
                    </label>
                    <label v-if="form.type === 'openai-chat'">
                        API 地址
                        <input v-model="form.baseUrl" placeholder="https://api.example.com" />
                    </label>
                    <label v-if="form.type === 'openai-chat'">
                        API Key 环境变量名
                        <input v-model="form.apiKeyEnv" placeholder="RL2_API_KEY" />
                    </label>
                    <label v-if="form.type === 'openai-chat'">
                        最大模型请求数
                        <input v-model.number="form.maxToolRequests" type="number" min="0" step="1"
                            placeholder="留空 = 无上限" />
                        <span class="field-hint">可选。留空或 0 表示无上限；正整数才启用硬上限。</span>
                    </label>
                    <label v-if="form.type === 'dsh-sdk'">
                        DSH 仓库路径
                        <input v-model="form.dshRepo" placeholder="../deepseek-harness" />
                    </label>
                    <div class="form-actions">
                        <button type="button" @click="closeForm">取消</button>
                        <button type="submit" class="btn-primary">保存</button>
                    </div>
                </form>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';

interface Provider {
    name: string;
    type: string;
    model: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    dshRepo?: string;
    maxToolRequests?: number | null;
}

const providers = ref<Provider[]>([]);
const loading = ref(true);
const error = ref('');
const showAddForm = ref(false);
const editingProvider = ref<Provider | null>(null);

const form = ref<Provider>({
    name: '',
    type: 'openai-chat',
    model: '',
    baseUrl: '',
    apiKeyEnv: '',
    maxToolRequests: null
});

async function loadProviders() {
    loading.value = true;
    error.value = '';
    try {
        providers.value = await invoke('get_providers');
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

function editProvider(provider: Provider) {
    editingProvider.value = provider;
    form.value = { ...provider };
}

function closeForm() {
    showAddForm.value = false;
    editingProvider.value = null;
    form.value = { name: '', type: 'openai-chat', model: '', baseUrl: '', apiKeyEnv: '', maxToolRequests: null };
}

async function saveProvider() {
    try {
        const raw = form.value.maxToolRequests;
        let maxToolRequests: number | null = null;
        if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
            maxToolRequests = Number(raw);
            if (!Number.isSafeInteger(maxToolRequests) || maxToolRequests < 0) {
                error.value = '最大模型请求数必须是非负整数';
                return;
            }
        }
        const config: Provider = { ...form.value, maxToolRequests };
        if (config.type !== 'openai-chat') delete config.maxToolRequests;
        await invoke('save_provider', { config });
        closeForm();
        await loadProviders();
    } catch (e) {
        error.value = String(e);
    }
}

async function deleteProvider(name: string) {
    if (!confirm(`确定删除服务商 ${name}？`)) return;
    try {
        await invoke('delete_provider', { name });
        await loadProviders();
    } catch (e) {
        error.value = String(e);
    }
}

onMounted(loadProviders);
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

.provider-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
}

.provider-card {
    background: #fff;
    border-radius: 16px;
    padding: 20px;
    border: 1px solid #fce4ec;
    box-shadow: 0 2px 8px rgba(244, 143, 177, 0.08);
    transition: all 0.2s;
}

.provider-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 16px rgba(244, 143, 177, 0.15);
}

.provider-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
}

.provider-header h3 {
    color: #d81b60;
    font-size: 16px;
}

.type-badge {
    background: linear-gradient(135deg, #e1bee7 0%, #ce93d8 100%);
    color: #fff;
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 11px;
}

.provider-info {
    color: #b8a0ac;
    font-size: 13px;
    margin-bottom: 16px;
    line-height: 1.6;
}

.provider-actions {
    display: flex;
    gap: 8px;
}

.provider-actions button {
    padding: 6px 16px;
    border: none;
    border-radius: 16px;
    cursor: pointer;
    font-size: 13px;
    transition: transform 0.1s;
}

.provider-actions button:hover {
    transform: scale(1.05);
}

.provider-actions button:first-child {
    background: linear-gradient(135deg, #f8bbd0 0%, #f48fb1 100%);
    color: #fff;
}

.btn-danger {
    background: linear-gradient(135deg, #ef9a9a 0%, #e57373 100%) !important;
    color: #fff;
}

.btn-primary {
    padding: 10px 24px;
    border: none;
    border-radius: 20px;
    cursor: pointer;
    background: linear-gradient(135deg, #f8bbd0 0%, #f48fb1 100%);
    color: #fff;
    font-size: 14px;
    transition: transform 0.1s;
}

.btn-primary:hover {
    transform: scale(1.05);
}

.modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
}

.modal-content {
    background: #fff;
    padding: 28px;
    border-radius: 20px;
    width: 420px;
    border: 1px solid #fce4ec;
    box-shadow: 0 8px 32px rgba(244, 143, 177, 0.2);
}

.modal-content h3 {
    color: #d81b60;
    margin-bottom: 20px;
    font-size: 18px;
}

.modal-content form {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.modal-content label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: #b8a0ac;
}

.modal-content input,
.modal-content select {
    padding: 10px 14px;
    border: 1px solid #f8cdd8;
    border-radius: 12px;
    background: #fff5f7;
    color: #5a4a52;
    font-size: 14px;
    outline: none;
}

.modal-content input:focus,
.modal-content select:focus {
    border-color: #f48fb1;
    background: #fff;
}

.field-hint {
    color: #c9a6b8;
    font-size: 11px;
    line-height: 1.4;
}

.form-actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    margin-top: 8px;
}

.form-actions button {
    padding: 8px 24px;
    border: none;
    border-radius: 16px;
    cursor: pointer;
    font-size: 14px;
}

.form-actions button[type="button"] {
    background: #f5f5f5;
    color: #9e9e9e;
}

.loading, .empty {
    text-align: center;
    padding: 60px;
    color: #c9a6b8;
}

.error {
    color: #e91e63;
    text-align: center;
    padding: 40px;
}
</style>
