/**
 * Provider-entry-backed custom models store (Phase 3B).
 *
 * Custom models used to live in localStorage (`claude-custom-models` /
 * `codex-custom-models`), shared by every provider of a kind. They now follow
 * the provider entry (`customModels` on ProviderConfig / CodexProviderConfig)
 * so they survive config export/import and stay attached to the provider they
 * were created for.
 *
 * Read path: the active provider entry's `customModels` win; when the active
 * entry is missing, special (CLI login / local settings.json), or carries no
 * custom models, the legacy localStorage data is still served (read-only
 * compatibility, kept for one version so a failed migration never loses data).
 *
 * Write path: updates go to the active provider entry via the existing
 * `update_provider` / `update_codex_provider` bridge flow. A localStorage
 * shadow copy is kept in sync until the backend echoes `customModels` back in
 * the provider list, at which point the legacy key is cleared ("confirm then
 * clear"). This keeps the UI correct even against a backend that does not
 * persist entry-level custom models yet.
 *
 * Migration: the first time (per session) an active regular provider entry is
 * seen without `customModels` while legacy localStorage data exists, the
 * legacy list is written into the entry through the normal update flow. The
 * legacy key is removed only after the entry confirms the data.
 */

import type { CodexProviderConfig, CodexCustomModel, ModelPricing, ProviderConfig } from '../types/provider';
import { isSpecialProviderId, isValidModelPricing, STORAGE_KEYS, validateCodexCustomModels } from '../types/provider';
import { sendBridgeEvent } from './bridge';
import { getProviderCapabilities, type ProviderKind } from './providerCapabilities';
import { subscribeCodexProviderList, subscribeProviderList } from './runtimeProviderCapabilities';

type RuntimeProvider = ProviderConfig | CodexProviderConfig;

const STORAGE_KEY_BY_KIND: Record<ProviderKind, string> = {
  claude: STORAGE_KEYS.CLAUDE_CUSTOM_MODELS,
  codex: STORAGE_KEYS.CODEX_CUSTOM_MODELS,
};

/** Bridge event carrying entry updates for each provider kind. */
const UPDATE_EVENT_BY_KIND: Record<ProviderKind, string> = {
  claude: 'update_provider',
  codex: 'update_codex_provider',
};

interface KindState {
  /** Last provider list pushed by the backend (may predate entry-level customModels support). */
  entries: RuntimeProvider[];
  /** Legacy localStorage content (canonical, validated shape). */
  legacyModels: CodexCustomModel[];
}

const state: Record<ProviderKind, KindState> = {
  claude: { entries: [], legacyModels: [] },
  codex: { entries: [], legacyModels: [] },
};

const listeners = new Set<() => void>();
const migrationAttempted = new Set<ProviderKind>();
let bootstrapped = false;

function emit(): void {
  Array.from(listeners).forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('[providerCustomModelsStore] Listener threw:', error);
    }
  });
}

function dispatchLocalStorageChange(key: string): void {
  try {
    window.dispatchEvent(new CustomEvent('localStorageChange', { detail: { key } }));
  } catch {
    // Non-fatal: event fan-out only matters to legacy listeners.
  }
}

/**
 * Read the legacy localStorage list. Codex data was always written in the
 * strict shape; the Claude key historically accepted entries without a label,
 * so those are normalized (label = id) instead of dropped.
 */
function readLegacyCustomModels(kind: ProviderKind): CodexCustomModel[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_BY_KIND[kind]);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    const strict = validateCodexCustomModels(parsed);
    if (kind === 'codex' || !Array.isArray(parsed)) {
      return strict;
    }
    const strictIds = new Set(strict.map((m) => m.id));
    const extras = (parsed as Array<{ id?: unknown; label?: unknown; description?: unknown }>)
      .filter((m) =>
        !!m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim().length > 0
        && !strictIds.has(m.id as string))
      .map((m) => ({
        id: m.id as string,
        label: typeof m.label === 'string' && m.label.trim().length > 0 ? m.label : (m.id as string),
        description: typeof m.description === 'string' ? m.description : undefined,
      }));
    return [...strict, ...extras];
  } catch {
    return [];
  }
}

