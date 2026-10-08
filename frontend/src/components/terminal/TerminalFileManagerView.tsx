import React, { useState, useEffect, useRef, useCallback, useImperativeHandle } from 'react';
import Editor from '@monaco-editor/react';
import {
  Folder,
  FolderPlus,
  Upload,
  RefreshCw,
  Download,
  Trash2,
  Edit2,
  FileText,
  FileCode,
  Image as ImageIcon,
  Archive,
  File,
  ChevronRight,
  ArrowUp,
  Search,
  Save,
  X,
  Copy,
  Check,
  Eye,
  EyeOff,
  AlertTriangle,
  Loader2,
  Plus
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { useTheme } from '../../theme/ThemeContext';
import { defineGeminiProxyTheme } from '../../utils/monacoTheme';
import { TerminalImagePreviewModal } from './TerminalImagePreviewModal';

export interface TerminalFileManagerHandle {
  refresh: () => void;
}

export interface TerminalFileManagerViewProps {
  adminKey: string;
  activeHostId: string;
  onRequestAddNode?: () => void;
}

export interface TerminalFileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  updatedAt: number;
  extension: string;
}

export interface ListFilesResponse {
  success: boolean;
  currentPath: string;
  parentPath: string | null;
  separator: string;
  files: TerminalFileItem[];
  error?: string;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'html', 'htm', 'css', 'scss', 'less',
  'py', 'sh', 'bash', 'zsh', 'sql', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'dockerfile', 'makefile', 'vue', 'svelte'
]);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'bz2', '7z', 'rar', 'xz']);

function getMonacoLanguage(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
      return 'json';
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
    case 'less':
      return 'scss';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sql':
      return 'sql';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'hpp':
    case 'cc':
      return 'cpp';
    case 'java':
      return 'java';
    case 'xml':
    case 'svg':
      return 'xml';
    case 'dockerfile':
      return 'dockerfile';
    default:
      return 'plaintext';
  }
}

