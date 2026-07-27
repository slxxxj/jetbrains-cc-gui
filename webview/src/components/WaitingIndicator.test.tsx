import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WaitingIndicator } from './WaitingIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'chat.generatingResponse': '正在生成响应',
        'chat.elapsedTime': '已用 {{time}}',
        'common.seconds': '秒',
      };
      let result = translations[key] ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          result = result.replace(`{{${k}}}`, v);
        }
      }
      return result;
    },
  }),
}));

describe('WaitingIndicator hint', () => {
  it('shows the default generating-response label without a hint', () => {
    render(<WaitingIndicator />);
    expect(screen.getByText(/正在生成响应/)).toBeTruthy();
  });

  it('replaces the label with the hint while keeping the elapsed time', () => {
    render(<WaitingIndicator hint="正在准备工具调用：Write" />);
    expect(screen.getByText(/正在准备工具调用：Write/)).toBeTruthy();
    expect(screen.queryByText(/正在生成响应/)).toBeNull();
    expect(screen.getByText(/已用/)).toBeTruthy();
  });
});
