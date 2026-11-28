import React from 'react';
import { TextSelect, X, Copy, Check } from 'lucide-react';

export interface TerminalSelectionToolbarProps {
  isSelectMode: boolean;
  hasSelection: boolean;
  selectedCharCount: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onCopySelection: () => void;
  onExitSelectMode: () => void;
  t: (key: string, fallback?: string) => string;
}

export const TerminalSelectionToolbar: React.FC<TerminalSelectionToolbarProps> = ({
  isSelectMode,
  hasSelection,
  selectedCharCount,
  onSelectAll,
  onClearSelection,
  onCopySelection,
  onExitSelectMode,
  t,
}) => {
  if (!isSelectMode) return null;

  return (
    <div className="ui-elevated-glass absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 sm:gap-1.5 px-2 py-1 rounded-xl border border-[var(--border-default)] text-[var(--text-primary)] text-xs shadow-[var(--shadow-popover)] select-none whitespace-nowrap max-w-[95vw] overflow-x-auto no-scrollbar">
      {/* Status Icon Indicator */}
      <div
        className="flex items-center text-[var(--status-warning-text)] font-semibold px-1 shrink-0"
        title={t('webTerminal.selectModeActive')}
      >
        <TextSelect className="w-3.5 h-3.5" />
      </div>

      <div className="h-3.5 w-[1px] bg-[var(--border-subtle)] shrink-0" />

      {/* Select Screen / All (Compact) */}
      <button
        type="button"
        onClick={onSelectAll}
        title={t('webTerminal.selectAllVisible')}
        className="px-2 py-0.5 rounded-lg bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] active:scale-95 text-[var(--text-primary)] text-[11px] font-medium border border-[var(--border-subtle)] transition-all shrink-0 cursor-pointer"
      >
        {t('webTerminal.selectAllShort', '全选')}
      </button>

      {/* Clear Selection (Visible when has selection) */}
      {hasSelection && (
        <button
          type="button"
          onClick={onClearSelection}
          className="p-1 rounded-lg bg-[var(--bg-control)] hover:bg-[var(--status-danger-bg)] text-[var(--text-secondary)] hover:text-[var(--status-danger-text)] border border-[var(--border-subtle)] active:scale-95 text-[11px] transition-all shrink-0 cursor-pointer"
          title={t('webTerminal.clearSelection')}
        >
          <X className="w-3 h-3" />
        </button>
      )}

      {/* Copy Button (Highlights and shows count when selected) */}
      <button
        type="button"
        disabled={!hasSelection}
        onClick={onCopySelection}
        className={`px-2.5 py-0.5 rounded-lg text-[11px] font-semibold flex items-center space-x-1 transition-all shrink-0 ${
          hasSelection
            ? 'ui-btn-primary cursor-pointer'
            : 'bg-[var(--bg-control)] text-[var(--text-muted)] border border-[var(--border-subtle)] opacity-40 cursor-not-allowed'
        }`}
        title={t('webTerminal.copy')}
      >
        <Copy className="w-3 h-3" />
        <span>{t('webTerminal.copy')}</span>
        {hasSelection && selectedCharCount > 0 && (
          <span className="text-[10px] font-mono tabular-nums opacity-85">({selectedCharCount})</span>
        )}
      </button>

      {/* Done / Exit Select Mode */}
      <button
        type="button"
        onClick={onExitSelectMode}
        className="px-2 py-0.5 rounded-lg bg-[var(--status-success-bg)] hover:opacity-90 active:scale-95 text-[var(--status-success-text)] border border-[var(--status-success-border)] flex items-center space-x-1 text-[11px] font-semibold transition-all shrink-0 cursor-pointer"
        title={t('webTerminal.done')}
      >
        <Check className="w-3 h-3 stroke-[2.5]" />
        <span>{t('webTerminal.done')}</span>
      </button>
    </div>
  );
};

export default TerminalSelectionToolbar;
