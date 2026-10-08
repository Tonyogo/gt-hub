import React, { useState } from 'react';
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Keyboard,
  Check,
  Copy,
  ClipboardPaste,
  TextSelect,
  MoreHorizontal,
  SlidersHorizontal
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { encodeNavigationKey } from '../../utils/terminalKeyEncoder';

interface TerminalAccessoryBarProps {
  onSendInput: (data: string) => void;
  isCtrlActive: boolean;
  onToggleCtrl: () => void;
  isAltActive: boolean;
  onToggleAlt: () => void;
  isShiftActive?: boolean;
  onToggleShift?: () => void;
  onToggleKeyboard: () => void;
  onHideKeyboard?: () => void;
  isKeyboardOpen?: boolean;
  hasSelection?: boolean;
  isSelectMode?: boolean;
  onCopy?: () => void;
  onPaste?: () => void;
  onToggleSelectMode?: () => void;
  isConciseMode?: boolean;
  onToggleConciseMode?: () => void;
}

export const TerminalAccessoryBar: React.FC<TerminalAccessoryBarProps> = ({
  onSendInput,
  isCtrlActive,
  onToggleCtrl,
  isAltActive,
  onToggleAlt,
  isShiftActive = false,
  onToggleShift,
  onToggleKeyboard,
  onHideKeyboard,
  isKeyboardOpen,
  hasSelection = false,
  isSelectMode = false,
  onCopy,
  onPaste,
  onToggleSelectMode,
  isConciseMode: propIsConciseMode,
  onToggleConciseMode: propOnToggleConciseMode,
}) => {
  const { t } = useTranslation();

  const [internalConciseMode, setInternalConciseMode] = useState<boolean>(() => {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('terminal_accessory_concise_mode');
      if (saved !== null) {
        return saved === 'true';
      }
    }
    return true;
  });

  const isConciseMode = propIsConciseMode !== undefined ? propIsConciseMode : internalConciseMode;

  const handleToggleConciseMode = () => {
    const next = !isConciseMode;
    if (propOnToggleConciseMode) {
      propOnToggleConciseMode();
    } else {
      setInternalConciseMode(next);
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem('terminal_accessory_concise_mode', String(next));
        } catch {
          // ignore storage errors
        }
      }
    }
  };

  return (
    <div className="bg-[var(--bg-surface)] border-t border-[var(--border-subtle)] px-2 py-1.5 flex items-center justify-between gap-1 select-none overflow-x-auto scrollbar-none z-20">
      {/* Scrollable Accessory Key Row */}
      <div className="flex items-center space-x-1 sm:space-x-1.5 shrink-0">
        {/* Modifier: ESC */}
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendInput('\x1b')}
          className="px-2.5 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] font-mono text-xs font-semibold border border-[var(--border-subtle)] transition-all shadow-sm"
        >
          {t('webTerminal.accessoryKeys.esc')}
        </button>

        {/* Modifier: TAB */}
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendInput(isShiftActive ? '\x1b[Z' : '\t')}
          className="px-2.5 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] font-mono text-xs font-semibold border border-[var(--border-subtle)] transition-all shadow-sm"
        >
          {t('webTerminal.accessoryKeys.tab')}
        </button>

        {/* Sticky Modifier: CTRL */}
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleCtrl}
          className={`px-2.5 py-1 rounded-lg font-mono text-xs font-semibold border transition-all shadow-sm active:scale-95 ${
            isCtrlActive
              ? 'bg-indigo-600 text-white border-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.5)]'
              : 'bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] text-[var(--text-primary)] border-[var(--border-subtle)]'
          }`}
        >
          {t('webTerminal.accessoryKeys.ctrl')}
        </button>

        {/* Sticky Modifier: ALT */}
        {!isConciseMode && (
          <>
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onToggleAlt}
              className={`px-2.5 py-1 rounded-lg font-mono text-xs font-semibold border transition-all shadow-sm active:scale-95 ${
                isAltActive
                  ? 'bg-purple-600 text-white border-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.5)]'
                  : 'bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] text-[var(--text-primary)] border-[var(--border-subtle)]'
              }`}
            >
              {t('webTerminal.accessoryKeys.alt')}
            </button>

            {/* Sticky Modifier: SHIFT */}
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onToggleShift}
              className={`px-2.5 py-1 rounded-lg font-mono text-xs font-semibold border transition-all shadow-sm active:scale-95 ${
                isShiftActive
                  ? 'bg-amber-600 text-white border-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.5)]'
                  : 'bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] text-[var(--text-primary)] border-[var(--border-subtle)]'
              }`}
            >
              {t('webTerminal.accessoryKeys.shift')}
            </button>
          </>
        )}

        <div className="h-4 w-[1px] bg-[var(--border-subtle)] mx-0.5" />

        {/* Action: Ctrl+C */}
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendInput('\x03')}
          className="px-2 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 active:scale-95 text-rose-500 dark:text-rose-400 font-mono text-xs font-semibold border border-rose-500/30 transition-all"
          title="SIGINT (Ctrl+C)"
        >
          ^C
        </button>

        {/* Quick OK Key (Grouped with ^C signal/action keys) */}
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendInput('OK\r')}
          className="px-2 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 active:scale-95 text-emerald-600 dark:text-emerald-400 font-mono text-xs font-semibold border border-emerald-500/30 transition-all shadow-sm"
          title="Quick Input (OK + Enter)"
        >
          {t('webTerminal.accessoryKeys.ok', 'OK')}
        </button>

        {/* Full Mode Combination Keys: Ctrl+D, Ctrl+L, Ctrl+B */}
        {!isConciseMode && (
          <>
            {/* Action: Ctrl+D */}
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSendInput('\x04')}
              className="px-2 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 active:scale-95 text-amber-500 dark:text-amber-400 font-mono text-xs font-semibold border border-amber-500/30 transition-all"
              title="EOF (Ctrl+D)"
            >
              ^D
            </button>

            {/* Action: Ctrl+Z */}
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSendInput('\x1a')}
              className="px-2 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 active:scale-95 text-amber-500 dark:text-amber-400 font-mono text-xs font-semibold border border-amber-500/30 transition-all"
              title="Suspend (Ctrl+Z)"
            >
              {t('webTerminal.accessoryKeys.ctrlZ', '^Z')}
            </button>

            {/* Action: Ctrl+L */}
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSendInput('\x0c')}
              className="px-2 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] font-mono text-xs font-semibold border border-[var(--border-subtle)] transition-all"
              title="Clear Screen (Ctrl+L)"
            >
              ^L
            </button>

            {/* Action: Ctrl+B (tmux Prefix) */}
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSendInput('\x02')}
              className="px-2 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 active:scale-95 text-emerald-500 dark:text-emerald-400 font-mono text-xs font-semibold border border-emerald-500/30 transition-all"
              title="tmux Prefix (Ctrl+B)"
            >
              ^B
            </button>
          </>
        )}

        <div className="h-4 w-[1px] bg-[var(--border-subtle)] mx-0.5" />

        {/* Execution & Direction Group: Enter (↵) and Arrow Keys */}
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendInput('\r')}
          className="px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 active:scale-95 text-indigo-500 dark:text-indigo-300 font-mono text-xs font-semibold border border-indigo-500/30 transition-all shadow-sm"
          title="Enter (Return)"
        >
          ↵
        </button>

        {/* Arrow Keys: Up, Down, Left, Right */}
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendInput(encodeNavigationKey('ArrowUp', isCtrlActive, isAltActive, !!isShiftActive))}
          className="w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] flex items-center justify-center border border-[var(--border-subtle)] transition-all"
          title="Up Arrow"
        >
          <ArrowUp className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendInput(encodeNavigationKey('ArrowDown', isCtrlActive, isAltActive, !!isShiftActive))}
          className="w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] flex items-center justify-center border border-[var(--border-subtle)] transition-all"
          title="Down Arrow"
        >
          <ArrowDown className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendInput(encodeNavigationKey('ArrowLeft', isCtrlActive, isAltActive, !!isShiftActive))}
          className="w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] flex items-center justify-center border border-[var(--border-subtle)] transition-all"
          title="Left Arrow"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendInput(encodeNavigationKey('ArrowRight', isCtrlActive, isAltActive, !!isShiftActive))}
          className="w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] flex items-center justify-center border border-[var(--border-subtle)] transition-all"
          title="Right Arrow"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>

        {/* Full Mode: Extended Navigation & Edit Keys (Home, End, Del, PgUp, PgDn) */}
        {!isConciseMode && (
          <>
            <div className="h-4 w-[1px] bg-[var(--border-subtle)] mx-0.5" />

            {/* Navigation: Home */}
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSendInput(encodeNavigationKey('Home', isCtrlActive, isAltActive, !!isShiftActive))}
              className="px-2 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] font-mono text-xs font-semibold border border-[var(--border-subtle)] transition-all shadow-sm"
              title="Home"
            >
              {t('webTerminal.accessoryKeys.home', 'Home')}
            </button>

            {/* Navigation: End */}
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSendInput(encodeNavigationKey('End', isCtrlActive, isAltActive, !!isShiftActive))}
              className="px-2 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] font-mono text-xs font-semibold border border-[var(--border-subtle)] transition-all shadow-sm"
              title="End"
            >
              {t('webTerminal.accessoryKeys.end', 'End')}
            </button>

            {/* Navigation / Edit: Del (Forward Delete) */}
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSendInput(encodeNavigationKey('Delete', isCtrlActive, isAltActive, !!isShiftActive))}
              className="px-2 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] font-mono text-xs font-semibold border border-[var(--border-subtle)] transition-all shadow-sm"
              title="Delete (Forward Delete)"
            >
              {t('webTerminal.accessoryKeys.del', 'Del')}
            </button>

            {/* Navigation: Page Up */}
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSendInput(encodeNavigationKey('PageUp', isCtrlActive, isAltActive, !!isShiftActive))}
              className="px-2 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] font-mono text-xs font-semibold border border-[var(--border-subtle)] transition-all shadow-sm"
              title="Page Up"
            >
              {t('webTerminal.accessoryKeys.pgUp')}
            </button>

            {/* Navigation: Page Down */}
            <button
              type="button"
              onTouchStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSendInput(encodeNavigationKey('PageDown', isCtrlActive, isAltActive, !!isShiftActive))}
              className="px-2 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] font-mono text-xs font-semibold border border-[var(--border-subtle)] transition-all shadow-sm"
              title="Page Down"
            >
              {t('webTerminal.accessoryKeys.pgDn')}
            </button>
          </>
        )}

        <div className="h-4 w-[1px] bg-[var(--border-subtle)] mx-0.5" />

        {/* Action: Paste */}
        <button
          type="button"
          onClick={onPaste}
          className="px-2 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] flex items-center space-x-1 font-mono text-xs font-semibold border border-[var(--border-subtle)] transition-all shadow-sm"
          title={t('webTerminal.paste')}
        >
          <ClipboardPaste className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
          <span className="text-[11px]">{t('webTerminal.paste')}</span>
        </button>

        {/* Mode Toggle Capsule Button */}
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleToggleConciseMode}
          className="px-2 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] active:scale-95 text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center space-x-1 font-sans text-xs font-medium border border-[var(--border-subtle)] transition-all shadow-sm shrink-0 cursor-pointer"
          title={isConciseMode ? t('webTerminal.accessoryKeys.expandFull', '切换至完整按键模式') : t('webTerminal.accessoryKeys.collapseConcise', '切换至简洁按键模式')}
        >
          {isConciseMode ? (
            <>
              <MoreHorizontal className="w-3.5 h-3.5 text-indigo-400" />
              <span className="text-[11px]">{t('webTerminal.accessoryKeys.moreKeys', '更多')}</span>
            </>
          ) : (
            <>
              <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-400" />
              <span className="text-[11px]">{t('webTerminal.accessoryKeys.conciseKeys', '简洁')}</span>
            </>
          )}
        </button>
      </div>

      {/* Right Fixed Controls: Selection/Copy, Keyboard Toggle & Done/Checkmark Dismiss */}
      <div className="flex items-center space-x-1 pl-1 border-l border-[var(--border-subtle)] shrink-0">
        {/* Select Mode / Copy Button (Always visible in mobile right thumb zone) */}
        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={hasSelection ? onCopy : onToggleSelectMode}
          className={`p-1.5 rounded-lg border transition-all active:scale-95 flex items-center justify-center ${
            isSelectMode
              ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/40 shadow-sm ring-1 ring-amber-500/30'
              : hasSelection
              ? 'bg-indigo-600 text-white border-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.5)]'
              : 'bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] text-[var(--text-primary)] border-[var(--border-subtle)]'
          }`}
          title={hasSelection ? t('webTerminal.copySelection') : isSelectMode ? t('webTerminal.exitSelectMode') : t('webTerminal.selectMode')}
        >
          {hasSelection ? (
            <Copy className="w-3.5 h-3.5" />
          ) : (
            <TextSelect className="w-3.5 h-3.5" />
          )}
        </button>

        <button
          type="button"
          onTouchStart={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleKeyboard}
          className={`p-1.5 rounded-lg border transition-all active:scale-95 ${
            isKeyboardOpen
              ? 'bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 border-indigo-500/40 shadow-sm'
              : 'bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] text-[var(--text-primary)] border-[var(--border-subtle)]'
          }`}
          title={isKeyboardOpen ? t('webTerminal.hideKeyboard') : t('webTerminal.showKeyboard')}
        >
          <Keyboard className="w-3.5 h-3.5" />
        </button>

        {/* Dedicated Dismiss Checkmark Button (打勾收起软键盘 / 完成) */}
        <button
          type="button"
          onClick={onHideKeyboard || onToggleKeyboard}
          className="px-2 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 active:scale-95 text-emerald-600 dark:text-emerald-400 border border-emerald-500/40 flex items-center space-x-1 transition-all shadow-sm cursor-pointer"
          title={t('webTerminal.hideKeyboard')}
        >
          <Check className="w-3.5 h-3.5 stroke-[2.5]" />
          <span className="text-[11px] font-semibold">{t('webTerminal.done')}</span>
        </button>
      </div>
    </div>
  );
};
