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
  Clock,
  Copy,
  Check,
  Server,
  Loader2,
  FileCode,
  AlertCircle,
  X
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { apiFetch } from '../../utils/apiClient';
import { TaskSummary, TaskStatus, CreateTaskInput } from './types/task';
import { TaskLogModal } from './components/TaskLogModal';
import { CreateTaskModal } from './components/CreateTaskModal';
import { TerminalEmptyState } from './components/TerminalEmptyState';

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
}

export const TerminalTaskView = React.forwardRef<TerminalTaskHandle, TerminalTaskViewProps>(
  ({ adminKey, activeHostId, isConnected = true, onRequestAddNode }, ref) => {
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

    const fetchTasks = useCallback(
      async (silent = false) => {
        if (!activeHostId) {
          setTasks([]);
          return;
        }

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
          if (data.success && Array.isArray(data.tasks)) {
            setTasks(data.tasks);
          } else {
            setTasks([]);
          }
        } catch (err: any) {
          if (!silent) {
            showToast(err.message || '获取后台任务失败', 'error');
          }
        } finally {
          if (!silent) {
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

    // Fetch on mount or activeHostId change
    useEffect(() => {
      fetchTasks(false);
    }, [fetchTasks]);

    // Polling safety: Only poll when there are running tasks
    useEffect(() => {
      if (!activeHostId) return;

      const hasRunning = tasks.some((t) => t.status === 'running');
      if (!hasRunning) return;

      const timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        fetchTasks(true);
      }, 3000);

      return () => clearInterval(timer);
    }, [activeHostId, tasks, fetchTasks]);

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
    const handleKillTask = async (taskId: string) => {
      if (!activeHostId) return;

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
      } catch (err: any) {
        showToast(err.message || '终止任务失败', 'error');
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

    return (
      <div className="flex-1 flex flex-col h-full bg-[#121316] text-slate-200 overflow-hidden relative">
        {/* Top Toolbar */}
        <div className="px-4 py-3 border-b border-white/[0.08] bg-black/20 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2">
              <Activity className="w-5 h-5 text-indigo-400" />
              <h2 className="text-sm font-semibold text-white tracking-wide">
                {t('tasks.title', '后台任务管理')}
              </h2>
            </div>
            {activeHostId && (
              <div className="hidden sm:flex items-center space-x-2 px-2.5 py-0.5 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs">
                <span className="text-slate-400 font-mono text-[11px]">{activeHostId}</span>
                <span className="text-slate-500">•</span>
                <span className="text-indigo-300 font-mono text-[11px]">
                  {totalCount} {isZh ? '个任务' : 'tasks'}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center space-x-2">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('tasks.searchPlaceholder', '搜索任务 ID 或命令...')}
                className="pl-8 pr-3 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-hidden focus:border-indigo-500 w-36 sm:w-56 transition-all"
              />
            </div>

            {/* Refresh Button */}
            <button
              type="button"
              onClick={() => fetchTasks(false)}
              disabled={isLoading || !activeHostId}
              className="p-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all disabled:opacity-40"
              title={t('tasks.refresh', '刷新')}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-indigo-400' : ''}`} />
            </button>

            {/* Create Task Button */}
            <button
              type="button"
              onClick={() => setIsCreateModalOpen(true)}
              disabled={!activeHostId || !isConnected}
              className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all flex items-center space-x-1.5 shadow-md shadow-indigo-600/20 disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('tasks.createTask', '新建任务')}</span>
            </button>
          </div>
        </div>

        {/* Offline Warning Banner */}
        {activeHostId && !isConnected && (
          <div className="px-4 py-2 bg-rose-500/10 border-b border-rose-500/20 text-rose-300 text-xs flex items-center justify-between shrink-0">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{t('tasks.nodeOffline', '目标节点已断开连接或离线')}</span>
            </div>
            <span className="text-[11px] opacity-75">
              {isZh ? '当前无法创建或操作任务，等待节点重新连接' : 'Tasks cannot be modified while node is offline'}
            </span>
          </div>
        )}

        {/* Workspace Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 flex flex-col space-y-4">
          {/* No Node Selected State */}
          {!activeHostId ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto">
              <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/[0.06] text-slate-400 mb-4">
                <Server className="w-10 h-10 opacity-60" />
              </div>
              <h3 className="text-base font-semibold text-white mb-1">
                {t('tasks.noNode', '请先选择需要管理任务的目标节点')}
              </h3>
              <p className="text-xs text-slate-400 mb-6 leading-relaxed">
                {isZh
                  ? '后台任务在目标节点上独立守护运行，支持随时查看实时输出与状态跟踪。'
                  : 'Tasks run autonomously on the target host. Please select a node above.'}
              </p>
              {onRequestAddNode && (
                <button
                  type="button"
                  onClick={onRequestAddNode}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all flex items-center space-x-2"
                >
                  <Plus className="w-4 h-4" />
                  <span>{t('webTerminal.hostSelector.addNode', '接入内网新节点')}</span>
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Stat Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0">
                {/* Total */}
                <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <p className="text-[11px] text-slate-400">{t('tasks.statTotal', '总任务数')}</p>
                    <p className="text-xl font-semibold text-white mt-1 font-mono">{totalCount}</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                    <Activity className="w-4 h-4" />
                  </div>
                </div>

                {/* Running */}
                <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <p className="text-[11px] text-slate-400">{t('tasks.statRunning', '运行中')}</p>
                    <div className="flex items-center space-x-1.5 mt-1">
                      <p className="text-xl font-semibold text-amber-300 font-mono">{runningCount}</p>
                      {runningCount > 0 && (
                        <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                      )}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    <PlayCircle className="w-4 h-4" />
                  </div>
                </div>

                {/* Completed */}
                <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <p className="text-[11px] text-slate-400">{t('tasks.statCompleted', '已完成')}</p>
                    <p className="text-xl font-semibold text-emerald-400 mt-1 font-mono">{completedCount}</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <CheckCircle2 className="w-4 h-4" />
                  </div>
                </div>

                {/* Failed */}
                <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <p className="text-[11px] text-slate-400">{t('tasks.statFailed', '失败 / 超时')}</p>
                    <p className="text-xl font-semibold text-rose-400 mt-1 font-mono">{failedCount}</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20">
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
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-all flex items-center space-x-1.5 shrink-0 ${
                      statusFilter === pill.id
                        ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 shadow-xs'
                        : 'bg-white/[0.03] text-slate-400 hover:text-slate-200 border border-white/[0.06]'
                    }`}
                  >
                    <span>{pill.label}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/40 font-mono">
                      {pill.count}
                    </span>
                  </button>
                ))}
              </div>

              {/* Tasks Table / Empty State */}
              {filteredTasks.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-white/[0.01] border border-white/[0.06] rounded-2xl">
                  <div className="p-3 rounded-2xl bg-white/[0.04] text-slate-400 mb-3">
                    <Terminal className="w-8 h-8 opacity-60" />
                  </div>
                  <h4 className="text-sm font-semibold text-white mb-1">
                    {t('tasks.emptyTitle', '暂无后台任务')}
                  </h4>
                  <p className="text-xs text-slate-400 max-w-sm mb-4 leading-relaxed">
                    {t('tasks.emptyDesc', '当前节点尚未记录任何后台执行任务。')}
                  </p>
                  {isConnected && (
                    <button
                      type="button"
                      onClick={() => setIsCreateModalOpen(true)}
                      className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all flex items-center space-x-1.5"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>{t('tasks.createTask', '新建任务')}</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex-1 bg-white/[0.01] border border-white/[0.06] rounded-2xl overflow-hidden flex flex-col">
                  <div className="overflow-x-auto flex-1">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-white/[0.08] bg-black/30 text-slate-400 text-[11px] select-none font-medium">
                          <th className="py-2.5 px-4 font-normal">{t('tasks.colTaskId', '任务 ID')}</th>
                          <th className="py-2.5 px-4 font-normal">{t('tasks.colCommand', '执行命令')}</th>
                          <th className="py-2.5 px-4 font-normal">{t('tasks.colStatus', '状态')}</th>
                          <th className="py-2.5 px-4 font-normal">{t('tasks.colExitCode', '退出码')}</th>
                          <th className="py-2.5 px-4 font-normal">{t('tasks.colDuration', '耗时')}</th>
                          <th className="py-2.5 px-4 font-normal hidden md:table-cell">{t('tasks.colStartTime', '启动时间')}</th>
                          <th className="py-2.5 px-4 font-normal text-right">{t('tasks.colActions', '操作')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {filteredTasks.map((task) => {
                          const isCopied = copiedTaskId === task.taskId;
                          return (
                            <tr
                              key={task.taskId}
                              onClick={() => {
                                setSelectedTaskForLogs(task);
                                setIsLogModalOpen(true);
                              }}
                              className="hover:bg-white/[0.02] transition-colors cursor-pointer group"
                            >
                              {/* Task ID */}
                              <td className="py-3 px-4 font-mono text-[11px] text-slate-300">
                                <div className="flex items-center space-x-1.5">
                                  <span className="truncate max-w-[120px]">{task.taskId}</span>
                                  <button
                                    type="button"
                                    onClick={(e) => handleCopyTaskId(e, task.taskId)}
                                    className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/[0.06] transition-all"
                                    title={t('tasks.copySuccess', '复制 ID')}
                                  >
                                    {isCopied ? (
                                      <Check className="w-3 h-3 text-emerald-400" />
                                    ) : (
                                      <Copy className="w-3 h-3" />
                                    )}
                                  </button>
                                </div>
                              </td>

                              {/* Command */}
                              <td className="py-3 px-4 max-w-xs sm:max-w-md">
                                <div
                                  className="font-mono text-[11px] text-indigo-300 truncate bg-black/25 px-2 py-1 rounded-md border border-white/[0.04]"
                                  title={task.command}
                                >
                                  {task.command}
                                </div>
                              </td>

                              {/* Status */}
                              <td className="py-3 px-4">
                                {task.status === 'completed' && (
                                  <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                    <CheckCircle2 className="w-3 h-3" />
                                    <span>{t('tasks.filterCompleted', '已完成')}</span>
                                  </span>
                                )}
                                {task.status === 'running' && (
                                  <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                    <PlayCircle className="w-3 h-3 animate-pulse" />
                                    <span>{t('tasks.filterRunning', '运行中')}</span>
                                  </span>
                                )}
                                {task.status === 'failed' && (
                                  <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                                    <XCircle className="w-3 h-3" />
                                    <span>{t('tasks.filterFailed', '失败')}</span>
                                  </span>
                                )}
                                {task.status === 'timeout' && (
                                  <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                                    <AlertTriangle className="w-3 h-3" />
                                    <span>超时</span>
                                  </span>
                                )}
                                {task.status === 'killed' && (
                                  <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-800 text-slate-400 border border-white/10">
                                    <Square className="w-3 h-3" />
                                    <span>{t('tasks.filterKilled', '已终止')}</span>
                                  </span>
                                )}
                              </td>

                              {/* Exit Code */}
                              <td className="py-3 px-4">
                                {task.exitCode !== null && task.exitCode !== undefined ? (
                                  <span
                                    className={`font-mono px-2 py-0.5 rounded-md text-[11px] font-medium border ${
                                      task.exitCode === 0
                                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                        : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                                    }`}
                                  >
                                    {task.exitCode}
                                  </span>
                                ) : (
                                  <span className="text-slate-500 font-mono">-</span>
                                )}
                              </td>

                              {/* Duration */}
                              <td className="py-3 px-4 font-mono text-slate-300 text-[11px]">
                                {formatDuration(task.startTime, task.endTime)}
                              </td>

                              {/* Start Time */}
                              <td className="py-3 px-4 text-slate-400 text-[11px] hidden md:table-cell">
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
                                    className="px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white border border-white/[0.06] text-xs transition-all"
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
                                      className="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 text-xs transition-all flex items-center space-x-1"
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
            await handleKillTask(taskId);
          }}
        />

        {/* Toast Container */}
        {toasts.length > 0 && (
          <div className="absolute bottom-4 right-4 z-50 flex flex-col space-y-2 pointer-events-none">
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className={`pointer-events-auto px-4 py-2.5 rounded-xl border text-xs shadow-2xl flex items-center space-x-2 animate-in fade-in slide-in-from-bottom-2 duration-150 ${
                  toast.type === 'error'
                    ? 'bg-rose-950/90 border-rose-500/40 text-rose-200'
                    : toast.type === 'success'
                    ? 'bg-emerald-950/90 border-emerald-500/40 text-emerald-200'
                    : 'bg-slate-900/90 border-slate-700 text-slate-200'
                }`}
              >
                {toast.type === 'error' && <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />}
                {toast.type === 'success' && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                <span>{toast.message}</span>
                <button
                  type="button"
                  onClick={() => removeToast(toast.id)}
                  className="ml-2 text-slate-400 hover:text-white"
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
