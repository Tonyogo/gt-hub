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
import { ModalShell } from '../ui/ModalShell';

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
    setCurrentContent('#!/usr/bin/env bash\n# @title: \n# @description: \n\necho "Hello World"\n');
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

  return (
    <ModalShell
      variant="drawer"
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClassName="max-w-2xl"
      bodyClassName="p-0 flex flex-col overflow-hidden"
      title={t('scripts.title', '常用脚本库')}
      icon={
        <div className="p-1.5 rounded-lg bg-[var(--accent-soft-bg)] text-[var(--accent-text)] border border-[var(--accent-soft-border)]">
          <FileCode className="w-4 h-4" />
        </div>
      }
      footer={
        <div className="flex items-center justify-between gap-2">
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
              className={`flex items-center space-x-1.5 px-4 py-1.5 ${
                isConnected && currentContent
                  ? 'ui-btn-primary cursor-pointer'
                  : 'rounded-lg bg-[var(--bg-control)] text-[var(--text-muted)] text-xs font-medium cursor-not-allowed border border-[var(--border-subtle)]'
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
      }
    >
      {/* Status Alert */}
      {statusMessage && (
        <div
          className={`px-4 py-2 text-xs flex items-center justify-between shrink-0 ${
            statusMessage.type === 'success'
              ? 'bg-[var(--status-success-bg)] text-[var(--status-success-text)] border-b border-[var(--status-success-border)]'
              : 'bg-[var(--status-danger-bg)] text-[var(--status-danger-text)] border-b border-[var(--status-danger-border)]'
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
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left: Scripts list */}
        <div className="w-56 sm:w-64 border-r border-[var(--border-subtle)] flex flex-col shrink-0 bg-[var(--bg-sidebar)]">
          {/* Search & New */}
          <div className="p-2.5 border-b border-[var(--border-subtle)] space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[var(--text-muted)]" />
              <input
                type="text"
                placeholder={t('scripts.searchPlaceholder', '搜索脚本...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ui-input w-full pl-8 pr-2.5 py-1.5"
              />
            </div>
            <button
              type="button"
              onClick={handleStartCreate}
              className="ui-btn-primary w-full flex items-center justify-center space-x-1 px-2.5 py-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('scripts.newScript', '新建脚本')}</span>
            </button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto overscroll-contain divide-y divide-[var(--border-subtle)]">
            {isLoading && scripts.length === 0 ? (
              <div className="p-4 text-center text-xs text-[var(--text-muted)]">加载中...</div>
            ) : filteredScripts.length === 0 ? (
              <div className="p-4 text-center text-xs text-[var(--text-muted)]">
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
                    className={`relative w-full text-left p-2.5 transition-colors flex flex-col space-y-1 ${
                      isSelected
                        ? 'bg-[var(--accent-soft-bg)] text-[var(--text-primary)]'
                        : 'hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)]'
                    }`}
                  >
                    {isSelected && <span className="ui-row-indicator" />}
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-xs font-medium truncate">
                        {item.title && item.title !== '新脚本' ? item.title : item.name}
                      </span>
                      <span className="ui-badge-neutral text-[10px] px-1.5 py-0.2 font-mono shrink-0">
                        {item.interpreter || 'sh'}
                      </span>
                    </div>
                    {item.title && item.title !== item.name && item.title !== '新脚本' && (
                      <p className="text-[10px] text-[var(--text-muted)] font-mono truncate">{item.name}</p>
                    )}
                    {item.description && item.description !== '描述信息' && (
                      <p className="text-[11px] text-[var(--text-muted)] line-clamp-1">{item.description}</p>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Detail / Preview / Edit */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-[var(--bg-surface)]">
          {/* Meta bar */}
          <div className="px-4 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0 bg-[var(--bg-surface-sub)]">
            <div className="min-w-0 flex-1">
              {isCreating ? (
                <input
                  type="text"
                  placeholder={t('scripts.namePlaceholder', '脚本文件名 (如: test.sh)')}
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  className="ui-input w-full px-2 py-1 font-mono"
                />
              ) : (
                <div className="flex items-center space-x-2">
                  <Code2 className="w-3.5 h-3.5 text-[var(--accent-text)] shrink-0" />
                  <span className="text-xs font-mono font-medium text-[var(--text-primary)] truncate">
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
                  className="ui-btn-secondary px-2 py-1 flex items-center space-x-1"
                >
                  {isEditing ? <Eye className="w-3 h-3" /> : <Edit3 className="w-3 h-3" />}
                  <span>{isEditing ? t('scripts.preview', '预览') : t('scripts.edit', '编辑')}</span>
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="ui-icon-btn text-[var(--status-danger-text)] hover:bg-[var(--status-danger-bg)] hover:border-[var(--status-danger-border)]"
                  title="删除脚本"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* Editor / Viewer area */}
          <div className="flex-1 min-h-0 p-3 overflow-hidden flex flex-col">
            {isEditing || isCreating ? (
              <textarea
                value={currentContent}
                onChange={(e) => setCurrentContent(e.target.value)}
                className="w-full h-full bg-[var(--code-bg)] border border-[var(--border-input)] rounded-lg p-3 text-xs font-mono text-[var(--code-text)] resize-none focus:outline-none focus:border-[var(--accent-fill)] leading-relaxed"
                spellCheck={false}
              />
            ) : (
              <pre className="w-full h-full bg-[var(--code-bg)] border border-[var(--border-subtle)] rounded-lg p-3 text-xs font-mono text-[var(--code-text)] overflow-auto whitespace-pre leading-relaxed select-text">
                {currentContent || '# 空内容'}
              </pre>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
};

export default TerminalScriptDrawer;
