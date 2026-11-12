// The only Tauri call layer. Every view imports its types and commands from
// here, and the task view types come from contract.generated.ts, which is
// generated from the real manager output.
import { invoke } from '@tauri-apps/api/core';
import type {
  Task,
  TaskDetail,
  TaskDetailUsage,
  TaskEvent,
  TaskRound,
  TaskRuntime,
  TaskUsage,
  UsageRound,
} from './contract.generated';

export type {
  Task,
  TaskDetail,
  TaskDetailUsage,
  TaskEvent,
  TaskRound,
  TaskRuntime,
  TaskUsage,
  UsageRound,
};

export interface TaskViewPage {
  text: string;
  offset: number;
  limit: number;
  totalChars: number;
  nextOffset: number | null;
  complete: boolean;
}

export interface Provider {
  name: string;
  type: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  dshRepo?: string;
  credentialsFile?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  maxToolRequests?: number | null;
  stream?: boolean;
}

export interface InvalidProvider {
  file: string;
  error: string;
}

export interface ProvidersResponse {
  providers: Provider[];
  invalid: InvalidProvider[];
}

export interface UsageLimits {
  enabled: boolean;
  warnCostCny: number;
  blockCostCny: number;
  warnRequests: number;
  blockRequests: number;
}

export interface Settings {
  defaultProvider: string;
  fallbackProvider: string;
  usageLimits: UsageLimits;
}

export interface SaveSettingsResult {
  saved: boolean;
  restartRequired: boolean;
  settings: Settings;
}

export interface CreateTaskInput {
  workspace: string;
  prompt: string;
  plan?: string;
  criteria?: string;
  workspaceMode?: string;
  maxTokens?: number;
  effort?: string;
}

export interface ReworkInput {
  id: string;
  prompt: string;
  maxTokens?: number;
  effort?: string;
}

export type ManagerHealth = 'running' | 'unhealthy' | 'notRunning';

export const api = {
  listTasks: () => invoke<Task[]>('get_tasks'),
  taskDetail: (id: string) => invoke<TaskDetail>('get_task_detail', { id }),
  taskView: (id: string, view: string, offset = 0, limit = 4000) =>
    invoke<TaskViewPage>('get_task_view', { id, view, offset, limit }),
  createTask: (args: CreateTaskInput) => invoke<unknown>('create_task', { args }),
  reworkTask: (args: ReworkInput) => invoke<unknown>('rework_task', { args }),
  acceptTask: (id: string, evidence: string) =>
    invoke<unknown>('accept_task', { id, evidence }),
  closeTask: (id: string) => invoke<unknown>('close_task', { id }),
  cancelTask: (id: string) => invoke<unknown>('cancel_task', { id }),
  cleanupWorktree: (id: string) => invoke<unknown>('cleanup_worktree', { id }),
  managerHealth: () => invoke<ManagerHealth>('is_manager_running'),
  startManager: () => invoke<boolean>('start_manager'),
  providers: () => invoke<ProvidersResponse>('get_providers'),
  validateProvider: (config: Provider) => invoke<unknown>('validate_provider', { config }),
  saveProvider: (config: Provider) => invoke<unknown>('save_provider', { config }),
  deleteProvider: (name: string) => invoke<unknown>('delete_provider', { name }),
  settings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) =>
    invoke<SaveSettingsResult>('save_settings', { settings }),
};
