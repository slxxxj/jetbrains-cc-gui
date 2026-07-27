import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QUICK_PROMPTS, pickQuickPromptText } from '../quickPrompts';
import {
  customQuickPromptLabel,
  loadCustomQuickPrompts,
  removeCustomQuickPrompt,
  saveCustomQuickPrompt,
  type CustomQuickPrompt,
} from '../customQuickPrompts';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  maxWidth: 'calc(100vw - 16px)',
  overflowX: 'hidden',
};
const ITEM_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1 };
const DELETE_BTN_STYLE: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  opacity: 0.6,
  padding: '0 2px',
  color: 'inherit',
};
const DIVIDER_STYLE: React.CSSProperties = {
  height: '1px',
  margin: '4px 0',
  background: 'var(--border-color, rgba(128, 128, 128, 0.3))',
};
const SAVE_ROW_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px' };

interface QuickPromptSelectProps {
  /** Called with the selected preset's prompt text (to fill the input box). */
  onSelect: (prompt: string) => void;
  /** Returns the current input box text (used by "save current as prompt"). */
  getInputText?: () => string;
  disabled?: boolean;
}

/**
 * QuickPromptSelect - one-click preset instruction panel.
 *
 * A zap button in the input toolbar that opens a list of polished scenario
 * prompts (explain / fix bug / write tests / refactor / ...). Selecting one
 * fills the input box, ready to send or edit. Users can also save their own
 * prompts from the current input content and delete them later.
 */
export const QuickPromptSelect = ({ onSelect, getInputText, disabled }: QuickPromptSelectProps) => {
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [customPrompts, setCustomPrompts] = useState<CustomQuickPrompt[]>(() => loadCustomQuickPrompts());
  const [canSaveCurrent, setCanSaveCurrent] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, recalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
    preferredAlignment: 'right',
  });

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      setCanSaveCurrent(Boolean(getInputText?.().trim()));
      recalculate();
    }
  }, [isOpen, disabled, getInputText, recalculate]);

  const handleSelect = useCallback((prompt: string) => {
    onSelect(prompt);
    setIsOpen(false);
  }, [onSelect]);

  const handleSaveCurrent = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const text = getInputText?.().trim();
    if (!text) return;
    setCustomPrompts(saveCustomQuickPrompt(text));
    setCanSaveCurrent(false);
  }, [getInputText]);

  const handleRemoveCustom = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setCustomPrompts(removeCustomQuickPrompt(id));
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (isOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        disabled={disabled}
        title={t('quickPrompts.tooltip', { defaultValue: 'Quick prompts: one-click preset instructions' })}
      >
        <span className="codicon codicon-zap" />
        <span className="selector-button-text">
          {t('quickPrompts.button', { defaultValue: 'Quick' })}
        </span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{ ...DROPDOWN_STYLE, ...positionedStyle }}
        >
          {QUICK_PROMPTS.map((preset) => (
            <div
              key={preset.id}
              className="selector-option"
              onClick={() => handleSelect(pickQuickPromptText(preset, 'prompt', i18n.language))}
            >
              <span className={`codicon ${preset.icon}`} />
              <div style={ITEM_INFO_STYLE}>
                <span>{pickQuickPromptText(preset, 'label', i18n.language)}</span>
                <span className="mode-description">{pickQuickPromptText(preset, 'desc', i18n.language)}</span>
              </div>
            </div>
          ))}

          {customPrompts.length > 0 && <div style={DIVIDER_STYLE} />}

          {customPrompts.map((custom) => (
            <div
              key={custom.id}
              className="selector-option"
              onClick={() => handleSelect(custom.text)}
              title={custom.text}
            >
              <span className="codicon codicon-star-empty" />
              <div style={ITEM_INFO_STYLE}>
                <span>{customQuickPromptLabel(custom.text)}</span>
              </div>
              <button
                style={DELETE_BTN_STYLE}
                onClick={(e) => handleRemoveCustom(e, custom.id)}
                title={t('quickPrompts.deleteCustom', { defaultValue: 'Delete this prompt' })}
                aria-label={t('quickPrompts.deleteCustom', { defaultValue: 'Delete this prompt' })}
              >
                <span className="codicon codicon-close" />
              </button>
            </div>
          ))}

          {getInputText && <div style={DIVIDER_STYLE} />}

          {getInputText && (
            <div
              className={`selector-option ${canSaveCurrent ? '' : 'disabled'}`}
              style={SAVE_ROW_STYLE}
              onClick={canSaveCurrent ? handleSaveCurrent : undefined}
              aria-disabled={!canSaveCurrent}
            >
              <span className="codicon codicon-add" />
              <div style={ITEM_INFO_STYLE}>
                <span>{t('quickPrompts.saveCurrent', { defaultValue: 'Save current input as prompt' })}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default QuickPromptSelect;
