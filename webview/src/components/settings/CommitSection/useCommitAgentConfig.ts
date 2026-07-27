import { useState, useEffect, useCallback } from 'react';
import { sendToJava } from '../../../utils/bridge';

export interface CommitAgentConfig {
  /** Files each parallel agent summarizes. */
  batchSize: number;
  /** Maximum number of agents running in parallel. */
  maxParallel: number;
  /** Skip thinking/reasoning for faster generation. */
  fastMode: boolean;
  /** Append the per-file change detail list to the commit message. */
  includeFileDetail: boolean;
}

export const DEFAULT_COMMIT_AGENT_CONFIG: CommitAgentConfig = {
  batchSize: 30,
  maxParallel: 8,
  fastMode: true,
  includeFileDetail: true,
};

/**
 * Self-contained commit agent (fan-out) configuration hook.
 * Loads the persisted values on mount via the JCEF bridge and saves each
 * change immediately. Safe when the bridge is unavailable (defaults are kept).
 */
export function useCommitAgentConfig() {
  const [config, setConfig] = useState<CommitAgentConfig>(DEFAULT_COMMIT_AGENT_CONFIG);

  useEffect(() => {
    window.updateCommitAgentConfig = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setConfig({
          batchSize:
            typeof data.batchSize === 'number' ? data.batchSize : DEFAULT_COMMIT_AGENT_CONFIG.batchSize,
          maxParallel:
            typeof data.maxParallel === 'number' ? data.maxParallel : DEFAULT_COMMIT_AGENT_CONFIG.maxParallel,
          fastMode:
            typeof data.fastMode === 'boolean' ? data.fastMode : DEFAULT_COMMIT_AGENT_CONFIG.fastMode,
          includeFileDetail:
            typeof data.includeFileDetail === 'boolean'
              ? data.includeFileDetail
              : DEFAULT_COMMIT_AGENT_CONFIG.includeFileDetail,
        });
      } catch {
        // Ignore malformed payloads from the backend.
      }
    };
    sendToJava('get_commit_agent_config');
    return () => {
      window.updateCommitAgentConfig = undefined;
    };
  }, []);

  const updateBatchSize = useCallback((batchSize: number) => {
    if (!Number.isFinite(batchSize)) {
      return;
    }
    setConfig((prev) => ({ ...prev, batchSize }));
    sendToJava('set_commit_agent_config', { batchSize });
  }, []);

  const updateMaxParallel = useCallback((maxParallel: number) => {
    if (!Number.isFinite(maxParallel)) {
      return;
    }
    setConfig((prev) => ({ ...prev, maxParallel }));
    sendToJava('set_commit_agent_config', { maxParallel });
  }, []);

  const updateFastMode = useCallback((fastMode: boolean) => {
    setConfig((prev) => ({ ...prev, fastMode }));
    sendToJava('set_commit_agent_config', { fastMode });
  }, []);

  const updateIncludeFileDetail = useCallback((includeFileDetail: boolean) => {
    setConfig((prev) => ({ ...prev, includeFileDetail }));
    sendToJava('set_commit_agent_config', { includeFileDetail });
  }, []);

  return { config, updateBatchSize, updateMaxParallel, updateFastMode, updateIncludeFileDetail };
}