function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i] || 'TB'}`;
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const TerminalFileManagerView = React.forwardRef<TerminalFileManagerHandle, TerminalFileManagerViewProps>(function TerminalFileManagerView({
  adminKey,
  activeHostId,
  onRequestAddNode,
}: TerminalFileManagerViewProps, ref) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const monacoTheme = resolvedTheme === 'dark' ? 'gemini-proxy-dark' : 'gemini-proxy-light';

  // Navigation and data states
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [separator, setSeparator] = useState<string>('/');
  const [files, setFiles] = useState<TerminalFileItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false);
  const [pathInput, setPathInput] = useState<string>('');
  const [copiedPath, setCopiedPath] = useState<boolean>(false);
  const [showHiddenFiles, setShowHiddenFiles] = useState<boolean>(() => {
    try {
      return localStorage.getItem('terminal_show_hidden_files') === 'true';
    } catch {
      return false;
    }
  });

  const handleToggleHiddenFiles = useCallback(() => {
    setShowHiddenFiles((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('terminal_show_hidden_files', String(next));
      } catch {}
      return next;
    });
  }, []);

  // Upload and Drag-n-drop
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Modals
  const [newFolderOpen, setNewFolderOpen] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>('');

  const [renameTarget, setRenameTarget] = useState<TerminalFileItem | null>(null);
  const [renameInput, setRenameInput] = useState<string>('');

  const [deleteTarget, setDeleteTarget] = useState<TerminalFileItem | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  // File Preview & Edit Modal
  const [editorTarget, setEditorTarget] = useState<{
    file: TerminalFileItem;
    content: string;
    isBinary: boolean;
    loading: boolean;
    saving: boolean;
    savedAlert: boolean;
    error?: string;
  } | null>(null);

  // Image Preview Modal
  const [imagePreviewTarget, setImagePreviewTarget] = useState<{
    file: TerminalFileItem;
    blobUrl: string;
  } | null>(null);

  // Load directory items
  const loadFiles = useCallback(async (targetPath?: string) => {
    if (!activeHostId) {
      setLoading(false);
      setFiles([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let url = `/api/terminal/files/list?hostId=${encodeURIComponent(activeHostId)}`;
      if (targetPath) {
        url += `&path=${encodeURIComponent(targetPath)}`;
      }
      const res = await fetch(url, {
        headers: { 'x-admin-key': adminKey },
      });
      const data: ListFilesResponse = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to load file list');
      } else {
        setCurrentPath(data.currentPath);
        setPathInput(data.currentPath);
        setParentPath(data.parentPath);
        setSeparator(data.separator || '/');
        setFiles(data.files || []);
      }
    } catch (err: any) {
      setError(err.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, [adminKey, activeHostId]);

  useImperativeHandle(ref, () => ({
    refresh: () => {
      loadFiles(currentPath);
    },
  }), [loadFiles, currentPath]);

  // Reload when activeHostId changes
  useEffect(() => {
    setCurrentPath('');
    setParentPath(null);
    if (!activeHostId) {
      setLoading(false);
      setFiles([]);
      return;
    }
    loadFiles();
  }, [activeHostId, loadFiles]);

  // Breadcrumbs generator
  const breadcrumbs = React.useMemo(() => {
    if (!currentPath) return [];
    const isWindows = currentPath.includes('\\');
    const sep = isWindows ? '\\' : '/';
    const parts = currentPath.split(sep).filter(Boolean);

    const crumbs: { name: string; fullPath: string }[] = [];
    if (!isWindows) {
      // Root / for Unix
      crumbs.push({ name: '/', fullPath: '/' });
    }

    let accumulated = isWindows ? '' : '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (isWindows && i === 0) {
        accumulated = part + sep;
      } else {
        accumulated = isWindows
          ? (accumulated.endsWith(sep) ? `${accumulated}${part}` : `${accumulated}${sep}${part}`)
          : `${accumulated}/${part}`;
      }
      crumbs.push({ name: part, fullPath: accumulated });
    }
    return crumbs;
  }, [currentPath]);

  // Filtered files
  const filteredFiles = React.useMemo(() => {
    let result = files;
    if (!showHiddenFiles) {
      result = result.filter(f => !f.name.startsWith('.'));
    }
    if (!searchQuery.trim()) return result;
    const query = searchQuery.toLowerCase().trim();
    return result.filter(f => f.name.toLowerCase().includes(query));
  }, [files, showHiddenFiles, searchQuery]);

  // Native Download
  const handleDownload = useCallback((file: TerminalFileItem) => {
    const url = `/api/terminal/files/download?hostId=${encodeURIComponent(activeHostId)}&path=${encodeURIComponent(file.path)}`;
    fetch(url, { headers: { 'x-admin-key': adminKey } })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to download file');
        }
        return res.blob();
      })
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      })
      .catch((err) => alert(err.message));
  }, [activeHostId, adminKey]);

  // Open Preview / Edit
  const handleOpenFile = useCallback(async (file: TerminalFileItem) => {
    const ext = file.extension.toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      // Fetch image as blob for preview
      try {
        const url = `/api/terminal/files/download?hostId=${encodeURIComponent(activeHostId)}&path=${encodeURIComponent(file.path)}`;
        const res = await fetch(url, { headers: { 'x-admin-key': adminKey } });
        if (!res.ok) throw new Error('Failed to load image');
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setImagePreviewTarget({ file, blobUrl });
      } catch (err: any) {
        alert(err.message);
      }
      return;
    }

    // Text / Code Editor
    setEditorTarget({
      file,
      content: '',
      isBinary: false,
      loading: true,
      saving: false,
      savedAlert: false,
    });

    try {
      const url = `/api/terminal/files/content?hostId=${encodeURIComponent(activeHostId)}&path=${encodeURIComponent(file.path)}`;
      const res = await fetch(url, { headers: { 'x-admin-key': adminKey } });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setEditorTarget(prev => prev ? {
          ...prev,
          loading: false,
          error: data.error || 'Failed to read file',
          isBinary: Boolean(data.isBinary),
        } : null);
      } else {
        setEditorTarget(prev => prev ? {
          ...prev,
          loading: false,
          content: data.content || '',
          isBinary: Boolean(data.isBinary),
        } : null);
      }
    } catch (err: any) {
      setEditorTarget(prev => prev ? {
        ...prev,
        loading: false,
        error: err.message,
      } : null);
    }
  }, [activeHostId, adminKey]);

  // Save Editor Content
  const handleSaveEditor = useCallback(async () => {
    if (!editorTarget || editorTarget.saving || editorTarget.isBinary) return;
    setEditorTarget(prev => prev ? { ...prev, saving: true } : null);

    try {
      const res = await fetch('/api/terminal/files/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          hostId: activeHostId,
          path: editorTarget.file.path,
          content: editorTarget.content,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || 'Failed to save file');
      } else {
        setEditorTarget(prev => prev ? { ...prev, savedAlert: true } : null);
        setTimeout(() => {
          setEditorTarget(prev => prev ? { ...prev, savedAlert: false } : null);
        }, 2500);
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setEditorTarget(prev => prev ? { ...prev, saving: false } : null);
    }
  }, [editorTarget, adminKey, activeHostId]);

  // Upload handler
  const handleUploadFiles = useCallback(async (fileList: FileList | File[]) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      for (let i = 0; i < fileList.length; i++) {
        formData.append('file', fileList[i]);
      }
      const url = `/api/terminal/files/upload?hostId=${encodeURIComponent(activeHostId)}&path=${encodeURIComponent(currentPath)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-admin-key': adminKey },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to upload file');
      }
      loadFiles(currentPath);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setUploading(false);
    }
  }, [activeHostId, currentPath, adminKey, loadFiles]);

  // Create folder
  const handleCreateFolder = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    try {
      const res = await fetch('/api/terminal/files/mkdir', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          hostId: activeHostId,
          path: currentPath,
          dirName: newFolderName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || 'Failed to create directory');
      } else {
        setNewFolderOpen(false);
        setNewFolderName('');
        loadFiles(currentPath);
      }
    } catch (err: any) {
      alert(err.message);
    }
  }, [newFolderName, activeHostId, currentPath, adminKey, loadFiles]);

  // Rename
  const handleRename = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget || !renameInput.trim()) return;
    const parentDir = currentPath;
    const newPath = currentPath.endsWith(separator)
      ? `${parentDir}${renameInput.trim()}`
      : `${parentDir}${separator}${renameInput.trim()}`;

    try {
      const res = await fetch('/api/terminal/files/rename', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          hostId: activeHostId,
          oldPath: renameTarget.path,
          newPath,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || 'Failed to rename');
      } else {
        setRenameTarget(null);
        setRenameInput('');
        loadFiles(currentPath);
      }
    } catch (err: any) {
      alert(err.message);
    }
  }, [renameTarget, renameInput, currentPath, separator, activeHostId, adminKey, loadFiles]);

  // Delete
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const url = `/api/terminal/files/delete?hostId=${encodeURIComponent(activeHostId)}&path=${encodeURIComponent(deleteTarget.path)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'x-admin-key': adminKey },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || 'Failed to delete');
      } else {
        setDeleteTarget(null);
        loadFiles(currentPath);
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, activeHostId, adminKey, loadFiles, currentPath]);

  // Copy Path
  const handleCopyPath = () => {
    if (!currentPath) return;
    navigator.clipboard.writeText(currentPath);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  // Keyboard shortcut Ctrl+S inside editor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        if (editorTarget && !editorTarget.isBinary) {
          e.preventDefault();
          handleSaveEditor();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editorTarget, handleSaveEditor]);

  // Cleanup image preview blob URL
  useEffect(() => {
    return () => {
      if (imagePreviewTarget?.blobUrl) {
        URL.revokeObjectURL(imagePreviewTarget.blobUrl);
      }
    };
  }, [imagePreviewTarget]);

  // Render File Icon
  const renderItemIcon = (item: TerminalFileItem) => {
    if (item.isDirectory) {
      return <Folder className="w-4 h-4 text-amber-500 fill-amber-500/20 shrink-0" />;
    }
    const ext = item.extension.toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      return <ImageIcon className="w-4 h-4 text-emerald-400 shrink-0" />;
    }
    if (CODE_EXTENSIONS.has(ext)) {
      return <FileCode className="w-4 h-4 text-indigo-400 shrink-0" />;
    }
    if (ARCHIVE_EXTENSIONS.has(ext)) {
      return <Archive className="w-4 h-4 text-orange-400 shrink-0" />;
    }
    if (['txt', 'md', 'log', 'conf', 'env'].includes(ext)) {
      return <FileText className="w-4 h-4 text-sky-400 shrink-0" />;
    }
    return <File className="w-4 h-4 text-slate-400 shrink-0" />;
  };

  return (
    <div
      className="flex-1 flex flex-col min-h-0 relative bg-[var(--bg-canvas)] text-[var(--text-primary)] select-none"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleUploadFiles(e.dataTransfer.files);
        }
      }}
    >
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleUploadFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* Empty State Guard */}
      {!activeHostId ? (
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none bg-[var(--bg-canvas)]">
          <div className="w-12 h-12 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-400 mb-3">
            <Folder className="w-6 h-6" />
          </div>
          <p className="text-sm font-medium text-[var(--text-secondary)] font-sans">
            {t('webTerminal.emptyState.title', '当前暂无在线终端节点')}
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1.5 max-w-sm leading-relaxed font-sans">
            {t('webTerminal.emptyState.fileManagerDesc', '反向连接终端 Agent 节点后，即可在此实时浏览、编辑、上传和下载远程文件。')}
          </p>
          {onRequestAddNode && (
            <button
              type="button"
              onClick={onRequestAddNode}
              className="mt-4 px-3.5 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-medium flex items-center space-x-1.5 transition-all active:scale-95 cursor-pointer shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('webTerminal.hostSelector.addNode', '接入内网新节点')}</span>
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Top Action & Breadcrumb Bar */}
          <div className="ui-card p-2 sm:p-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] shrink-0 mb-2">
        {/* Left: Breadcrumbs / Path input */}
        <div className="flex items-center space-x-1.5 flex-1 min-w-[240px] overflow-hidden text-xs sm:text-sm">
          {parentPath !== null && (
            <button
              onClick={() => loadFiles(parentPath)}
              title={t('files.parentDir', '返回上级')}
              className="p-1 rounded-md hover:bg-[var(--bg-surface-hover)] text-slate-400 hover:text-[var(--text-primary)] transition-colors shrink-0"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          )}

          {isEditingPath ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setIsEditingPath(false);
                if (pathInput.trim()) loadFiles(pathInput.trim());
              }}
              className="flex-1 flex items-center gap-1"
            >
              <input
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                autoFocus
                onBlur={() => setIsEditingPath(false)}
                className="flex-1 bg-[var(--bg-surface-sub)] border border-[var(--border-subtle)] rounded px-2 py-0.5 text-xs text-[var(--text-primary)] focus:outline-hidden focus:border-indigo-500"
              />
            </form>
          ) : (
            <div className="flex items-center flex-wrap gap-1 overflow-x-auto py-0.5 no-scrollbar">
              {breadcrumbs.map((crumb, idx) => (
                <React.Fragment key={crumb.fullPath}>
                  {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
                  <button
                    onClick={() => loadFiles(crumb.fullPath)}
                    className="hover:underline text-slate-300 hover:text-indigo-400 truncate max-w-[140px] font-medium"
                    title={crumb.fullPath}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
              <button
                onClick={() => setIsEditingPath(true)}
                title="Edit path manually"
                className="p-1 text-slate-400 hover:text-slate-200"
              >
                <Edit2 className="w-3 h-3" />
              </button>
            </div>
          )}

          <button
            onClick={handleCopyPath}
            title={t('files.copyPath', '复制路径')}
            className="p-1 rounded hover:bg-[var(--bg-surface-hover)] text-slate-400 hover:text-slate-200 transition-colors shrink-0 ml-1"
          >
            {copiedPath ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Right: Search, Refresh, Upload, New Folder */}
        <div className="flex items-center space-x-1.5 shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('files.searchPlaceholder', '过滤当前目录文件...')}
              className="pl-7 pr-2 py-1 bg-[var(--bg-surface-sub)] border border-[var(--border-subtle)] rounded-lg text-xs w-28 sm:w-36 focus:w-48 transition-all focus:outline-hidden focus:border-indigo-500 text-[var(--text-primary)]"
            />
          </div>

          <button
            onClick={() => loadFiles(currentPath)}
            disabled={loading}
            title={t('files.refresh', '刷新')}
            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-sub)] hover:bg-[var(--bg-surface-hover)] text-slate-300 hover:text-white transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>

          <button
            type="button"
            onClick={handleToggleHiddenFiles}
            title={showHiddenFiles ? t('files.hideHidden', '不显示隐藏文件') : t('files.showHidden', '显示隐藏文件')}
            className={`p-1.5 rounded-lg border transition-colors ${
              showHiddenFiles
                ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25'
                : 'border-[var(--border-subtle)] bg-[var(--bg-surface-sub)] hover:bg-[var(--bg-surface-hover)] text-slate-400 hover:text-slate-200'
            }`}
          >
            {showHiddenFiles ? (
              <Eye className="w-3.5 h-3.5" />
            ) : (
              <EyeOff className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            onClick={() => setNewFolderOpen(true)}
            className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-sub)] hover:bg-[var(--bg-surface-hover)] text-xs text-slate-200 hover:text-white transition-colors"
          >
            <FolderPlus className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">{t('files.newFolder', '新建文件夹')}</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white shadow-xs transition-colors"
          >
            {uploading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5" />
            )}
            <span>{uploading ? t('files.uploading', '正在上传...') : t('files.upload', '上传文件')}</span>
          </button>
        </div>
      </div>

      {/* Drag & Drop Visual Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-indigo-950/60 backdrop-blur-xs border-2 border-dashed border-indigo-400 flex flex-col items-center justify-center pointer-events-none rounded-xl">
          <Upload className="w-12 h-12 text-indigo-300 animate-bounce mb-2" />
          <p className="text-white text-base font-semibold">
            {t('files.dropToUpload', '释放鼠标以上传文件到此目录')}
          </p>
        </div>
      )}

      {/* Main File Table View */}
      <div className="ui-card flex-1 min-h-0 flex flex-col overflow-hidden border border-[var(--border-subtle)] rounded-xl relative">
        {loading && files.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-500 mb-2" />
            <span className="text-xs">{t('files.loading', '加载中...')}</span>
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-rose-400">
            <AlertTriangle className="w-8 h-8 mb-2" />
            <span className="text-sm font-medium">{error}</span>
            <button
              onClick={() => loadFiles(currentPath)}
              className="mt-3 px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs"
            >
              {t('files.refresh', '重试')}
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="sticky top-0 bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)] text-slate-400 font-medium z-10">
                <tr>
                  <th className="py-2.5 px-3">{t('files.name', '名称')}</th>
                  <th className="py-2.5 px-3 w-28 text-right hidden sm:table-cell">{t('files.size', '大小')}</th>
                  <th className="py-2.5 px-3 w-40 hidden md:table-cell">{t('files.updatedAt', '修改时间')}</th>
                  <th className="py-2.5 px-3 w-32 text-right">{t('files.actions', '操作')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {/* Parent directory row */}
                {parentPath !== null && !searchQuery && (
                  <tr
                    onClick={() => loadFiles(parentPath)}
                    className="hover:bg-[var(--bg-surface-hover)] cursor-pointer transition-colors"
                  >
                    <td className="py-2 px-3 flex items-center space-x-2 text-slate-400 font-medium">
                      <Folder className="w-4 h-4 text-amber-500/80" />
                      <span>.. ({t('files.parentDir', '返回上级')})</span>
                    </td>
                    <td className="py-2 px-3 hidden sm:table-cell" />
                    <td className="py-2 px-3 hidden md:table-cell" />
                    <td className="py-2 px-3 text-right" />
                  </tr>
                )}

                {filteredFiles.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-12 text-center text-slate-500">
                      {t('files.emptyDir', '当前目录下没有文件。')}
                    </td>
                  </tr>
                ) : (
                  filteredFiles.map((item) => {
                    const isHidden = item.name.startsWith('.');
                    return (
                    <tr
                      key={item.path}
                      className={`hover:bg-[var(--bg-surface-hover)] transition-colors group ${
                        isHidden ? 'opacity-75' : ''
                      }`}
                      onDoubleClick={() => {
                        if (item.isDirectory) {
                          loadFiles(item.path);
                        } else {
                          handleOpenFile(item);
                        }
                      }}
                    >
                      <td className="py-2 px-3">
                        <div className="flex items-center space-x-2 min-w-0">
                          {renderItemIcon(item)}
                          <button
                            onClick={() => {
                              if (item.isDirectory) {
                                loadFiles(item.path);
                              } else {
                                handleOpenFile(item);
                              }
                            }}
                            className={`${
                              isHidden ? 'text-slate-400' : 'text-slate-200'
                            } hover:text-indigo-400 truncate text-left font-medium transition-colors`}
                            title={item.name}
                          >
                            {item.name}
                          </button>
                        </div>
                      </td>

                      <td className="py-2 px-3 text-right text-slate-400 font-mono hidden sm:table-cell">
                        {item.isDirectory ? '-' : formatFileSize(item.size)}
                      </td>

                      <td className="py-2 px-3 text-slate-400 font-mono hidden md:table-cell">
                        {formatDate(item.updatedAt)}
                      </td>

                      <td className="py-2 px-3 text-right">
                        <div className="flex items-center justify-end space-x-1 opacity-80 group-hover:opacity-100 transition-opacity">
                          {!item.isDirectory && (
                            <>
                              <button
                                onClick={() => handleOpenFile(item)}
                                title={t('files.preview', '查看 / 编辑')}
                                className="p-1 rounded hover:bg-slate-700/50 text-slate-400 hover:text-indigo-300"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleDownload(item)}
                                title={t('files.download', '下载')}
                                className="p-1 rounded hover:bg-slate-700/50 text-slate-400 hover:text-emerald-300"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}

                          <button
                            onClick={() => {
                              setRenameTarget(item);
                              setRenameInput(item.name);
                            }}
                            title={t('files.rename', '重命名')}
                            className="p-1 rounded hover:bg-slate-700/50 text-slate-400 hover:text-amber-300"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => setDeleteTarget(item)}
                            title={t('files.delete', '删除')}
                            className="p-1 rounded hover:bg-slate-700/50 text-slate-400 hover:text-rose-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>
      )}

      {/* Modal: New Folder */}
      {newFolderOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <form
            onSubmit={handleCreateFolder}
            className="ui-card w-full max-w-sm p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl"
          >
            <h3 className="text-sm font-semibold mb-3 flex items-center space-x-2">
              <FolderPlus className="w-4 h-4 text-amber-400" />
              <span>{t('files.createFolderTitle', '新建文件夹')}</span>
            </h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t('files.folderNamePlaceholder', '输入文件夹名称')}
              autoFocus
              className="w-full px-3 py-1.5 mb-4 rounded-lg bg-[var(--bg-surface-sub)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)] focus:outline-hidden focus:border-indigo-500"
            />
            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => {
                  setNewFolderOpen(false);
                  setNewFolderName('');
                }}
                className="px-3 py-1 rounded-lg border border-[var(--border-subtle)] text-xs text-slate-400 hover:text-white"
              >
                {t('files.cancel', '取消')}
              </button>
              <button
                type="submit"
                disabled={!newFolderName.trim()}
                className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium"
              >
                {t('files.confirm', '确定')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Rename */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <form
            onSubmit={handleRename}
            className="ui-card w-full max-w-sm p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl"
          >
            <h3 className="text-sm font-semibold mb-3 flex items-center space-x-2">
              <Edit2 className="w-4 h-4 text-amber-400" />
              <span>{t('files.renameTitle', '重命名')}</span>
            </h3>
            <input
              type="text"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              placeholder={t('files.newNamePlaceholder', '输入新名称')}
              autoFocus
              className="w-full px-3 py-1.5 mb-4 rounded-lg bg-[var(--bg-surface-sub)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)] focus:outline-hidden focus:border-indigo-500"
            />
            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => {
                  setRenameTarget(null);
                  setRenameInput('');
                }}
                className="px-3 py-1 rounded-lg border border-[var(--border-subtle)] text-xs text-slate-400 hover:text-white"
              >
                {t('files.cancel', '取消')}
              </button>
              <button
                type="submit"
                disabled={!renameInput.trim() || renameInput === renameTarget.name}
                className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium"
              >
                {t('files.confirm', '确定')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Delete Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="ui-card w-full max-w-sm p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl">
            <h3 className="text-sm font-semibold mb-2 text-rose-400 flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4" />
              <span>{t('files.delete', '删除')}</span>
            </h3>
            <p className="text-xs text-slate-300 mb-4">
              {t('files.deleteConfirm', '确定要删除 "{name}" 吗？此操作不可逆！').replace('{name}', deleteTarget.name)}
            </p>
            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-3 py-1 rounded-lg border border-[var(--border-subtle)] text-xs text-slate-400 hover:text-white"
              >
                {t('files.cancel', '取消')}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center space-x-1 px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium"
              >
                {deleting && <Loader2 className="w-3 h-3 animate-spin" />}
                <span>{t('files.delete', '删除')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Text/Code Editor */}
      {editorTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-2 sm:p-4">
          <div className="ui-card w-full max-w-5xl h-[90vh] flex flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="p-3 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0 bg-[var(--bg-surface-sub)]">
              <div className="flex items-center space-x-2 min-w-0">
                {renderItemIcon(editorTarget.file)}
                <span className="font-semibold text-xs sm:text-sm text-slate-200 truncate" title={editorTarget.file.path}>
                  {editorTarget.file.name}
                </span>
                <span className="text-[10px] text-slate-400 font-mono px-1.5 py-0.5 rounded bg-black/30 hidden sm:inline">
                  {formatFileSize(editorTarget.file.size)}
                </span>
                {editorTarget.savedAlert && (
                  <span className="text-[10px] text-emerald-400 font-medium animate-pulse flex items-center space-x-1">
                    <Check className="w-3 h-3" />
                    <span>{t('files.saved', '文件保存成功！')}</span>
                  </span>
                )}
              </div>

              <div className="flex items-center space-x-2 shrink-0">
                <button
                  onClick={() => handleDownload(editorTarget.file)}
                  title={t('files.download', '下载')}
                  className="flex items-center space-x-1 px-2 py-1 rounded border border-[var(--border-subtle)] text-slate-300 hover:text-white text-xs"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t('files.download', '下载')}</span>
                </button>

                {!editorTarget.isBinary && (
                  <button
                    onClick={handleSaveEditor}
                    disabled={editorTarget.saving || editorTarget.loading}
                    className="flex items-center space-x-1 px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
                  >
                    {editorTarget.saving ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Save className="w-3.5 h-3.5" />
                    )}
                    <span>{t('files.save', '保存 (Ctrl+S)')}</span>
                  </button>
                )}

                <button
                  onClick={() => setEditorTarget(null)}
                  className="p-1 rounded hover:bg-slate-700/50 text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Editor Content Area */}
            <div className="flex-1 min-h-0 relative">
              {editorTarget.loading ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-500 mb-2" />
                  <span className="text-xs">{t('files.loading', '加载中...')}</span>
                </div>
              ) : editorTarget.error ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-rose-400">
                  <AlertTriangle className="w-8 h-8 mb-2" />
                  <span className="text-sm font-medium">{editorTarget.error}</span>
                </div>
              ) : editorTarget.isBinary ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-slate-400">
                  <File className="w-12 h-12 text-slate-500 mb-3" />
                  <p className="text-xs sm:text-sm max-w-md mb-4 text-slate-300">
                    {t('files.unsupportedPreview', '此文件为二进制格式，暂不支持在线预览。您可以直接下载查看。')}
                  </p>
                  <button
                    onClick={() => handleDownload(editorTarget.file)}
                    className="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium"
                  >
                    <Download className="w-4 h-4" />
                    <span>{t('files.download', '下载文件')}</span>
                  </button>
                </div>
              ) : (
                <Editor
                  height="100%"
                  language={getMonacoLanguage(editorTarget.file.extension)}
                  theme={monacoTheme}
                  beforeMount={defineGeminiProxyTheme}
                  value={editorTarget.content}
                  onChange={(val) => {
                    setEditorTarget(prev => prev ? { ...prev, content: val || '' } : null);
                  }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                    lineNumbers: 'on',
                    automaticLayout: true,
                    tabSize: 2,
                    wordWrap: 'on',
                    padding: { top: 12, bottom: 12 },
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: Image Preview */}
      {imagePreviewTarget && (
        <TerminalImagePreviewModal
          file={imagePreviewTarget.file}
          blobUrl={imagePreviewTarget.blobUrl}
          onClose={() => setImagePreviewTarget(null)}
          onDownload={handleDownload}
        />
      )}
    </div>
  );
});

export default TerminalFileManagerView;