function writeLegacyCustomModels(kind: ProviderKind, models: CodexCustomModel[]): void {
  const key = STORAGE_KEY_BY_KIND[kind];
  try {
    if (models.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(models));
    }
  } catch {
    // localStorage write failure (e.g. quota exceeded) — the provider entry
    // remains the authoritative copy.
  }
  state[kind].legacyModels = models;
  dispatchLocalStorageChange(key);
}

function clearLegacyCustomModels(kind: ProviderKind): void {
  const key = STORAGE_KEY_BY_KIND[kind];
  try {
    if (localStorage.getItem(key) === null) {
      if (state[kind].legacyModels.length === 0) return;
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage failures; clearing is best-effort.
  }
  if (state[kind].legacyModels.length > 0) {
    state[kind].legacyModels = [];
    dispatchLocalStorageChange(key);
  }
}

/** The active entry for a kind, derived from the last pushed provider list. */
function getActiveEntry(kind: ProviderKind): RuntimeProvider | undefined {
  return state[kind].entries.find((entry) => entry.isActive);
}

function entryCustomModels(entry: RuntimeProvider | undefined): CodexCustomModel[] {
  if (!entry || !Array.isArray(entry.customModels)) {
    return [];
  }
  // Lenient normalization: the contract makes label/description optional on
  // entry-level custom models, so fill label with the id instead of dropping
  // the entry (validateCodexCustomModels would require a non-empty label).
  return (entry.customModels as Array<{ id?: unknown; label?: unknown; description?: unknown; pricing?: unknown }>)
    .filter((m) => !!m && typeof m === 'object' && typeof m.id === 'string' && (m.id as string).trim().length > 0)
    .map((m) => ({
      id: m.id as string,
      label: typeof m.label === 'string' && m.label.trim().length > 0 ? m.label : (m.id as string),
      description: typeof m.description === 'string' ? m.description : undefined,
      ...(isValidModelPricing(m.pricing) ? { pricing: m.pricing as ModelPricing } : {}),
    }));
}

function sendEntryCustomModelsUpdate(kind: ProviderKind, entry: RuntimeProvider, models: CodexCustomModel[]): void {
  sendBridgeEvent(UPDATE_EVENT_BY_KIND[kind], JSON.stringify({
    id: entry.id,
    updates: { customModels: models },
  }));
}

/** Optimistically reflect an entry update in local state until the backend re-pushes the list. */
function applyOptimisticEntryModels(kind: ProviderKind, entryId: string, models: CodexCustomModel[]): void {
  state[kind].entries = state[kind].entries.map((entry) =>
    entry.id === entryId ? { ...entry, customModels: models } : entry);
}

/**
 * One-time migration per kind per session: legacy localStorage data exists
 * and the active regular entry has none → write the legacy list into the
 * entry. When the entry is later seen carrying custom models, the legacy key
 * is cleared (confirm-then-clear).
 */
function maybeMigrateLegacyModels(kind: ProviderKind): void {
  const active = getActiveEntry(kind);
  if (!active || isSpecialProviderId(active.id)) {
    return;
  }
  const fromEntry = entryCustomModels(active);
  if (fromEntry.length > 0) {
    // Entry is authoritative — the migration (if any) is confirmed durable.
    clearLegacyCustomModels(kind);
    migrationAttempted.add(kind);
    return;
  }
  if (migrationAttempted.has(kind)) {
    return;
  }
  const legacy = state[kind].legacyModels;
  if (legacy.length === 0) {
    return;
  }
  migrationAttempted.add(kind);
  applyOptimisticEntryModels(kind, active.id, legacy);
  sendEntryCustomModelsUpdate(kind, active, legacy);
}

function handleEntriesUpdate(kind: ProviderKind, entries: RuntimeProvider[]): void {
  state[kind].entries = Array.isArray(entries) ? entries : [];
  maybeMigrateLegacyModels(kind);
  emit();
}

const MAX_BOOTSTRAP_RETRIES = 30;
const BOOTSTRAP_RETRY_INTERVAL_MS = 100;

function requestProviderList(kind: ProviderKind): boolean {
  return sendBridgeEvent(getProviderCapabilities(kind).runtimeProviderEvents.listEvent);
}

function bootstrap(): void {
  if (bootstrapped || typeof window === 'undefined') {
    return;
  }
  bootstrapped = true;

  (['claude', 'codex'] as ProviderKind[]).forEach((kind) => {
    state[kind].legacyModels = readLegacyCustomModels(kind);
  });

  subscribeProviderList((json) => {
    try {
      handleEntriesUpdate('claude', JSON.parse(json));
    } catch (error) {
      console.error('[providerCustomModelsStore] Failed to parse Claude providers:', error);
    }
  });
  subscribeCodexProviderList((json) => {
    try {
      handleEntriesUpdate('codex', JSON.parse(json));
    } catch (error) {
      console.error('[providerCustomModelsStore] Failed to parse Codex providers:', error);
    }
  });

  // Keep the legacy shadow in sync with cross-tab and same-tab localStorage writes.
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEYS.CLAUDE_CUSTOM_MODELS || e.key === STORAGE_KEYS.CODEX_CUSTOM_MODELS) {
      refreshLegacyFromStorage();
    }
  };
  const handleCustomStorage = (e: Event) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key === STORAGE_KEYS.CLAUDE_CUSTOM_MODELS || key === STORAGE_KEYS.CODEX_CUSTOM_MODELS) {
      refreshLegacyFromStorage();
    }
  };
  window.addEventListener('storage', handleStorage);
  window.addEventListener('localStorageChange', handleCustomStorage);

  // Fetch the provider lists once the JCEF bridge is up.
  let retryCount = 0;
  const attemptRequest = () => {
    const claudeSent = requestProviderList('claude');
    const codexSent = requestProviderList('codex');
    if ((!claudeSent || !codexSent) && retryCount < MAX_BOOTSTRAP_RETRIES) {
      retryCount++;
      setTimeout(attemptRequest, BOOTSTRAP_RETRY_INTERVAL_MS);
    }
  };
  attemptRequest();
}

