import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatModeSelect } from './ChatModeSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

describe('ChatModeSelect', () => {
  it('renders all five chat mode options for Claude', () => {
    render(
      <ChatModeSelect
        value="agent"
        onChange={vi.fn()}
        provider="claude"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    for (const id of ['agent', 'ask', 'plan', 'debug', 'multitask']) {
      expect(screen.getByTestId(`chat-mode-option-${id}`)).toBeTruthy();
    }
  });

  it('is hidden for Codex (no chat mode concept)', () => {
    render(
      <ChatModeSelect
        value="agent"
        onChange={vi.fn()}
        provider="codex"
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('selecting a mode reports its id via onChange', () => {
    const onChange = vi.fn();
    render(
      <ChatModeSelect
        value="agent"
        onChange={onChange}
        provider="claude"
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByTestId('chat-mode-option-plan'));
    expect(onChange).toHaveBeenCalledWith('plan');
  });

  it('renders the selected mode label on the button', () => {
    render(
      <ChatModeSelect
        value="debug"
        onChange={vi.fn()}
        provider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('Debug');
  });
});
