import { useState } from 'react';
import { CLAUDE_MODELS } from '../../components/ChatInputBox/types';
import type { ChatMode, PermissionMode } from '../../components/ChatInputBox/types';

/**
 * Claude-specific selectable state. State only — handlers that span providers
 * (mode/model/provider switching, long-context toggle) live in the orchestrator
 * (useModelProviderState) since they need to read both Claude and Codex state.
 */
export function useClaudeProvider() {
  const [selectedClaudeModel, setSelectedClaudeModel] = useState(CLAUDE_MODELS[0].id);
  const [claudePermissionMode, setClaudePermissionMode] = useState<PermissionMode>('default');
  const [longContextEnabled, setLongContextEnabled] = useState(true);
  const [claudeSettingsAlwaysThinkingEnabled, setClaudeSettingsAlwaysThinkingEnabled] = useState(true);
  // Subagent (Task tool) model override. '' = no override (follow the main
  // model / CLI default); Claude-only.
  const [selectedSubagentModel, setSelectedSubagentModel] = useState('');
  // Per-message chat mode. 'agent' = default/normal; Claude-only. Travels
  // inside the send_message payload (no bridge event on change).
  const [selectedChatMode, setSelectedChatMode] = useState<ChatMode>('agent');

  return {
    selectedClaudeModel,
    setSelectedClaudeModel,
    claudePermissionMode,
    setClaudePermissionMode,
    longContextEnabled,
    setLongContextEnabled,
    claudeSettingsAlwaysThinkingEnabled,
    setClaudeSettingsAlwaysThinkingEnabled,
    selectedSubagentModel,
    setSelectedSubagentModel,
    selectedChatMode,
    setSelectedChatMode,
  };
}

export type UseClaudeProviderReturn = ReturnType<typeof useClaudeProvider>;
