<template>
    <div>
        <h2>设置</h2>

        <div v-if="loading" class="loading">加载中...</div>
        <div v-else-if="error" class="error">{{ error }}</div>

        <div v-else class="settings-form">
            <section>
                <h3>默认服务商</h3>
                <select v-model="settings.defaultProvider">
                    <option v-for="name in providerNames" :key="name" :value="name">{{ name }}</option>
                </select>
            </section>

            <section>
                <h3>回退服务商</h3>
                <select v-model="settings.fallbackProvider">
                    <option v-for="name in providerNames" :key="name" :value="name">{{ name }}</option>
                </select>
                <p class="hint">当默认服务商失败时自动切换</p>
            </section>

            <section>
                <h3>全局用量上限（可选）</h3>
                <label class="checkbox">
                    <input v-model="settings.usageLimits.enabled" type="checkbox" />
                    启用用量上限
                </label>
                <p class="hint">默认关闭：不限制请求数和费用，仅记录用量。需要时勾选并按下列阈值警告或阻断。</p>
                <div class="limit-grid" :class="{ 'limit-disabled': !settings.usageLimits.enabled }">
                    <label>
                        警告费用 (元)
                        <input v-model.number="settings.usageLimits.warnCostCny" type="number" step="0.1"
                            :disabled="!settings.usageLimits.enabled" />
                    </label>
                    <label>
                        阻断费用 (元)
                        <input v-model.number="settings.usageLimits.blockCostCny" type="number" step="0.1"
                            :disabled="!settings.usageLimits.enabled" />
                    </label>
                    <label>
                        警告请求数
                        <input v-model.number="settings.usageLimits.warnRequests" type="number"
                            :disabled="!settings.usageLimits.enabled" />
                    </label>
                    <label>
                        阻断请求数
                        <input v-model.number="settings.usageLimits.blockRequests" type="number"
                            :disabled="!settings.usageLimits.enabled" />
                    </label>
                </div>
            </section>

            <button class="btn-primary" @click="saveSettings">保存</button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';

interface Provider {
    name: string;
    type: string;
}

interface Settings {
    defaultProvider: string;
    fallbackProvider: string;
    usageLimits: {
        enabled: boolean;
        warnCostCny: number;
        blockCostCny: number;
        warnRequests: number;
        blockRequests: number;
    };
}

const settings = ref<Settings>({
    defaultProvider: '',
    fallbackProvider: '',
    usageLimits: {
        enabled: false,
        warnCostCny: 3,
        blockCostCny: 5,
        warnRequests: 100,
        blockRequests: 160
    }
});

const providers = ref<Provider[]>([]);
const providerNames = computed(() => {
    const names = providers.value.map(provider => provider.name);
    return names.includes('dsh-sdk') ? names : ['dsh-sdk', ...names];
});
const loading = ref(true);
const error = ref('');

async function loadSettings() {
    loading.value = true;
    try {
        const [s, p] = await Promise.all([
            invoke<Settings>('get_settings'),
            invoke<Provider[]>('get_providers')
        ]);
        settings.value = s;
        providers.value = p;
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

async function saveSettings() {
    try {
        await invoke('save_settings', { settings: settings.value });
        error.value = '';
        alert('保存成功');
    } catch (e) {
        error.value = String(e);
    }
}

onMounted(loadSettings);
</script>

<style scoped>
h2 {
    color: #d81b60;
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 20px;
}

.settings-form {
    max-width: 520px;
    display: flex;
    flex-direction: column;
    gap: 20px;
}

section {
    background: #fff;
    padding: 20px 24px;
    border-radius: 16px;
    border: 1px solid #fce4ec;
    box-shadow: 0 2px 8px rgba(244, 143, 177, 0.08);
}

section h3 {
    margin-bottom: 14px;
    font-size: 15px;
    color: #d81b60;
    font-weight: 500;
}

select, input {
    padding: 10px 14px;
    border: 1px solid #f8cdd8;
    border-radius: 12px;
    background: #fff5f7;
    color: #5a4a52;
    width: 100%;
    font-size: 14px;
    outline: none;
}

select:focus, input:focus {
    border-color: #f48fb1;
    background: #fff;
}

.limit-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-top: 14px;
}

.limit-grid.limit-disabled {
    opacity: 0.55;
}

.limit-grid label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: #b8a0ac;
}

.checkbox {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    color: #7a5c6c;
}

.checkbox input {
    width: auto;
    accent-color: #f48fb1;
}

.hint {
    font-size: 12px;
    color: #c9a6b8;
    margin-top: 6px;
}

.btn-primary {
    padding: 12px 32px;
    background: linear-gradient(135deg, #f8bbd0 0%, #f48fb1 100%);
    border: none;
    border-radius: 24px;
    color: #fff;
    cursor: pointer;
    font-size: 15px;
    align-self: flex-start;
    transition: transform 0.1s;
}

.btn-primary:hover {
    transform: scale(1.05);
}

.loading, .error {
    text-align: center;
    padding: 60px;
}

.error {
    color: #e91e63;
}
</style>
