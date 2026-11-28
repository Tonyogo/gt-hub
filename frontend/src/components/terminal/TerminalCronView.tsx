import React, { useState, useEffect, useRef, useCallback, useImperativeHandle } from 'react';
import {
  Clock,
  Plus,
  RefreshCw,
  Play,
  Pause,
  Trash2,
  Edit2,
  FileText,
  AlertCircle,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Server,
  Search,
  Terminal,
  FileCode,
  X,
  Info
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { apiFetch, getStoredAdminKey } from '../../utils/apiClient';
import { CronJobSummary, CronJobConfig } from './types/cron';
import { CronJobModal } from './components/CronJobModal';
import { CronLogModal } from './components/CronLogModal';

export interface ToastMessage {
  id: string;
  message: string;
  type: 'error' | 'success' | 'info';
}

export interface TerminalCronHandle {
  refresh: () => void;
}

export interface TerminalCronViewProps {
  adminKey?: string;
  activeHostId?: string;
  isConnected?: boolean;
  onRequestAddNode?: () => void;
  isActive?: boolean;
}

export const TerminalCronView = React.forwardRef<TerminalCronHandle, TerminalCronViewProps>(
  ({ adminKey, activeHostId, isConnected = true, onRequestAddNode, isActive = false }, ref) => {
    const { t, language } = useTranslation();
    const isZh = language === 'zh';

    const [jobs, setJobs] = useState<CronJobSummary[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [searchQuery, setSearchQuery] = useState<string>('');
    const [runningJobIds, setRunningJobIds] = useState<Set<string>>(new Set());
    const [deleteConfirmJobId, setDeleteConfirmJobId] = useState<string | null>(null);

    // Modal states
    const [isJobModalOpen, setIsJobModalOpen] = useState<boolean>(false);
    const [editingJob, setEditingJob] = useState<CronJobSummary | null>(null);
    const [selectedJobForLogs, setSelectedJobForLogs] = useState<CronJobSummary | null>(null);

    // Toast notification state
    const [toasts, setToasts] = useState<ToastMessage[]>([]);

    const showToast = useCallback((message: string, type: 'error' | 'success' | 'info' = 'info') => {
      const id = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, 3500);
    }, []);

    const removeToast = useCallback((id: string) => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, []);

    // API Headers helper
    const getHeaders = useCallback(() => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      const key = adminKey || getStoredAdminKey();
      if (key) {
        headers['x-admin-key'] = key;
      }
      return headers;
    }, [adminKey]);

    const activeHostIdRef = useRef<string | undefined>(activeHostId);
    activeHostIdRef.current = activeHostId;
    const isActiveRef = useRef<boolean>(isActive);
    isActiveRef.current = isActive;

    // Fetch jobs list
    const fetchJobs = useCallback(async (silent = false) => {
      if (!activeHostId) {
        setJobs([]);
        return;
      }

      if (silent && !isActiveRef.current) return;

      const requestHostId = activeHostId;

      if (!silent) {
        setIsLoading(true);
      }

      try {
        const res = await apiFetch(`/api/terminal/cron/${encodeURIComponent(activeHostId)}`, {
          headers: getHeaders(),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        const data = await res.json();
        if (activeHostIdRef.current !== requestHostId) {
          return;
        }

        if (data && data.success && Array.isArray(data.data)) {
          setJobs(data.data);
        } else {
          setJobs([]);
        }
      } catch (err: any) {
        if (activeHostIdRef.current !== requestHostId) return;
        if (!silent && isActiveRef.current) {
          showToast(err.message || '加载定时任务列表失败', 'error');
        }
      } finally {
        if (activeHostIdRef.current === requestHostId && !silent) {
          setIsLoading(false);
        }
      }
    }, [activeHostId, getHeaders, showToast]);

    // Expose refresh via ref
    useImperativeHandle(ref, () => ({
      refresh: () => fetchJobs(false),
    }), [fetchJobs]);

    // Reset jobs and state when activeHostId changes to prevent showing stale cron jobs and modals from previous host
    useEffect(() => {
      setJobs([]);
      setIsLoading(false);
      setDeleteConfirmJobId(null);
      setRunningJobIds(new Set());
      setIsJobModalOpen(false);
      setEditingJob(null);
      setSelectedJobForLogs(null);
    }, [activeHostId]);

    // Initial fetch when active or when activeHostId changes while active
    useEffect(() => {
      if (!isActive) return;
      fetchJobs(false);
    }, [isActive, fetchJobs]);

    // Silent background poll every 10 seconds only when active and host is selected
    useEffect(() => {
      if (!isActive || !activeHostId) return;

      const timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        fetchJobs(true);
      }, 10000);

      return () => clearInterval(timer);
    }, [isActive, activeHostId, fetchJobs]);

    // Trigger run now
    const handleRunNow = async (job: CronJobSummary) => {
      if (!activeHostId) return;
      if (!isConnected) {
        showToast(t('cron.nodeOffline', '目标节点已断开连接或离线'), 'error');
        return;
      }

      setRunningJobIds((prev) => new Set(prev).add(job.id));
      try {
        const res = await apiFetch(
          `/api/terminal/cron/${encodeURIComponent(activeHostId)}/${encodeURIComponent(job.id)}/run`,
          {
            method: 'POST',
            headers: getHeaders(),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }

        showToast(t('cron.runSuccess', '已成功触发执行'), 'success');
        // Quick refresh after 1.5s to get latest status
        setTimeout(() => fetchJobs(true), 1500);
      } catch (err: any) {
        showToast(err.message || '触发失败', 'error');
      } finally {
        setRunningJobIds((prev) => {
          const next = new Set(prev);
          next.delete(job.id);
          return next;
        });
      }
    };

    // Toggle Pause / Resume
    const handleToggleStatus = async (job: CronJobSummary) => {
      if (!activeHostId) return;
      const nextStatus = job.status === 'active' ? 'paused' : 'active';

      try {
        const res = await apiFetch(
          `/api/terminal/cron/${encodeURIComponent(activeHostId)}/${encodeURIComponent(job.id)}`,
          {
            method: 'PATCH',
            headers: getHeaders(),
            body: JSON.stringify({ status: nextStatus }),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }

        showToast(
          nextStatus === 'active'
            ? (isZh ? '任务已恢复' : 'Job resumed')
            : (isZh ? '任务已暂停' : 'Job paused'),
          'info'
        );
        fetchJobs(true);
      } catch (err: any) {
        showToast(err.message || '更新状态失败', 'error');
      }
    };

    // Delete Job
    const handleDeleteJob = async (jobId: string) => {
      if (!activeHostId) return;

      try {
        const res = await apiFetch(
          `/api/terminal/cron/${encodeURIComponent(activeHostId)}/${encodeURIComponent(jobId)}`,
          {
            method: 'DELETE',
            headers: getHeaders(),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }

        showToast(isZh ? '任务已删除' : 'Job deleted', 'success');
        setDeleteConfirmJobId(null);
        fetchJobs(true);
      } catch (err: any) {
        showToast(err.message || '删除失败', 'error');
      }
    };

    // Save Job (Create or Edit)
    const handleSaveJob = async (formData: Partial<CronJobConfig>) => {
      if (!activeHostId) return;

      if (editingJob) {
        const res = await apiFetch(
          `/api/terminal/cron/${encodeURIComponent(activeHostId)}/${encodeURIComponent(editingJob.id)}`,
          {
            method: 'PATCH',
            headers: getHeaders(),
            body: JSON.stringify(formData),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        showToast(isZh ? '任务修改已保存' : 'Job updated successfully', 'success');
      } else {
        const res = await apiFetch(
          `/api/terminal/cron/${encodeURIComponent(activeHostId)}`,
          {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(formData),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        showToast(isZh ? '新任务创建成功' : 'Job created successfully', 'success');
      }

      fetchJobs(true);
    };

    // Format helper for next run countdown
    const formatNextRun = (nextRunTime: number | null): string => {
      if (!nextRunTime) return '-';
      const diff = nextRunTime - Date.now();
      if (diff <= 0) return isZh ? '即将触发' : 'Due soon';
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return isZh ? `${sec} 秒后` : `in ${sec}s`;
      const min = Math.floor(sec / 60);
      if (min < 60) return isZh ? `${min} 分钟后` : `in ${min}m`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return isZh ? `${hr} 小时后` : `in ${hr}h`;
      const days = Math.floor(hr / 24);
      return isZh ? `${days} 天后` : `in ${days}d`;
    };

    const formatDuration = (ms?: number) => {
      if (ms === undefined || ms === null) return '-';
      if (ms < 1000) return `${ms}ms`;
      return `${(ms / 1000).toFixed(1)}s`;
    };

    // Filter jobs by search query
    const filteredJobs = jobs.filter((j) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        j.name.toLowerCase().includes(q) ||
        j.cron.toLowerCase().includes(q) ||
        (j.command && j.command.toLowerCase().includes(q)) ||
        (j.scriptName && j.scriptName.toLowerCase().includes(q))
      );
    });

    const isSwrRefreshing = isLoading && jobs.length > 0;

    return (
      <div className="flex-1 flex flex-col h-full min-h-0 bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-hidden relative">
        {/* Top Toolbar */}
        <div className="px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2">
              <Clock className="w-5 h-5 text-[var(--accent-text)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] tracking-wide">
                {t('cron.title', '定时任务')}
              </h2>
            </div>
            {activeHostId && (
              <div className="hidden sm:flex items-center space-x-2 px-2.5 py-0.5 rounded-md bg-[var(--bg-surface-sub)] border border-[var(--border-subtle)] text-xs">
                <span className="text-[var(--text-secondary)] font-mono text-[11px]">{activeHostId}</span>
                <span className="text-[var(--text-muted)]">•</span>
                <span className="text-[var(--accent-text)] font-mono tabular-nums text-[11px]">
                  {jobs.length} {isZh ? '个任务' : 'jobs'}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center space-x-2">
            {/* Search Input */}
            {jobs.length > 0 && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={isZh ? '过滤任务...' : 'Filter jobs...'}
                  className="ui-input pl-8 pr-3 py-1.5 w-24 focus:w-36 sm:w-48 transition-all"
                />
              </div>
            )}

            {/* Refresh Button */}
            <button
              type="button"
              onClick={() => fetchJobs(false)}
              disabled={isLoading || !activeHostId}
              className="ui-icon-btn disabled:opacity-40"
              title={t('cron.refresh', '刷新')}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-[var(--accent-primary)]' : ''}`} />
            </button>

            {/* Add Job Button */}
            <button
              type="button"
              onClick={() => {
                setEditingJob(null);
                setIsJobModalOpen(true);
              }}
              disabled={!activeHostId || !isConnected}
              className="ui-btn-primary px-3 py-1.5 flex items-center space-x-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('cron.addJob', '新建任务')}</span>
            </button>
          </div>
        </div>

        {/* SWR Top Indeterminate Progress Bar */}
        {isSwrRefreshing && (
          <div className="h-0.5 w-full bg-[var(--accent-soft-bg)] overflow-hidden shrink-0">
            <div className="h-full w-1/3 bg-[var(--accent-primary)] animate-pulse" />
          </div>
        )}

        {/* Offline Warning Banner */}
        {activeHostId && !isConnected && (
          <div className="px-4 py-2 bg-[var(--status-danger-bg)] border-b border-[var(--status-danger-border)] text-[var(--status-danger-text)] text-xs flex items-center justify-between shrink-0">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{t('cron.nodeOffline', '目标节点已断开连接或离线')}</span>
            </div>
            <span className="text-[11px] opacity-80">
              {isZh ? '调度仍由 Agent 本地自主执行，恢复连接后自动同步' : 'Scheduled jobs execute autonomously on Agent'}
            </span>
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5 flex flex-col">
          {/* No Node Selected State */}
          {!activeHostId ? (
            <div className="ui-ambient-stage flex-1 flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto w-full rounded-xl">
              <div className="relative z-10 flex flex-col items-center">
                <div className="p-4 rounded-xl bg-[var(--accent-soft-bg)] border border-[var(--accent-soft-border)] text-[var(--accent-text)] mb-4 dark:shadow-[0_0_24px_rgba(59,130,246,0.18)]">
                  <Server className="w-10 h-10 opacity-85" />
                </div>
                <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">
                  {t('cron.noNode', '请先选择需要管理定时任务的节点')}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mb-6 leading-relaxed">
                  {isZh
                    ? '定时任务由目标主机节点上的 Agent 守护进程就地执行与管理。请在顶部节点选择栏中指定节点。'
                    : 'Cron jobs are executed locally by the agent daemon. Please select a host from the top dropdown.'}
                </p>
                {onRequestAddNode && (
                  <button
                    type="button"
                    onClick={onRequestAddNode}
                    className="ui-btn-primary px-4 py-2 cursor-pointer"
                  >
                    {isZh ? '接入新节点' : 'Connect New Node'}
                  </button>
                )}
              </div>
            </div>
          ) : isLoading && jobs.length === 0 ? (
            /* Loading State */
            <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-secondary)] space-y-3">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--accent-primary)]" />
              <span className="text-xs">{isZh ? '加载定时任务中...' : 'Loading cron jobs...'}</span>
            </div>
          ) : jobs.length === 0 ? (
            /* Empty Jobs State */
            <div className="ui-ambient-stage flex-1 flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto w-full rounded-xl">
              <div className="relative z-10 flex flex-col items-center">
                <div className="p-4 rounded-xl bg-[var(--accent-soft-bg)] border border-[var(--accent-soft-border)] text-[var(--accent-text)] mb-4 dark:shadow-[0_0_24px_rgba(59,130,246,0.18)]">
                  <Clock className="w-10 h-10" />
                </div>
                <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">
                  {t('cron.emptyTitle', '暂无定时任务')}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mb-6 leading-relaxed">
                  {t('cron.emptyDesc', '当前节点尚未配置任何定时任务，点击下方按钮开始创建。')}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setEditingJob(null);
                    setIsJobModalOpen(true);
                  }}
                  disabled={!isConnected}
                  className="ui-btn-primary px-4 py-2 flex items-center space-x-2 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>{t('cron.addJob', '新建任务')}</span>
                </button>
              </div>
            </div>
          ) : (
            /* Job List Table / Cards */
            <div className={`space-y-3 transition-opacity ${isSwrRefreshing ? 'opacity-70' : ''}`}>
              {filteredJobs.length === 0 ? (
                <div className="ui-card p-8 text-center text-[var(--text-secondary)] text-xs">
                  {isZh ? '未找到匹配的任务' : 'No matching jobs found'}
                </div>
              ) : (
                <>
                  {/* Mobile Card List (< sm) */}
                  <div className="sm:hidden space-y-3 pb-4">
                    {filteredJobs.map((job) => {
                      const isRunning = runningJobIds.has(job.id);
                      const isPaused = job.status === 'paused';
                      const lastExec = job.lastExecution;

                      return (
                        <div
                          key={job.id}
                          className="ui-card-interactive p-3.5 space-y-3"
                        >
                          {/* Card Header: breathing dot + name + status badge */}
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center space-x-2 min-w-0">
                              <div
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  isRunning
                                    ? 'bg-[var(--accent-primary)] animate-ping'
                                    : isPaused
                                    ? 'bg-zinc-400 dark:bg-zinc-500'
                                    : 'bg-emerald-400 dark:shadow-[0_0_8px_rgba(52,211,153,0.65)]'
                                }`}
                              />
                              <span className="font-semibold text-[var(--text-primary)] text-sm truncate">
                                {job.name}
                              </span>
                            </div>

                            <div className="shrink-0">
                              {isPaused ? (
                                <span className="ui-badge-neutral text-[10px] px-1.5 py-0.5">
                                  {t('cron.statusPaused', '已暂停')}
                                </span>
                              ) : !lastExec ? (
                                <span className="ui-badge-neutral text-[10px] px-1.5 py-0.5">
                                  {t('cron.statusActive', '运行中')}
                                </span>
                              ) : lastExec.status === 'completed' ? (
                                <span className="ui-badge-success inline-flex items-center space-x-1 px-1.5 py-0.5 text-[10px] font-medium">
                                  <CheckCircle2 className="w-2.5 h-2.5" />
                                  <span>{t('cron.statusCompleted', '成功')}</span>
                                </span>
                              ) : lastExec.status === 'failed' ? (
                                <span className="ui-badge-danger inline-flex items-center space-x-1 px-1.5 py-0.5 text-[10px] font-medium">
                                  <XCircle className="w-2.5 h-2.5" />
                                  <span>{t('cron.statusFailed', '失败')}</span>
                                </span>
                              ) : lastExec.status === 'skipped' ? (
                                <span className="ui-badge-warning inline-flex items-center space-x-1 px-1.5 py-0.5 text-[10px] font-medium">
                                  <AlertTriangle className="w-2.5 h-2.5" />
                                  <span>{t('cron.statusSkipped', '跳过')}</span>
                                </span>
                              ) : lastExec.status === 'running' ? (
                                <span className="ui-badge-info inline-flex items-center space-x-1 px-1.5 py-0.5 text-[10px] font-medium">
                                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                  <span>{t('cron.statusRunning', '运行中')}</span>
                                </span>
                              ) : (
                                <span className="text-[var(--text-secondary)] text-[10px]">{lastExec.status}</span>
                              )}
                            </div>
                          </div>

                          {/* Card Source / Command */}
                          <div className="text-xs text-[var(--text-secondary)] font-mono bg-[var(--code-bg)] rounded-lg px-2.5 py-2 border border-[var(--border-subtle)]">
                            {job.source === 'hub' ? (
                              <div className="flex items-center space-x-1.5 text-[var(--accent-text)]">
                                <FileCode className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">hub:{job.scriptName}</span>
                              </div>
                            ) : (
                              <div className="flex items-center space-x-1.5 text-[var(--text-secondary)]">
                                <Terminal className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                                <span className="truncate">{job.command}</span>
                              </div>
                            )}
                          </div>

                          {/* Card Meta: Cron + Next Run + Duration */}
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="flex flex-col space-y-0.5">
                              <span className="text-[10px] text-[var(--text-muted)]">{t('cron.modal.cronLabel', 'Cron 表达式')}</span>
                              <span className="font-mono tabular-nums text-[var(--accent-text)] bg-[var(--bg-surface-sub)] px-1.5 py-0.5 rounded-md border border-[var(--border-subtle)] text-[11px] inline-block w-fit">
                                {job.cron}
                              </span>
                            </div>

                            <div className="flex flex-col space-y-0.5">
                              <span className="text-[10px] text-[var(--text-muted)]">{t('cron.nextRun', '下次运行')}</span>
                              <span className={`font-mono tabular-nums text-[11px] truncate ${isPaused ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                                {isPaused ? (isZh ? '已挂起' : 'Paused') : formatNextRun(job.nextRunTime)}
                              </span>
                            </div>

                            {lastExec?.durationMs !== undefined && (
                              <div className="flex flex-col space-y-0.5 col-span-2">
                                <span className="text-[10px] text-[var(--text-muted)]">{t('cron.duration', '耗时')}</span>
                                <span className="font-mono tabular-nums text-[var(--text-secondary)] text-[11px]">
                                  {formatDuration(lastExec.durationMs)}
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Card Actions: min-h-[36px] touch targets */}
                          <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-1">
                            <div className="flex items-center space-x-1.5">
                              {/* Run Now */}
                              <button
                                type="button"
                                onClick={() => handleRunNow(job)}
                                disabled={isRunning || !isConnected}
                                className="ui-icon-btn min-h-[36px] min-w-[36px] p-2 hover:bg-[var(--status-success-bg)] hover:text-[var(--status-success-text)] hover:border-[var(--status-success-border)] flex items-center justify-center disabled:opacity-40"
                                title={t('cron.runNow', '立即运行')}
                              >
                                {isRunning ? (
                                  <Loader2 className="w-4 h-4 animate-spin text-[var(--status-success-text)]" />
                                ) : (
                                  <Play className="w-4 h-4" />
                                )}
                              </button>

                              {/* Pause / Resume */}
                              <button
                                type="button"
                                onClick={() => handleToggleStatus(job)}
                                className={`min-h-[36px] min-w-[36px] p-2 rounded-lg border flex items-center justify-center transition-all ${
                                  isPaused
                                    ? 'bg-[var(--status-warning-bg)] text-[var(--status-warning-text)] border-[var(--status-warning-border)]'
                                    : 'bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]'
                                }`}
                                title={isPaused ? t('cron.resume', '恢复') : t('cron.pause', '暂停')}
                              >
                                {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                              </button>

                              {/* View Logs */}
                              <button
                                type="button"
                                onClick={() => setSelectedJobForLogs(job)}
                                className="ui-icon-btn min-h-[36px] min-w-[36px] p-2 hover:bg-[var(--accent-soft-bg)] hover:text-[var(--accent-text)] hover:border-[var(--accent-soft-border)] flex items-center justify-center"
                                title={t('cron.logs', '查看日志')}
                              >
                                <FileText className="w-4 h-4" />
                              </button>

                              {/* Edit Job */}
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingJob(job);
                                  setIsJobModalOpen(true);
                                }}
                                className="ui-icon-btn min-h-[36px] min-w-[36px] p-2 flex items-center justify-center"
                                title={t('cron.editJob', '编辑任务')}
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                            </div>

                            {/* Delete Job */}
                            <div>
                              {deleteConfirmJobId === job.id ? (
                                <div className="flex items-center space-x-1.5">
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteJob(job.id)}
                                    className="min-h-[36px] px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium transition-all"
                                  >
                                    {isZh ? '确认删除' : 'Confirm'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setDeleteConfirmJobId(null)}
                                    className="ui-icon-btn min-h-[36px] min-w-[36px] p-2 flex items-center justify-center"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setDeleteConfirmJobId(job.id)}
                                  className="ui-icon-btn min-h-[36px] min-w-[36px] p-2 hover:bg-[var(--status-danger-bg)] hover:text-[var(--status-danger-text)] hover:border-[var(--status-danger-border)] flex items-center justify-center"
                                  title={t('cron.deleteJob', '删除任务')}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Desktop Table (hidden sm:block) */}
                  <div className="hidden sm:block overflow-x-auto ui-card overflow-hidden">
                    <table className="w-full text-left text-xs text-[var(--text-secondary)]">
                      <thead className="bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)] text-[var(--text-secondary)] font-medium text-[11px] uppercase tracking-wider">
                        <tr>
                          <th className="py-3 px-4">{isZh ? '任务' : 'Job'}</th>
                          <th className="py-3 px-4">{t('cron.modal.cronLabel', 'Cron 表达式')}</th>
                          <th className="py-3 px-4">{t('cron.nextRun', '下次运行')}</th>
                          <th className="py-3 px-4">{t('cron.lastStatus', '最近状态')}</th>
                          <th className="py-3 px-4">{t('cron.duration', '耗时')}</th>
                          <th className="py-3 px-4 text-right">{isZh ? '操作' : 'Actions'}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border-subtle)]">
                        {filteredJobs.map((job) => {
                          const isRunning = runningJobIds.has(job.id);
                          const isPaused = job.status === 'paused';
                          const lastExec = job.lastExecution;

                          return (
                            <tr
                              key={job.id}
                              className="hover:bg-[var(--bg-surface-hover)] transition-colors group"
                            >
                              {/* Job Name & Source Details */}
                              <td className="py-3.5 px-4 align-top">
                                <div className="flex items-start space-x-2.5">
                                  <div
                                    className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                                      isRunning
                                        ? 'bg-[var(--accent-primary)] animate-ping'
                                        : isPaused
                                        ? 'bg-zinc-400 dark:bg-zinc-500'
                                        : 'bg-emerald-400 dark:shadow-[0_0_8px_rgba(52,211,153,0.65)]'
                                    }`}
                                    title={
                                      isPaused
                                        ? t('cron.statusPaused', '已暂停')
                                        : isRunning
                                        ? t('cron.statusRunning', '运行中')
                                        : t('cron.statusActive', '运行中')
                                    }
                                  />
                                  <div className="space-y-1">
                                    <div className="flex items-center space-x-2">
                                      <span className="font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent-text)] transition-colors">
                                        {job.name}
                                      </span>
                                      {isPaused && (
                                        <span className="ui-badge-neutral text-[10px] px-1.5 py-0.2">
                                          {t('cron.statusPaused', '已暂停')}
                                        </span>
                                      )}
                                    </div>

                                    <div className="flex items-center space-x-2 text-[11px] text-[var(--text-secondary)]">
                                      {job.source === 'hub' ? (
                                        <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-md bg-[var(--accent-soft-bg)] text-[var(--accent-text)] border border-[var(--accent-soft-border)] font-mono">
                                          <FileCode className="w-3 h-3" />
                                          <span>hub:{job.scriptName}</span>
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center space-x-1 text-[var(--text-secondary)] font-mono truncate max-w-xs">
                                          <Terminal className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                                          <span className="truncate">{job.command}</span>
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </td>

                              {/* Cron Expression */}
                              <td className="py-3.5 px-4 align-top">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-mono tabular-nums text-xs px-2 py-0.5 rounded-md bg-[var(--bg-surface-sub)] text-[var(--accent-text)] border border-[var(--border-subtle)]">
                                    {job.cron}
                                  </span>
                                </div>
                              </td>

                              {/* Next Run Countdown */}
                              <td className="py-3.5 px-4 align-top">
                                <span
                                  className={`font-mono tabular-nums text-xs ${
                                    isPaused ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'
                                  }`}
                                >
                                  {isPaused ? (isZh ? '已挂起' : 'Paused') : formatNextRun(job.nextRunTime)}
                                </span>
                              </td>

                              {/* Last Execution Status */}
                              <td className="py-3.5 px-4 align-top">
                                {!lastExec ? (
                                  <span className="text-[var(--text-muted)] text-[11px]">-</span>
                                ) : lastExec.status === 'completed' ? (
                                  <span className="ui-badge-success inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                                    <CheckCircle2 className="w-3 h-3" />
                                    <span>{t('cron.statusCompleted', '成功')}</span>
                                  </span>
                                ) : lastExec.status === 'failed' ? (
                                  <span className="ui-badge-danger inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                                    <XCircle className="w-3 h-3" />
                                    <span>{t('cron.statusFailed', '失败')}</span>
                                  </span>
                                ) : lastExec.status === 'skipped' ? (
                                  <span className="ui-badge-warning inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                                    <AlertTriangle className="w-3 h-3" />
                                    <span>{t('cron.statusSkipped', '跳过')}</span>
                                  </span>
                                ) : lastExec.status === 'running' ? (
                                  <span className="ui-badge-info inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    <span>{t('cron.statusRunning', '运行中')}</span>
                                  </span>
                                ) : (
                                  <span className="text-[var(--text-secondary)] text-[11px]">{lastExec.status}</span>
                                )}
                              </td>

                              {/* Duration */}
                              <td className="py-3.5 px-4 align-top">
                                <span className="font-mono tabular-nums text-[var(--text-secondary)] text-xs">
                                  {formatDuration(lastExec?.durationMs)}
                                </span>
                              </td>

                              {/* Action Buttons */}
                              <td className="py-3.5 px-4 align-top text-right">
                                <div className="flex items-center justify-end space-x-1">
                                  {/* Run Now */}
                                  <button
                                    type="button"
                                    onClick={() => handleRunNow(job)}
                                    disabled={isRunning || !isConnected}
                                    className="ui-icon-btn hover:bg-[var(--status-success-bg)] hover:text-[var(--status-success-text)] hover:border-[var(--status-success-border)] disabled:opacity-40"
                                    title={t('cron.runNow', '立即运行')}
                                  >
                                    {isRunning ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--status-success-text)]" />
                                    ) : (
                                      <Play className="w-3.5 h-3.5" />
                                    )}
                                  </button>

                                  {/* Pause / Resume */}
                                  <button
                                    type="button"
                                    onClick={() => handleToggleStatus(job)}
                                    className={`p-1.5 rounded-lg border transition-all ${
                                      isPaused
                                        ? 'bg-[var(--status-warning-bg)] text-[var(--status-warning-text)] border-[var(--status-warning-border)] hover:opacity-90'
                                        : 'bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]'
                                    }`}
                                    title={isPaused ? t('cron.resume', '恢复') : t('cron.pause', '暂停')}
                                  >
                                    {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                                  </button>

                                  {/* View Logs */}
                                  <button
                                    type="button"
                                    onClick={() => setSelectedJobForLogs(job)}
                                    className="ui-icon-btn hover:bg-[var(--accent-soft-bg)] hover:text-[var(--accent-text)] hover:border-[var(--accent-soft-border)]"
                                    title={t('cron.logs', '查看日志')}
                                  >
                                    <FileText className="w-3.5 h-3.5" />
                                  </button>

                                  {/* Edit Job */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingJob(job);
                                      setIsJobModalOpen(true);
                                    }}
                                    className="ui-icon-btn"
                                    title={t('cron.editJob', '编辑任务')}
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>

                                  {/* Delete Job */}
                                  {deleteConfirmJobId === job.id ? (
                                    <div className="flex items-center space-x-1">
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteJob(job.id)}
                                        className="px-2 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-medium transition-all"
                                      >
                                        {isZh ? '确认删除' : 'Confirm'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setDeleteConfirmJobId(null)}
                                        className="ui-icon-btn p-1"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setDeleteConfirmJobId(job.id)}
                                      className="ui-icon-btn hover:bg-[var(--status-danger-bg)] hover:text-[var(--status-danger-text)] hover:border-[var(--status-danger-border)]"
                                      title={t('cron.deleteJob', '删除任务')}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Create / Edit Modal */}
        <CronJobModal
          isOpen={isJobModalOpen}
          onClose={() => {
            setIsJobModalOpen(false);
            setEditingJob(null);
          }}
          onSave={handleSaveJob}
          initialData={editingJob}
          adminKey={adminKey}
          activeHostId={activeHostId}
        />

        {/* Execution Logs Modal */}
        <CronLogModal
          isOpen={Boolean(selectedJobForLogs)}
          onClose={() => setSelectedJobForLogs(null)}
          job={selectedJobForLogs}
          activeHostId={activeHostId}
          adminKey={adminKey}
        />

        {/* Floating Toast Notifications */}
        <div className="fixed top-4 right-4 z-50 flex flex-col space-y-2 pointer-events-none">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`ui-elevated-glass pointer-events-auto flex items-center space-x-2.5 px-4 py-2.5 rounded-xl border shadow-[var(--shadow-popover)] text-xs ${
                toast.type === 'error'
                  ? 'border-[var(--status-danger-border)] text-[var(--status-danger-text)]'
                  : toast.type === 'success'
                  ? 'border-[var(--status-success-border)] text-[var(--status-success-text)]'
                  : 'border-[var(--border-default)] text-[var(--text-primary)]'
              }`}
            >
              {toast.type === 'error' && <AlertCircle className="w-4 h-4 shrink-0" />}
              {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 shrink-0" />}
              {toast.type === 'info' && <Info className="w-4 h-4 text-[var(--accent-text)] shrink-0" />}
              <span>{toast.message}</span>
              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                className="p-1 rounded hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all ml-1"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }
);

TerminalCronView.displayName = 'TerminalCronView';
export default TerminalCronView;
