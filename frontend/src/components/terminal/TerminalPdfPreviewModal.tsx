import React, { useState, useEffect } from 'react';
import {
  FileText,
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  X,
  Loader2,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { TerminalFileItem } from './TerminalFileManagerView';

export interface TerminalPdfPreviewModalProps {
  file: TerminalFileItem;
  blobUrl: string | null;
  loading: boolean;
  error?: string | null;
  onClose: () => void;
  onDownload: (file: TerminalFileItem) => void;
  onRetry?: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i] || 'TB'}`;
}

export const TerminalPdfPreviewModal: React.FC<TerminalPdfPreviewModalProps> = ({
  file,
  blobUrl,
  loading,
  error,
  onClose,
  onDownload,
  onRetry,
}) => {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState<boolean>(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-2 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={`ui-card flex flex-col border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl overflow-hidden transition-all duration-200 ${
          isMaximized ? 'w-full h-full rounded-none' : 'w-full max-w-6xl h-[90vh] rounded-xl'
        }`}
      >
        {/* Header Bar */}
        <div className="p-3 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0 bg-[var(--bg-surface-sub)] select-none">
          <div className="flex items-center space-x-2 min-w-0">
            <FileText className="w-4 h-4 text-rose-400 shrink-0" />
            <span className="font-semibold text-xs sm:text-sm text-slate-200 truncate" title={file.path}>
              {file.name}
            </span>
            <span className="text-[10px] text-slate-400 font-mono px-1.5 py-0.5 rounded bg-black/30 hidden sm:inline">
              {formatFileSize(file.size)}
            </span>
          </div>

          <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
            {/* Open in New Tab */}
            <button
              type="button"
              disabled={!blobUrl}
              onClick={() => {
                if (blobUrl) {
                  window.open(blobUrl, '_blank', 'noopener,noreferrer');
                }
              }}
              title={t('files.openInNewTab', '新窗口打开')}
              className="flex items-center space-x-1 px-2 py-1 rounded border border-[var(--border-subtle)] text-slate-300 hover:text-white text-xs disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{t('files.openInNewTab', '新窗口打开')}</span>
            </button>

            {/* Maximize / Restore */}
            <button
              type="button"
              onClick={() => setIsMaximized((prev) => !prev)}
              title={isMaximized ? t('files.restore', '还原') : t('files.maximize', '最大化')}
              className="p-1 rounded border border-[var(--border-subtle)] text-slate-300 hover:text-white text-xs transition-colors"
            >
              {isMaximized ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>

            {/* Download */}
            <button
              type="button"
              onClick={() => onDownload(file)}
              title={t('files.download', '下载')}
              className="flex items-center space-x-1 px-2 py-1 rounded border border-[var(--border-subtle)] text-slate-300 hover:text-white text-xs transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('files.download', '下载')}</span>
            </button>

            {/* Close */}
            <button
              type="button"
              onClick={onClose}
              title={t('files.close', '关闭')}
              className="p-1 rounded hover:bg-slate-700/50 text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 min-h-0 relative bg-slate-900">
          {loading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-rose-500 mb-2" />
              <span className="text-xs">{t('files.loading', '加载中...')}</span>
            </div>
          ) : error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-rose-400">
              <AlertTriangle className="w-8 h-8 mb-2" />
              <p className="text-sm font-medium mb-4 max-w-md">{error}</p>
              <div className="flex items-center space-x-2">
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-sub)] hover:bg-[var(--bg-surface-hover)] text-slate-200 text-xs font-medium transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{t('files.retry', '重试')}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onDownload(file)}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{t('files.download', '下载')}</span>
                </button>
              </div>
            </div>
          ) : blobUrl ? (
            <iframe
              src={blobUrl}
              title={file.name}
              className="w-full h-full border-0 bg-white"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default TerminalPdfPreviewModal;
