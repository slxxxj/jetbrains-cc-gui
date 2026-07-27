import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useSubagentActivity,
  useSubagentSteps,
  SUBAGENT_ACTIVITY_STALE_MS,
  type SubagentActivity,
} from '../../utils/taskActivityStore';
import { formatSubagentDuration } from '../StatusPanel/subagentProcess';

/**
 * Live subagent progress (Cursor-style). Data comes from the taskActivityStore,
 * which is fed by task_event / subagent_message callbacks — both during the
 * spawning turn and between turns (async subagents keep running after the main
 * turn's result). Everything here renders null when no live data exists, so
 * history-replayed sessions keep their original look.
 */

/** A 'running' activity that went silent for too long counts as interrupted. */
function effectiveStatus(activity: SubagentActivity): SubagentActivity['status'] {
  if (activity.status === 'running' && Date.now() - activity.updatedAt > SUBAGENT_ACTIVITY_STALE_MS) {
    return 'stopped';
  }
  return activity.status;
}

function formatDuration(ms: number | undefined, t: ReturnType<typeof useTranslation>['t']): string | undefined {
  return formatSubagentDuration(ms, {
    ms: t('subagent.process.unitMs'),
    s: t('subagent.process.unitS'),
  }) ?? undefined;
}

function formatStats(activity: SubagentActivity, t: ReturnType<typeof useTranslation>['t']): string {
  const parts: string[] = [];
  if (activity.toolUses != null) {
    parts.push(t('subagent.live.toolCount', { count: activity.toolUses }));
  }
  const duration = formatDuration(activity.durationMs, t);
  if (duration) {
    parts.push(duration);
  }
  return parts.join(' · ');
}

interface SubagentLiveLineProps {
  toolId?: string;
}

/**
 * One-line live status shown directly under the agent card header while (and
 * shortly after) the subagent runs — visible without expanding the card.
 */
export const SubagentLiveLine = memo(function SubagentLiveLine({ toolId }: SubagentLiveLineProps) {
  const { t } = useTranslation();
  const activity = useSubagentActivity(toolId);

  if (!activity) return null;
  const status = effectiveStatus(activity);
  const stats = formatStats(activity, t);

  if (status === 'running') {
    const action = activity.lastToolName
      ? t('subagent.live.runningTool', { toolName: activity.lastToolName })
      : t('subagent.live.starting');
    return (
      <div className="subagent-live-line running">
        <span className="subagent-live-spinner" />
        <span className="subagent-live-action">{action}</span>
        {stats && <span className="subagent-live-stats">{stats}</span>}
      </div>
    );
  }

  const statusLabel =
    status === 'completed'
      ? t('subagent.live.statusCompleted')
      : status === 'error'
        ? t('subagent.live.statusError')
        : t('subagent.live.statusStopped');

  return (
    <div className={`subagent-live-line ${status}`}>
      <span className={`codicon ${status === 'completed' ? 'codicon-check' : status === 'error' ? 'codicon-error' : 'codicon-debug-stop'}`} />
      <span className="subagent-live-action">{statusLabel}</span>
      {stats && <span className="subagent-live-stats">{stats}</span>}
    </div>
  );
});

interface SubagentStepsProps {
  toolId?: string;
}

/**
 * Nested list of the subagent's internal tool calls (sidechain steps), rendered
 * inside the expanded agent card. Each row shows status + tool name + summary.
 */
export const SubagentSteps = memo(function SubagentSteps({ toolId }: SubagentStepsProps) {
  const { t } = useTranslation();
  const steps = useSubagentSteps(toolId);

  if (!steps || steps.length === 0) return null;

  return (
    <div className="subagent-live-steps">
      <div className="subagent-live-steps-title">{t('subagent.live.stepsTitle')}</div>
      {steps.map((step) => (
        <div key={step.id} className={`subagent-live-step ${step.status}`}>
          <span className={`subagent-step-status ${step.status}`} />
          <span className="subagent-step-name">{step.name}</span>
          {step.summary && (
            <span className="subagent-step-summary" title={step.summary}>
              {step.summary}
            </span>
          )}
        </div>
      ))}
    </div>
  );
});

interface SubagentResultSummaryProps {
  toolId?: string;
}

/**
 * The async subagent's final report (from the task notification). Rendered in
 * the expanded card because the Agent tool_result itself only carries the
 * "async launched" metadata, never the report text.
 */
export const SubagentResultSummary = memo(function SubagentResultSummary({ toolId }: SubagentResultSummaryProps) {
  const { t } = useTranslation();
  const activity = useSubagentActivity(toolId);

  if (!activity?.summary) return null;
  const status = effectiveStatus(activity);
  if (status === 'running') return null;

  return (
    <div className="subagent-live-result">
      <div className="subagent-live-steps-title">{t('subagent.process.result')}</div>
      <div className="subagent-live-result-text">{activity.summary}</div>
    </div>
  );
});
