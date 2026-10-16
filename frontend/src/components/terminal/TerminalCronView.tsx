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
import { apiFetch } from '../../utils/apiClient';
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
      const key = adminKey || (typeof window !== 'undefined' ? localStorage.getItem('gt_admin_key') || localStorage.getItem('admin_secret_key') : '');
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

    return (
      <div className="flex-1 flex flex-col h-full bg-[#121316] text-slate-200 overflow-hidden relative">
        {/* Top Toolbar */}
        <div className="px-4 py-3 border-b border-white/[0.08] bg-black/20 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2">
              <Clock className="w-5 h-5 text-indigo-400" />
              <h2 className="text-sm font-semibold text-white tracking-wide">
                {t('cron.title', '定时任务')}
              </h2>
            </div>
            {activeHostId && (
              <div className="hidden sm:flex items-center space-x-2 px-2.5 py-0.5 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs">
                <span className="text-slate-400 font-mono text-[11px]">{activeHostId}</span>
                <span className="text-slate-500">•</span>
                <span className="text-indigo-300 font-mono text-[11px]">
                  {jobs.length} {isZh ? '个任务' : 'jobs'}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center space-x-2">
            {/* Search Input */}
            {jobs.length > 0 && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={isZh ? '过滤任务...' : 'Filter jobs...'}
                  className="pl-8 pr-3 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-hidden focus:border-indigo-500 w-32 sm:w-48 transition-all"
                />
              </div>
            )}

            {/* Refresh Button */}
            <button
              type="button"
              onClick={() => fetchJobs(false)}
              disabled={isLoading || !activeHostId}
              className="p-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all disabled:opacity-40"
              title={t('cron.refresh', '刷新')}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-indigo-400' : ''}`} />
            </button>

            {/* Add Job Button */}
            <button
              type="button"
              onClick={() => {
                setEditingJob(null);
                setIsJobModalOpen(true);
              }}
              disabled={!activeHostId || !isConnected}
              className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all flex items-center space-x-1.5 shadow-md shadow-indigo-600/20 disabled:opacity-50 disabled:pointer-events-none"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('cron.addJob', '新建任务')}</span>
            </button>
          </div>
        </div>

        {/* Offline Warning Banner */}
        {activeHostId && !isConnected && (
          <div className="px-4 py-2 bg-rose-500/10 border-b border-rose-500/20 text-rose-300 text-xs flex items-center justify-between shrink-0">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{t('cron.nodeOffline', '目标节点已断开连接或离线')}</span>
            </div>
            <span className="text-[11px] opacity-75">
              {isZh ? '调度仍由 Agent 本地自主执行，恢复连接后自动同步' : 'Scheduled jobs execute autonomously on Agent'}
            </span>
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {/* No Node Selected State */}
          {!activeHostId ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto">
              <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/[0.06] text-slate-400 mb-4">
                <Server className="w-10 h-10 opacity-60" />
              </div>
              <h3 className="text-base font-semibold text-white mb-1">
                {t('cron.noNode', '请先选择需要管理定时任务的节点')}
              </h3>
              <p className="text-xs text-slate-400 mb-6 leading-relaxed">
                {isZh
                  ? '定时任务由目标主机节点上的 Agent 守护进程就地执行与管理。请在顶部节点选择栏中指定节点。'
                  : 'Cron jobs are executed locally by the agent daemon. Please select a host from the top dropdown.'}
              </p>
              {onRequestAddNode && (
                <button
                  type="button"
                  onClick={onRequestAddNode}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all shadow-md shadow-indigo-600/20"
                >
                  {isZh ? '接入新节点' : 'Connect New Node'}
                </button>
              )}
            </div>
          ) : isLoading && jobs.length === 0 ? (
            /* Loading State */
            <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-3">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
              <span className="text-xs">{isZh ? '加载定时任务中...' : 'Loading cron jobs...'}</span>
            </div>
          ) : jobs.length === 0 ? (
            /* Empty Jobs State */
            <div className="h-full flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto">
              <div className="p-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 mb-4">
                <Clock className="w-10 h-10" />
              </div>
              <h3 className="text-base font-semibold text-white mb-1">
                {t('cron.emptyTitle', '暂无定时任务')}
              </h3>
              <p className="text-xs text-slate-400 mb-6 leading-relaxed">
                {t('cron.emptyDesc', '当前节点尚未配置任何定时任务，点击下方按钮开始创建。')}
              </p>
              <button
                type="button"
                onClick={() => {
                  setEditingJob(null);
                  setIsJobModalOpen(true);
                }}
                disabled={!isConnected}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all shadow-md shadow-indigo-600/20 flex items-center space-x-2 disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                <span>{t('cron.addJob', '新建任务')}</span>
              </button>
            </div>
          ) : (
            /* Job List Table / Cards */
            <div className="space-y-3">
              {filteredJobs.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs bg-white/[0.02] border border-white/[0.06] rounded-2xl">
                  {isZh ? '未找到匹配的任务' : 'No matching jobs found'}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-black/20">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-white/[0.02] border-b border-white/[0.06] text-slate-400 font-medium text-[11px] uppercase tracking-wider">
                      <tr>
                        <th className="py-3 px-4">{isZh ? '任务' : 'Job'}</th>
                        <th className="py-3 px-4">{t('cron.modal.cronLabel', 'Cron 表达式')}</th>
                        <th className="py-3 px-4">{t('cron.nextRun', '下次运行')}</th>
                        <th className="py-3 px-4">{t('cron.lastStatus', '最近状态')}</th>
                        <th className="py-3 px-4">{t('cron.duration', '耗时')}</th>
                        <th className="py-3 px-4 text-right">{isZh ? '操作' : 'Actions'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {filteredJobs.map((job) => {
                        const isRunning = runningJobIds.has(job.id);
                        const isPaused = job.status === 'paused';
                        const lastExec = job.lastExecution;

                        return (
                          <tr
                            key={job.id}
                            className="hover:bg-white/[0.02] transition-colors group"
                          >
                            {/* Job Name & Source Details */}
                            <td className="py-3.5 px-4 align-top">
                              <div className="flex items-start space-x-2.5">
                                <div
                                  className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                                    isRunning
                                      ? 'bg-indigo-400 animate-ping'
                                      : isPaused
                                      ? 'bg-slate-500'
                                      : 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]'
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
                                    <span className="font-semibold text-white group-hover:text-indigo-300 transition-colors">
                                      {job.name}
                                    </span>
                                    {isPaused && (
                                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 border border-slate-700">
                                        {t('cron.statusPaused', '已暂停')}
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex items-center space-x-2 text-[11px] text-slate-400">
                                    {job.source === 'hub' ? (
                                      <span className="inline-flex items-center space-x-1 text-indigo-300 font-mono">
                                        <FileCode className="w-3 h-3 text-indigo-400" />
                                        <span>hub:{job.scriptName}</span>
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center space-x-1 text-slate-400 font-mono truncate max-w-xs">
                                        <Terminal className="w-3 h-3 text-slate-500 shrink-0" />
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
                                <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-black/40 text-indigo-300 border border-white/[0.04]">
                                  {job.cron}
                                </span>
                              </div>
                            </td>

                            {/* Next Run Countdown */}
                            <td className="py-3.5 px-4 align-top">
                              <span
                                className={`text-xs ${
                                  isPaused ? 'text-slate-500' : 'text-slate-300'
                                }`}
                              >
                                {isPaused ? (isZh ? '已挂起' : 'Paused') : formatNextRun(job.nextRunTime)}
                              </span>
                            </td>

                            {/* Last Execution Status */}
                            <td className="py-3.5 px-4 align-top">
                              {!lastExec ? (
                                <span className="text-slate-500 text-[11px]">-</span>
                              ) : lastExec.status === 'completed' ? (
                                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                  <CheckCircle2 className="w-3 h-3" />
                                  <span>{t('cron.statusCompleted', '成功')}</span>
                                </span>
                              ) : lastExec.status === 'failed' ? (
                                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                                  <XCircle className="w-3 h-3" />
                                  <span>{t('cron.statusFailed', '失败')}</span>
                                </span>
                              ) : lastExec.status === 'skipped' ? (
                                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                  <AlertTriangle className="w-3 h-3" />
                                  <span>{t('cron.statusSkipped', '跳过')}</span>
                                </span>
                              ) : lastExec.status === 'running' ? (
                                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                  <span>{t('cron.statusRunning', '运行中')}</span>
                                </span>
                              ) : (
                                <span className="text-slate-400 text-[11px]">{lastExec.status}</span>
                              )}
                            </td>

                            {/* Duration */}
                            <td className="py-3.5 px-4 align-top">
                              <span className="font-mono text-slate-400 text-xs">
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
                                  className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-emerald-500/20 text-slate-400 hover:text-emerald-300 border border-white/[0.06] hover:border-emerald-500/30 transition-all disabled:opacity-40"
                                  title={t('cron.runNow', '立即运行')}
                                >
                                  {isRunning ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
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
                                      ? 'bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20'
                                      : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border-white/[0.06]'
                                  }`}
                                  title={isPaused ? t('cron.resume', '恢复') : t('cron.pause', '暂停')}
                                >
                                  {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                                </button>

                                {/* View Logs */}
                                <button
                                  type="button"
                                  onClick={() => setSelectedJobForLogs(job)}
                                  className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-indigo-500/20 text-slate-400 hover:text-indigo-300 border border-white/[0.06] hover:border-indigo-500/30 transition-all"
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
                                  className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
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
                                      className="p-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-slate-400 hover:text-white transition-all"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setDeleteConfirmJobId(job.id)}
                                    className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 border border-white/[0.06] hover:border-rose-500/30 transition-all"
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

        {/* Dark Terminal Execution Logs Modal */}
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
              className={`pointer-events-auto flex items-center space-x-2.5 px-4 py-2.5 rounded-xl border shadow-2xl backdrop-blur-md text-xs animate-in slide-in-from-top-2 duration-200 ${
                toast.type === 'error'
                  ? 'bg-rose-950/90 border-rose-500/30 text-rose-200'
                  : toast.type === 'success'
                  ? 'bg-emerald-950/90 border-emerald-500/30 text-emerald-200'
                  : 'bg-slate-900/90 border-white/10 text-slate-200'
              }`}
            >
              {toast.type === 'error' && <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />}
              {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
              {toast.type === 'info' && <Info className="w-4 h-4 text-indigo-400 shrink-0" />}
              <span>{toast.message}</span>
              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                className="p-1 rounded hover:bg-white/10 text-slate-400 hover:text-white transition-all ml-1"
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
