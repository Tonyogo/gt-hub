import React, { useState, useRef, useEffect, useCallback } from 'react';
import WebTerminalView, { WebTerminalHandle } from './WebTerminalView';
import TerminalFileManagerView, { TerminalFileManagerHandle } from './terminal/TerminalFileManagerView';
import TerminalCronView, { TerminalCronHandle } from './terminal/TerminalCronView';
import TerminalTaskView, { TerminalTaskHandle } from './terminal/TerminalTaskView';
import { TerminalHostSelector } from './terminal/TerminalHostSelector';
import {
  TerminalSquare,
  FolderOpen,
  Clock,
  Activity,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  RefreshCw,
  Trash2,
  TextSelect,
  ArrowLeft,
  Github,
  Languages,
  Sun,
  Moon,
  LogOut,
  ScrollText,
  MoreVertical,
} from 'lucide-react';
import { useTranslation } from '../i18n/LanguageContext';
import { useTheme } from '../theme/ThemeContext';
import { calculateKeyboardTranslateY } from '../utils/mobileViewportHelper';
import { apiFetch, onUnauthorized } from '../utils/apiClient';
import {
  isFullscreenActive,
  toggleBrowserFullscreen,
  onFullscreenChange,
} from '../utils/browserFullscreenHelper';

export interface UnifiedTerminalViewProps {
  adminKey?: string;
  isStandalone?: boolean;
  onEnterStandalone?: () => void;
  onExitStandalone?: () => void;
  onLogout?: () => void;
}

export type TerminalSubTab = 'interactive' | 'files' | 'cron' | 'tasks';


