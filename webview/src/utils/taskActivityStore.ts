/**
 * Task-activity store — live subagent (Agent/Task tool) progress and per-tool
 * heartbeat state, fed by two window callbacks the Java layer invokes:
 *
 *   window.onTaskEvent(json)        — background-task lifecycle from the SDK
 *     {kind:'started'|'progress'|'notification'|'updated'|'tool_progress', ...}
 *   window.onSubagentMessage(json)  — trimmed sidechain tool steps
 *     {parentToolUseId, role, blocks:[{type:'tool_use',...}|{type:'tool_result',...}]}
 *
 * These arrive both during the spawning turn and between turns (an async
 * subagent keeps running after the main turn's result), which is why they flow
 * outside the normal message pipeline. The store is a module singleton like
 * availableModelsStore: window callbacks write, React consumers subscribe via
 * useSyncExternalStore with per-key snapshots so only the affected agent card
 * re-renders on each progress tick.
 */

import { useSyncExternalStore } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubagentRunStatus = 'running' | 'completed' | 'error' | 'stopped';

export interface SubagentActivity {
  taskId?: string;
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  status: SubagentRunStatus;
  lastToolName?: string;
  toolUses?: number;
  totalTokens?: number;
  durationMs?: number;
  summary?: string;
  updatedAt: number;
}

export interface SubagentStep {
  id: string;
  name: string;
  summary?: string;
  status: 'running' | 'completed' | 'error';
}

export interface ToolProgressInfo {
  toolUseId?: string;
  toolName?: string;
  parentToolUseId: string | null;
  elapsedTimeSeconds?: number;
  at: number;
}

interface TaskEventPayload {
  kind?: string;
  taskId?: string;
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  lastToolName?: string;
  summary?: string;
  status?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  patch?: { status?: string };
  toolName?: string;
  parentToolUseId?: string | null;
  elapsedTimeSeconds?: number;
}

interface SubagentMessagePayload {
  parentToolUseId?: string;
  role?: string;
  blocks?: Array<{
    type?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    is_error?: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A tool_progress heartbeat older than this no longer counts as "alive". */
export const TOOL_PROGRESS_STALE_MS = 15_000;

/**
 * A 'running' subagent activity that stopped receiving updates for this long is
 * considered interrupted (the session was killed before any completion event).
 */
export const SUBAGENT_ACTIVITY_STALE_MS = 10 * 60_000;

const STEP_SUMMARY_MAX = 80;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const activities = new Map<string, SubagentActivity>();
const steps = new Map<string, SubagentStep[]>();
let latestToolProgress: ToolProgressInfo | null = null;

const listeners = new Set<() => void>();

function emit(): void {
  Array.from(listeners).forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('[taskActivityStore] Listener threw:', error);
    }
  });
}

export function subscribeTaskActivity(listener: () => void): () => void {
  installTaskEventDispatchers();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Reducers (pure-ish; exported for tests)
// ---------------------------------------------------------------------------

function activityKey(payload: TaskEventPayload): string | undefined {
  return payload.toolUseId ?? payload.taskId;
}

function mapNotificationStatus(status: string | undefined): SubagentRunStatus {
  if (status === 'failed') return 'error';
  if (status === 'stopped' || status === 'killed') return 'stopped';
  return 'completed';
}

export function applyTaskEvent(payload: TaskEventPayload): void {
  if (!payload || typeof payload !== 'object' || typeof payload.kind !== 'string') return;

  if (payload.kind === 'tool_progress') {
    latestToolProgress = {
      toolUseId: payload.toolUseId,
      toolName: payload.toolName,
      parentToolUseId: typeof payload.parentToolUseId === 'string' ? payload.parentToolUseId : null,
      elapsedTimeSeconds: typeof payload.elapsedTimeSeconds === 'number' ? payload.elapsedTimeSeconds : undefined,
      at: Date.now(),
    };
    emit();
    return;
  }

  const key = activityKey(payload);
  if (!key) return;
  const prev = activities.get(key);
  const now = Date.now();

  switch (payload.kind) {
    case 'started':
      activities.set(key, {
        ...prev,
        taskId: payload.taskId ?? prev?.taskId,
        toolUseId: payload.toolUseId ?? prev?.toolUseId,
        description: payload.description ?? prev?.description,
        subagentType: payload.subagentType ?? prev?.subagentType,
        status: 'running',
        updatedAt: now,
      });
      break;
    case 'progress':
      activities.set(key, {
        ...prev,
        taskId: payload.taskId ?? prev?.taskId,
        toolUseId: payload.toolUseId ?? prev?.toolUseId,
        description: payload.description ?? prev?.description,
        subagentType: payload.subagentType ?? prev?.subagentType,
        status: prev?.status === 'running' || !prev ? 'running' : prev.status,
        lastToolName: payload.lastToolName ?? prev?.lastToolName,
        toolUses: payload.usage?.toolUses ?? prev?.toolUses,
        totalTokens: payload.usage?.totalTokens ?? prev?.totalTokens,
        durationMs: payload.usage?.durationMs ?? prev?.durationMs,
        summary: payload.summary ?? prev?.summary,
        updatedAt: now,
      });
      break;
    case 'notification':
      activities.set(key, {
        ...prev,
        taskId: payload.taskId ?? prev?.taskId,
        toolUseId: payload.toolUseId ?? prev?.toolUseId,
        status: mapNotificationStatus(payload.status),
        summary: payload.summary ?? prev?.summary,
        toolUses: payload.usage?.toolUses ?? prev?.toolUses,
        totalTokens: payload.usage?.totalTokens ?? prev?.totalTokens,
        durationMs: payload.usage?.durationMs ?? prev?.durationMs,
        updatedAt: now,
      });
      break;
    case 'updated': {
      const patchStatus = payload.patch?.status;
      if (!prev && !patchStatus) return;
      activities.set(key, {
        ...prev,
        taskId: payload.taskId ?? prev?.taskId,
        status:
          patchStatus === 'completed' || patchStatus === 'failed' || patchStatus === 'killed'
            ? mapNotificationStatus(patchStatus)
            : patchStatus === 'running'
              ? 'running'
              : (prev?.status ?? 'running'),
        updatedAt: now,
      });
      break;
    }
    default:
      return;
  }
  emit();
}

function truncateSummary(value: string): string {
  return value.length > STEP_SUMMARY_MAX ? `${value.slice(0, STEP_SUMMARY_MAX)}…` : value;
}

/** Pick the one input field that best identifies a tool call for a step row. */
export function summarizeStepInput(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  const candidates = ['file_path', 'pattern', 'command', 'query', 'url', 'description', 'prompt', 'path'];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return truncateSummary(value.trim());
    }
  }
  return undefined;
}

