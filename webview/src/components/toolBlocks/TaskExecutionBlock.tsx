import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { normalizeToolName } from '../../utils/toolConstants';
import { sendBridgeEvent } from '../../utils/bridge';
import { useSubagentHistoryGetter, useSessionId, useGetToolResultRaw, type GetToolResultRawFn } from '../../contexts/SubagentContext';
import { useSubagentActivity, useSubagentSteps, SUBAGENT_ACTIVITY_STALE_MS } from '../../utils/taskActivityStore';
import SubagentProcessDetails from '../StatusPanel/SubagentProcessDetails';
import { SubagentLiveLine, SubagentResultSummary, SubagentSteps } from './SubagentLiveSteps';

const MONO_FONT_STYLE: React.CSSProperties = {
  fontFamily: "var(--codeaide-code-font-family, var(--idea-editor-font-family, 'JetBrains Mono', 'Consolas', monospace))",
};
const NORMAL_WEIGHT_STYLE: React.CSSProperties = { fontWeight: 'normal' };

interface TaskExecutionBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  toolId?: string;
  isStreaming?: boolean;
}

type SpawnAgentMeta = {
  agentId?: string;
  nickname?: string;
  model?: string;
  reasoningEffort?: string;
};

function extractResultText(result?: ToolResultBlock | null): string | undefined {
  if (!result) return undefined;
  if (typeof result.content === 'string') {
    return result.content;
  }
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  return undefined;
}

function parseSpawnAgentMeta(input: ToolInput, result?: ToolResultBlock | null): SpawnAgentMeta {
  const text = extractResultText(result)?.trim();
  let parsed: Record<string, unknown> | null = null;

  if (text && (text.startsWith('{') || text.startsWith('['))) {
    try {
      const candidate = JSON.parse(text);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }

  const getString = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  };

  const agentId = getString(
    parsed?.agent_id,
    parsed?.agentId,
    parsed?.agent_path,
    parsed?.agentPath,
  ) ?? (text?.match(/\b([0-9a-f]{8}-[0-9a-f-]{27})\b/i)?.[1]);

  const nickname = getString(
    parsed?.nickname,
    parsed?.name,
  );

  const model = getString(
    parsed?.model,
    input.model,
  ) ?? (text?.match(/\(([A-Za-z0-9._:-]+)(?:\s+(low|medium|high|xhigh))?\)/i)?.[1]);

  const reasoningEffort = getString(
    parsed?.reasoning_effort,
    parsed?.reasoningEffort,
    input.reasoning_effort,
    input.reasoningEffort,
  ) ?? (text?.match(/\(([A-Za-z0-9._:-]+)(?:\s+(low|medium|high|xhigh))?\)/i)?.[2]);

  return { agentId, nickname, model, reasoningEffort };
}

function parseAgentToolMeta(
  getToolResultRaw: GetToolResultRawFn,
  toolUseId?: string,
): {
  agentId?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
} {
  if (!toolUseId) return {};
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const record = metadata as Record<string, unknown>;
  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  return {
    agentId: getString(record.agentId),
    totalDurationMs: getNumber(record.totalDurationMs),
    totalTokens: getNumber(record.totalTokens),
    totalToolUseCount: getNumber(record.totalToolUseCount),
  };
}

function shortenAgentId(agentId?: string): string | undefined {
  if (!agentId) return undefined;
  return agentId.length > 8 ? `${agentId.slice(0, 8)}…` : agentId;
}

