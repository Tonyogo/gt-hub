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
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 sm:gap-1.5 px-2 py-1 rounded-2xl bg-[var(--bg-surface)]/95 border border-indigo-500/30 text-[var(--text-primary)] text-xs backdrop-blur-xl shadow-2xl animate-in fade-in slide-in-from-top-2 select-none whitespace-nowrap max-w-[95vw] overflow-x-auto no-scrollbar">
      {/* Status Icon Indicator */}
      <div
        className="flex items-center text-amber-500 dark:text-amber-400 font-semibold px-1 shrink-0"
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
        className="px-2 py-0.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] hover:bg-black/[0.1] dark:hover:bg-white/[0.15] active:scale-95 text-[var(--text-primary)] text-[11px] font-medium transition-all shrink-0 cursor-pointer"
      >
        {t('webTerminal.selectAllShort', '全选')}
      </button>

      {/* Clear Selection (Visible when has selection) */}
      {hasSelection && (
        <button
          type="button"
          onClick={onClearSelection}
          className="p-1 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 active:scale-95 text-[11px] transition-all shrink-0 cursor-pointer"
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
            ? 'bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white shadow-sm ring-1 ring-indigo-400/50 cursor-pointer'
            : 'bg-black/[0.04] dark:bg-white/[0.05] text-slate-400 opacity-40 cursor-not-allowed'
        }`}
        title={t('webTerminal.copy')}
      >
        <Copy className="w-3 h-3" />
        <span>{t('webTerminal.copy')}</span>
        {hasSelection && selectedCharCount > 0 && (
          <span className="text-[10px] font-mono opacity-85">({selectedCharCount})</span>
        )}
      </button>

      {/* Done / Exit Select Mode */}
      <button
        type="button"
        onClick={onExitSelectMode}
        className="px-2 py-0.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 active:scale-95 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 flex items-center space-x-1 text-[11px] font-semibold transition-all shrink-0 cursor-pointer"
        title={t('webTerminal.done')}
      >
        <Check className="w-3 h-3 stroke-[2.5]" />
        <span>{t('webTerminal.done')}</span>
      </button>
    </div>
  );
};

export default TerminalSelectionToolbar;
