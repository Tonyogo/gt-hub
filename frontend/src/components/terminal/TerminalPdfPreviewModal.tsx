import React, { useState } from 'react';
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
import { ModalShell } from '../ui/ModalShell';

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

  // Escape key close handled by ModalShell

  return (
    <ModalShell
      isOpen={true}
      onClose={onClose}
      noHeader={true}
      ariaLabel={file.name}
      maxWidthClassName={isMaximized ? 'max-w-none' : 'max-w-5xl'}
      heightClassName={isMaximized ? 'h-[100dvh]' : 'h-[88dvh]'}
      bodyClassName="p-0 flex flex-col bg-[var(--bg-elevated)]"
    >
      {/* Header Bar */}
      <div className="p-3 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0 bg-[var(--bg-surface-sub)] select-none">
        <div className="flex items-center space-x-2 min-w-0">
          <FileText className="w-4 h-4 text-[var(--status-danger-text)] shrink-0" />
          <span className="font-semibold text-xs sm:text-sm text-[var(--text-primary)] truncate" title={file.path}>
            {file.name}
          </span>
          <span className="ui-badge-neutral text-[10px] font-mono tabular-nums px-1.5 py-0.5 hidden sm:inline">
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
            className="ui-btn-secondary flex items-center space-x-1 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span className="hidden md:inline">{t('files.openInNewTab', '新窗口打开')}</span>
          </button>

          {/* Maximize / Restore */}
          <button
            type="button"
            onClick={() => setIsMaximized((prev) => !prev)}
            title={isMaximized ? t('files.restore', '还原') : t('files.maximize', '最大化')}
            className="ui-icon-btn"
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
            className="ui-btn-secondary flex items-center space-x-1 px-2 py-1"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t('files.download', '下载')}</span>
          </button>

          {/* Close */}
          <button
            type="button"
            onClick={onClose}
            title={t('files.close', '关闭')}
            className="ui-icon-btn hover:bg-[var(--status-danger-bg)] hover:text-[var(--status-danger-text)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 min-h-0 relative bg-[var(--bg-terminal)]">
        {loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-[var(--text-muted)]">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--accent-primary)] mb-2" />
            <span className="text-xs">{t('files.loading', '加载中...')}</span>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-[var(--status-danger-text)]">
            <AlertTriangle className="w-8 h-8 mb-2" />
            <p className="text-sm font-medium mb-4 max-w-md">{error}</p>
            <div className="flex items-center space-x-2">
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="ui-btn-secondary flex items-center space-x-1.5 px-3 py-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>{t('files.retry', '重试')}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => onDownload(file)}
                className="ui-btn-primary flex items-center space-x-1.5 px-3 py-1.5 cursor-pointer"
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
    </ModalShell>
  );
};

export default TerminalPdfPreviewModal;
