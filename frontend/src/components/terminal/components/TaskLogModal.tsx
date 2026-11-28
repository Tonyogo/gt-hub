import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
  Loader2,
  Square,
  ArrowDown
} from 'lucide-react';
import { useTranslation } from '../../../i18n/LanguageContext';
import { apiFetch, getStoredAdminKey } from '../../../utils/apiClient';
import { TaskSummary, TaskStatus, TaskLogResponse } from '../types/task';
import {
  AnsiLogSegment,
  AnsiParserState,
  parseAnsiToSegments,
  parseAnsiToSegmentsWithState,
  stripAnsiCodes,
} from '../../../utils/ansiLogFormatter';
import { ModalShell } from '../../ui/ModalShell';

const MAX_RENDERED_SEGMENTS = 2500;

export interface TaskLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: TaskSummary | null;
  activeHostId: string;
  adminKey?: string;
  onKillTask?: (taskId: string) => Promise<boolean | void>;
}

export function shouldAcceptTaskLogResponse(state: {
  isOpen: boolean;
  currentSeq: number;
  requestSeq: number;
  activeTaskId: string | null;
  requestTaskId: string;
}): boolean {
  return (
    state.isOpen &&
    state.currentSeq === state.requestSeq &&
    state.activeTaskId === state.requestTaskId
  );
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
  const [showAllSegments, setShowAllSegments] = useState<boolean>(false);

  const ansiCacheRef = useRef<{
    text: string;
    segments: AnsiLogSegment[];
    state: AnsiParserState;
  }>({ text: '', segments: [], state: {} });

  useEffect(() => {
    setShowAllSegments(false);
  }, [task?.taskId, isOpen]);

  const logSegments = useMemo<AnsiLogSegment[]>(() => {
    if (!logText) {
      ansiCacheRef.current = { text: '', segments: [], state: {} };
      return [];
    }

    const prev = ansiCacheRef.current;
    if (prev.text && logText.startsWith(prev.text)) {
      const delta = logText.slice(prev.text.length);
      if (delta.length === 0) {
        return prev.segments;
      }
      // Incremental path is safe when delta does not rewrite lines via CR/BS
      // and previous buffer does not end mid-ANSI escape sequence.
      const hasControlRewrite = delta.includes('\r') || delta.includes('\b');
      const hasIncompleteEscape = /\x1b(?:\[[^\x40-\x7e]*|\][^\x07\x1b]*)?$/.test(prev.text.slice(-64));
      if (!hasControlRewrite && !hasIncompleteEscape) {
        const { segments: deltaSegments, endState } = parseAnsiToSegmentsWithState(delta, prev.state);
        const nextSegments = prev.segments.slice();
        for (const seg of deltaSegments) {
          const last = nextSegments[nextSegments.length - 1];
          if (last && last.colorClass === seg.colorClass && Boolean(last.bold) === Boolean(seg.bold)) {
            nextSegments[nextSegments.length - 1] = { ...last, text: last.text + seg.text };
          } else {
            nextSegments.push(seg);
          }
        }
        ansiCacheRef.current = { text: logText, segments: nextSegments, state: endState };
        return nextSegments;
      }
    }

    const fullSegments = parseAnsiToSegments(logText);
    const { endState } = parseAnsiToSegmentsWithState(logText.slice(-4096));
    ansiCacheRef.current = { text: logText, segments: fullSegments, state: endState };
    return fullSegments;
  }, [logText]);

  const isTailWindowed = !showAllSegments && logSegments.length > MAX_RENDERED_SEGMENTS;
  const visibleLogSegments = useMemo(
    () => (isTailWindowed ? logSegments.slice(-MAX_RENDERED_SEGMENTS) : logSegments),
    [isTailWindowed, logSegments]
  );

  const offsetRef = useRef<number>(0);
  const pollTimerRef = useRef<any>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const isPollingRef = useRef<boolean>(false);
  const activeTaskIdRef = useRef<string>('');
  const isOpenRef = useRef<boolean>(isOpen);
  isOpenRef.current = isOpen;
  const requestSeqRef = useRef<number>(0);
  const activeFetchIdRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const logTextRef = useRef<string>(logText);
  logTextRef.current = logText;

  const getHeaders = useCallback(() => {
    const headers: Record<string, string> = {};
    const key = adminKey || getStoredAdminKey();
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
      if (!task || !activeHostId) return;
      if (isPollingRef.current && !isManualRefresh) return;

      const seq = requestSeqRef.current;
      const reqTaskId = task.taskId;
      const fetchId = ++activeFetchIdRef.current;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      isPollingRef.current = true;
      if (isManualRefresh && !logTextRef.current) {
        setIsLoading(true);
      }

      try {
        const offset = offsetRef.current;
        const res = await apiFetch(
          `/api/terminal/exec/${encodeURIComponent(activeHostId)}/${encodeURIComponent(
            task.taskId
          )}?offset=${offset}`,
          { headers: getHeaders(), signal: controller.signal }
        );

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data: TaskLogResponse = await res.json();

        // Check if response should still be accepted
        if (
          !shouldAcceptTaskLogResponse({
            isOpen: isOpenRef.current,
            currentSeq: requestSeqRef.current,
            requestSeq: seq,
            activeTaskId: activeTaskIdRef.current,
            requestTaskId: reqTaskId,
          })
        ) {
          return;
        }

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
          if (data.status === 'running' && isOpenRef.current) {
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
        if (err.name === 'AbortError') return;
        if (
          !shouldAcceptTaskLogResponse({
            isOpen: isOpenRef.current,
            currentSeq: requestSeqRef.current,
            requestSeq: seq,
            activeTaskId: activeTaskIdRef.current,
            requestTaskId: reqTaskId,
          })
        ) {
          return;
        }
        setErrorMessage(err.message || 'Network error fetching task log');
      } finally {
        if (activeFetchIdRef.current === fetchId) {
          isPollingRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [task, activeHostId, getHeaders]
  );

  // Initialize or reset when modal opens or task changes
  useEffect(() => {
    requestSeqRef.current++;
    activeFetchIdRef.current++;
    isPollingRef.current = false;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    clearTimer();

    if (isOpen && task) {
      activeTaskIdRef.current = task.taskId;
      offsetRef.current = 0;
      setLogText('');
      setCurrentStatus(task.status);
      setCurrentExitCode(task.exitCode ?? null);
      setErrorMessage(null);
      setIsCopied(false);
      fetchLogChunk(true);
    } else {
      activeTaskIdRef.current = '';
      setLogText('');
      setErrorMessage(null);
      setIsCopied(false);
      offsetRef.current = 0;
    }

    return () => {
      requestSeqRef.current++;
      activeFetchIdRef.current++;
      isPollingRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      clearTimer();
    };
  }, [isOpen, task?.taskId, fetchLogChunk]);

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
      await navigator.clipboard.writeText(stripAnsiCodes(logText));
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

      if (onKillTask) {
        const ok = await onKillTask(task.taskId);
        if (ok !== false) {
          setCurrentStatus('killed');
        }
      } else {
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
          <span className="truncate">{t('tasks.logsModal.title', '任务执行日志')}</span>
          <span className="ui-badge-neutral font-mono text-[11px] px-2 py-0.5 shrink-0 select-all">
            {task.taskId}
          </span>
        </div>
      }
      subtitle={<span className="font-mono">$ {task.command}</span>}
      headerExtra={
        <button
          type="button"
          onClick={() => fetchLogChunk(true)}
          disabled={isLoading}
          className="ui-icon-btn disabled:opacity-50"
          title={t('tasks.refresh', '刷新')}
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-[var(--accent-primary)]' : ''}`} />
        </button>
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-muted)] font-mono truncate">
            Host: {activeHostId} {task.cwd ? `• CWD: ${task.cwd}` : ''}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ui-btn-secondary min-h-[36px] px-4 py-1.5"
          >
            {t('tasks.logsModal.close', '关闭')}
          </button>
        </div>
      }
    >
      {/* Metadata & Controls Bar */}
      <div className="px-4 sm:px-5 py-2.5 bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          {/* Status Badge */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[var(--text-secondary)]">{t('tasks.colStatus', '状态')}:</span>
            {currentStatus === 'completed' && (
              <span className="ui-badge-success inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                <CheckCircle2 className="w-3 h-3" />
                <span>{t('tasks.filterCompleted', '已完成')}</span>
              </span>
            )}
            {currentStatus === 'running' && (
              <span className="ui-badge-warning inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                <PlayCircle className="w-3 h-3 animate-pulse" />
                <span>{t('tasks.filterRunning', '运行中')}</span>
              </span>
            )}
            {currentStatus === 'failed' && (
              <span className="ui-badge-danger inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                <XCircle className="w-3 h-3" />
                <span>{t('tasks.filterFailed', '失败')}</span>
              </span>
            )}
            {currentStatus === 'timeout' && (
              <span className="ui-badge-danger inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                <AlertTriangle className="w-3 h-3" />
                <span>超时</span>
              </span>
            )}
            {currentStatus === 'killed' && (
              <span className="ui-badge-neutral inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                <Square className="w-3 h-3" />
                <span>{t('tasks.filterKilled', '已终止')}</span>
              </span>
            )}
          </div>

          {/* Exit Code */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[var(--text-secondary)]">{t('tasks.colExitCode', '退出码')}:</span>
            {currentExitCode !== null && currentExitCode !== undefined ? (
              <span
                className={`font-mono tabular-nums px-2 py-0.5 text-[11px] font-medium ${
                  currentExitCode === 0 ? 'ui-badge-success' : 'ui-badge-danger'
                }`}
              >
                {currentExitCode}
              </span>
            ) : (
              <span className="text-[var(--text-muted)]">-</span>
            )}
          </div>

          {/* Duration */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[var(--text-secondary)]">{t('tasks.colDuration', '耗时')}:</span>
            <span className="font-mono tabular-nums text-[var(--text-secondary)]">
              {formatDuration(task.startTime, task.endTime)}
            </span>
          </div>

          {/* Start Time */}
          <div className="hidden sm:flex items-center space-x-1.5">
            <Clock className="w-3 h-3 text-[var(--text-muted)]" />
            <span className="font-mono tabular-nums text-[var(--text-secondary)]">{formatTime(task.startTime)}</span>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* Auto-scroll Toggle */}
          <button
            type="button"
            onClick={() => setAutoScroll((prev) => !prev)}
            className={`min-h-[36px] px-2.5 py-1 rounded-lg text-xs font-medium border transition-all flex items-center space-x-1.5 ${
              autoScroll
                ? 'bg-[var(--accent-soft-bg)] text-[var(--accent-text)] border-[var(--accent-soft-border)]'
                : 'bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]'
            }`}
            title={t('tasks.logsModal.autoScroll', '自动滚屏')}
          >
            <ArrowDown className={`w-3.5 h-3.5 ${autoScroll ? 'text-[var(--accent-text)]' : ''}`} />
            <span className="hidden sm:inline">{t('tasks.logsModal.autoScroll', '自动滚屏')}</span>
          </button>

          {/* Copy Button */}
          {logText && (
            <button
              type="button"
              onClick={handleCopy}
              className={`min-h-[36px] px-2.5 py-1 rounded-lg text-xs font-medium border transition-all flex items-center space-x-1.5 ${
                isCopied
                  ? 'bg-[var(--status-success-bg)] text-[var(--status-success-text)] border-[var(--status-success-border)]'
                  : 'bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]'
              }`}
            >
              {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{isCopied ? t('tasks.copySuccess', '已复制') : t('tasks.logsModal.copy', '复制日志')}</span>
            </button>
          )}

          {/* Kill Task Button (only if running) */}
          {currentStatus === 'running' && (
            <button
              type="button"
              onClick={handleKill}
              disabled={isKilling}
              className="min-h-[36px] px-2.5 py-1 rounded-lg text-xs font-medium bg-[var(--status-danger-bg)] hover:opacity-90 text-[var(--status-danger-text)] border border-[var(--status-danger-border)] transition-all flex items-center space-x-1.5 disabled:opacity-50"
            >
              {isKilling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
              <span>{t('tasks.killTask', '终止任务')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Log Viewer Viewport */}
      <div className="p-4 flex-1 min-h-0 flex flex-col bg-[var(--bg-terminal)]">
        {isLoading && !logText ? (
          <div className="flex-1 flex flex-col items-center justify-center space-y-2 text-[var(--text-secondary)]">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--accent-primary)]" />
            <span className="text-xs">加载日志中...</span>
          </div>
        ) : errorMessage && !logText ? (
          <div className="p-4 rounded-xl bg-[var(--status-danger-bg)] border border-[var(--status-danger-border)] text-[var(--status-danger-text)] text-xs">
            {errorMessage}
          </div>
        ) : !logText ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-2 text-[var(--text-muted)]">
            <Terminal className="w-8 h-8 opacity-40" />
            <p className="text-xs">{t('tasks.emptyDesc', '暂无日志输出')}</p>
          </div>
        ) : (
          <div
            ref={logContainerRef}
            className="flex-1 min-h-0 bg-[var(--bg-terminal)] font-mono text-xs text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-xl p-4 overflow-y-auto whitespace-pre-wrap break-all select-text ansi-log-container"
          >
            {isTailWindowed && (
              <div className="mb-2 pb-2 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                <span>
                  {t(
                    'tasks.logsModal.windowedNotice',
                    `已省略较早的 ${logSegments.length - MAX_RENDERED_SEGMENTS} 个日志片段以保持流畅`
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setShowAllSegments(true)}
                  className="px-2 py-0.5 rounded bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--accent-text)] font-medium transition-colors shrink-0"
                >
                  {t('tasks.logsModal.showAll', '显示全部')}
                </button>
              </div>
            )}
            {visibleLogSegments.map((seg, idx) => (
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

export default TaskLogModal;