export function applySubagentMessage(payload: SubagentMessagePayload): void {
  const parentId = payload?.parentToolUseId;
  if (!parentId || !Array.isArray(payload.blocks)) return;

  const prev = steps.get(parentId) ?? [];
  let next = prev;

  const upsert = (step: SubagentStep) => {
    const index = next.findIndex((s) => s.id === step.id);
    if (index === -1) {
      if (next === prev) next = [...prev];
      next.push(step);
    } else if (next[index].status !== step.status || next[index].summary !== step.summary) {
      if (next === prev) next = [...prev];
      // A completed/errored step never flips back to running.
      next[index] = {
        ...step,
        summary: step.summary ?? next[index].summary,
        status: next[index].status !== 'running' && step.status === 'running' ? next[index].status : step.status,
      };
    }
  };

  for (const block of payload.blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      upsert({
        id: block.id,
        name: typeof block.name === 'string' && block.name ? block.name : 'tool',
        summary: summarizeStepInput(block.input),
        status: 'running',
      });
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      upsert({
        id: block.tool_use_id,
        name: 'tool',
        summary: undefined,
        status: block.is_error === true ? 'error' : 'completed',
      });
    }
  }

  if (next !== prev) {
    steps.set(parentId, next);
    // Keep the activity's tool counter in sync as a fallback for sessions
    // where task_progress events are absent (e.g. older CLI versions).
    const activity = activities.get(parentId);
    if (activity && (activity.toolUses ?? 0) < next.length) {
      activities.set(parentId, { ...activity, toolUses: next.length, updatedAt: Date.now() });
    }
    emit();
  }
}

// ---------------------------------------------------------------------------
// Window-callback dispatchers
// ---------------------------------------------------------------------------

function parseJson(json: unknown): Record<string, unknown> | null {
  if (typeof json !== 'string' || !json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Install (or re-install) the window callbacks the Java layer invokes. Safe to
 * call repeatedly; also called lazily on first subscribe so consumers mounted
 * before app-level registration still work.
 *
 * Every event also bumps the stream-stall watchdog: during a long async
 * subagent run these events may be the ONLY sign of life for minutes (the main
 * chain is silent), and without the bump the 60s watchdog could force a false
 * stream-end.
 */
export function installTaskEventDispatchers(): void {
  window.onTaskEvent = (json: string) => {
    if (window.__lastStreamActivityAt !== undefined) {
      window.__lastStreamActivityAt = Date.now();
    }
    const payload = parseJson(json);
    if (payload) applyTaskEvent(payload as TaskEventPayload);
  };
  window.onSubagentMessage = (json: string) => {
    if (window.__lastStreamActivityAt !== undefined) {
      window.__lastStreamActivityAt = Date.now();
    }
    const payload = parseJson(json);
    if (payload) applySubagentMessage(payload as SubagentMessagePayload);
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getSubagentActivity(toolUseId: string | undefined): SubagentActivity | undefined {
  return toolUseId ? activities.get(toolUseId) : undefined;
}

export function getSubagentSteps(toolUseId: string | undefined): SubagentStep[] | undefined {
  return toolUseId ? steps.get(toolUseId) : undefined;
}

export function getLatestToolProgress(): ToolProgressInfo | null {
  return latestToolProgress;
}

/** The live tool heartbeat, or null when missing or older than the staleness window. */
export function getFreshToolProgress(now = Date.now()): ToolProgressInfo | null {
  if (!latestToolProgress) return null;
  return now - latestToolProgress.at < TOOL_PROGRESS_STALE_MS ? latestToolProgress : null;
}

/** Clear only the tool heartbeat (called at stream end / stream start). */
export function clearToolProgress(): void {
  if (latestToolProgress) {
    latestToolProgress = null;
    emit();
  }
}

/** Drop all state — session switch / history reload / test reset. */
export function resetTaskActivityStore(): void {
  activities.clear();
  steps.clear();
  latestToolProgress = null;
  emit();
}

// ---------------------------------------------------------------------------
// React bindings
// ---------------------------------------------------------------------------

export function useSubagentActivity(toolUseId: string | undefined): SubagentActivity | undefined {
  return useSyncExternalStore(subscribeTaskActivity, () => getSubagentActivity(toolUseId));
}

export function useSubagentSteps(toolUseId: string | undefined): SubagentStep[] | undefined {
  return useSyncExternalStore(subscribeTaskActivity, () => getSubagentSteps(toolUseId));
}

export function useLatestToolProgress(): ToolProgressInfo | null {
  return useSyncExternalStore(subscribeTaskActivity, getLatestToolProgress);
}
