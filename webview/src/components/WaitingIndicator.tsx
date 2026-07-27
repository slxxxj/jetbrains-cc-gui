import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { TOOL_PROGRESS_STALE_MS, type ToolProgressInfo } from '../utils/taskActivityStore';

interface WaitingIndicatorProps {
  size?: number;
  /** Loading start timestamp (ms), used to maintain continuous timing across view switches */
  startTime?: number;
  /**
   * Transient streaming status hint (already translated, e.g. "Preparing tool
   * call: Write" / "Compacting context"). Replaces the default "generating
   * response" label while set; the spinner and elapsed time stay.
   */
  hint?: string;
  /**
   * Latest tool_progress heartbeat from the SDK (a tool currently executing,
   * main chain or subagent). Rendered as "Running <tool> · Ns" so a long tool
   * execution visibly proves the session is alive instead of looking frozen.
   * Stale heartbeats (older than TOOL_PROGRESS_STALE_MS) are ignored — the 1s
   * elapsed timer re-renders this component and re-checks freshness every tick.
   */
  toolProgress?: ToolProgressInfo | null;
}

export const WaitingIndicator = ({ size = 18, startTime, hint, toolProgress }: WaitingIndicatorProps) => {
  const { t } = useTranslation();
  const [dotCount, setDotCount] = useState(1);
  const [elapsedSeconds, setElapsedSeconds] = useState(() => {
    // If a start time is provided, calculate the elapsed seconds
    if (startTime) {
      return Math.floor((Date.now() - startTime) / 1000);
    }
    return 0;
  });

  // Ellipsis animation
  useEffect(() => {
    const timer = setInterval(() => {
      setDotCount(prev => (prev % 3) + 1);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // Timer: track elapsed seconds for the current thinking round
  useEffect(() => {
    const timer = setInterval(() => {
      if (startTime) {
        // Calculate from the externally provided start time to avoid reset on view switches
        setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
      } else {
        setElapsedSeconds(prev => prev + 1);
      }
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [startTime]);

  const dots = '.'.repeat(dotCount);

  const spinnerStyle: React.CSSProperties = { width: size, height: size };

  // Format elapsed time: show "X seconds" under 60s, "X min Y sec" above 60s
  const formatElapsedTime = (seconds: number): string => {
    if (seconds < 60) {
      return `${seconds} ${t('common.seconds')}`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${t('chat.minutesAndSeconds', { minutes, seconds: remainingSeconds })}`;
  };

  // Live "a tool is executing" line. The heartbeat carries the SDK-reported
  // elapsed seconds at event time; local ticks extrapolate between heartbeats.
  // While fresh, the seconds suffix tracks the running tool instead of the
  // whole turn — that is the number the user watches during a long execution.
  const now = Date.now();
  const freshProgress = toolProgress && now - toolProgress.at < TOOL_PROGRESS_STALE_MS ? toolProgress : null;
  const toolElapsedSeconds = freshProgress
    ? Math.max(
        Math.floor((freshProgress.elapsedTimeSeconds ?? 0) + (now - freshProgress.at) / 1000),
        0,
      )
    : 0;
  const label = hint
    ?? (freshProgress?.toolName ? t('chat.runningTool', { toolName: freshProgress.toolName }) : undefined);
  const suffixSeconds = freshProgress ? toolElapsedSeconds : elapsedSeconds;

  return (
    <div className="waiting-indicator">
      <span className="waiting-spinner" style={spinnerStyle} />
      <span className="waiting-text">
	        {label ?? t('chat.generatingResponse')}<span className="waiting-dots">{dots}</span>
	        <span className="waiting-seconds">（{t('chat.elapsedTime', { time: formatElapsedTime(suffixSeconds) })}）</span>
      </span>
    </div>
  );
};

export default WaitingIndicator;

