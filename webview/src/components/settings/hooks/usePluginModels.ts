import { useState, useCallback, useEffect } from 'react';
import type { CodexCustomModel, ModelPricing } from '../../../types/provider';
import { isValidModelPricing, STORAGE_KEYS } from '../../../types/provider';
import { sendBridgeEvent } from '../../../utils/bridge';
import { getProviderCapabilities, type ProviderKind } from '../../../utils/providerCapabilities';
import {
  getProviderCustomModels,
  setProviderCustomModels,
  subscribeProviderCustomModels,
} from '../../../utils/providerCustomModelsStore';

const STORAGE_KEY_TO_PROVIDER: Partial<Record<string, ProviderKind>> = {
  [STORAGE_KEYS.CLAUDE_CUSTOM_MODELS]: 'claude',
  [STORAGE_KEYS.CODEX_CUSTOM_MODELS]: 'codex',
};

function readConfiguredClaudePricingModels(): CodexCustomModel[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING);
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([id, pricing]) => id.trim() && isValidModelPricing(pricing))
      .map(([id, pricing]) => ({
        id: normalizeComparableModelId(id.trim()),
        label: normalizeComparableModelId(id.trim()),
        pricing: pricing as ModelPricing,
      }))
      .filter(model => model.id);
  } catch {
    return [];
  }
}

function normalizeComparableModelId(modelId: string): string {
  return modelId.trim().replace(/\[1m\]$/i, '');
}

/**
 * Mirror custom model pricing into the Java config file used by usage aggregators.
 * The complete model list is sent because deleting a model or clearing all pricing
 * must replace the provider's persisted pricing map, not merge with stale entries.
 */
function syncCustomModelPricing(provider: ProviderKind, models: CodexCustomModel[]) {
  const syncModels = getProviderCapabilities(provider).supportsConfiguredModelPricing
    ? [
      ...models,
      ...readConfiguredClaudePricingModels(),
    ]
    : models;

  sendBridgeEvent('set_custom_model_pricing', JSON.stringify({
    provider,
    models: syncModels,
  }));
}

/**
 * Hook to manage plugin-level custom models.
 *
 * Phase 3B: persistence moved from localStorage to the active provider entry
 * (`customModels` on ProviderConfig / CodexProviderConfig) via
 * providerCustomModelsStore; the legacy localStorage keys remain as a
 * read-only fallback and transitional shadow. The `storageKey` parameter is
 * kept for API compatibility and only selects the provider kind.
 */
export function usePluginModels(storageKey: string) {
  const provider: ProviderKind = STORAGE_KEY_TO_PROVIDER[storageKey] ?? 'claude';
  const [models, setModels] = useState<CodexCustomModel[]>(() => getProviderCustomModels(provider));

  useEffect(() => {
    setModels(getProviderCustomModels(provider));
    return subscribeProviderCustomModels(() => {
      setModels(getProviderCustomModels(provider));
    });
  }, [provider]);

  const updateModels = useCallback((newModels: CodexCustomModel[]) => {
    setProviderCustomModels(provider, newModels);
    setModels(getProviderCustomModels(provider));
    syncCustomModelPricing(provider, getProviderCustomModels(provider));
  }, [provider]);

  return { models, updateModels };
}
