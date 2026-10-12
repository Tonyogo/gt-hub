import React from 'react';
import { TerminalSquare, Plus } from 'lucide-react';

export interface TerminalEmptyStateProps {
  visible: boolean;
  onRequestAddNode?: () => void;
  t: (key: string, fallback?: string) => string;
}

export const TerminalEmptyState: React.FC<TerminalEmptyStateProps> = ({
  visible,
  onRequestAddNode,
  t,
}) => {
  if (!visible) return null;

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-6 text-center select-none bg-[var(--bg-canvas)]">
      <div className="w-12 h-12 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-400 mb-3">
        <TerminalSquare className="w-6 h-6" />
      </div>
      <p className="text-sm font-medium text-[var(--text-secondary)] font-sans">
        {t('webTerminal.emptyState.title', '当前暂无在线终端节点')}
      </p>
      <p className="text-xs text-[var(--text-muted)] mt-1.5 max-w-sm leading-relaxed font-sans">
        {t(
          'webTerminal.emptyState.desc',
          '系统采用纯反向 Agent 统一架构。请在宿主机或任意远程节点运行反向终端 Agent，建立安全连接后即可在此管理控制台与文件。'
        )}
      </p>
      {onRequestAddNode && (
        <button
          type="button"
          onClick={onRequestAddNode}
          className="mt-4 px-3.5 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-medium flex items-center space-x-1.5 transition-all active:scale-95 cursor-pointer shadow-xs"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{t('webTerminal.hostSelector.addNode', '接入内网新节点')}</span>
        </button>
      )}
    </div>
  );
};

export default TerminalEmptyState;
