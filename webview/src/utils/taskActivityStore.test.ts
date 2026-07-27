import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyTaskEvent,
  applySubagentMessage,
  getSubagentActivity,
  getSubagentSteps,
  getLatestToolProgress,
  getFreshToolProgress,
  clearToolProgress,
  resetTaskActivityStore,
  summarizeStepInput,
  installTaskEventDispatchers,
  TOOL_PROGRESS_STALE_MS,
} from './taskActivityStore';

beforeEach(() => {
  resetTaskActivityStore();
});

describe('applyTaskEvent', () => {
  it('started creates a running activity keyed by toolUseId', () => {
    applyTaskEvent({ kind: 'started', taskId: 'task-1', toolUseId: 'toolu_1', description: 'Count files', subagentType: 'Explore' });
    const activity = getSubagentActivity('toolu_1');
    expect(activity?.status).toBe('running');
    expect(activity?.description).toBe('Count files');
    expect(activity?.subagentType).toBe('Explore');
  });

  it('progress merges usage and lastToolName into the existing activity', () => {
    applyTaskEvent({ kind: 'started', taskId: 'task-1', toolUseId: 'toolu_1', description: 'Count files' });
    applyTaskEvent({
      kind: 'progress', taskId: 'task-1', toolUseId: 'toolu_1', lastToolName: 'Glob',
      usage: { totalTokens: 100, toolUses: 2, durationMs: 5000 },
    });
    const activity = getSubagentActivity('toolu_1');
    expect(activity?.status).toBe('running');
    expect(activity?.lastToolName).toBe('Glob');
    expect(activity?.toolUses).toBe(2);
    expect(activity?.durationMs).toBe(5000);
    // Earlier fields survive the merge
    expect(activity?.description).toBe('Count files');
  });

  it('notification marks the activity completed with summary', () => {
    applyTaskEvent({ kind: 'started', taskId: 'task-1', toolUseId: 'toolu_1' });
    applyTaskEvent({ kind: 'notification', taskId: 'task-1', toolUseId: 'toolu_1', status: 'completed', summary: '778 files' });
    const activity = getSubagentActivity('toolu_1');
    expect(activity?.status).toBe('completed');
    expect(activity?.summary).toBe('778 files');
  });

  it('notification maps failed → error and stopped → stopped', () => {
    applyTaskEvent({ kind: 'notification', taskId: 'task-1', toolUseId: 'toolu_1', status: 'failed' });
    applyTaskEvent({ kind: 'notification', taskId: 'task-2', toolUseId: 'toolu_2', status: 'stopped' });
    expect(getSubagentActivity('toolu_1')?.status).toBe('error');
    expect(getSubagentActivity('toolu_2')?.status).toBe('stopped');
  });

  it('updated patch closes a running activity', () => {
    applyTaskEvent({ kind: 'started', taskId: 'task-1', toolUseId: 'toolu_1' });
    applyTaskEvent({ kind: 'updated', taskId: 'task-1', patch: { status: 'completed' } });
    expect(getSubagentActivity('task-1')?.status).toBe('completed');
  });

  it('tool_progress updates the latest heartbeat without touching activities', () => {
    applyTaskEvent({ kind: 'tool_progress', toolUseId: 'toolu_9', toolName: 'Bash', parentToolUseId: null, elapsedTimeSeconds: 12 });
    expect(getLatestToolProgress()?.toolName).toBe('Bash');
    expect(getLatestToolProgress()?.elapsedTimeSeconds).toBe(12);
    expect(getSubagentActivity('toolu_9')).toBeUndefined();
  });

  it('ignores malformed payloads', () => {
    applyTaskEvent({});
    applyTaskEvent({ kind: 'started' });
    applyTaskEvent(null as unknown as Parameters<typeof applyTaskEvent>[0]);
    expect(getSubagentActivity(undefined)).toBeUndefined();
  });
});

describe('tool progress freshness', () => {
  it('fresh heartbeat is returned; stale one is not', () => {
    applyTaskEvent({ kind: 'tool_progress', toolUseId: 'toolu_9', toolName: 'Bash', parentToolUseId: null, elapsedTimeSeconds: 1 });
    expect(getFreshToolProgress()?.toolName).toBe('Bash');
    const staleAt = Date.now() + TOOL_PROGRESS_STALE_MS + 1;
    expect(getFreshToolProgress(staleAt)).toBeNull();
  });

  it('clearToolProgress drops the heartbeat', () => {
    applyTaskEvent({ kind: 'tool_progress', toolUseId: 'toolu_9', toolName: 'Bash', parentToolUseId: null, elapsedTimeSeconds: 1 });
    clearToolProgress();
    expect(getLatestToolProgress()).toBeNull();
  });
});