export default function UnifiedTerminalView({
  adminKey: propAdminKey,
  isStandalone = true,
  onEnterStandalone,
  onExitStandalone,
  onLogout,
}: UnifiedTerminalViewProps) {
  const { t, language, setLanguage } = useTranslation();
  const { setTheme, resolvedTheme } = useTheme();
  const [adminKey, setAdminKey] = useState<string>(() => {
    return propAdminKey || (typeof window !== 'undefined' ? localStorage.getItem('admin_secret_key') || '' : '');
  });

  useEffect(() => {
    if (propAdminKey !== undefined) {
      setAdminKey(propAdminKey);
    }
  }, [propAdminKey]);

  // Auto-logout on 401 unauthorized responses from terminal API
  useEffect(() => {
    if (!onLogout) return;
    return onUnauthorized(onLogout);
  }, [onLogout]);

  const [subTab, setSubTab] = useState<TerminalSubTab>('interactive');
  const [activeHostId, setActiveHostId] = useState<string>(() => {
    return localStorage.getItem('terminal_active_host') || '';
  });

  const terminalRef = useRef<WebTerminalHandle>(null);
  const fileManagerRef = useRef<TerminalFileManagerHandle>(null);
  const cronRef = useRef<TerminalCronHandle>(null);
  const taskRef = useRef<TerminalTaskHandle>(null);
  const [serverTimezone, setServerTimezone] = useState<string>('');

  useEffect(() => {
    let isMounted = true;
    const fetchServerTimezone = async () => {
      try {
        const headers: Record<string, string> = {};
        const key =
          adminKey ||
          (typeof window !== 'undefined'
            ? localStorage.getItem('gt_admin_key') || localStorage.getItem('admin_secret_key') || ''
            : '');
        if (key) headers['x-admin-key'] = key;
        const res = await apiFetch('/api/terminal/version', { headers });
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.timezone) {
            setServerTimezone(data.timezone);
          }
        }
      } catch {
        // Silently ignore
      }
    };
    fetchServerTimezone();
    return () => {
      isMounted = false;
    };
  }, [adminKey]);


  const [connectionStatus, setConnectionStatus] = useState<{ isConnected: boolean; isConnecting: boolean }>({
    isConnected: false,
    isConnecting: true,
  });
  const [isSelectMode, setIsSelectMode] = useState<boolean>(false);
  const [isAddNodeModalOpen, setIsAddNodeModalOpen] = useState<boolean>(false);
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState<boolean>(() => isFullscreenActive());
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState<boolean>(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMoreMenuOpen) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setIsMoreMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside as EventListener);
    document.addEventListener('touchstart', handleClickOutside as EventListener);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside as EventListener);
      document.removeEventListener('touchstart', handleClickOutside as EventListener);
    };
  }, [isMoreMenuOpen]);

  useEffect(() => {
    return onFullscreenChange((active) => {
      setIsBrowserFullscreen(active);
      setTimeout(() => {
        terminalRef.current?.fit(true);
      }, 150);
    });
  }, []);

  const headerRef = useRef<HTMLDivElement>(null);
  // Mobile Visual Viewport tracking for virtual keyboard positioning in standalone mode
  const [workspaceStyle, setWorkspaceStyle] = useState<React.CSSProperties>({});
  const baseHeightRef = useRef<number>(typeof window !== 'undefined' ? window.innerHeight : 0);
  const isMobile = typeof window !== 'undefined'
    ? window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    : false;

  const isKeyboardShowingRef = useRef<boolean>(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const screenHeight = window.screen ? window.screen.height : 0;
      const currentHeight = window.innerHeight;
      const isNearFullHeight = (
        (screenHeight > 0 ? currentHeight >= screenHeight * 0.72 : true) &&
        (baseHeightRef.current <= 0 || currentHeight >= baseHeightRef.current - 100)
      );
      if (isNearFullHeight) {
        baseHeightRef.current = Math.max(baseHeightRef.current, currentHeight);
      }
    }
  }, [isStandalone]);

  useEffect(() => {
    const handleOrientation = () => {
      if (typeof window !== 'undefined') {
        const screenHeight = window.screen ? window.screen.height : 0;
        const currentHeight = window.innerHeight;
        const isNearFullHeight = (
          (screenHeight > 0 ? currentHeight >= screenHeight * 0.72 : true) &&
          (baseHeightRef.current <= 0 || currentHeight >= baseHeightRef.current - 100)
        );
        if (isNearFullHeight) {
          baseHeightRef.current = currentHeight;
        }
      }
    };
    window.addEventListener('orientationchange', handleOrientation);
    return () => window.removeEventListener('orientationchange', handleOrientation);
  }, []);

  useEffect(() => {
    if (!isStandalone || !isMobile || typeof window === 'undefined' || !window.visualViewport) {
      setWorkspaceStyle({});
      return;
    }

    const handleViewportChange = () => {
      const vv = window.visualViewport;
      if (!vv) return;

      const screenHeight = typeof window !== 'undefined' && window.screen ? window.screen.height : 0;
      const currentHeight = Math.max(window.innerHeight, vv.height);
      const isNearFullHeight = (
        (screenHeight > 0 ? currentHeight >= screenHeight * 0.72 : true) &&
        (baseHeightRef.current <= 0 || currentHeight >= baseHeightRef.current - 100)
      );
      if (isNearFullHeight) {
        baseHeightRef.current = Math.max(baseHeightRef.current, currentHeight);
      }

      // Keep window scroll at top to avoid browser auto-scroll misalignment on mobile
      if (typeof window !== 'undefined' && window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }

      const offsetResult = calculateKeyboardTranslateY({
        baseHeight: baseHeightRef.current,
        viewportHeight: vv.height,
        offsetTop: vv.offsetTop || 0,
      });

      const wasKeyboardShowing = isKeyboardShowingRef.current;
      isKeyboardShowingRef.current = offsetResult.isKeyboardShowing;

      const headerHeight = headerRef.current?.offsetHeight || 44;

      if (offsetResult.isKeyboardShowing) {
        const availableHeight = Math.max(120, vv.height - headerHeight);
        setWorkspaceStyle({
          height: `${availableHeight}px`,
          maxHeight: `${availableHeight}px`,
          flex: 'none',
          transition: 'none',
          overflow: 'hidden',
        });
        // Anchor to bottom and align cursor on keyboard open transition
        if (!wasKeyboardShowing) {
          const _wasAtBottom = terminalRef.current?.isAtBottom ? terminalRef.current.isAtBottom() : false;
          terminalRef.current?.scrollToBottomSafe?.();
        }
        terminalRef.current?.updateCursorShift?.();
      } else {
        setWorkspaceStyle({});
        terminalRef.current?.updateCursorShift?.();
        if (wasKeyboardShowing) {
          terminalRef.current?.scrollToBottomSafe?.();
          if (typeof window !== 'undefined') {
            if (window.scrollY !== 0) {
              window.scrollTo(0, 0);
            }
            setTimeout(() => {
              if (typeof window !== 'undefined' && window.scrollY !== 0) {
                window.scrollTo(0, 0);
              }
              terminalRef.current?.scrollToBottomSafe?.();
            }, 100);
            setTimeout(() => {
              if (typeof window !== 'undefined' && window.scrollY !== 0) {
                window.scrollTo(0, 0);
              }
              terminalRef.current?.scrollToBottomSafe?.();
            }, 320);
          }
        }
      }
    };

    window.visualViewport.addEventListener('resize', handleViewportChange);
    window.visualViewport.addEventListener('scroll', handleViewportChange);
    return () => {
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('scroll', handleViewportChange);
    };
  }, [isStandalone, isMobile]);

  const handleHostChange = useCallback((newHostId: string) => {
    setActiveHostId(newHostId);
    localStorage.setItem('terminal_active_host', newHostId);
  }, []);

  const handleSubTabChange = useCallback((newTab: TerminalSubTab) => {
    setSubTab(newTab);
    if (newTab === 'interactive') {
      setTimeout(() => {
        terminalRef.current?.fit();
      }, 50);
    }
  }, []);

  const handleFullscreenToggle = useCallback(() => {
    toggleBrowserFullscreen(isMobile).catch(() => {});
  }, [isMobile]);

  const handleResetSession = useCallback(() => {
    if (window.confirm(t('webTerminal.resetConfirm'))) {
      terminalRef.current?.resetSession();
    }
  }, [t]);

  const handleToggleSelectMode = useCallback(() => {
    terminalRef.current?.toggleSelectMode();
  }, []);

  useEffect(() => {
    if (subTab === 'interactive' && activeHostId) {
      const t1 = setTimeout(() => terminalRef.current?.fit(), 60);
      const t2 = setTimeout(() => terminalRef.current?.fit(), 200);
      const t3 = setTimeout(() => terminalRef.current?.fit(), 500);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      };
    }
  }, [subTab, activeHostId]);

  useEffect(() => {
    const handleWindowResize = () => {
      if (subTab === 'interactive' && !isMobile) {
        terminalRef.current?.fit();
      }
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [subTab, isMobile]);

  return (
    <div
      className={`mx-auto flex flex-col bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-hidden shadow-2xl font-mono text-xs transition-none ${
        isStandalone
          ? 'fixed inset-0 z-50 rounded-none h-[100dvh] w-screen overflow-hidden overscroll-none border-none'
          : 'w-full h-full flex-1 min-h-[420px] md:max-w-7xl md:h-[calc(100vh-140px)] md:min-h-[500px] rounded-none md:rounded-2xl border-x-0 md:border-x border-t-0 md:border-t'
      }`}
    >
      {/* Top Window Bar */}
      <div ref={headerRef} className="bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)] px-2 sm:px-4 py-1.5 sm:py-2 flex items-center justify-between select-none shrink-0 sticky top-0 z-30">
        <div className="flex items-center space-x-1.5 sm:space-x-2 min-w-0">
          {/* Back to Console (Standalone Mode) */}
          {isStandalone && onExitStandalone && (
            <button
              type="button"
              onClick={onExitStandalone}
              className="mr-1 px-1.5 sm:px-2 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-slate-300 hover:text-white border border-white/[0.08] transition-all flex items-center space-x-1 text-xs active:scale-95"
              title={t('webTerminal.backToDashboard')}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span className="hidden sm:inline font-sans text-[11px]">{t('webTerminal.backToDashboard')}</span>
            </button>
          )}

          {/* Host Node Selector */}
          <TerminalHostSelector
            adminKey={adminKey}
            activeHostId={activeHostId}
            onSelectHost={handleHostChange}
            isAddModalOpen={isAddNodeModalOpen}
            onAddModalOpenChange={setIsAddNodeModalOpen}
            connectionStatus={connectionStatus}
          />

          <div className="h-4 w-px bg-[var(--border-subtle)] hidden sm:block" />

          {/* SubTab Toggle Pills */}
          <div className="flex items-center p-0.5 rounded-xl bg-[var(--bg-surface-sub)] border border-[var(--border-subtle)] shrink-0">
            <button
              type="button"
              onClick={() => handleSubTabChange('interactive')}
              className={`flex items-center space-x-1.5 px-2 sm:px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                subTab === 'interactive'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <TerminalSquare className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('terminal.interactiveTab', '命令行终端')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSubTabChange('files')}
              className={`flex items-center space-x-1.5 px-2 sm:px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                subTab === 'files'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('files.title', '文件管理')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSubTabChange('cron')}
              className={`flex items-center space-x-1.5 px-2 sm:px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                subTab === 'cron'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('cron.title', '定时任务')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSubTabChange('tasks')}
              className={`flex items-center space-x-1.5 px-2 sm:px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                subTab === 'tasks'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('tasks.tabName', '任务管理')}</span>
            </button>
          </div>

          {/* Connection Status Badge (when in interactive tab, desktop only) */}
          {subTab === 'interactive' && (
            <div className="hidden sm:flex items-center space-x-1 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-lg bg-black/30 border border-white/[0.06] text-slate-300 font-mono text-[11px] shrink-0">
              <div
                className={`w-1.5 h-1.5 rounded-full ${
                  !activeHostId
                    ? 'bg-slate-500'
                    : connectionStatus.isConnected
                    ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]'
                    : connectionStatus.isConnecting
                    ? 'bg-amber-400 animate-ping'
                    : 'bg-rose-400'
                }`}
              />
              <span className="hidden sm:inline text-[10px]">
                {!activeHostId
                  ? t('webTerminal.emptyState.noOnlineHosts', '无在线节点')
                  : connectionStatus.isConnected
                  ? t('webTerminal.connected')
                  : connectionStatus.isConnecting
                  ? t('webTerminal.connecting')
                  : t('webTerminal.disconnected')}
              </span>
            </div>
          )}

          {/* Global Server Timezone Badge */}
          {serverTimezone && (
            <div
              className="hidden sm:flex items-center space-x-1 px-2 py-1 rounded-lg bg-black/30 border border-white/[0.06] text-slate-300 font-mono text-[11px] shrink-0"
              title={`${t('common.serverTimezone', '服务器时区')}: ${serverTimezone}`}
            >
              <span className="text-xs">🌐</span>
              <span>{serverTimezone}</span>
            </div>
          )}
        </div>


        {/* Action Buttons */}
        <div className="flex items-center space-x-0.5 sm:space-x-1.5 shrink-0">
          {subTab === 'interactive' && (
            <>
              {/* Zoom Out */}
              <button
                type="button"
                onClick={() => terminalRef.current?.zoomOut()}
                className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
                title="Zoom Out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>

              {/* Zoom In */}
              <button
                type="button"
                onClick={() => terminalRef.current?.zoomIn()}
                className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
                title="Zoom In"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>

              {/* Reconnect */}
              <button
                type="button"
                onClick={() => terminalRef.current?.reconnect()}
                className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
                title={t('webTerminal.reconnect')}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${connectionStatus.isConnecting ? 'animate-spin text-indigo-400' : ''}`} />
              </button>

              {/* Reset Terminal Session */}
              <button
                type="button"
                onClick={handleResetSession}
                className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 border border-white/[0.06] hover:border-rose-500/30 transition-all"
                title={t('webTerminal.resetSession')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              {/* Script Library Drawer Toggle */}
              <button
                type="button"
                data-testid="unified-open-scripts-btn"
                className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white border border-white/[0.06] transition-all items-center space-x-1 text-xs"
                onClick={() => terminalRef.current?.openScriptDrawer()}
                title={t('scripts.title', '常用脚本库')}
              >
                <ScrollText className="w-3.5 h-3.5 text-indigo-400" />
                <span className="hidden md:inline font-sans text-[11px]">{t('scripts.title', '常用脚本库')}</span>
              </button>

              {/* Select / Copy Mode Toggle */}
              <button
                type="button"
                onClick={handleToggleSelectMode}
                className={`p-1 sm:p-1.5 rounded-lg border transition-all flex items-center space-x-1 shrink-0 ${
                  isSelectMode
                    ? 'bg-amber-500/20 text-amber-500 dark:text-amber-300 border-amber-500/40 shadow-sm ring-1 ring-amber-500/30'
                    : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06]'
                }`}
                title={isSelectMode ? t('webTerminal.exitSelectMode', '退出选择') : t('webTerminal.selectMode', '划选模式')}
              >
                <TextSelect className="w-3.5 h-3.5" />
                <span className="text-[11px] hidden xl:inline">
                  {isSelectMode ? t('webTerminal.exitSelectMode', '退出选择') : t('webTerminal.selectMode', '划选模式')}
                </span>
              </button>
            </>
          )}

          {subTab === 'files' && (
            <button
              type="button"
              onClick={() => fileManagerRef.current?.refresh()}
              className="p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
              title={t('files.refresh', '刷新')}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}

          {subTab === 'cron' && (
            <button
              type="button"
              onClick={() => cronRef.current?.refresh()}
              className="p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
              title={t('cron.refresh', '刷新')}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}

          {subTab === 'tasks' && (
            <button
              type="button"
              onClick={() => taskRef.current?.refresh()}
              className="p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
              title={t('tasks.refresh', '刷新')}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}


          {/* Fullscreen Toggle (All devices, landscape mode on mobile) */}
          <button
            type="button"
            data-testid="fullscreen-toggle-btn"
            onClick={handleFullscreenToggle}
            className={`p-1 sm:p-1.5 rounded-lg border transition-all ${
              isBrowserFullscreen
                ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
                : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06]'
            }`}
            title={isBrowserFullscreen ? t('webTerminal.exitFullscreen') : t('webTerminal.fullscreen')}
          >
            {isBrowserFullscreen ? <Minimize2 className="w-3.5 h-3.5 text-indigo-400" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>

          {/* Mobile More Actions Menu */}
          <div className="relative sm:hidden" ref={moreMenuRef}>
            <button
              type="button"
              data-testid="mobile-more-btn"
              onClick={() => setIsMoreMenuOpen((prev) => !prev)}
              className={`p-1 rounded-lg border transition-all ${
                isMoreMenuOpen
                  ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06]'
              }`}
              title="更多操作"
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </button>

            {isMoreMenuOpen && (
              <div
                data-testid="mobile-more-menu"
                className="absolute right-0 top-full mt-1.5 w-48 bg-[#18181b] border border-[#27272a] rounded-xl shadow-2xl py-1 z-50 divide-y divide-white/[0.06] text-xs text-slate-300 animate-in fade-in zoom-in-95 duration-100"
              >
                {subTab === 'interactive' && (
                  <div className="py-1">
                    <button
                      type="button"
                      onClick={() => {
                        terminalRef.current?.openScriptDrawer();
                        setIsMoreMenuOpen(false);
                      }}
                      className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
                    >
                      <ScrollText className="w-3.5 h-3.5 text-indigo-400" />
                      <span>{t('scripts.title', '常用脚本库')}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        terminalRef.current?.reconnect();
                        setIsMoreMenuOpen(false);
                      }}
                      className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
                    >
                      <RefreshCw className="w-3.5 h-3.5 text-indigo-400" />
                      <span>{t('webTerminal.reconnect', '重新连接')}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        handleResetSession();
                        setIsMoreMenuOpen(false);
                      }}
                      className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-rose-500/10 text-rose-300 text-left transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t('webTerminal.resetSession', '重置会话')}</span>
                    </button>
                  </div>
                )}

                <div className="py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setLanguage(language === 'zh' ? 'en' : 'zh');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
                  >
                    <Languages className="w-3.5 h-3.5 text-slate-400" />
                    <span>{language === 'zh' ? 'English' : '简体中文'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
                  >
                    {resolvedTheme === 'dark' ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-indigo-400" />}
                    <span>{resolvedTheme === 'dark' ? '亮色主题' : '暗色主题'}</span>
                  </button>

                  <a
                    href="https://github.com/Tonyogo/gt-hub"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setIsMoreMenuOpen(false)}
                    className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
                  >
                    <Github className="w-3.5 h-3.5 text-slate-400" />
                    <span>GitHub</span>
                  </a>
                </div>

                {onLogout && (
                  <div className="py-1">
                    <button
                      type="button"
                      onClick={() => {
                        onLogout();
                        setIsMoreMenuOpen(false);
                      }}
                      className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-rose-500/10 text-rose-400 text-left transition-colors"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>{t('nav.logout', '退出登录')}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Global Settings Separator */}
          <div className="h-3.5 w-px bg-[var(--border-subtle)] mx-0.5 sm:mx-1 hidden sm:block" />

          {/* GitHub Repository Link */}
          <a
            href="https://github.com/Tonyogo/gt-hub"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all items-center justify-center"
            title={t('nav.github', 'GitHub 仓库')}
          >
            <Github className="w-3.5 h-3.5" />
          </a>

          {/* Language Switcher */}
          <button
            type="button"
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
            title="Toggle Language"
          >
            <Languages className="w-3.5 h-3.5" />
          </button>

          {/* Theme Switcher */}
          <button
            type="button"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
            title="Toggle Theme"
          >
            {resolvedTheme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>

          {/* Logout Action */}
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 border border-white/[0.06] hover:border-rose-500/30 transition-all"
              title={t('nav.logout', '退出登录')}
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Dual Panels Workspace Container */}
      <div
        style={isMobile && isStandalone ? workspaceStyle : undefined}
        className="flex-1 min-h-0 flex flex-col relative overflow-hidden"
      >
        {/* Main Dual Panels Workspace (Preserved via CSS hidden / flex toggle) */}
        <div className={`flex-1 min-h-0 ${subTab === 'interactive' ? 'flex' : 'hidden'} flex-col`}>
          <WebTerminalView
            ref={terminalRef}
            adminKey={adminKey}
            hideHeader={true}
            standalone={Boolean(isStandalone)}
            onExitStandalone={onExitStandalone}
            onToggleStandalone={(val) => {
              if (val && onEnterStandalone) {
                onEnterStandalone();
              } else if (!val && onExitStandalone) {
                onExitStandalone();
              }
            }}
            controlledHostId={activeHostId}
            onControlledHostChange={handleHostChange}
            hideInnerHostSelector={true}
            onConnectionChange={setConnectionStatus}
            onSelectModeChange={setIsSelectMode}
            onRequestAddNode={() => setIsAddNodeModalOpen(true)}
          />
        </div>

        <div className={`flex-1 min-h-0 ${subTab === 'files' ? 'flex' : 'hidden'} flex-col`}>
          <TerminalFileManagerView
            ref={fileManagerRef}
            adminKey={adminKey}
            activeHostId={activeHostId}
            isActive={subTab === 'files'}
            onRequestAddNode={() => setIsAddNodeModalOpen(true)}
          />
        </div>

        <div className={`flex-1 min-h-0 ${subTab === 'cron' ? 'flex' : 'hidden'} flex-col`}>
          <TerminalCronView
            ref={cronRef}
            adminKey={adminKey}
            activeHostId={activeHostId}
            isConnected={connectionStatus.isConnected}
            isActive={subTab === 'cron'}
            onRequestAddNode={() => setIsAddNodeModalOpen(true)}
          />
        </div>

        <div className={`flex-1 min-h-0 ${subTab === 'tasks' ? 'flex' : 'hidden'} flex-col`}>
          <TerminalTaskView
            ref={taskRef}
            adminKey={adminKey}
            activeHostId={activeHostId}
            isConnected={connectionStatus.isConnected}
            isActive={subTab === 'tasks'}
            onRequestAddNode={() => setIsAddNodeModalOpen(true)}
          />
        </div>
      </div>

    </div>
  );
}
