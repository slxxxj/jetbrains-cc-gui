import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QuickPromptSelect } from './QuickPromptSelect';
import { QUICK_PROMPTS, pickQuickPromptText } from '../quickPrompts';
import {
  CUSTOM_QUICK_PROMPTS_KEY,
  customQuickPromptLabel,
  loadCustomQuickPrompts,
  removeCustomQuickPrompt,
  saveCustomQuickPrompt,
} from '../customQuickPrompts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../hooks/useDropdownPosition', () => ({
  useDropdownPosition: () => ({ positionedStyle: {}, recalculate: vi.fn() }),
}));

describe('QuickPromptSelect', () => {
  it('lists all quick prompt presets when opened', () => {
    render(<QuickPromptSelect onSelect={vi.fn()} />);

    expect(screen.queryByText('Explain Code')).toBeNull();

    fireEvent.click(screen.getByRole('button'));

    for (const preset of QUICK_PROMPTS) {
      expect(screen.getByText(preset.labelEn)).toBeTruthy();
    }
  });

  it('calls onSelect with the English prompt body and closes', () => {
    const onSelect = vi.fn();
    render(<QuickPromptSelect onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Write Tests'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      QUICK_PROMPTS.find(p => p.id === 'test')!.promptEn,
    );
    expect(screen.queryByText('Write Tests')).toBeNull();
  });

  it('does not open when disabled', () => {
    render(<QuickPromptSelect onSelect={vi.fn()} disabled />);

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('Explain Code')).toBeNull();
  });
});

describe('pickQuickPromptText', () => {
  const preset = QUICK_PROMPTS[0];

  it('picks zh text for zh languages', () => {
    expect(pickQuickPromptText(preset, 'label', 'zh-CN')).toBe(preset.labelZh);
    expect(pickQuickPromptText(preset, 'prompt', 'zh-TW')).toBe(preset.promptZh);
  });

  it('falls back to en for other languages', () => {
    expect(pickQuickPromptText(preset, 'label', 'ja')).toBe(preset.labelEn);
    expect(pickQuickPromptText(preset, 'desc', 'fr')).toBe(preset.descEn);
  });
});

describe('customQuickPrompts storage', () => {
  beforeEach(() => {
    window.localStorage.removeItem(CUSTOM_QUICK_PROMPTS_KEY);
  });

  it('saves and reloads a custom prompt', () => {
    const list = saveCustomQuickPrompt('  检查最近的改动有没有并发安全问题  ');
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('检查最近的改动有没有并发安全问题');
    expect(loadCustomQuickPrompts()).toHaveLength(1);
  });

  it('ignores empty text and duplicates', () => {
    saveCustomQuickPrompt('hello');
    expect(saveCustomQuickPrompt('   ')).toHaveLength(1);
    expect(saveCustomQuickPrompt('hello')).toHaveLength(1);
  });

  it('removes by id', () => {
    const [a] = saveCustomQuickPrompt('first');
    saveCustomQuickPrompt('second');
    const remaining = removeCustomQuickPrompt(a.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe('second');
  });

  it('truncates long labels to the first line', () => {
    const long = 'x'.repeat(40);
    expect(customQuickPromptLabel(long)).toHaveLength(25); // 24 + ellipsis
    expect(customQuickPromptLabel('short\nsecond line')).toBe('short');
  });
});

describe('QuickPromptSelect custom prompts', () => {
  beforeEach(() => {
    window.localStorage.removeItem(CUSTOM_QUICK_PROMPTS_KEY);
  });

  it('saves the current input as a custom prompt and selects it', () => {
    const onSelect = vi.fn();
    render(
      <QuickPromptSelect onSelect={onSelect} getInputText={() => '  review my diff please  '} />,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Save current input as prompt'));

    expect(loadCustomQuickPrompts()[0]?.text).toBe('review my diff please');

    // Dropdown stays open after saving; the custom prompt is listed right away.
    fireEvent.click(screen.getByText('review my diff please'));
    expect(onSelect).toHaveBeenCalledWith('review my diff please');
  });

  it('deletes a custom prompt via its delete button', () => {
    saveCustomQuickPrompt('temporary prompt');
    render(<QuickPromptSelect onSelect={vi.fn()} getInputText={() => ''} />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('temporary prompt')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Delete this prompt'));
    expect(loadCustomQuickPrompts()).toHaveLength(0);
  });

  it('disables save when the input is empty', () => {
    render(<QuickPromptSelect onSelect={vi.fn()} getInputText={() => '   '} />);

    fireEvent.click(screen.getByRole('button'));
    const saveRow = screen.getByText('Save current input as prompt').closest('.selector-option');
    expect(saveRow?.getAttribute('aria-disabled')).toBe('true');
  });
});
