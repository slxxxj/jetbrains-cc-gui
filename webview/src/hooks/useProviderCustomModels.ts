import { useCallback, useEffect, useState } from 'react';
import type { CodexCustomModel } from '../types/provider';
import type { ProviderKind } from '../utils/providerCapabilities';
import {
  getProviderCustomModels,
  setProviderCustomModels,
  subscribeProviderCustomModels,
} from '../utils/providerCustomModelsStore';

export interface UseProviderCustomModelsResult {
  /** Custom models of the active provider entry (legacy localStorage fallback). */
  models: CodexCustomModel[];
  /** Persist a new custom model list for the provider kind. */
  updateModels: (models: CodexCustomModel[]) => void;
}

/**
 * React binding for entry-backed custom models (Phase 3B). Reads the active
 * provider entry's `customModels` (falling back to the legacy localStorage
 * list) and re-renders on provider-list pushes, migrations, and writes.
 */
export function useProviderCustomModels(provider: ProviderKind): UseProviderCustomModelsResult {
  const [models, setModels] = useState<CodexCustomModel[]>(() => getProviderCustomModels(provider));

  useEffect(() => {
    setModels(getProviderCustomModels(provider));
    return subscribeProviderCustomModels(() => {
      setModels(getProviderCustomModels(provider));
    });
  }, [provider]);

  const updateModels = useCallback(
    (next: CodexCustomModel[]) => setProviderCustomModels(provider, next),
    [provider],
  );

  return { models, updateModels };
}
