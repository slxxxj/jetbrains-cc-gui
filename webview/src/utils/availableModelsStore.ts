/**
 * Available-models store — the frontend half of the dynamic model list.
 *
 * The backend answers `get_available_models` bridge events by invoking
 * `window.updateAvailableModels(json)` with a payload of the shape:
 *
 *   { "provider": "claude" | "codex",
 *     "models": [{ "id", "label", "description" }],
 *     "source": "dynamic" | "fallback" }
 *
 * This module registers a single dispatcher for that callback (same pattern as
 * runtimeProviderCapabilities), caches the latest payload per provider, and
 * notifies subscribers. React consumers should use `useAvailableModels`
 * (hooks/useAvailableModels.ts); `ButtonArea` merges the dynamic list with the
 * built-in fallback list and the active provider's custom models via
 * {@link mergeModelLists}.
 */

import type { ModelInfo } from '../components/ChatInputBox/types';
import { sendBridgeEvent } from './bridge';
import { isKnownProvider, type ProviderKind } from './providerCapabilities';

/** Origin of a model list payload: live-fetched from the provider or the built-in fallback. */
export type AvailableModelsSource = 'dynamic' | 'fallback';

export interface AvailableModelsEntry {
  models: ModelInfo[];
  source: AvailableModelsSource;
}

type AvailableModelsListener = () => void;

const cache = new Map<ProviderKind, AvailableModelsEntry>();
const listeners = new Set<AvailableModelsListener>();

function emit(): void {
  // Snapshot to avoid mutation during iteration.
  Array.from(listeners).forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('[availableModelsStore] Listener threw:', error);
    }
  });
}

/**
 * Parse and validate an `updateAvailableModels` payload. Returns null for
 * malformed payloads; unknown providers and non-array model lists are
 * rejected, individual entries without a usable string id are dropped.
 */
export function parseAvailableModelsPayload(
  json: string,
): { provider: ProviderKind; entry: AvailableModelsEntry } | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (!isKnownProvider(record.provider)) {
    return null;
  }
  const rawModels = Array.isArray(record.models) ? record.models : [];
  const models: ModelInfo[] = rawModels
    .filter((m): m is { id: string; label?: unknown; description?: unknown } =>
      !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string'
      && ((m as { id: string }).id.trim().length > 0))
    .map((m) => ({
      id: m.id,
      label: typeof m.label === 'string' && m.label.trim().length > 0 ? m.label : m.id,
      description: typeof m.description === 'string' ? m.description : undefined,
    }));
  const source: AvailableModelsSource = record.source === 'dynamic' ? 'dynamic' : 'fallback';
  return { provider: record.provider, entry: { models, source } };
}

/**
 * Installs (or re-installs) the single dispatcher on `window`. Safe to call
 * multiple times — calling it during a test reset simply re-attaches the
 * dispatcher.
 */
export function installAvailableModelsDispatcher(): void {
  window.updateAvailableModels = (json: string) => {
    const parsed = parseAvailableModelsPayload(json);
    if (!parsed) {
      return;
    }
    cache.set(parsed.provider, parsed.entry);
    emit();
  };
}

function ensureInstalled(): void {
  if (typeof window === 'undefined') return;
  if (window.updateAvailableModels) {
    return;
  }
  installAvailableModelsDispatcher();
}

/** Subscribe to cache changes. Returns an unsubscribe function. */
export function subscribeAvailableModels(listener: AvailableModelsListener): () => void {
  ensureInstalled();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Latest cached payload for a provider, or undefined when none arrived yet. */
export function getAvailableModelsEntry(provider: ProviderKind): AvailableModelsEntry | undefined {
  return cache.get(provider);
}

/**
 * Reset all module state. Test-only: the store is a process-wide singleton,
 * so tests need a clean cache between cases.
 */
export function resetAvailableModelsForTests(): void {
  cache.clear();
  listeners.clear();
}

/**
 * Ask the backend for the available models of a provider. With `refresh` the
 * backend bypasses its cache and re-fetches from the provider. Returns the
 * sendBridgeEvent result (false when the JCEF bridge is not ready yet).
 */
export function requestAvailableModels(provider: ProviderKind, refresh = false): boolean {
  return sendBridgeEvent(
    'get_available_models',
    JSON.stringify(refresh ? { provider, refresh: true } : { provider }),
  );
}

/**
 * Merge model list layers into one list, de-duplicated by model id. Earlier
 * layers win, so callers pass them in priority order (custom → dynamic →
 * built-in fallback).
 */
export function mergeModelLists(...layers: Array<ModelInfo[] | undefined>): ModelInfo[] {
  const seen = new Set<string>();
  const merged: ModelInfo[] = [];
  for (const layer of layers) {
    if (!layer) continue;
    for (const model of layer) {
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
  }
  return merged;
}
