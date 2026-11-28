import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Copy,
  Check,
  RefreshCw,
  Terminal,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  PlayCircle,
  Loader2
} from 'lucide-react';
import { useTranslation } from '../../../i18n/LanguageContext';
import { apiFetch, getStoredAdminKey } from '../../../utils/apiClient';
import { CronJobSummary, CronExecutionLogResponse } from '../types/cron';
import { parseAnsiToSegments, stripAnsiCodes } from '../../../utils/ansiLogFormatter';
import { ModalShell } from '../../ui/ModalShell';

export interface CronLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  job: CronJobSummary | null;
  activeHostId?: string;
  adminKey?: string;
}

export const CronLogModal: React.FC<CronLogModalProps> = ({
  isOpen,
  onClose,
  job,
  activeHostId,
  adminKey,
}) => {
  const { t } = useTranslation();

  const [isLoading, setIsLoading] = useState(false);
  const [logData, setLogData] = useState<CronExecutionLogResponse | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    if (!job || !activeHostId) return;

    try {
      setIsLoading(true);
      setErrorMessage(null);

      const headers: Record<string, string> = {};
      const key = adminKey || getStoredAdminKey();
      if (key) {
        headers['x-admin-key'] = key;
      }

      const res = await apiFetch(
        `/api/terminal/cron/${encodeURIComponent(activeHostId)}/${encodeURIComponent(job.id)}/logs`,
        { headers }
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data: CronExecutionLogResponse = await res.json();
      setLogData(data);
    } catch (err: any) {
      setErrorMessage(err.message || '获取执行日志失败');
    } finally {
      setIsLoading(false);
    }
  }, [job, activeHostId, adminKey]);

  useEffect(() => {
    if (isOpen && job) {
      fetchLogs();
    } else {
      setLogData(null);
      setErrorMessage(null);
      setIsCopied(false);
    }
  }, [isOpen, job, fetchLogs]);

  const rawOutput =
    logData?.output ||
    (logData?.stdout ? `${logData.stdout}${logData.stderr ? `\n${logData.stderr}` : ''}` : '') ||
    logData?.stderr ||
    '';

  const logSegments = useMemo(() => parseAnsiToSegments(rawOutput), [rawOutput]);

  if (!isOpen || !job) return null;

  const handleCopy = async () => {
    if (!rawOutput) return;
    try {
      await navigator.clipboard.writeText(stripAnsiCodes(rawOutput));
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures gracefully
    }
  };

  const status = logData?.status || job.lastExecution?.status || 'not_run';
  const exitCode = logData?.exitCode !== undefined ? logData.exitCode : job.lastExecution?.exitCode;
  const durationMs = logData?.durationMs !== undefined ? logData.durationMs : job.lastExecution?.durationMs;
  const triggerTime = job.lastExecution?.triggerTime;

  const formatDuration = (ms?: number) => {
    if (ms === undefined || ms === null) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const formatTime = (ts?: number) => {
    if (!ts) return '-';
    return new Date(ts).toLocaleString();
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClassName="max-w-4xl"
      heightClassName="h-[88dvh]"
      bodyClassName="p-0 flex flex-col"
      icon={
        <div className="p-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--accent-text)]">
          <Terminal className="w-4 h-4" />
        </div>
      }
      title={
        <div className="flex items-center space-x-2 min-w-0">
          <span className="truncate">{job.name}</span>
          <span className="ui-badge-neutral font-mono text-[11px] px-2 py-0.5 shrink-0">
            {job.cron}
          </span>
        </div>
      }
      subtitle={
        <span>
          {t('cron.logsModal.title', '执行日志')} • Host:{' '}
          <span className="text-[var(--text-primary)] font-mono">{activeHostId}</span>
        </span>
      }
      headerExtra={
        <button
          type="button"
          onClick={fetchLogs}
          disabled={isLoading}
          className="ui-icon-btn disabled:opacity-50"
          title={t('cron.logsModal.refresh', '刷新日志')}
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-[var(--accent-primary)]' : ''}`} />
        </button>
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-muted)] font-mono truncate">
            {logData?.taskId ? `Task ID: ${logData.taskId}` : ''}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ui-btn-secondary px-4 py-1.5"
          >
            {t('cron.logsModal.close', '关闭')}
          </button>
        </div>
      }
    >
      {/* Execution Metadata Bar */}
      <div className="px-4 sm:px-5 py-2.5 bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          {/* Status Badge */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[var(--text-secondary)]">{t('cron.logsModal.status', '状态')}:</span>
            {status === 'completed' && (
              <span className="ui-badge-success inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                <CheckCircle2 className="w-3 h-3" />
                <span>{t('cron.statusCompleted', '成功')}</span>
              </span>
            )}
            {status === 'failed' && (
              <span className="ui-badge-danger inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                <XCircle className="w-3 h-3" />
                <span>{t('cron.statusFailed', '失败')}</span>
              </span>
            )}
            {status === 'skipped' && (
              <span className="ui-badge-warning inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                <AlertTriangle className="w-3 h-3" />
                <span>{t('cron.statusSkipped', '跳过')}</span>
              </span>
            )}
            {status === 'running' && (
              <span className="ui-badge-info inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                <PlayCircle className="w-3 h-3 animate-pulse" />
                <span>{t('cron.statusRunning', '运行中')}</span>
              </span>
            )}
            {(status === 'not_run' || !['completed', 'failed', 'skipped', 'running'].includes(status)) && (
              <span className="ui-badge-neutral px-2 py-0.5 text-[11px] font-medium">
                {status}
              </span>
            )}
          </div>

          {/* Exit Code Badge */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[var(--text-secondary)]">{t('cron.logsModal.exitCode', '退出码')}:</span>
            {exitCode !== undefined && exitCode !== null ? (
              <span
                className={`font-mono tabular-nums px-2 py-0.5 text-[11px] font-medium ${
                  exitCode === 0 ? 'ui-badge-success' : 'ui-badge-danger'
                }`}
              >
                {exitCode}
              </span>
            ) : (
              <span className="text-[var(--text-muted)]">-</span>
            )}
          </div>

          {/* Duration */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[var(--text-secondary)]">{t('cron.logsModal.duration', '耗时')}:</span>
            <span className="font-mono tabular-nums text-[var(--text-secondary)]">{formatDuration(durationMs)}</span>
          </div>

          {/* Trigger Time */}
          {triggerTime && (
            <div className="hidden sm:flex items-center space-x-1.5">
              <Clock className="w-3 h-3 text-[var(--text-muted)]" />
              <span className="font-mono tabular-nums text-[var(--text-secondary)]">{formatTime(triggerTime)}</span>
            </div>
          )}
        </div>

        {/* Copy Button */}
        {rawOutput && (
          <button
            type="button"
            onClick={handleCopy}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all flex items-center space-x-1.5 ${
              isCopied
                ? 'bg-[var(--status-success-bg)] text-[var(--status-success-text)] border-[var(--status-success-border)]'
                : 'bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]'
            }`}
          >
            {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{isCopied ? t('cron.logsModal.copied', '已复制') : t('cron.logsModal.copy', '复制日志')}</span>
          </button>
        )}
      </div>

      {/* Terminal Window Viewport */}
      <div className="p-4 flex-1 min-h-0 flex flex-col bg-[var(--bg-terminal)]">
        {isLoading && !rawOutput ? (
          <div className="flex-1 flex flex-col items-center justify-center space-y-2 text-[var(--text-secondary)]">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--accent-primary)]" />
            <span className="text-xs">加载日志中...</span>
          </div>
        ) : errorMessage ? (
          <div className="p-4 rounded-xl bg-[var(--status-danger-bg)] border border-[var(--status-danger-border)] text-[var(--status-danger-text)] text-xs">
            {errorMessage}
          </div>
        ) : status === 'skipped' ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-3">
            <div className="p-3 rounded-full bg-[var(--status-warning-bg)] border border-[var(--status-warning-border)] text-[var(--status-warning-text)]">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div className="max-w-md">
              <h4 className="text-sm font-semibold text-[var(--text-primary)]">本次执行已被跳过</h4>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                由于任务配置了并发重叠保护策略（Forbid），前一次执行尚未结束或存在冲突，系统自动跳过了当前调度周期的触发。
              </p>
            </div>
          </div>
        ) : !rawOutput ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-2 text-[var(--text-muted)]">
            <Terminal className="w-8 h-8 opacity-40" />
            <p className="text-xs">{t('cron.logsModal.noLogs', '暂无执行日志记录。')}</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 bg-[var(--bg-terminal)] font-mono text-xs text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-xl p-4 overflow-y-auto whitespace-pre-wrap break-all select-text ansi-log-container">
            {logSegments.map((seg, idx) => (
              <span
                key={idx}
                className={[seg.colorClass, seg.bold ? 'font-bold' : ''].filter(Boolean).join(' ') || undefined}
              >
                {seg.text}
              </span>
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  );
};
