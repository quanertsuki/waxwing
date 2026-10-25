<template>
  <div class="modal" @click.self="$emit('close')">
    <form class="sheet" @submit.prevent="submit">
      <header>
        <div>
          <p class="eyebrow">NEW DELEGATION</p>
          <h3>创建任务</h3>
        </div>
        <button type="button" class="ghost" @click="$emit('close')">取消</button>
      </header>

      <label>
        <span>项目目录</span>
        <input v-model.trim="form.workspace" placeholder="D:\\projects\\example" required />
      </label>

      <div class="two-columns">
        <label>
          <span>工作区模式</span>
          <select v-model="form.workspaceMode">
            <option value="auto">自动（推荐）</option>
            <option value="worktree">Git worktree</option>
            <option value="shared">共享目录</option>
          </select>
        </label>
        <label>
          <span>单轮输出预算（可选）</span>
          <input v-model="maxTokens" inputmode="numeric" placeholder="继承默认值" />
        </label>
      </div>
      <p class="hint">
        自动模式会为干净的 Git 仓库创建独立 worktree；脏仓库需要显式选择共享目录。
      </p>

      <label>
        <span>任务说明</span>
        <textarea v-model="form.prompt" rows="5" placeholder="描述可独立验收的完整任务" required />
      </label>
      <label>
        <span>计划</span>
        <textarea v-model="form.plan" rows="2" placeholder="可选" />
      </label>
      <label>
        <span>验收标准</span>
        <textarea v-model="form.criteria" rows="3" placeholder="明确由 Delegating Agent 独立执行的检查" />
      </label>

      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <button type="button" class="ghost" @click="$emit('close')">取消</button>
        <button type="submit" class="primary" :disabled="submitting">
          {{ submitting ? '正在创建…' : '创建并运行' }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';

const emit = defineEmits<{ close: []; created: [] }>();
const submitting = ref(false);
const error = ref('');
const maxTokens = ref('');
const form = ref({
  workspace: '',
  workspaceMode: 'auto',
  prompt: '',
  plan: '',
  criteria: '',
});

async function submit() {
  submitting.value = true;
  error.value = '';
  try {
    const args: Record<string, unknown> = { ...form.value };
    if (maxTokens.value.trim()) {
      const parsed = Number(maxTokens.value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error('单轮输出预算必须是正整数');
      }
      args.maxTokens = parsed;
    }
    await invoke('create_task', { args });
    emit('created');
    emit('close');
  } catch (value) {
    error.value = String(value);
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(72, 32, 48, 0.28);
  backdrop-filter: blur(5px);
}
.sheet {
  width: min(720px, 100%);
  max-height: 90vh;
  overflow: auto;
  padding: 28px;
  border: 1px solid #f6c9d8;
  border-radius: 24px;
  background:
    radial-gradient(circle at 100% 0, rgba(248, 187, 208, 0.34), transparent 34%),
    #fffafb;
  box-shadow: 0 24px 70px rgba(126, 44, 74, 0.22);
}
header,
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
header {
  margin-bottom: 20px;
}
h3 {
  margin: 2px 0 0;
  color: #b91c5c;
  font-size: 25px;
}
.eyebrow {
  margin: 0;
  color: #d27796;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
}
label {
  display: grid;
  gap: 7px;
  margin-bottom: 14px;
  color: #7b5262;
  font-size: 13px;
  font-weight: 600;
}
input,
select,
textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #f0c9d6;
  border-radius: 12px;
  padding: 11px 13px;
  background: #fff;
  color: #533844;
  font: inherit;
  font-weight: 400;
  outline: none;
}
input:focus,
select:focus,
textarea:focus {
  border-color: #e56d99;
  box-shadow: 0 0 0 3px rgba(229, 109, 153, 0.13);
}
textarea {
  resize: vertical;
}
.two-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.hint {
  margin: -5px 0 16px;
  color: #a17c8b;
  font-size: 12px;
  line-height: 1.55;
}
button {
  border: 0;
  border-radius: 999px;
  padding: 10px 20px;
  cursor: pointer;
  font: inherit;
}
.ghost {
  color: #9c6077;
  background: #fff0f5;
}
.primary {
  color: #fff;
  background: linear-gradient(135deg, #e94f87, #c92b67);
  box-shadow: 0 7px 18px rgba(201, 43, 103, 0.25);
}
.primary:disabled {
  opacity: 0.55;
  cursor: wait;
}
.error {
  color: #b4234d;
  background: #fff0f3;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12px;
}
.actions {
  justify-content: flex-end;
  margin-top: 18px;
}
@media (max-width: 640px) {
  .two-columns {
    grid-template-columns: 1fr;
  }
}
</style>