function refreshLegacyFromStorage(): void {
  (['claude', 'codex'] as ProviderKind[]).forEach((kind) => {
    state[kind].legacyModels = readLegacyCustomModels(kind);
  });
  emit();
}

/** Subscribe to custom-model changes (both kinds). Returns an unsubscribe function. */
export function subscribeProviderCustomModels(listener: () => void): () => void {
  bootstrap();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reset all module state. Test-only: the store is a process-wide singleton,
 * so tests that drive it through window callbacks need a clean slate.
 */
export function resetProviderCustomModelsForTests(): void {
  state.claude = { entries: [], legacyModels: [] };
  state.codex = { entries: [], legacyModels: [] };
  migrationAttempted.clear();
  bootstrapped = false;
}

/**
 * Custom models for a provider kind: the active entry's list when available,
 * otherwise the legacy localStorage data (read-only compatibility).
 */
export function getProviderCustomModels(kind: ProviderKind): CodexCustomModel[] {
  bootstrap();
  const active = getActiveEntry(kind);
  if (active && !isSpecialProviderId(active.id)) {
    const fromEntry = entryCustomModels(active);
    if (fromEntry.length > 0) {
      return fromEntry;
    }
  }
  return state[kind].legacyModels;
}

/**
 * Persist custom models for a provider kind. Writes go to the active provider
 * entry via the regular provider-update bridge flow; a localStorage shadow
 * copy is kept until the backend echoes entry-level custom models. When no
 * regular active entry exists (CLI login / local settings.json), only the
 * legacy localStorage path is written.
 */
export function setProviderCustomModels(kind: ProviderKind, models: CodexCustomModel[]): void {
  bootstrap();
  const valid = validateCodexCustomModels(models);
  const active = getActiveEntry(kind);
  if (active && !isSpecialProviderId(active.id)) {
    applyOptimisticEntryModels(kind, active.id, valid);
    sendEntryCustomModelsUpdate(kind, active, valid);
  }
  // Transitional shadow: keeps the list intact when the backend does not
  // persist entry-level customModels yet; cleared on first confirmed echo.
  writeLegacyCustomModels(kind, valid);
  emit();
}
