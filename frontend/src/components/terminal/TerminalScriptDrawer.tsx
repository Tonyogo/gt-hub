import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  X,
  Play,
  Plus,
  Trash2,
  Save,
  Search,
  Code2,
  FileCode,
  AlertCircle,
  Check,
  Edit3,
  Eye,
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { apiFetch } from '../../utils/apiClient';
import { generateScriptExecutionCommand } from '../../utils/terminalScriptExecutor';

export interface ScriptItem {
  name: string;
  title: string;
  description: string;
  interpreter: string;
  size: number;
  updatedAt: string;
}

export interface TerminalScriptDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onExecute: (command: string) => void;
  isConnected: boolean;
  activeHostTitle?: string;
  adminKey?: string;
}

export const TerminalScriptDrawer: React.FC<TerminalScriptDrawerProps> = ({
  isOpen,
  onClose,
  onExecute,
  isConnected,
  activeHostTitle,
  adminKey,
}) => {
  const { t } = useTranslation();
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedScriptName, setSelectedScriptName] = useState<string | null>(null);
  const [currentContent, setCurrentContent] = useState<string>('');
  const [currentMeta, setCurrentMeta] = useState<ScriptItem | null>(null);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [newFileName, setNewFileName] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (adminKey) {
      headers['x-admin-key'] = adminKey;
    }
    return headers;
  }, [adminKey]);

  const loadScripts = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/admin/scripts', { headers: authHeaders });
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setScripts(json.data);
        if (json.data.length > 0 && !selectedScriptName) {
          setSelectedScriptName(json.data[0].name);
        }
      }
    } catch {
      setStatusMessage({ text: t('scripts.saveError', '获取脚本列表失败'), type: 'error' });
    } finally {
      setIsLoading(false);
    }
  }, [authHeaders, selectedScriptName, t]);

  useEffect(() => {
    if (isOpen) {
      loadScripts();
    }
  }, [isOpen, loadScripts]);

  useEffect(() => {
    if (!selectedScriptName || isCreating) return;
    let isCancelled = false;

    async function fetchDetail() {
      try {
        const res = await apiFetch(`/api/admin/scripts/${encodeURIComponent(selectedScriptName!)}`, {
          headers: authHeaders,
        });
        const json = await res.json();
        if (!isCancelled && json.success && json.data) {
          setCurrentContent(json.data.content || '');
          setCurrentMeta(json.data);
          setIsEditing(false);
        }
      } catch {
        if (!isCancelled) {
          setStatusMessage({ text: '加载脚本详情失败', type: 'error' });
        }
      }
    }

    fetchDetail();
    return () => {
      isCancelled = true;
    };
  }, [selectedScriptName, isCreating, authHeaders]);

  const filteredScripts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return scripts;
    return scripts.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.title && s.title.toLowerCase().includes(q)) ||
        (s.description && s.description.toLowerCase().includes(q))
    );
  }, [scripts, searchQuery]);

  const handleStartCreate = () => {
    setIsCreating(true);
    setSelectedScriptName(null);
    setNewFileName('');
    setCurrentContent('#!/usr/bin/env bash\n# @title: 新脚本\n# @description: 描述信息\n\necho "Hello World"\n');
    setCurrentMeta(null);
    setIsEditing(true);
  };

  const handleSave = async () => {
    setStatusMessage(null);
    try {
      if (isCreating) {
        if (!newFileName.trim()) {
          setStatusMessage({ text: '请输入脚本文件名', type: 'error' });
          return;
        }
        const res = await apiFetch('/api/admin/scripts', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newFileName.trim(), content: currentContent }),
        });
        const json = await res.json();
        if (json.success) {
          setIsCreating(false);
          setSelectedScriptName(newFileName.trim());
          setIsEditing(false);
          await loadScripts();
          setStatusMessage({ text: t('scripts.saveSuccess', '脚本保存成功'), type: 'success' });
        } else {
          setStatusMessage({ text: json.error || t('scripts.saveError', '保存失败'), type: 'error' });
        }
      } else if (selectedScriptName) {
        const res = await apiFetch(`/api/admin/scripts/${encodeURIComponent(selectedScriptName)}`, {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: currentContent }),
        });
        const json = await res.json();
        if (json.success) {
          setIsEditing(false);
          await loadScripts();
          setStatusMessage({ text: t('scripts.saveSuccess', '脚本保存成功'), type: 'success' });
        } else {
          setStatusMessage({ text: json.error || t('scripts.saveError', '保存失败'), type: 'error' });
        }
      }
    } catch (err: any) {
      setStatusMessage({ text: err.message || t('scripts.saveError', '保存失败'), type: 'error' });
    }
  };

  const handleDelete = async () => {
    if (!selectedScriptName) return;
    if (!window.confirm(t('scripts.deleteConfirm', '确定要删除该脚本吗？'))) return;

    try {
      const res = await apiFetch(`/api/admin/scripts/${encodeURIComponent(selectedScriptName)}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      const json = await res.json();
      if (json.success) {
        setSelectedScriptName(null);
        setCurrentContent('');
        await loadScripts();
      }
    } catch {
      setStatusMessage({ text: '删除失败', type: 'error' });
    }
  };

  const handleExecute = () => {
    if (!isConnected || !currentContent) return;
    const interp = currentMeta?.interpreter || 'bash';
    const command = generateScriptExecutionCommand(currentContent, interp);
    onExecute(command);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="w-full max-w-2xl h-full bg-[var(--bg-surface-sub,#18181b)] border-l border-[var(--border-subtle,#27272a)] flex flex-col shadow-2xl text-slate-200">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--border-subtle,#27272a)] flex items-center justify-between shrink-0 bg-white/[0.02]">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <FileCode className="w-4 h-4" />
            </div>
            <h2 className="text-sm font-semibold text-white tracking-wide">
              {t('scripts.title', '常用脚本库')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Status Alert */}
        {statusMessage && (
          <div
            className={`px-4 py-2 text-xs flex items-center justify-between ${
              statusMessage.type === 'success'
                ? 'bg-emerald-500/15 text-emerald-400 border-b border-emerald-500/20'
                : 'bg-rose-500/15 text-rose-400 border-b border-rose-500/20'
            }`}
          >
            <span className="flex items-center space-x-1.5">
              {statusMessage.type === 'success' ? <Check className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
              <span>{statusMessage.text}</span>
            </span>
            <button type="button" onClick={() => setStatusMessage(null)} className="opacity-70 hover:opacity-100">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Content Body: Split Left & Right */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Scripts list */}
          <div className="w-56 sm:w-64 border-r border-[var(--border-subtle,#27272a)] flex flex-col shrink-0 bg-black/20">
            {/* Search & New */}
            <div className="p-2.5 border-b border-[var(--border-subtle,#27272a)] space-y-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
                <input
                  type="text"
                  placeholder={t('scripts.searchPlaceholder', '搜索脚本...')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-hidden focus:border-indigo-500"
                />
              </div>
              <button
                type="button"
                onClick={handleStartCreate}
                className="w-full flex items-center justify-center space-x-1 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('scripts.newScript', '新建脚本')}</span>
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
              {isLoading && scripts.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">加载中...</div>
              ) : filteredScripts.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">
                  {t('scripts.emptyTitle', '暂无脚本')}
                </div>
              ) : (
                filteredScripts.map((item) => {
                  const isSelected = !isCreating && selectedScriptName === item.name;
                  return (
                    <button
                      type="button"
                      key={item.name}
                      onClick={() => {
                        setIsCreating(false);
                        setSelectedScriptName(item.name);
                      }}
                      className={`w-full text-left p-2.5 transition-colors flex flex-col space-y-1 ${
                        isSelected
                          ? 'bg-indigo-600/15 border-l-2 border-indigo-500 text-white'
                          : 'hover:bg-white/[0.04] text-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium truncate">{item.title || item.name}</span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded-sm bg-white/[0.08] text-slate-400 font-mono">
                          {item.interpreter || 'sh'}
                        </span>
                      </div>
                      {item.description && (
                        <p className="text-[11px] text-slate-400 line-clamp-1">{item.description}</p>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: Detail / Preview / Edit */}
          <div className="flex-1 flex flex-col overflow-hidden bg-black/10">
            {/* Meta bar */}
            <div className="px-4 py-2 border-b border-[var(--border-subtle,#27272a)] flex items-center justify-between shrink-0 bg-white/[0.01]">
              <div className="min-w-0 flex-1">
                {isCreating ? (
                  <input
                    type="text"
                    placeholder={t('scripts.namePlaceholder', '脚本文件名 (如: test.sh)')}
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    className="w-full bg-white/[0.05] border border-white/[0.1] rounded px-2 py-1 text-xs text-white focus:outline-hidden focus:border-indigo-500"
                  />
                ) : (
                  <div className="flex items-center space-x-2">
                    <Code2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    <span className="text-xs font-mono font-medium text-white truncate">
                      {selectedScriptName || '未选择脚本'}
                    </span>
                  </div>
                )}
              </div>

              {!isCreating && selectedScriptName && (
                <div className="flex items-center space-x-1 ml-2">
                  <button
                    type="button"
                    onClick={() => setIsEditing(!isEditing)}
                    className="px-2 py-1 rounded bg-white/[0.06] hover:bg-white/[0.12] text-slate-300 hover:text-white text-xs flex items-center space-x-1"
                  >
                    {isEditing ? <Eye className="w-3 h-3" /> : <Edit3 className="w-3 h-3" />}
                    <span>{isEditing ? t('scripts.preview', '预览') : t('scripts.edit', '编辑')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="p-1 rounded text-rose-400 hover:bg-rose-500/10 transition-colors"
                    title="删除脚本"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Editor / Viewer area */}
            <div className="flex-1 p-3 overflow-hidden flex flex-col">
              {isEditing || isCreating ? (
                <textarea
                  value={currentContent}
                  onChange={(e) => setCurrentContent(e.target.value)}
                  className="w-full h-full bg-[#121214] border border-white/[0.08] rounded-lg p-3 text-xs font-mono text-slate-200 resize-none focus:outline-hidden focus:border-indigo-500 leading-relaxed"
                  spellCheck={false}
                />
              ) : (
                <pre className="w-full h-full bg-[#121214] border border-white/[0.08] rounded-lg p-3 text-xs font-mono text-slate-200 overflow-auto whitespace-pre leading-relaxed select-text">
                  {currentContent || '# 空内容'}
                </pre>
              )}
            </div>

            {/* Footer Action Bar */}
            <div className="p-3 border-t border-[var(--border-subtle,#27272a)] bg-white/[0.02] flex items-center justify-between shrink-0">
              <div>
                {(isEditing || isCreating) && (
                  <button
                    type="button"
                    onClick={handleSave}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>保存</span>
                  </button>
                )}
              </div>

              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  data-testid="execute-script-btn"
                  onClick={handleExecute}
                  disabled={!isConnected || !currentContent}
                  title={!isConnected ? t('scripts.notConnected', '终端未连接') : undefined}
                  className={`flex items-center space-x-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    isConnected && currentContent
                      ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm active:scale-95'
                      : 'bg-white/[0.05] text-slate-500 cursor-not-allowed border border-white/[0.05]'
                  }`}
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>
                    {t('scripts.runInTerminal', '执行到当前终端')}
                    {activeHostTitle ? ` (${activeHostTitle})` : ''}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TerminalScriptDrawer;
