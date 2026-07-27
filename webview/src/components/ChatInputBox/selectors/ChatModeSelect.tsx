import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_CHAT_MODES, type ChatMode } from '../types';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import { supportsChatMode } from '../../../utils/providerCapabilities';

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
const MODE_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' };
const MODE_TEXT_STYLE: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

interface ChatModeSelectProps {
  value: ChatMode;
  onChange: (mode: ChatMode) => void;
  provider?: string;
}

/**
 * ChatModeSelect - Per-message chat mode selector (agent/ask/plan/debug/multitask).
 *
 * Claude-only (gated by providerCapabilities.supportsChatMode). The selection
 * travels inside the send_message payload as `chatMode` — no immediate bridge
 * event fires on change (the subagentModel pattern, not set_mode).
 */
export const ChatModeSelect = ({ value, onChange, provider }: ChatModeSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, recalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
    preferredAlignment: 'right',
  });

  const isVisible = supportsChatMode(provider);

  const currentMode = AVAILABLE_CHAT_MODES.find(m => m.id === value) || AVAILABLE_CHAT_MODES[0];

  // Helper function to get translated mode text (defaultValue = built-in fallback)
  const getModeText = (modeId: ChatMode, field: 'label' | 'tooltip' | 'description') => {
    const fallback = AVAILABLE_CHAT_MODES.find(m => m.id === modeId)?.[field] ?? '';
    return t(`chatModes.${modeId}.${field}`, { defaultValue: fallback });
  };

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  /**
   * Select mode
   */
  const handleSelect = useCallback((mode: ChatMode) => {
    onChange(mode);
    setIsOpen(false);
  }, [onChange]);

  /**
   * Close on outside click
   */
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

    // Delay adding event listener to prevent immediate trigger
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
        title={getModeText(currentMode.id, 'tooltip')}
      >
        <span className={`codicon ${currentMode.icon}`} />
        <span className="selector-button-text">{getModeText(currentMode.id, 'label')}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{ ...DROPDOWN_STYLE, ...positionedStyle }}
        >
          {AVAILABLE_CHAT_MODES.map((mode) => (
            <div
              key={mode.id}
              data-testid={`chat-mode-option-${mode.id}`}
              className={`selector-option ${mode.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(mode.id)}
              title={getModeText(mode.id, 'tooltip')}
            >
              <span className={`codicon ${mode.icon}`} />
              <div style={MODE_INFO_STYLE}>
                <span style={MODE_TEXT_STYLE}>{getModeText(mode.id, 'label')}</span>
                <span className="mode-description" style={MODE_TEXT_STYLE}>{getModeText(mode.id, 'description')}</span>
              </div>
              {mode.id === value && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ChatModeSelect;
