import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Server,
  ChevronDown,
  Check,
  Plus,
  Copy,
  X,
  Search,
  RefreshCw,
  Terminal,
  Trash2,
  Wifi,
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { formatRelativeTime } from '../../utils/timeHelpers';

export interface ManagedHostItem {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  platform: string;
  status: 'online' | 'offline';
  lastSeen: number;
  type: 'agent';
}

export interface TerminalHostSelectorProps {
  adminKey: string;
  activeHostId: string;
  onSelectHost: (hostId: string) => void;
  isAddModalOpen?: boolean;
  onAddModalOpenChange?: (open: boolean) => void;
  connectionStatus?: {
    isConnected: boolean;
    isConnecting: boolean;
  };
}

export function TerminalHostSelector({
  adminKey,
  activeHostId,
  onSelectHost,
  isAddModalOpen: propIsAddModalOpen,
  onAddModalOpenChange,
  connectionStatus,
}: TerminalHostSelectorProps) {
  const { t, lang } = useTranslation();
  const [hosts, setHosts] = useState<ManagedHostItem[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = window.sessionStorage?.getItem('cached_terminal_hosts');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      } catch {}
    }
    return [];
  });
  const hasLoadedRef = useRef<boolean>(false);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [internalAddModalOpen, setInternalAddModalOpen] = useState<boolean>(false);
  const isAddModalOpen = propIsAddModalOpen !== undefined ? propIsAddModalOpen : internalAddModalOpen;
  const setIsAddModalOpen = (open: boolean) => {
    setInternalAddModalOpen(open);
    onAddModalOpenChange?.(open);
  };
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [hideOffline, setHideOffline] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      try {
        return localStorage.getItem('terminal_hide_offline_hosts') === 'true';
      } catch {}
    }
    return false;
  });

  const toggleHideOffline = () => {
    setHideOffline((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('terminal_hide_offline_hosts', String(next));
      } catch {}
      return next;
    });
  };
  const [copied, setCopied] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isClearingOffline, setIsClearingOffline] = useState<boolean>(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{
    top: number;
    left: number;
    width?: number;
    maxHeight?: number;
  }>({ top: 0, left: 0 });

  const updateDropdownPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const dropdownWidth = 320; // sm:w-80 default approx
    const margin = 8;

    // Horizontal boundary clamping
    let left = rect.left;
    if (typeof window !== 'undefined') {
      left = Math.max(margin, Math.min(rect.left, window.innerWidth - dropdownWidth - margin));
    }

    // Vertical boundary checking & flipping
    let top = rect.bottom + 6;
    const popoverHeight = 360;
    if (typeof window !== 'undefined') {
      if (window.innerHeight - rect.bottom < 280 && rect.top > 280) {
        top = Math.max(margin, rect.top - popoverHeight - 6);
      }
    }

    const maxHeight = typeof window !== 'undefined' ? Math.min(380, window.innerHeight - 32) : 380;

    setDropdownPos({
      top,
      left,
      width: dropdownWidth,
      maxHeight,
    });
  }, []);

  const fetchHosts = async () => {
    try {
      setIsLoading(true);
      const effectiveKey = adminKey || (typeof localStorage !== 'undefined' ? localStorage.getItem('adminKey') || '' : '');
      const res = await fetch('/api/terminal/hosts', {
        headers: effectiveKey ? { 'x-admin-key': effectiveKey } : {},
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.hosts)) {
          setHosts(data.hosts);
          try {
            window.sessionStorage?.setItem('cached_terminal_hosts', JSON.stringify(data.hosts));
          } catch {}
        }
      }
    } catch {
      // Ignore network fetch error
    } finally {
      setIsLoading(false);
      hasLoadedRef.current = true;
    }
  };

  const handleClearOfflineHosts = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(t('webTerminal.hostSelector.clearOfflineConfirm', '确定清除所有离线节点吗？'))) {
      return;
    }
    try {
      setIsClearingOffline(true);
      const effectiveKey = adminKey || (typeof localStorage !== 'undefined' ? localStorage.getItem('adminKey') || '' : '');
      const res = await fetch('/api/terminal/hosts/offline', {
        method: 'DELETE',
        headers: effectiveKey ? { 'x-admin-key': effectiveKey } : {},
      });
      if (res.ok) {
        await fetchHosts();
      }
    } catch {
      // Ignore error
    } finally {
      setIsClearingOffline(false);
    }
  };

  useEffect(() => {
    fetchHosts();
    const interval = setInterval(fetchHosts, 10000);
    return () => clearInterval(interval);
  }, [adminKey]);

  // Auto-switch to first online host if current activeHostId is absent or invalid
  useEffect(() => {
    // Prevent wiping activeHostId before the initial fetch completes when local state is empty
    if (!hasLoadedRef.current && hosts.length === 0) {
      return;
    }

    if (hosts.length === 0) {
      if (activeHostId) {
        onSelectHost('');
      }
      return;
    }

    const currentHost = hosts.find((h) => h.id === activeHostId);
    if (!currentHost || currentHost.status !== 'online') {
      const firstOnline = hosts.find((h) => h.status === 'online');
      if (firstOnline) {
        if (firstOnline.id !== activeHostId) {
          onSelectHost(firstOnline.id);
        }
      } else if (!currentHost && hosts.length > 0) {
        onSelectHost(hosts[0].id);
      }
    }
  }, [hosts, activeHostId, onSelectHost]);

  useEffect(() => {
    if (!isOpen) return;
    updateDropdownPosition();

    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        popoverRef.current &&
        !popoverRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    const handleWindowChange = () => {
      updateDropdownPosition();
    };

    document.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [isOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!isAddModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsAddModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAddModalOpen]);

  const activeHost = useMemo(() => {
    return hosts.find((h) => h.id === activeHostId) || null;
  }, [hosts, activeHostId]);

  const filteredHosts = useMemo(() => {
    let list = hosts;
    if (hideOffline) {
      list = list.filter((h) => h.status === 'online');
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (h) =>
          h.name.toLowerCase().includes(q) ||
          h.id.toLowerCase().includes(q) ||
          h.ip.toLowerCase().includes(q) ||
          h.platform.toLowerCase().includes(q)
      );
    }

    // Defensive deduplication by name (online takes precedence over offline)
    const nameMap = new Map<string, ManagedHostItem>();
    for (const h of list) {
      const existing = nameMap.get(h.name);
      if (!existing) {
        nameMap.set(h.name, h);
      } else if (h.status === 'online' && existing.status !== 'online') {
        nameMap.set(h.name, h);
      } else if (h.status === existing.status && (h.lastSeen || 0) > (existing.lastSeen || 0)) {
        nameMap.set(h.name, h);
      }
    }

    return Array.from(nameMap.values()).sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'online' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [hosts, searchQuery, hideOffline]);

  const onlineCount = useMemo(() => hosts.filter((h) => h.status === 'online').length, [hosts]);
  const hasOfflineHosts = useMemo(() => hosts.some((h) => h.status === 'offline'), [hosts]);

  const agentCommand = useMemo(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
    const effectiveKey = adminKey || (typeof localStorage !== 'undefined' ? localStorage.getItem('adminKey') || '' : '');
    return `gt login "${origin}" "${effectiveKey}" && gt run -d --name="my-server"`;
  }, [adminKey]);

  const handleCopyCommand = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(agentCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const popoverContent = isOpen && typeof document !== 'undefined' ? (
    <div
      ref={popoverRef}
      style={{
        position: 'fixed',
        top: `${dropdownPos.top}px`,
        left: `${dropdownPos.left}px`,
        maxHeight: dropdownPos.maxHeight ? `${dropdownPos.maxHeight}px` : undefined,
      }}
      className="w-72 sm:w-80 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] shadow-2xl z-[9999] overflow-hidden animate-in fade-in zoom-in-95 font-sans flex flex-col"
    >
      {/* Header with Search, Add Node Button & Clear Offline */}
      <div className="p-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-sub)]/50 space-y-2 shrink-0">
        <div className="flex items-center justify-between text-xs px-1">
          <span className="font-semibold text-[var(--text-secondary)] flex items-center space-x-1.5">
            <Server className="w-3.5 h-3.5 text-indigo-400" />
            <span>
              {t('webTerminal.hostSelector.hostsCount', {
                online: onlineCount.toString(),
                total: hosts.length.toString(),
              })
                .replace('{online}', onlineCount.toString())
                .replace('{total}', hosts.length.toString())}
            </span>
          </span>

          <div className="flex items-center space-x-1.5">
            {hasOfflineHosts && (
              <button
                type="button"
                onClick={handleClearOfflineHosts}
                disabled={isClearingOffline}
                className="flex items-center space-x-1 px-1.5 py-0.5 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-[11px] font-medium transition-all active:scale-95 cursor-pointer disabled:opacity-50"
                title={t('webTerminal.hostSelector.clearOfflineTooltip', '清除当前所有已离线的主机节点')}
              >
                <Trash2 className="w-3 h-3" />
                <span>{t('webTerminal.hostSelector.clearOffline', '清理离线')}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setIsAddModalOpen(true);
              }}
              className="flex items-center space-x-1 px-2 py-0.5 rounded-md bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-[11px] font-medium transition-all active:scale-95 cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              <span>{t('webTerminal.hostSelector.addNode')}</span>
            </button>
          </div>
        </div>

        {/* Filter Input */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('webTerminal.hostSelector.filterPlaceholder')}
            className="w-full pl-8 pr-8 py-1 bg-black/[0.04] dark:bg-white/[0.06] border border-[var(--border-subtle)] rounded-lg text-xs text-[var(--text-primary)] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <button
            type="button"
            onClick={toggleHideOffline}
            className={`absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md transition-all ${
              hideOffline
                ? 'text-emerald-400 bg-emerald-500/15 border border-emerald-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            title={hideOffline ? t('webTerminal.hostSelector.showAllHosts') : t('webTerminal.hostSelector.showOnlyOnline')}
          >
            <Wifi className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Host Item List */}
      <div className="max-h-64 sm:max-h-80 overflow-y-auto overscroll-contain p-1 pb-2 divide-y divide-[var(--border-subtle)]/40">
        {filteredHosts.map((h) => {
          const isSelected = h.id === activeHostId;
          const isOnline = h.status === 'online';
          const offlineTooltip = !isOnline && h.lastSeen ? `${t('webTerminal.hostSelector.offlineAt', '最后离线时间: ')}${new Date(h.lastSeen).toLocaleString()}` : undefined;

          return (
            <button
              key={h.id}
              type="button"
              onClick={() => {
                onSelectHost(h.id);
                setIsOpen(false);
              }}
              title={offlineTooltip}
              className={`w-full p-2 rounded-lg flex items-center justify-between text-left transition-all ${
                isSelected
                  ? 'bg-indigo-600/15 text-indigo-300 font-medium'
                  : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.05] text-[var(--text-primary)]'
              }`}
            >
              <div className="flex items-center space-x-2.5 min-w-0">
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                    isSelected
                      ? 'bg-indigo-500/20 text-indigo-400'
                      : isOnline
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : 'bg-slate-500/10 text-slate-400'
                  }`}
                >
                  <Server className="w-4 h-4" />
                </div>

                <div className="min-w-0">
                  <div className="flex items-center space-x-1.5">
                    <span className="text-xs truncate font-mono">
                      {h.name}
                    </span>
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        isOnline ? 'bg-emerald-400' : 'bg-slate-500'
                      }`}
                    />
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] truncate font-mono">
                    {isOnline ? `${h.ip} · ${h.platform}` : `${h.ip} · ${formatRelativeTime(h.lastSeen, lang)}`}
                  </div>
                </div>
              </div>

              {isSelected && <Check className="w-4 h-4 text-indigo-400 shrink-0 ml-2" />}
            </button>
          );
        })}

        {filteredHosts.length === 0 && (
          <div className="p-4 text-center text-xs text-[var(--text-muted)] font-sans space-y-1.5">
            {isLoading ? <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-1 text-indigo-400" /> : null}
            <div>{t('webTerminal.hostSelector.noHosts', '未找到匹配的主机节点')}</div>
            {hideOffline && hasOfflineHosts && (
              <button
                type="button"
                onClick={() => {
                  setHideOffline(false);
                  try {
                    localStorage.setItem('terminal_hide_offline_hosts', 'false');
                  } catch {}
                }}
                className="text-[11px] text-indigo-400 hover:underline inline-flex items-center space-x-1"
              >
                <span>{t('webTerminal.hostSelector.clickToShowAll', '显示全部')}</span>
              </button>
            )}
          </div>
        )}

        {/* Helper tip when no hosts exist */}
        {hosts.length === 0 && !searchQuery.trim() && (
          <div className="p-2.5 bg-indigo-500/5 rounded-lg m-1 border border-indigo-500/10 text-[11px] text-slate-400 font-sans leading-relaxed">
            {t(
              'webTerminal.hostSelector.onlyLocalTip',
              '当前暂无在线主机。点击上方「接入内网新节点」即可通过反向隧道将服务器接入此终端。'
            )}
          </div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="relative inline-flex items-center space-x-1">
      {/* Node Trigger Pill Button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          const nextOpen = !isOpen;
          setIsOpen(nextOpen);
          if (nextOpen) {
            updateDropdownPosition();
            fetchHosts();
          }
        }}
        className={`flex items-center space-x-1.5 px-2 py-1 rounded-lg border text-xs font-mono transition-all select-none active:scale-95 ${
          isOpen
            ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300 shadow-sm'
            : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white border-white/[0.08]'
        }`}
        title={t('webTerminal.hostSelector.switchHostPrompt')}
      >
        <Server className={`w-3.5 h-3.5 shrink-0 ${activeHost && activeHost.status === 'online' ? 'text-emerald-400' : 'text-slate-400'}`} />

        <span className="font-medium text-[11px] max-w-[72px] sm:max-w-[130px] truncate">
          {activeHost ? activeHost.name : t('webTerminal.emptyState.noOnlineHosts', '无在线节点')}
        </span>

        {/* Online/Connection Status Dot */}
        <span className="relative flex items-center justify-center w-2 h-2 shrink-0">
          {!activeHost ? (
            <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
          ) : connectionStatus ? (
            connectionStatus.isConnected ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="absolute w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-60" />
              </>
            ) : connectionStatus.isConnecting ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="absolute w-2 h-2 rounded-full bg-amber-400 animate-ping opacity-60" />
              </>
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
            )
          ) : activeHost.status === 'online' ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="absolute w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-60" />
            </>
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
          )}
        </span>

        <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-180 text-indigo-300' : ''}`} />
      </button>

      {/* Quick Add Node Plus Button Beside Trigger (hidden on mobile to prevent header overcrowding) */}
      <button
        type="button"
        onClick={() => {
          setIsOpen(false);
          setIsAddModalOpen(true);
        }}
        className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] active:scale-95 text-slate-300 hover:text-white border border-white/[0.08] transition-all cursor-pointer shrink-0"
        title={t('webTerminal.hostSelector.addNode', '接入内网新节点')}
        aria-label={t('webTerminal.hostSelector.addNode', '接入内网新节点')}
      >
        <Plus className="w-3.5 h-3.5" />
      </button>

      {/* Host Dropdown Popover via Portal */}
      {typeof document !== 'undefined' && popoverContent && (() => {
        const dropdownPortal = createPortal(popoverContent, document.body);
        return dropdownPortal;
      })()}

      {/* Add Intranet Node Guide Modal */}
      {isAddModalOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in"
          onClick={() => setIsAddModalOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] shadow-2xl overflow-hidden animate-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between bg-[var(--bg-surface-sub)]/60">
              <div className="flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  {t('webTerminal.hostSelector.addNodeTitle')}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.08] transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4 text-xs font-sans">
              <p className="text-[var(--text-secondary)] leading-relaxed">
                {t('webTerminal.hostSelector.addNodeDesc')}
              </p>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                  <span>{t('webTerminal.hostSelector.runOnTarget', '在目标节点运行终端 Agent:')}</span>
                  <span className="font-mono text-emerald-400">{t('webTerminal.emptyState.requirements', 'Node.js 18+ required')}</span>
                </div>

                <div className="relative group">
                  <pre className="p-3 pr-10 rounded-xl bg-black/40 border border-white/[0.08] font-mono text-[11px] text-slate-200 overflow-x-auto whitespace-pre-wrap break-all select-all">
                    {agentCommand}
                  </pre>
                  <button
                    type="button"
                    onClick={handleCopyCommand}
                    className="absolute top-2 right-2 p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white flex items-center justify-center shadow-md transition-all cursor-pointer"
                    title={copied ? t('webTerminal.hostSelector.commandCopied', '命令已复制！') : t('webTerminal.hostSelector.copyCommand', '复制运行命令')}
                    aria-label={copied ? t('webTerminal.hostSelector.commandCopied', '命令已复制！') : t('webTerminal.hostSelector.copyCommand', '复制运行命令')}
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/20 p-3 text-[11px] text-indigo-300 space-y-1">
                <div className="font-semibold flex items-center space-x-1">
                  <span>💡 {t('webTerminal.hostSelector.directTunnelTitle', '反向安全隧道')}</span>
                </div>
                <p className="text-indigo-300/80 leading-normal">
                  {t(
                    'webTerminal.hostSelector.directTunnelDesc',
                    'Agent 启动后会直接与当前代理建立出站 WebSocket 安全长连接，无需公网 IP 和开放端口。连接成功后将立即出现在上方节点列表中。'
                  )}
                </p>
                <p className="text-indigo-300/80 leading-normal pt-1 border-t border-indigo-500/20">
                  {t(
                    'webTerminal.hostSelector.addNodeTip',
                    '可通过 --name 指定持久化机器标识（如 my-server），同名节点重启时将自动复用并更新状态，避免重复卡片。'
                  )}
                </p>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-surface-sub)]/40 flex justify-end">
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] active:scale-95 text-[var(--text-primary)] text-xs font-medium transition-all cursor-pointer"
              >
                {t('webTerminal.done')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

