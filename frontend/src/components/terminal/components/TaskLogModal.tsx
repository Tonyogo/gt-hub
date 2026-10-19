import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  Loader2,
  Square,
  ArrowDown
} from 'lucide-react';
import { useTranslation } from '../../../i18n/LanguageContext';
import { apiFetch } from '../../../utils/apiClient';
import { TaskSummary, TaskStatus, TaskLogResponse } from '../types/task';

export interface TaskLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: TaskSummary | null;
  activeHostId: string;
  adminKey?: string;
  onKillTask?: (taskId: string) => Promise<void>;
}

const MAX_LOG_CHARS = 500 * 1024; // 500KB cap for browser DOM memory protection

export const TaskLogModal: React.FC<TaskLogModalProps> = ({
  isOpen,
  onClose,
  task,
  activeHostId,
  adminKey,
  onKillTask,
}) => {
  const { t } = useTranslation();

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [logText, setLogText] = useState<string>('');
  const [currentStatus, setCurrentStatus] = useState<TaskStatus>('running');
  const [currentExitCode, setCurrentExitCode] = useState<number | null>(null);
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [isKilling, setIsKilling] = useState<boolean>(false);

  const offsetRef = useRef<number>(0);
  const pollTimerRef = useRef<any>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const isPollingRef = useRef<boolean>(false);
  const activeTaskIdRef = useRef<string>('');

  const getHeaders = useCallback(() => {
    const headers: Record<string, string> = {};
    const key =
      adminKey ||
      (typeof window !== 'undefined'
        ? localStorage.getItem('gt_admin_key') || localStorage.getItem('admin_secret_key') || ''
        : '');
    if (key) {
      headers['x-admin-key'] = key;
    }
    return headers;
  }, [adminKey]);

  const clearTimer = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const fetchLogChunk = useCallback(
    async (isManualRefresh = false) => {
      if (!task || !activeHostId || isPollingRef.current) return;

      isPollingRef.current = true;
      if (isManualRefresh && !logText) {
        setIsLoading(true);
      }

      try {
        const offset = offsetRef.current;
        const res = await apiFetch(
          `/api/terminal/exec/${encodeURIComponent(activeHostId)}/${encodeURIComponent(
            task.taskId
          )}?offset=${offset}`,
          { headers: getHeaders() }
        );

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data: TaskLogResponse = await res.json();
        if (data.success) {
          if (data.status) {
            setCurrentStatus(data.status);
          }
          if (data.exitCode !== undefined && data.exitCode !== null) {
            setCurrentExitCode(data.exitCode);
          }

          if (data.output && data.output.length > 0) {
            setLogText((prev) => {
              let combined = prev + data.output;
              if (combined.length > MAX_LOG_CHARS) {
                combined = combined.slice(-MAX_LOG_CHARS);
              }
              return combined;
            });
          }

          if (data.offset !== undefined) {
            offsetRef.current = data.offset;
          }

          // If still running and modal is open, schedule next poll
          if (data.status === 'running' && isOpen) {
            clearTimer();
            pollTimerRef.current = setTimeout(() => {
              fetchLogChunk(false);
            }, 1500);
          } else {
            clearTimer();
          }
        } else {
          setErrorMessage(data.error || 'Failed to fetch task logs');
        }
      } catch (err: any) {
        setErrorMessage(err.message || 'Network error fetching task log');
      } finally {
        isPollingRef.current = false;
        setIsLoading(false);
      }
    },
    [task, activeHostId, getHeaders, isOpen, logText]
  );

  // Initialize or reset when modal opens or task changes
  useEffect(() => {
    if (isOpen && task) {
      activeTaskIdRef.current = task.taskId;
      offsetRef.current = 0;
      setLogText('');
      setCurrentStatus(task.status);
      setCurrentExitCode(task.exitCode ?? null);
      setErrorMessage(null);
      setIsCopied(false);
      clearTimer();
      fetchLogChunk(true);
    } else {
      clearTimer();
      setLogText('');
      setErrorMessage(null);
      setIsCopied(false);
      offsetRef.current = 0;
    }

    return () => {
      clearTimer();
    };
  }, [isOpen, task?.taskId]);

  // Handle auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logText, autoScroll]);

  if (!isOpen || !task) return null;

  const handleCopy = async () => {
    if (!logText) return;
    try {
      await navigator.clipboard.writeText(logText);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Graceful clipboard fallback
    }
  };

  const handleKill = async () => {
    if (currentStatus !== 'running' || isKilling) return;
    const confirmed = window.confirm(t('tasks.killConfirm', '确定要向该任务发送终止信号吗？'));
    if (!confirmed) return;

    try {
      setIsKilling(true);
      clearTimer();

      const res = await apiFetch(
        `/api/terminal/exec/${encodeURIComponent(activeHostId)}/${encodeURIComponent(
          task.taskId
        )}/kill`,
        {
          method: 'POST',
          headers: {
            ...getHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ signal: 'SIGTERM' }),
        }
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      setCurrentStatus('killed');
      if (onKillTask) {
        await onKillTask(task.taskId);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to kill task');
    } finally {
      setIsKilling(false);
    }
  };

  const formatDuration = (start: number, end: number | null) => {
    const elapsed = (end || Date.now()) - start;
    if (elapsed < 1000) return `${elapsed}ms`;
    const sec = elapsed / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    const remSec = (sec % 60).toFixed(0);
    return `${min}m ${remSec}s`;
  };

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleString();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in duration-150">
      <div
        className="bg-[#18181b] border-t sm:border border-white/10 rounded-t-2xl sm:rounded-2xl rounded-b-none sm:rounded-b-2xl shadow-2xl max-w-4xl w-full overflow-hidden text-slate-200 my-0 sm:my-auto flex flex-col max-h-[90vh] sm:max-h-[85vh] pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile Pull Handle */}
        <div className="sm:hidden w-10 h-1 bg-white/20 rounded-full mx-auto my-2 shrink-0" />
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="p-2 rounded-xl bg-slate-800/80 border border-white/10 text-slate-300 shrink-0">
              <Terminal className="w-5 h-5 text-indigo-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center space-x-2">
                <h3 className="text-base font-semibold text-white truncate">
                  {t('tasks.logsModal.title', '任务执行日志')}
                </h3>
                <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-white/[0.06] text-slate-300 shrink-0 select-all">
                  {task.taskId}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 truncate font-mono">
                $ {task.command}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-1.5 shrink-0">
            <button
              type="button"
              onClick={() => fetchLogChunk(true)}
              disabled={isLoading}
              className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white border border-white/[0.06] transition-all disabled:opacity-50"
              title={t('tasks.refresh', '刷新')}
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

        {/* Metadata & Controls Bar */}
        <div className="px-5 py-2.5 bg-black/40 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            {/* Status Badge */}
            <div className="flex items-center space-x-1.5">
              <span className="text-slate-400">{t('tasks.colStatus', '状态')}:</span>
              {currentStatus === 'completed' && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>{t('tasks.filterCompleted', '已完成')}</span>
                </span>
              )}
              {currentStatus === 'running' && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  <PlayCircle className="w-3 h-3 animate-pulse" />
                  <span>{t('tasks.filterRunning', '运行中')}</span>
                </span>
              )}
              {currentStatus === 'failed' && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                  <XCircle className="w-3 h-3" />
                  <span>{t('tasks.filterFailed', '失败')}</span>
                </span>
              )}
              {currentStatus === 'timeout' && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                  <AlertTriangle className="w-3 h-3" />
                  <span>超时</span>
                </span>
              )}
              {currentStatus === 'killed' && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-800 text-slate-400 border border-white/10">
                  <Square className="w-3 h-3" />
                  <span>{t('tasks.filterKilled', '已终止')}</span>
                </span>
              )}
            </div>

            {/* Exit Code */}
            <div className="flex items-center space-x-1.5">
              <span className="text-slate-400">{t('tasks.colExitCode', '退出码')}:</span>
              {currentExitCode !== null && currentExitCode !== undefined ? (
                <span
                  className={`font-mono px-2 py-0.5 rounded-md text-[11px] font-medium border ${
                    currentExitCode === 0
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                  }`}
                >
                  {currentExitCode}
                </span>
              ) : (
                <span className="text-slate-500">-</span>
              )}
            </div>

            {/* Duration */}
            <div className="flex items-center space-x-1.5">
              <span className="text-slate-400">{t('tasks.colDuration', '耗时')}:</span>
              <span className="font-mono text-slate-300">
                {formatDuration(task.startTime, task.endTime)}
              </span>
            </div>

            {/* Start Time */}
            <div className="hidden sm:flex items-center space-x-1.5">
              <Clock className="w-3 h-3 text-slate-500" />
              <span className="text-slate-400">{formatTime(task.startTime)}</span>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Auto-scroll Toggle */}
            <button
              type="button"
              onClick={() => setAutoScroll((prev) => !prev)}
              className={`min-h-[36px] px-2.5 py-1 rounded-lg text-xs font-medium border transition-all flex items-center space-x-1.5 ${
                autoScroll
                  ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/30'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-slate-200 border-white/[0.06]'
              }`}
              title={t('tasks.logsModal.autoScroll', '自动滚屏')}
            >
              <ArrowDown className={`w-3.5 h-3.5 ${autoScroll ? 'text-indigo-400' : ''}`} />
              <span className="hidden sm:inline">{t('tasks.logsModal.autoScroll', '自动滚屏')}</span>
            </button>

            {/* Copy Button */}
            {logText && (
              <button
                type="button"
                onClick={handleCopy}
                className={`min-h-[36px] px-2.5 py-1 rounded-lg text-xs font-medium border transition-all flex items-center space-x-1.5 ${
                  isCopied
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                    : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white border-white/[0.06]'
                }`}
              >
                {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{isCopied ? t('tasks.copySuccess', '已复制') : t('tasks.logsModal.copy', '复制日志')}</span>
              </button>
            )}

            {/* Kill Task Button (only if running) */}
            {currentStatus === 'running' && (
              <button
                type="button"
                onClick={handleKill}
                disabled={isKilling}
                className="min-h-[36px] px-2.5 py-1 rounded-lg text-xs font-medium bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition-all flex items-center space-x-1.5 disabled:opacity-50"
              >
                {isKilling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                <span>{t('tasks.killTask', '终止任务')}</span>
              </button>
            )}
          </div>
        </div>

        {/* Log Viewer Viewport */}
        <div className="p-4 flex-1 min-h-[300px] flex flex-col bg-[#0c1017]">
          {isLoading && !logText ? (
            <div className="flex-1 flex flex-col items-center justify-center space-y-2 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
              <span className="text-xs">加载日志中...</span>
            </div>
          ) : errorMessage && !logText ? (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
              {errorMessage}
            </div>
          ) : !logText ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-2 text-slate-500">
              <Terminal className="w-8 h-8 opacity-40" />
              <p className="text-xs">{t('tasks.emptyDesc', '暂无日志输出')}</p>
            </div>
          ) : (
            <div
              ref={logContainerRef}
              className="flex-1 bg-slate-950 font-mono text-xs text-slate-200 border border-slate-800 rounded-xl p-4 max-h-[50vh] sm:max-h-[520px] overflow-y-auto whitespace-pre-wrap break-all select-text shadow-inner"
            >
              {logText}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <span className="text-[11px] text-slate-500 font-mono truncate max-w-sm">
            Host: {activeHostId} {task.cwd ? `• CWD: ${task.cwd}` : ''}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[36px] px-4 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 text-xs font-medium transition-all"
          >
            {t('tasks.logsModal.close', '关闭')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TaskLogModal;
