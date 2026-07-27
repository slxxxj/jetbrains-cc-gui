import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkUpdateOptions } from './SdkUpdateOptions';

const translations: Record<string, string> = {
  'models.sdkUpdate.check': '检查 SDK 更新',
  'models.sdkUpdate.checkHint': '检查 SDK 依赖是否有新版本',
  'models.sdkUpdate.checking': '正在检查 SDK 更新…',
  'models.sdkUpdate.upToDate': 'SDK 已是最新版本',
  'models.sdkUpdate.action': '更新 {{name}}：{{current}} → {{latest}}',
  'models.sdkUpdate.updating': '正在更新 {{name}}…',
  'models.sdkUpdate.done': '{{name}} 已更新至 {{version}}，下次发送消息时生效',
  'models.sdkUpdate.checkFailed': '检查更新失败（点击重试）',
  'models.sdkUpdate.updateFailed': '{{name}} 更新失败（点击重试）',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const template = translations[key] ?? key;
      if (!options) {
        return template;
      }
      return Object.entries(options).reduce(
        (result, [token, value]) => result.replace(`{{${token}}}`, value),
        template,
      );
    },
  }),
}));

const sentPayloads = (): Array<{ type: string; payload?: unknown }> =>
  (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map(
    ([payload]) => JSON.parse(payload as string),
  );

describe('SdkUpdateOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sendToJava = vi.fn();
    delete window.dependencyUpdateCheckResult;
    delete window.dependencyUpdateResult;
  });

  it('sends check_dependency_updates when the check row is clicked', () => {
    render(<SdkUpdateOptions />);

    fireEvent.click(screen.getByTestId('sdk-update-check'));

    expect(sentPayloads().map((p) => p.type)).toContain('check_dependency_updates');
    expect(screen.getByTestId('sdk-update-checking')).toBeTruthy();
  });

  it('shows an update row per outdated SDK and triggers update_dependency on click', () => {
    render(<SdkUpdateOptions />);

    act(() => {
      window.dependencyUpdateCheckResult?.(JSON.stringify({
        success: true,
        sdks: {
          'claude-sdk': {
            sdkName: 'Claude Code SDK',
            installed: true,
            currentVersion: '0.2.141',
            latestVersion: '0.3.220',
            hasUpdate: true,
          },
          'codex-sdk': {
            sdkName: 'Codex SDK',
            installed: true,
            currentVersion: '0.117.0',
            latestVersion: '0.117.0',
            hasUpdate: false,
          },
        },
      }));
    });

    expect(screen.getByText('更新 Claude Code SDK：0.2.141 → 0.3.220')).toBeTruthy();
    expect(screen.queryByText(/Codex SDK：/)).toBeNull();

    fireEvent.click(screen.getByTestId('sdk-update-action-claude-sdk'));

    const updateCalls = sentPayloads().filter((p) => p.type === 'update_dependency');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload).toEqual({ sdkId: 'claude-sdk' });
    expect(screen.getByText('正在更新 Claude Code SDK…')).toBeTruthy();
  });

  it('shows the up-to-date state when no SDK has an update', () => {
    render(<SdkUpdateOptions />);

    act(() => {
      window.dependencyUpdateCheckResult?.(JSON.stringify({
        success: true,
        sdks: {
          'claude-sdk': {
            sdkName: 'Claude Code SDK',
            installed: true,
            currentVersion: '0.3.220',
            latestVersion: '0.3.220',
            hasUpdate: false,
          },
        },
      }));
    });

    expect(screen.getByTestId('sdk-update-up-to-date')).toBeTruthy();
    expect(screen.getByText('SDK 已是最新版本')).toBeTruthy();
  });

  it('shows check failure with retry and re-checks on click', () => {
    render(<SdkUpdateOptions />);

    act(() => {
      window.dependencyUpdateCheckResult?.(JSON.stringify({
        success: false,
        error: 'npm registry unreachable',
      }));
    });

    const failedRow = screen.getByTestId('sdk-update-check-failed');
    expect(failedRow.textContent).toContain('检查更新失败');

    fireEvent.click(failedRow);
    expect(sentPayloads().map((p) => p.type)).toContain('check_dependency_updates');
  });

  it('shows done state after a successful update and clears the pending row', () => {
    render(<SdkUpdateOptions />);

    act(() => {
      window.dependencyUpdateCheckResult?.(JSON.stringify({
        success: true,
        sdks: {
          'claude-sdk': {
            sdkName: 'Claude Code SDK',
            installed: true,
            currentVersion: '0.2.141',
            latestVersion: '0.3.220',
            hasUpdate: true,
          },
        },
      }));
    });
    fireEvent.click(screen.getByTestId('sdk-update-action-claude-sdk'));

    act(() => {
      window.dependencyUpdateResult?.(JSON.stringify({
        success: true,
        sdkId: 'claude-sdk',
        version: '0.3.220',
      }));
    });

    expect(screen.getByText('Claude Code SDK 已更新至 0.3.220，下次发送消息时生效')).toBeTruthy();
    expect(screen.queryByTestId('sdk-update-action-claude-sdk')).toBeNull();
    // Status refresh requested so the settings panel reflects the new version
    expect(sentPayloads().map((p) => p.type)).toContain('get_dependency_status');
  });

  it('shows update failure with retry on a failed update', () => {
    render(<SdkUpdateOptions />);

    act(() => {
      window.dependencyUpdateCheckResult?.(JSON.stringify({
        success: true,
        sdks: {
          'claude-sdk': {
            sdkName: 'Claude Code SDK',
            installed: true,
            currentVersion: '0.2.141',
            latestVersion: '0.3.220',
            hasUpdate: true,
          },
        },
      }));
    });
    fireEvent.click(screen.getByTestId('sdk-update-action-claude-sdk'));

    act(() => {
      window.dependencyUpdateResult?.(JSON.stringify({
        success: false,
        sdkId: 'claude-sdk',
        error: 'npm install failed with exit code: 1',
      }));
    });

    const failedRow = screen.getByTestId('sdk-update-failed');
    expect(failedRow.textContent).toContain('Claude Code SDK 更新失败');

    fireEvent.click(failedRow);
    const updateCalls = sentPayloads().filter((p) => p.type === 'update_dependency');
    expect(updateCalls).toHaveLength(2);
  });
});
