import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelInfo } from '../types';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import { getProviderCapabilities } from '../../../utils/providerCapabilities';

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
const MODEL_OPTION_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' };
const MODEL_TEXT_STYLE: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

interface SubagentModelSelectProps {
  /** Selected subagent model id; '' means "default (follow the main model)". */
  value: string;
  onChange: (modelId: string) => void;
  /** Merged model list (custom → dynamic → built-in), same source as ModelSelect. */
  models?: ModelInfo[];
  currentProvider?: string;
}

/**
 * SubagentModelSelect - Subagent (Task tool) model selector.
 *
 * Claude-only (gated by providerCapabilities.supportsSubagentModel — Codex has
 * no subagent concept). The first option is always "Default (follow main
 * model)", stored as an empty value so the backend clears any stale
 * CLAUDE_CODE_SUBAGENT_MODEL instead of pinning a model.
 */
export const SubagentModelSelect = ({ value, onChange, models = [], currentProvider = 'claude' }: SubagentModelSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, recalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
    preferredAlignment: 'right',
  });

  const isVisible = getProviderCapabilities(currentProvider).supportsSubagentModel;

  const defaultLabel = t('models.subagent.default', { defaultValue: 'Default (follow main model)' });
  const selectedModel = models.find((m) => m.id === value);
  // Unknown ids (dynamic list not loaded yet) display verbatim so a persisted
  // selection never renders as an empty button.
  const buttonLabel = value === '' ? defaultLabel : (selectedModel?.label ?? value);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  const handleSelect = useCallback((modelId: string) => {
    onChange(modelId);
    setIsOpen(false);
  }, [onChange]);

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

  if (!isVisible) return null;

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        title={t('models.subagent.title', { defaultValue: 'Select subagent model' })}
      >
        <span className="codicon codicon-hubot" />
        <span className="selector-button-text">{buttonLabel}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{ ...DROPDOWN_STYLE, ...positionedStyle }}
        >
          <div
            className={`selector-option ${value === '' ? 'selected' : ''}`}
            data-testid="subagent-model-default-option"
            onClick={() => handleSelect('')}
          >
            <span className="codicon codicon-hubot" />
            <div style={MODEL_OPTION_INFO_STYLE}>
              <span style={MODEL_TEXT_STYLE}>{defaultLabel}</span>
              <span className="model-description" style={MODEL_TEXT_STYLE}>
                {t('models.subagent.defaultDescription', { defaultValue: 'Subagents use the main model' })}
              </span>
            </div>
            {value === '' && (
              <span className="codicon codicon-check check-mark" />
            )}
          </div>
          <div className="selector-divider" />
          {models.map((model) => (
            <div
              key={model.id}
              className={`selector-option ${model.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(model.id)}
            >
              <div style={MODEL_OPTION_INFO_STYLE}>
                <span style={MODEL_TEXT_STYLE}>{model.label}</span>
                {model.description && (
                  <span className="model-description" style={MODEL_TEXT_STYLE}>{model.description}</span>
                )}
              </div>
              {model.id === value && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SubagentModelSelect;
