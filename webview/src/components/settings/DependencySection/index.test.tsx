import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DependencySection from './index';

const translations: Record<string, string> = {
  'settings.dependency.title': 'SDK 依赖管理',
  'settings.dependency.description': '查看 AI SDK 依赖的安装状态。依赖由插件自动安装与更新，无需手动操作。',
  'settings.dependency.installPolicyTip': 'SDK 依赖由插件自动安装与更新；失败会自动重试，详情可查看 IDE 日志。',
  'settings.dependency.loading': '正在加载依赖状态...',
  'settings.dependency.claudeSdkName': 'Claude Code SDK',
  'settings.dependency.codexSdkName': 'Codex SDK',
  'settings.dependency.claudeSdkDescription': 'Claude AI 功能所需。包含 Claude Code SDK 及相关依赖。',
  'settings.dependency.codexSdkDescription': 'Codex AI 功能所需。包含 OpenAI Codex SDK。',
  'settings.dependency.installedVersion': '当前版本 {{version}}',
  'settings.dependency.statusInstalled': '已安装',
  'settings.dependency.statusNotInstalled': '未安装',
  'settings.dependency.statusInstalling': '安装中…',
  'settings.dependency.statusError': '安装失败，自动重试中',
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

const pushStatus = (status: unknown) => {
  act(() => {
    window.updateDependencyStatus?.(JSON.stringify(status));
  });
};

describe('DependencySection (read-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sendToJava = vi.fn();
  });

  it('renders SDK names, versions and status badges without any interactive controls', () => {
    render(<DependencySection isActive={false} />);

    pushStatus({
      'claude-sdk': {
        id: 'claude-sdk',
        name: 'Claude Code SDK',
        status: 'installed',
        installedVersion: '0.2.89',
      },
      'codex-sdk': {
        id: 'codex-sdk',
        name: 'Codex SDK',
        status: 'not_installed',
      },
    });

    expect(screen.getByText('Claude Code SDK')).toBeTruthy();
    expect(screen.getByText('Codex SDK')).toBeTruthy();
    expect(screen.getByText('v0.2.89')).toBeTruthy();
    expect(screen.getByText('已安装')).toBeTruthy();
    expect(screen.getByText('未安装')).toBeTruthy();

    // No install/uninstall/update buttons, no version selector, no listbox
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByText('目标版本')).toBeNull();
  });

  it('shows installing and error (auto-retry) states from the status payload', () => {
    render(<DependencySection isActive={false} />);

    pushStatus({
      'claude-sdk': {
        id: 'claude-sdk',
        name: 'Claude Code SDK',
        status: 'installing',
      },
      'codex-sdk': {
        id: 'codex-sdk',
        name: 'Codex SDK',
        status: 'error',
        errorMessage: 'npm registry unreachable',
      },
    });

    expect(screen.getByText('安装中…')).toBeTruthy();
    expect(screen.getByText('安装失败，自动重试中')).toBeTruthy();
    expect(screen.getByText('npm registry unreachable')).toBeTruthy();
  });

  it('requests only get_dependency_status when the tab becomes active', () => {
    render(<DependencySection isActive />);

    const sentTypes = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls
      .map(([payload]) => JSON.parse(payload as string).type);

    expect(sentTypes).toContain('get_dependency_status');
    expect(sentTypes).not.toContain('install_dependency');
    expect(sentTypes).not.toContain('uninstall_dependency');
    expect(sentTypes).not.toContain('update_dependency');
    expect(sentTypes).not.toContain('get_dependency_versions');
    expect(sentTypes).not.toContain('check_dependency_updates');
  });

  it('stays on the loading state until a status payload arrives', () => {
    render(<DependencySection isActive={false} />);

    expect(screen.getByText('正在加载依赖状态...')).toBeTruthy();

    pushStatus({
      'claude-sdk': { id: 'claude-sdk', name: 'Claude Code SDK', status: 'installed', installedVersion: '0.2.89' },
      'codex-sdk': { id: 'codex-sdk', name: 'Codex SDK', status: 'installed', installedVersion: '0.118.0' },
    });

    expect(screen.queryByText('正在加载依赖状态...')).toBeNull();
    expect(screen.getAllByText('已安装')).toHaveLength(2);
  });
});