describe('applySubagentMessage', () => {
  it('collects tool_use steps under the parent tool id', () => {
    applySubagentMessage({
      parentToolUseId: 'toolu_agent',
      role: 'assistant',
      blocks: [
        { type: 'tool_use', id: 'toolu_s1', name: 'Glob', input: { pattern: '*.md' } },
        { type: 'tool_use', id: 'toolu_s2', name: 'Read', input: { file_path: '/tmp/a.md' } },
      ],
    });
    const steps = getSubagentSteps('toolu_agent');
    expect(steps).toHaveLength(2);
    expect(steps?.[0]).toMatchObject({ id: 'toolu_s1', name: 'Glob', summary: '*.md', status: 'running' });
    expect(steps?.[1]).toMatchObject({ id: 'toolu_s2', name: 'Read', summary: '/tmp/a.md' });
    // Activity tool counter follows the step count
    expect(getSubagentActivity('toolu_agent')?.toolUses).toBeUndefined(); // no activity without task events
  });

  it('tool_result resolves the matching step; completed steps never flip back', () => {
    applySubagentMessage({
      parentToolUseId: 'toolu_agent',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'toolu_s1', name: 'Bash', input: { command: 'ls' } }],
    });
    applySubagentMessage({
      parentToolUseId: 'toolu_agent',
      role: 'user',
      blocks: [{ type: 'tool_result', tool_use_id: 'toolu_s1', is_error: true }],
    });
    expect(getSubagentSteps('toolu_agent')?.[0].status).toBe('error');
    // A duplicate tool_use for the same id must not resurrect "running"
    applySubagentMessage({
      parentToolUseId: 'toolu_agent',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'toolu_s1', name: 'Bash', input: { command: 'ls' } }],
    });
    expect(getSubagentSteps('toolu_agent')?.[0].status).toBe('error');
  });

  it('dedupes repeated snapshots of the same tool_use block', () => {
    const msg = {
      parentToolUseId: 'toolu_agent',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'toolu_s1', name: 'Glob', input: { pattern: '*.md' } }],
    };
    applySubagentMessage(msg);
    applySubagentMessage(msg);
    expect(getSubagentSteps('toolu_agent')).toHaveLength(1);
  });

  it('ignores messages without parent id or blocks', () => {
    applySubagentMessage({ role: 'assistant', blocks: [{ type: 'tool_use', id: 'x', name: 'Glob' }] });
    applySubagentMessage({ parentToolUseId: 'toolu_agent' });
    expect(getSubagentSteps('toolu_agent')).toBeUndefined();
  });
});

describe('summarizeStepInput', () => {
  it('picks the identifying field by priority', () => {
    expect(summarizeStepInput({ file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(summarizeStepInput({ command: 'ls -la' })).toBe('ls -la');
    expect(summarizeStepInput({ pattern: 'foo', path: '/x' })).toBe('foo');
    expect(summarizeStepInput({})).toBeUndefined();
    expect(summarizeStepInput(undefined)).toBeUndefined();
  });

  it('truncates long values', () => {
    const long = 'x'.repeat(200);
    expect(summarizeStepInput({ file_path: long })!.length).toBeLessThanOrEqual(81);
  });
});

describe('window dispatchers', () => {
  it('onTaskEvent / onSubagentMessage parse JSON and apply', () => {
    installTaskEventDispatchers();
    window.onTaskEvent!(JSON.stringify({ kind: 'started', taskId: 'task-1', toolUseId: 'toolu_1', description: 'd' }));
    expect(getSubagentActivity('toolu_1')?.status).toBe('running');
    window.onSubagentMessage!(JSON.stringify({
      parentToolUseId: 'toolu_1', role: 'assistant',
      blocks: [{ type: 'tool_use', id: 's1', name: 'Glob', input: { pattern: '*.ts' } }],
    }));
    expect(getSubagentSteps('toolu_1')).toHaveLength(1);
  });

  it('malformed JSON is dropped without throwing', () => {
    installTaskEventDispatchers();
    expect(() => window.onTaskEvent!('{oops')).not.toThrow();
    expect(() => window.onSubagentMessage!('42')).not.toThrow();
  });
});