const TaskExecutionBlock = memo(function TaskExecutionBlock({ name, input, result, toolId, isStreaming = false }: TaskExecutionBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const getSubagentHistory = useSubagentHistoryGetter();
  const currentSessionId = useSessionId();
  const getToolResultRaw = useGetToolResultRaw();

  if (!input) {
    return null;
  }

  const normalizedName = normalizeToolName(name ?? '');
  const isSpawnAgent = normalizedName === 'spawn_agent';
  const isAgentTool = normalizedName === 'agent' || normalizedName === 'task' || normalizedName === 'spawn_agent';
  const {
    description,
    prompt,
    subagent_type: subagentType,
    model: _model,
    reasoning_effort: _reasoningEffort,
    reasoningEffort: _reasoningEffortCamel,
    nickname: _nickname,
    name: _inputName,
    agent_id: _agentId,
    agentId: _agentIdCamel,
    agent_path: _agentPath,
    agentPath: _agentPathCamel,
    ...rest
  } = input;
  const spawnMeta = isSpawnAgent ? parseSpawnAgentMeta(input, result) : {};
  const agentToolMeta = !isSpawnAgent ? parseAgentToolMeta(getToolResultRaw, toolId) : {};
  const agentId = spawnMeta.agentId ?? agentToolMeta.agentId;
  const identityLabel = spawnMeta.nickname || (typeof subagentType === 'string' && subagentType ? subagentType : undefined);
  const modelSummary = [spawnMeta.model, spawnMeta.reasoningEffort].filter(Boolean).join(' ');
  const shortAgentId = shortenAgentId(agentId);

  // Determine status based on result. Caveat: for async subagent launches the
  // tool_result arrives immediately ("async launched" metadata) while the agent
  // is still running — a live 'running' activity must win over the early result,
  // otherwise the card shows a green dot for work that has not finished.
  const activity = useSubagentActivity(toolId);
  const activityStale = activity?.status === 'running'
    && Date.now() - activity.updatedAt > SUBAGENT_ACTIVITY_STALE_MS;
  const activityRunning = activity?.status === 'running' && !activityStale;
  const activityTerminal = activity != null && !activityRunning;
  const isCompleted = (result !== undefined && result !== null && !activityRunning) || activityTerminal;
  const isError = isCompleted
    && (result?.is_error === true || activity?.status === 'error' || activity?.status === 'stopped' || activityStale === true);
  const history = (toolId ? getSubagentHistory(toolId) : undefined) ?? (agentId ? getSubagentHistory(agentId) : undefined);
  // Live sidechain steps take precedence over the disk-history view: while
  // steps stream in, SubagentProcessDetails would only show a loading spinner.
  const liveSteps = useSubagentSteps(toolId);
  const hasLiveSteps = (liveSteps?.length ?? 0) > 0;

  useEffect(() => {
    if (!expanded || !isAgentTool || !currentSessionId || !toolId || history) return;
    sendBridgeEvent('load_subagent_session', JSON.stringify({
      sessionId: currentSessionId,
      agentId,
      description: typeof description === 'string' ? description : undefined,
      toolUseId: toolId,
    }));
  }, [agentId, currentSessionId, description, expanded, history, isAgentTool, toolId]);

  const shouldPollHistory = expanded
    && isAgentTool
    && Boolean(currentSessionId)
    && Boolean(toolId)
    && isStreaming
    && !isCompleted
    && !history;

  // Poll subagent history only while the tool is still actively streaming and
  // we have not received history yet. Avoid keeping idle intervals alive.
  useEffect(() => {
    if (!shouldPollHistory || !currentSessionId || !toolId) return;
    const timer = window.setInterval(() => {
      sendBridgeEvent('load_subagent_session', JSON.stringify({
        sessionId: currentSessionId,
        agentId,
        description: typeof description === 'string' ? description : undefined,
        toolUseId: toolId,
      }));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [agentId, currentSessionId, description, shouldPollHistory, toolId]);

  return (
    <div className="task-container">
      <div
        className={`task-header ${expanded ? 'task-header-expanded' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="task-title-section">
          <span className="codicon codicon-tools tool-title-icon" />

          <span className="tool-title-text">
            {name ?? t('tools.task')}
          </span>
          {identityLabel && (
            <span className="tool-title-summary">{identityLabel}</span>
          )}
          {modelSummary && (
            <span className="tool-title-summary">· {modelSummary}</span>
          )}
          {shortAgentId && (
            <span className="tool-title-summary" style={MONO_FONT_STYLE}>
              · {shortAgentId}
            </span>
          )}

          {!isSpawnAgent && typeof description === 'string' && (
            <span className="task-summary-text tool-title-summary" title={description} style={NORMAL_WEIGHT_STYLE}>
              {description}
            </span>
          )}
        </div>

        <div className="task-header-right">
          <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
        </div>
      </div>

      {/* Live progress line from the task_event stream — visible without
          expanding, keeps the card honest while an async subagent runs. */}
      <SubagentLiveLine toolId={toolId} />

      {expanded && (
        <div className="task-details">
          <div className="task-content-wrapper">
            {/* Live sidechain steps + async result summary take precedence;
                SubagentProcessDetails (disk history) complements below. */}
            <SubagentSteps toolId={toolId} />
            <SubagentResultSummary toolId={toolId} />

            {spawnMeta.nickname && (
              <div className="task-field">
                <div className="task-field-label">nickname</div>
                <div className="task-field-content">{spawnMeta.nickname}</div>
              </div>
            )}

            {spawnMeta.model && (
              <div className="task-field">
                <div className="task-field-label">model</div>
                <div className="task-field-content">{spawnMeta.model}</div>
              </div>
            )}

            {spawnMeta.reasoningEffort && (
              <div className="task-field">
                <div className="task-field-label">reasoning_effort</div>
                <div className="task-field-content">{spawnMeta.reasoningEffort}</div>
              </div>
            )}

            {spawnMeta.agentId && (
              <div className="task-field">
                <div className="task-field-label">agent_id</div>
                <div className="task-field-content">{spawnMeta.agentId}</div>
              </div>
            )}

            {isAgentTool && (!hasLiveSteps || isCompleted) && (
              <SubagentProcessDetails
                agentId={agentId}
                totalDurationMs={agentToolMeta.totalDurationMs}
                totalTokens={agentToolMeta.totalTokens}
                totalToolUseCount={agentToolMeta.totalToolUseCount}
                resultText={activity?.summary ?? extractResultText(result)}
                history={history}
                canLoad={Boolean(currentSessionId)}
              />
            )}

            {typeof prompt === 'string' && (
              <div className="task-field">
                <div className="task-field-label">
                  <span className="codicon codicon-comment" />
                  {t('tools.promptLabel')}
                </div>
                <div className="task-field-content">{prompt}</div>
              </div>
            )}

            {Object.entries(rest).map(([key, value]) => (
              <div key={key} className="task-field">
                <div className="task-field-label">{key}</div>
                <div className="task-field-content">
                  {typeof value === 'object' && value !== null
                    ? JSON.stringify(value, null, 2)
                    : String(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default TaskExecutionBlock;
