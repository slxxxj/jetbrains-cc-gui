import { useCallback, useEffect, useState } from 'react';
import type { ModelInfo } from '../components/ChatInputBox/types';
import type { ProviderKind } from '../utils/providerCapabilities';
import {
  getAvailableModelsEntry,
  requestAvailableModels,
  subscribeAvailableModels,
  type AvailableModelsSource,
} from '../utils/availableModelsStore';

const MAX_REQUEST_RETRIES = 30;
const REQUEST_RETRY_INTERVAL_MS = 100;

export interface UseAvailableModelsResult {
  /**
   * Dynamic model list for the provider, or undefined when the backend has
   * not answered yet (callers fall back to the built-in list in that case).
   */
  models: ModelInfo[] | undefined;
  /** Whether the list came from a live fetch or the backend's fallback. */
  source: AvailableModelsSource | undefined;
  /** Re-fetch the model list from the provider (backend cache bypass). */
  refresh: () => void;
}

/**
 * React binding for the dynamic model list (Phase 3B). Requests the list on
 * mount and whenever the provider changes — retrying until the JCEF bridge is
 * ready — and re-renders when `window.updateAvailableModels` delivers a new
 * payload.
 */
export function useAvailableModels(provider: ProviderKind): UseAvailableModelsResult {
  const [entry, setEntry] = useState(() => getAvailableModelsEntry(provider));

  useEffect(() => {
    // Sync with anything cached while this hook was not mounted (or cached
    // for a different provider before the provider prop changed).
    setEntry(getAvailableModelsEntry(provider));
    return subscribeAvailableModels(() => {
      setEntry(getAvailableModelsEntry(provider));
    });
  }, [provider]);

  useEffect(() => {
    let retryCount = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      const sent = requestAvailableModels(provider);
      if (!sent && retryCount < MAX_REQUEST_RETRIES) {
        retryCount++;
        timeoutId = setTimeout(attempt, REQUEST_RETRY_INTERVAL_MS);
      }
    };
    attempt();
    return () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [provider]);

  const refresh = useCallback(() => {
    requestAvailableModels(provider, true);
  }, [provider]);

  return { models: entry?.models, source: entry?.source, refresh };
}
