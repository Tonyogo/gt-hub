import React, { useState, useEffect, useRef, useCallback, useImperativeHandle } from 'react';
import {
  Activity,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  PlayCircle,
  CheckCircle2,
  XCircle,
  Square,
  AlertTriangle,
  Copy,
  Check,
  Server,
  Loader2,
  AlertCircle,
  X
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { apiFetch, getStoredAdminKey } from '../../utils/apiClient';
import { TaskSummary, CreateTaskInput } from './types/task';
import { TaskLogModal } from './components/TaskLogModal';
import { CreateTaskModal } from './components/CreateTaskModal';

export interface ToastMessage {
  id: string;
  message: string;
  type: 'error' | 'success' | 'info';
}

export interface TerminalTaskHandle {
  refresh: () => void;
}

export interface TerminalTaskViewProps {
  adminKey?: string;
  activeHostId?: string;
  isConnected?: boolean;
  onRequestAddNode?: () => void;
  isActive?: boolean;
}

export const TerminalTaskView = React.forwardRef<TerminalTaskHandle, TerminalTaskViewProps>(
  ({ adminKey, activeHostId, isConnected = true, onRequestAddNode, isActive = false }, ref) => {
    const { t, language } = useTranslation();
    const isZh = language === 'zh';

    const [tasks, setTasks] = useState<TaskSummary[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [searchQuery, setSearchQuery] = useState<string>('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'completed' | 'failed' | 'killed'>('all');
    const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);

    // Modal states
    const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
    const [isCreating, setIsCreating] = useState<boolean>(false);
    const [selectedTaskForLogs, setSelectedTaskForLogs] = useState<TaskSummary | null>(null);
    const [isLogModalOpen, setIsLogModalOpen] = useState<boolean>(false);

    // Toast notifications
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

    const fetchTasks = useCallback(
      async (silent = false) => {
        if (!activeHostId) {
          setTasks([]);
          return;
        }

        if (silent && !isActiveRef.current) return;

        const requestHostId = activeHostId;

        if (!silent) {
          setIsLoading(true);
        }

        try {
          const res = await apiFetch(
            `/api/terminal/exec/${encodeURIComponent(activeHostId)}?limit=100`,
            { headers: getHeaders() }
          );

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          const data = await res.json();
          if (activeHostIdRef.current !== requestHostId) {
            return;
          }

          if (data.success && Array.isArray(data.tasks)) {
            setTasks(data.tasks);
          } else {
            setTasks([]);
          }
        } catch (err: any) {
          if (activeHostIdRef.current !== requestHostId) return;
          if (!silent && isActiveRef.current) {
            showToast(err.message || '获取后台任务失败', 'error');
          }
        } finally {
          if (activeHostIdRef.current === requestHostId && !silent) {
            setIsLoading(false);
          }
        }
      },
      [activeHostId, getHeaders, showToast]
    );

    useImperativeHandle(
      ref,
      () => ({
        refresh: () => fetchTasks(false),
      }),
      [fetchTasks]
    );

    // Reset tasks and state when activeHostId changes to prevent showing stale tasks from previous host
    useEffect(() => {
      setTasks([]);
      setIsLoading(false);
      setIsCreateModalOpen(false);
      setIsCreating(false);
      setSelectedTaskForLogs(null);
      setIsLogModalOpen(false);
    }, [activeHostId]);

    // Fetch when active or activeHostId change while active
    useEffect(() => {
      if (!isActive) return;
      fetchTasks(false);
    }, [isActive, fetchTasks]);

    // Polling safety: Only poll when active and there are running tasks
    useEffect(() => {
      if (!isActive || !activeHostId) return;

      const hasRunning = tasks.some((t) => t.status === 'running');
      if (!hasRunning) return;

      const timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        fetchTasks(true);
      }, 3000);

      return () => clearInterval(timer);
    }, [isActive, activeHostId, tasks, fetchTasks]);

    // Handle Create Task submission
    const handleCreateTask = async (input: CreateTaskInput) => {
      if (!activeHostId) return;
      if (!isConnected) {
        showToast(t('tasks.nodeOffline', '目标节点已断开连接或离线'), 'error');
        return;
      }

      setIsCreating(true);
      try {
        const res = await apiFetch(`/api/terminal/exec/${encodeURIComponent(activeHostId)}`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify(input),
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        showToast(isZh ? '任务已成功提交' : 'Task started successfully', 'success');
        setIsCreateModalOpen(false);

        // Fetch tasks and open log modal for the newly created task
        await fetchTasks(true);

        const newTask: TaskSummary = {
          taskId: data.taskId,
          command: input.command,
          cwd: input.cwd,
          status: 'running',
          startTime: Date.now(),
          endTime: null,
          exitCode: null,
          signal: null,
        };
        setSelectedTaskForLogs(newTask);
        setIsLogModalOpen(true);
      } catch (err: any) {
        showToast(err.message || '创建任务失败', 'error');
      } finally {
        setIsCreating(false);
      }
    };

    // Handle kill task action
    const handleKillTask = async (taskId: string): Promise<boolean> => {
      if (!activeHostId) return false;

      try {
        const res = await apiFetch(
          `/api/terminal/exec/${encodeURIComponent(activeHostId)}/${encodeURIComponent(taskId)}/kill`,
          {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ signal: 'SIGTERM' }),
          }
        );

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        showToast(isZh ? '已发送终止信号' : 'Terminate signal sent', 'info');
        fetchTasks(true);
        return true;
      } catch (err: any) {
        showToast(err.message || '终止任务失败', 'error');
        return false;
      }
    };

    // Copy Task ID helper
    const handleCopyTaskId = async (e: React.MouseEvent, taskId: string) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(taskId);
        setCopiedTaskId(taskId);
        showToast(t('tasks.copySuccess', '已复制到剪贴板'), 'success');
        setTimeout(() => setCopiedTaskId(null), 2000);
      } catch {
        // Fallback
      }
    };

    // Format helper for duration
    const formatDuration = (start: number, end: number | null) => {
      const elapsed = (end || Date.now()) - start;
      if (elapsed < 1000) return `${elapsed}ms`;
      const sec = elapsed / 1000;
      if (sec < 60) return `${sec.toFixed(1)}s`;
      const min = Math.floor(sec / 60);
      const remSec = (sec % 60).toFixed(0);
      return `${min}m ${remSec}s`;
    };

    // Format helper for start time
    const formatTime = (ts: number) => {
      return new Date(ts).toLocaleString();
    };

    // Metrics calculation
    const totalCount = tasks.length;
    const runningCount = tasks.filter((t) => t.status === 'running').length;
    const completedCount = tasks.filter((t) => t.status === 'completed').length;
    const failedCount = tasks.filter((t) => t.status === 'failed' || t.status === 'timeout').length;

    // Filter tasks
    const filteredTasks = tasks.filter((task) => {
      if (statusFilter === 'running' && task.status !== 'running') return false;
      if (statusFilter === 'completed' && task.status !== 'completed') return false;
      if (statusFilter === 'failed' && task.status !== 'failed' && task.status !== 'timeout')
        return false;
      if (statusFilter === 'killed' && task.status !== 'killed') return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesId = task.taskId.toLowerCase().includes(q);
        const matchesCmd = task.command.toLowerCase().includes(q);
        const matchesCwd = task.cwd ? task.cwd.toLowerCase().includes(q) : false;
        return matchesId || matchesCmd || matchesCwd;
      }
      return true;
    });

    const isSwrRefreshing = isLoading && tasks.length > 0;

    return (
      <div className="flex-1 flex flex-col h-full min-h-0 bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-hidden relative">
        {/* Top Toolbar */}
        <div className="px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2">
              <Activity className="w-5 h-5 text-[var(--accent-text)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] tracking-wide">
                {t('tasks.title', '后台任务管理')}
              </h2>
            </div>
            {activeHostId && (
              <div className="hidden sm:flex items-center space-x-2 px-2.5 py-0.5 rounded-md bg-[var(--bg-surface-sub)] border border-[var(--border-subtle)] text-xs">
                <span className="text-[var(--text-secondary)] font-mono text-[11px]">{activeHostId}</span>
                <span className="text-[var(--text-muted)]">•</span>
                <span className="text-[var(--accent-text)] font-mono tabular-nums text-[11px]">
                  {totalCount} {isZh ? '个任务' : 'tasks'}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center space-x-2">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('tasks.searchPlaceholder', '搜索任务 ID 或命令...')}
                className="ui-input pl-8 pr-3 py-1.5 w-24 focus:w-36 sm:w-56 transition-all"
              />
            </div>

            {/* Refresh Button */}
            <button
              type="button"
              onClick={() => fetchTasks(false)}
              disabled={isLoading || !activeHostId}
              className="ui-icon-btn disabled:opacity-40"
              title={t('tasks.refresh', '刷新')}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-[var(--accent-primary)]' : ''}`} />
            </button>

            {/* Create Task Button */}
            <button
              type="button"
              onClick={() => setIsCreateModalOpen(true)}
              disabled={!activeHostId || !isConnected}
              className="ui-btn-primary px-3 py-1.5 flex items-center space-x-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('tasks.createTask', '新建任务')}</span>
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
              <span>{t('tasks.nodeOffline', '目标节点已断开连接或离线')}</span>
            </div>
            <span className="text-[11px] opacity-80">
              {isZh ? '当前无法创建或操作任务，等待节点重新连接' : 'Tasks cannot be modified while node is offline'}
            </span>
          </div>
        )}

        {/* Workspace Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5 flex flex-col space-y-4">
          {/* No Node Selected State */}
          {!activeHostId ? (
            <div className="ui-ambient-stage flex-1 flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto w-full rounded-xl">
              <div className="relative z-10 flex flex-col items-center">
                <div className="p-4 rounded-xl bg-[var(--accent-soft-bg)] border border-[var(--accent-soft-border)] text-[var(--accent-text)] mb-4 dark:shadow-[0_0_24px_rgba(59,130,246,0.18)]">
                  <Server className="w-10 h-10 opacity-85" />
                </div>
                <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">
                  {t('tasks.noNode', '请先选择需要管理任务的目标节点')}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mb-6 leading-relaxed">
                  {isZh
                    ? '后台任务在目标节点上独立守护运行，支持随时查看实时输出与状态跟踪。'
                    : 'Tasks run autonomously on the target host. Please select a node above.'}
                </p>
                {onRequestAddNode && (
                  <button
                    type="button"
                    onClick={onRequestAddNode}
                    className="ui-btn-primary px-4 py-2 flex items-center space-x-2 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>{t('webTerminal.hostSelector.addNode', '接入内网新节点')}</span>
                  </button>
                )}
              </div>
            </div>
          ) : isLoading && tasks.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-secondary)] space-y-3">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--accent-primary)]" />
              <span className="text-xs">{isZh ? '加载后台任务中...' : 'Loading background tasks...'}</span>
            </div>
          ) : (
            <>
              {/* 4-Column Seamless KPI Strip */}
              <div className="hidden sm:grid sm:grid-cols-4 ui-card overflow-hidden divide-y sm:divide-y-0 sm:divide-x divide-[var(--border-subtle)] shrink-0">
                {/* Total */}
                <div className="p-3.5 sm:px-4 sm:py-3.5 flex items-center justify-between">
                  <div>
                    <p className="text-[11px] text-[var(--text-secondary)]">{t('tasks.statTotal', '总任务数')}</p>
                    <p className="text-[26px] leading-tight font-semibold tracking-tight text-[var(--text-primary)] mt-1 font-mono tabular-nums">
                      {totalCount}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[var(--accent-soft-bg)] text-[var(--accent-text)] border border-[var(--accent-soft-border)]">
                    <Activity className="w-4 h-4" />
                  </div>
                </div>

                {/* Running */}
                <div className="p-3.5 sm:px-4 sm:py-3.5 flex items-center justify-between">
                  <div>
                    <p className="text-[11px] text-[var(--text-secondary)]">{t('tasks.statRunning', '运行中')}</p>
                    <div className="flex items-center space-x-2 mt-1">
                      <p className="text-[26px] leading-tight font-semibold tracking-tight text-[var(--status-warning-text)] font-mono tabular-nums">
                        {runningCount}
                      </p>
                      {runningCount > 0 && (
                        <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping dark:shadow-[0_0_8px_rgba(251,191,36,0.65)]" />
                      )}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[var(--status-warning-bg)] text-[var(--status-warning-text)] border border-[var(--status-warning-border)]">
                    <PlayCircle className="w-4 h-4" />
                  </div>
                </div>

                {/* Completed */}
                <div className="p-3.5 sm:px-4 sm:py-3.5 flex items-center justify-between">
                  <div>
                    <p className="text-[11px] text-[var(--text-secondary)]">{t('tasks.statCompleted', '已完成')}</p>
                    <p className="text-[26px] leading-tight font-semibold tracking-tight text-[var(--status-success-text)] mt-1 font-mono tabular-nums">
                      {completedCount}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[var(--status-success-bg)] text-[var(--status-success-text)] border border-[var(--status-success-border)]">
                    <CheckCircle2 className="w-4 h-4" />
                  </div>
                </div>

                {/* Failed */}
                <div className="p-3.5 sm:px-4 sm:py-3.5 flex items-center justify-between">
                  <div>
                    <p className="text-[11px] text-[var(--text-secondary)]">{t('tasks.statFailed', '失败 / 超时')}</p>
                    <p className="text-[26px] leading-tight font-semibold tracking-tight text-[var(--status-danger-text)] mt-1 font-mono tabular-nums">
                      {failedCount}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[var(--status-danger-bg)] text-[var(--status-danger-text)] border border-[var(--status-danger-border)]">
                    <XCircle className="w-4 h-4" />
                  </div>
                </div>
              </div>

              {/* Status Filter Pills */}
              <div className="flex items-center space-x-1.5 overflow-x-auto py-1 shrink-0 scrollbar-none">
                {[
                  { id: 'all', label: t('tasks.filterAll', '全部状态'), count: totalCount },
                  { id: 'running', label: t('tasks.filterRunning', '运行中'), count: runningCount },
                  { id: 'completed', label: t('tasks.filterCompleted', '已完成'), count: completedCount },
                  { id: 'failed', label: t('tasks.filterFailed', '失败'), count: failedCount },
                  {
                    id: 'killed',
                    label: t('tasks.filterKilled', '已终止'),
                    count: tasks.filter((t) => t.status === 'killed').length,
                  },
                ].map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    onClick={() => setStatusFilter(pill.id as any)}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-all flex items-center space-x-1.5 shrink-0 border ${
                      statusFilter === pill.id
                        ? 'bg-[var(--accent-soft-bg)] text-[var(--accent-text)] border-[var(--accent-soft-border)] shadow-xs'
                        : 'bg-[var(--bg-control)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)] hover:bg-[var(--bg-control-hover)]'
                    }`}
                  >
                    <span>{pill.label}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-[var(--bg-surface-sub)] font-mono tabular-nums">
                      {pill.count}
                    </span>
                  </button>
                ))}
              </div>

              {/* Tasks Table / Empty State */}
              {filteredTasks.length === 0 ? (
                <div className="ui-card ui-ambient-stage flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <div className="relative z-10 flex flex-col items-center">
                    <div className="p-3 rounded-xl bg-[var(--accent-soft-bg)] border border-[var(--accent-soft-border)] text-[var(--accent-text)] mb-3 dark:shadow-[0_0_24px_rgba(59,130,246,0.18)]">
                      <Terminal className="w-8 h-8 opacity-85" />
                    </div>
                    <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                      {t('tasks.emptyTitle', '暂无后台任务')}
                    </h4>
                    <p className="text-xs text-[var(--text-secondary)] max-w-sm mb-4 leading-relaxed">
                      {t('tasks.emptyDesc', '当前节点尚未记录任何后台执行任务。')}
                    </p>
                    {isConnected && (
                      <button
                        type="button"
                        onClick={() => setIsCreateModalOpen(true)}
                        className="ui-btn-primary px-3.5 py-1.5 flex items-center space-x-1.5 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>{t('tasks.createTask', '新建任务')}</span>
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className={`flex-1 min-h-0 flex flex-col transition-opacity ${isSwrRefreshing ? 'opacity-70' : ''}`}>
                  {/* Mobile Task Card List (< sm) */}
                  <div className="sm:hidden space-y-3 shrink-0 pb-4">
                    {filteredTasks.map((task) => {
                      const isCopied = copiedTaskId === task.taskId;
                      return (
                        <div
                          key={task.taskId}
                          onClick={() => {
                            setSelectedTaskForLogs(task);
                            setIsLogModalOpen(true);
                          }}
                          className="ui-card-interactive p-3.5 space-y-3 cursor-pointer"
                        >
                          {/* Card Header: Task ID + Copy + Status + Exit Code */}
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center space-x-1.5 min-w-0" onClick={(e) => e.stopPropagation()}>
                              <span className="font-mono text-xs text-[var(--text-secondary)] truncate max-w-[120px]">
                                {task.taskId}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => handleCopyTaskId(e, task.taskId)}
                                className="ui-icon-btn min-h-[36px] min-w-[36px] p-2 flex items-center justify-center"
                                title={t('tasks.copySuccess', '复制 ID')}
                              >
                                {isCopied ? (
                                  <Check className="w-3.5 h-3.5 text-[var(--status-success-text)]" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>

                            <div className="flex items-center space-x-1.5 shrink-0">
                              {task.status === 'completed' && (
                                <span className="ui-badge-success inline-flex items-center space-x-1 px-1.5 py-0.5 text-[10px] font-medium">
                                  <CheckCircle2 className="w-2.5 h-2.5" />
                                  <span>{t('tasks.filterCompleted', '已完成')}</span>
                                </span>
                              )}
                              {task.status === 'running' && (
                                <span className="ui-badge-warning inline-flex items-center space-x-1 px-1.5 py-0.5 text-[10px] font-medium">
                                  <PlayCircle className="w-2.5 h-2.5 animate-pulse" />
                                  <span>{t('tasks.filterRunning', '运行中')}</span>
                                </span>
                              )}
                              {task.status === 'failed' && (
                                <span className="ui-badge-danger inline-flex items-center space-x-1 px-1.5 py-0.5 text-[10px] font-medium">
                                  <XCircle className="w-2.5 h-2.5" />
                                  <span>{t('tasks.filterFailed', '失败')}</span>
                                </span>
                              )}
                              {task.status === 'timeout' && (
                                <span className="ui-badge-danger inline-flex items-center space-x-1 px-1.5 py-0.5 text-[10px] font-medium">
                                  <AlertTriangle className="w-2.5 h-2.5" />
                                  <span>超时</span>
                                </span>
                              )}
                              {task.status === 'killed' && (
                                <span className="ui-badge-neutral inline-flex items-center space-x-1 px-1.5 py-0.5 text-[10px] font-medium">
                                  <Square className="w-2.5 h-2.5" />
                                  <span>{t('tasks.filterKilled', '已终止')}</span>
                                </span>
                              )}

                              {task.exitCode !== null && task.exitCode !== undefined && (
                                <span
                                  className={`font-mono tabular-nums px-1.5 py-0.5 text-[10px] font-medium ${
                                    task.exitCode === 0 ? 'ui-badge-success' : 'ui-badge-danger'
                                  }`}
                                >
                                  {task.exitCode}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Command: monospace box */}
                          <div
                            className="font-mono text-xs text-[var(--accent-text)] truncate bg-[var(--code-bg)] px-2.5 py-2 rounded-lg border border-[var(--border-subtle)]"
                            title={task.command}
                          >
                            {task.command}
                          </div>

                          {/* Start Time & Duration */}
                          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] pt-0.5">
                            <div className="flex items-center space-x-1.5">
                              <span className="text-[10px] text-[var(--text-muted)]">{t('tasks.colStartTime', '启动时间')}:</span>
                              <span className="font-mono tabular-nums text-[11px] text-[var(--text-primary)]">{formatTime(task.startTime)}</span>
                            </div>
                            <div className="flex items-center space-x-1.5">
                              <span className="text-[10px] text-[var(--text-muted)]">{t('tasks.colDuration', '耗时')}:</span>
                              <span className="font-mono tabular-nums text-[11px] text-[var(--text-primary)]">
                                {formatDuration(task.startTime, task.endTime)}
                              </span>
                            </div>
                          </div>

                          {/* Card Actions: min-h-[36px] buttons */}
                          <div
                            className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-end space-x-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedTaskForLogs(task);
                                setIsLogModalOpen(true);
                              }}
                              className="ui-btn-secondary min-h-[36px] px-3 py-1.5"
                            >
                              {t('tasks.viewLogs', '查看日志')}
                            </button>

                            {task.status === 'running' && (
                              <button
                                type="button"
                                onClick={() => {
                                  const confirmed = window.confirm(
                                    t('tasks.killConfirm', '确定要向该任务发送终止信号吗？')
                                  );
                                  if (confirmed) {
                                    handleKillTask(task.taskId);
                                  }
                                }}
                                className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[var(--status-danger-bg)] hover:opacity-90 text-[var(--status-danger-text)] border border-[var(--status-danger-border)] text-xs font-medium transition-all flex items-center space-x-1.5"
                              >
                                <Square className="w-3.5 h-3.5" />
                                <span>{t('tasks.killTask', '终止')}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Desktop Table (hidden sm:flex) */}
                  <div className="hidden sm:flex sm:flex-col flex-1 min-h-[260px] ui-card overflow-hidden">
                    <div className="flex-1 min-h-0 overflow-auto overscroll-contain">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="sticky top-0 z-10 bg-[var(--bg-surface-sub)] shadow-[inset_0_-1px_0_var(--border-subtle)]">
                          <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface-sub)] text-[var(--text-secondary)] text-[11px] select-none font-medium">
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">{t('tasks.colTaskId', '任务 ID')}</th>
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">{t('tasks.colCommand', '执行命令')}</th>
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">{t('tasks.colStatus', '状态')}</th>
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">{t('tasks.colExitCode', '退出码')}</th>
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">{t('tasks.colDuration', '耗时')}</th>
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap hidden md:table-cell">{t('tasks.colStartTime', '启动时间')}</th>
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap text-right">{t('tasks.colActions', '操作')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--border-subtle)]">
                          {filteredTasks.map((task) => {
                            const isCopied = copiedTaskId === task.taskId;
                            return (
                              <tr
                                key={task.taskId}
                                onClick={() => {
                                  setSelectedTaskForLogs(task);
                                  setIsLogModalOpen(true);
                                }}
                                className="hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer group"
                              >
                                {/* Task ID */}
                                <td className="py-3 px-4 font-mono text-[11px] text-[var(--text-secondary)]">
                                  <div className="flex items-center space-x-1.5">
                                    <span className="truncate max-w-[120px]">{task.taskId}</span>
                                    <button
                                      type="button"
                                      onClick={(e) => handleCopyTaskId(e, task.taskId)}
                                      className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-control-hover)] transition-all"
                                      title={t('tasks.copySuccess', '复制 ID')}
                                    >
                                      {isCopied ? (
                                        <Check className="w-3 h-3 text-[var(--status-success-text)]" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                    </button>
                                  </div>
                                </td>

                                {/* Command */}
                                <td className="py-3 px-4 max-w-xs sm:max-w-md">
                                  <div
                                    className="font-mono text-[11px] text-[var(--accent-text)] truncate bg-[var(--code-bg)] px-2 py-1 rounded-md border border-[var(--border-subtle)]"
                                    title={task.command}
                                  >
                                    {task.command}
                                  </div>
                                </td>

                                {/* Status */}
                                <td className="py-3 px-4">
                                  {task.status === 'completed' && (
                                    <span className="ui-badge-success inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                                      <CheckCircle2 className="w-3 h-3" />
                                      <span>{t('tasks.filterCompleted', '已完成')}</span>
                                    </span>
                                  )}
                                  {task.status === 'running' && (
                                    <span className="ui-badge-warning inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                                      <PlayCircle className="w-3 h-3 animate-pulse" />
                                      <span>{t('tasks.filterRunning', '运行中')}</span>
                                    </span>
                                  )}
                                  {task.status === 'failed' && (
                                    <span className="ui-badge-danger inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                                      <XCircle className="w-3 h-3" />
                                      <span>{t('tasks.filterFailed', '失败')}</span>
                                    </span>
                                  )}
                                  {task.status === 'timeout' && (
                                    <span className="ui-badge-danger inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                                      <AlertTriangle className="w-3 h-3" />
                                      <span>超时</span>
                                    </span>
                                  )}
                                  {task.status === 'killed' && (
                                    <span className="ui-badge-neutral inline-flex items-center space-x-1 px-2 py-0.5 text-[11px] font-medium">
                                      <Square className="w-3 h-3" />
                                      <span>{t('tasks.filterKilled', '已终止')}</span>
                                    </span>
                                  )}
                                </td>

                                {/* Exit Code */}
                                <td className="py-3 px-4">
                                  {task.exitCode !== null && task.exitCode !== undefined ? (
                                    <span
                                      className={`font-mono tabular-nums px-2 py-0.5 text-[11px] font-medium ${
                                        task.exitCode === 0 ? 'ui-badge-success' : 'ui-badge-danger'
                                      }`}
                                    >
                                      {task.exitCode}
                                    </span>
                                  ) : (
                                    <span className="text-[var(--text-muted)] font-mono">-</span>
                                  )}
                                </td>

                                {/* Duration */}
                                <td className="py-3 px-4 font-mono tabular-nums text-[var(--text-secondary)] text-[11px]">
                                  {formatDuration(task.startTime, task.endTime)}
                                </td>

                                {/* Start Time */}
                                <td className="py-3 px-4 font-mono tabular-nums text-[var(--text-secondary)] text-[11px] hidden md:table-cell">
                                  {formatTime(task.startTime)}
                                </td>

                                {/* Actions */}
                                <td className="py-3 px-4 text-right">
                                  <div
                                    className="flex items-center justify-end space-x-1.5"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedTaskForLogs(task);
                                        setIsLogModalOpen(true);
                                      }}
                                      className="ui-btn-secondary px-2.5 py-1"
                                    >
                                      {t('tasks.viewLogs', '查看日志')}
                                    </button>

                                    {task.status === 'running' && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const confirmed = window.confirm(
                                            t('tasks.killConfirm', '确定要向该任务发送终止信号吗？')
                                          );
                                          if (confirmed) {
                                            handleKillTask(task.taskId);
                                          }
                                        }}
                                        className="px-2.5 py-1 rounded-lg bg-[var(--status-danger-bg)] hover:opacity-90 text-[var(--status-danger-text)] border border-[var(--status-danger-border)] text-xs font-medium transition-all flex items-center space-x-1"
                                      >
                                        <Square className="w-3 h-3" />
                                        <span>{t('tasks.killTask', '终止')}</span>
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
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Create Task Modal */}
        <CreateTaskModal
          isOpen={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
          onSubmit={handleCreateTask}
          isLoading={isCreating}
        />

        {/* Task Log Modal */}
        <TaskLogModal
          isOpen={isLogModalOpen}
          onClose={() => {
            setIsLogModalOpen(false);
            setSelectedTaskForLogs(null);
            fetchTasks(true);
          }}
          task={selectedTaskForLogs}
          activeHostId={activeHostId || ''}
          adminKey={adminKey}
          onKillTask={async (taskId) => {
            return await handleKillTask(taskId);
          }}
        />

        {/* Toast Container */}
        {toasts.length > 0 && (
          <div className="absolute bottom-4 right-4 z-50 flex flex-col space-y-2 pointer-events-none">
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className={`ui-elevated-glass pointer-events-auto px-4 py-2.5 rounded-xl border text-xs shadow-[var(--shadow-popover)] flex items-center space-x-2 ${
                  toast.type === 'error'
                    ? 'border-[var(--status-danger-border)] text-[var(--status-danger-text)]'
                    : toast.type === 'success'
                    ? 'border-[var(--status-success-border)] text-[var(--status-success-text)]'
                    : 'border-[var(--border-default)] text-[var(--text-primary)]'
                }`}
              >
                {toast.type === 'error' && <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
                {toast.type === 'success' && <Check className="w-3.5 h-3.5 shrink-0" />}
                <span>{toast.message}</span>
                <button
                  type="button"
                  onClick={() => removeToast(toast.id)}
                  className="ml-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
);

TerminalTaskView.displayName = 'TerminalTaskView';
export default TerminalTaskView;
