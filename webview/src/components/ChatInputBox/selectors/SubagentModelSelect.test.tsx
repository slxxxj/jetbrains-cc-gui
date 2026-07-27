import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SubagentModelSelect } from './SubagentModelSelect';
import type { ModelInfo } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

const MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

describe('SubagentModelSelect', () => {
  it('shows the default option first and the merged model list for Claude', () => {
    render(
      <SubagentModelSelect
        value=""
        onChange={vi.fn()}
        models={MODELS}
        currentProvider="claude"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    const defaultOption = screen.getByTestId('subagent-model-default-option');
    expect(defaultOption.textContent).toContain('Default (follow main model)');
    expect(screen.getByText('Sonnet 4.6')).toBeTruthy();
    expect(screen.getByText('Haiku 4.5')).toBeTruthy();
    // Default option is listed before any concrete model.
    expect(defaultOption.compareDocumentPosition(screen.getByText('Sonnet 4.6')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is hidden for Codex (no subagent concept)', () => {
    render(
      <SubagentModelSelect
        value=""
        onChange={vi.fn()}
        models={MODELS}
        currentProvider="codex"
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('selecting a model reports its id; selecting default reports an empty string', () => {
    const onChange = vi.fn();
    render(
      <SubagentModelSelect
        value=""
        onChange={onChange}
        models={MODELS}
        currentProvider="claude"
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Haiku 4.5'));
    expect(onChange).toHaveBeenCalledWith('claude-haiku-4-5');
  });

  it('selecting the default option clears the override', () => {
    const onChange = vi.fn();
    render(
      <SubagentModelSelect
        value="claude-haiku-4-5"
        onChange={onChange}
        models={MODELS}
        currentProvider="claude"
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByTestId('subagent-model-default-option'));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('renders the selected model label on the button, falling back to the raw id', () => {
    const { rerender } = render(
      <SubagentModelSelect
        value="claude-haiku-4-5"
        onChange={vi.fn()}
        models={MODELS}
        currentProvider="claude"
      />,
    );
    expect(screen.getByRole('button').textContent).toContain('Haiku 4.5');

    // Persisted id missing from the (not yet loaded) list still renders.
    rerender(
      <SubagentModelSelect
        value="glm-4.7-flash"
        onChange={vi.fn()}
        models={MODELS}
        currentProvider="claude"
      />,
    );
    expect(screen.getByRole('button').textContent).toContain('glm-4.7-flash');
  });
});
