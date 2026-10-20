import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
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

  if (!isOpen || !job) return null;

  const rawOutput =
    logData?.output ||
    (logData?.stdout ? `${logData.stdout}${logData.stderr ? `\n${logData.stderr}` : ''}` : '') ||
    logData?.stderr ||
    '';

  const handleCopy = async () => {
    if (!rawOutput) return;
    try {
      await navigator.clipboard.writeText(rawOutput);
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
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in duration-150">
      <div
        className="bg-[#18181b] border-t sm:border border-white/10 rounded-t-2xl sm:rounded-2xl rounded-b-none sm:rounded-b-2xl shadow-2xl max-w-3xl w-full overflow-hidden text-slate-200 my-0 sm:my-auto flex flex-col max-h-[90vh] sm:max-h-[85vh] pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile Pull Handle */}
        <div className="sm:hidden w-10 h-1 bg-white/20 rounded-full mx-auto my-2 shrink-0" />
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-slate-800/80 border border-white/10 text-slate-300">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-base font-semibold text-white truncate max-w-md">
                  {job.name}
                </h3>
                <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-white/[0.06] text-slate-400">
                  {job.cron}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {t('cron.logsModal.title', '执行日志')} • Host: <span className="text-slate-300 font-mono">{activeHostId}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-1.5">
            <button
              type="button"
              onClick={fetchLogs}
              disabled={isLoading}
              className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white border border-white/[0.06] transition-all disabled:opacity-50"
              title={t('cron.logsModal.refresh', '刷新日志')}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-indigo-400' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Execution Metadata Bar */}
        <div className="px-5 py-2.5 bg-black/40 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            {/* Status Badge */}
            <div className="flex items-center space-x-1.5">
              <span className="text-slate-400">{t('cron.logsModal.status', '状态')}:</span>
              {status === 'completed' && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>{t('cron.statusCompleted', '成功')}</span>
                </span>
              )}
              {status === 'failed' && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                  <XCircle className="w-3 h-3" />
                  <span>{t('cron.statusFailed', '失败')}</span>
                </span>
              )}
              {status === 'skipped' && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  <AlertTriangle className="w-3 h-3" />
                  <span>{t('cron.statusSkipped', '跳过')}</span>
                </span>
              )}
              {status === 'running' && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  <PlayCircle className="w-3 h-3 animate-pulse" />
                  <span>{t('cron.statusRunning', '运行中')}</span>
                </span>
              )}
              {(status === 'not_run' || !['completed', 'failed', 'skipped', 'running'].includes(status)) && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-800 text-slate-400">
                  {status}
                </span>
              )}
            </div>

            {/* Exit Code Badge */}
            <div className="flex items-center space-x-1.5">
              <span className="text-slate-400">{t('cron.logsModal.exitCode', '退出码')}:</span>
              {exitCode !== undefined && exitCode !== null ? (
                <span
                  className={`font-mono px-2 py-0.5 rounded-md text-[11px] font-medium border ${
                    exitCode === 0
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                  }`}
                >
                  {exitCode}
                </span>
              ) : (
                <span className="text-slate-500">-</span>
              )}
            </div>

            {/* Duration */}
            <div className="flex items-center space-x-1.5">
              <span className="text-slate-400">{t('cron.logsModal.duration', '耗时')}:</span>
              <span className="font-mono text-slate-300">{formatDuration(durationMs)}</span>
            </div>

            {/* Trigger Time */}
            {triggerTime && (
              <div className="hidden sm:flex items-center space-x-1.5">
                <Clock className="w-3 h-3 text-slate-500" />
                <span className="text-slate-400">{formatTime(triggerTime)}</span>
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
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white border-white/[0.06]'
              }`}
            >
              {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{isCopied ? t('cron.logsModal.copied', '已复制') : t('cron.logsModal.copy', '复制日志')}</span>
            </button>
          )}
        </div>

        {/* Terminal Window Viewport */}
        <div className="p-4 flex-1 min-h-[300px] flex flex-col bg-[#090d16]">
          {isLoading && !rawOutput ? (
            <div className="flex-1 flex flex-col items-center justify-center space-y-2 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
              <span className="text-xs">加载日志中...</span>
            </div>
          ) : errorMessage ? (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
              {errorMessage}
            </div>
          ) : status === 'skipped' ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-3">
              <div className="p-3 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div className="max-w-md">
                <h4 className="text-sm font-semibold text-white">本次执行已被跳过</h4>
                <p className="text-xs text-slate-400 mt-1">
                  由于任务配置了并发重叠保护策略（Forbid），前一次执行尚未结束或存在冲突，系统自动跳过了当前调度周期的触发。
                </p>
              </div>
            </div>
          ) : !rawOutput ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-2 text-slate-500">
              <Terminal className="w-8 h-8 opacity-40" />
              <p className="text-xs">{t('cron.logsModal.noLogs', '暂无执行日志记录。')}</p>
            </div>
          ) : (
            <div className="flex-1 bg-slate-950 font-mono text-xs text-slate-200 border border-slate-800 rounded-xl p-4 max-h-[500px] overflow-y-auto whitespace-pre-wrap break-all select-text shadow-inner">
              {rawOutput}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <span className="text-[11px] text-slate-500 font-mono">
            {logData?.taskId ? `Task ID: ${logData.taskId}` : ''}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 text-xs font-medium transition-all"
          >
            {t('cron.logsModal.close', '关闭')}
          </button>
        </div>
      </div>
    </div>
  );
};
