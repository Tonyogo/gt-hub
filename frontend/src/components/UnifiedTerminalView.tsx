import React, { useState, useRef, useEffect, useCallback } from 'react';
import WebTerminalView, { WebTerminalHandle } from './WebTerminalView';
import TerminalFileManagerView, { TerminalFileManagerHandle } from './terminal/TerminalFileManagerView';
import TerminalCronView, { TerminalCronHandle } from './terminal/TerminalCronView';
import TerminalTaskView, { TerminalTaskHandle } from './terminal/TerminalTaskView';
import TerminalProxyView, { TerminalProxyHandle } from './terminal/TerminalProxyView';
import { TerminalHostSelector } from './terminal/TerminalHostSelector';
import {
  TerminalSquare,
  FolderOpen,
  Clock,
  Activity,
  Globe,
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
  Columns2,
  X,
} from 'lucide-react';
import { useTranslation } from '../i18n/LanguageContext';
import { useTheme } from '../theme/ThemeContext';
import { calculateKeyboardTranslateY } from '../utils/mobileViewportHelper';
import { apiFetch, onUnauthorized, getStoredAdminKey } from '../utils/apiClient';
import {
  isFullscreenActive,
  toggleBrowserFullscreen,
  onFullscreenChange,
} from '../utils/browserFullscreenHelper';
import { formatTimezoneOffset } from '../utils/timeHelpers';

export interface UnifiedTerminalViewProps {
  adminKey?: string;
  isStandalone?: boolean;
  onEnterStandalone?: () => void;
  onExitStandalone?: () => void;
  onLogout?: () => void;
}

export type TerminalSubTab = 'interactive' | 'files' | 'cron' | 'tasks' | 'proxy';


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
    return propAdminKey || getStoredAdminKey() || (typeof localStorage !== 'undefined' ? localStorage.getItem('admin_secret_key') || '' : '');
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
  const splitTerminalRef = useRef<WebTerminalHandle>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const fileManagerRef = useRef<TerminalFileManagerHandle>(null);
  const cronRef = useRef<TerminalCronHandle>(null);
  const taskRef = useRef<TerminalTaskHandle>(null);
  const proxyRef = useRef<TerminalProxyHandle>(null);
  const [serverTimezone, setServerTimezone] = useState<string>('');

  const [isSplitMode, setIsSplitMode] = useState<boolean>(() => {
    return localStorage.getItem('terminal_split_enabled') === 'true';
  });
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const saved = localStorage.getItem('terminal_split_ratio');
    if (!saved) return 50;
    const parsed = parseInt(saved, 10);
    if (Number.isNaN(parsed)) return 50;
    return Math.max(20, Math.min(80, parsed));
  });
  const [activePane, setActivePane] = useState<'main' | 'split'>('main');
  const isDraggingSplitterRef = useRef<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    const fetchServerTimezone = async () => {
      try {
        const headers: Record<string, string> = {};
        const key = adminKey || getStoredAdminKey();
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

  const getActiveTerminalRef = useCallback((): WebTerminalHandle | null => {
    if (isSplitMode && activePane === 'split') {
      return splitTerminalRef.current;
    }
    return terminalRef.current;
  }, [isSplitMode, activePane]);

  const fitAllPanes = useCallback((force: boolean = false) => {
    terminalRef.current?.fit(force);
    if (isSplitMode) {
      splitTerminalRef.current?.fit(force);
    }
  }, [isSplitMode]);

  const openSplitPane = useCallback(() => {
    setIsSplitMode(true);
    localStorage.setItem('terminal_split_enabled', 'true');
    setActivePane('split');
    setTimeout(() => {
      terminalRef.current?.fit(true);
      splitTerminalRef.current?.fit(true);
      splitTerminalRef.current?.focus();
    }, 100);
  }, []);

  const closeSplitPane = useCallback((notifyBackend: boolean = true) => {
    if (notifyBackend) {
      splitTerminalRef.current?.closePaneSession();
    }
    setIsSplitMode(false);
    localStorage.setItem('terminal_split_enabled', 'false');
    setActivePane('main');
    setTimeout(() => {
      terminalRef.current?.fit(true);
      terminalRef.current?.focus();
    }, 100);
  }, []);

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingSplitterRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingSplitterRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const rawRatio = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(20, Math.min(80, Math.round(rawRatio)));
      setSplitRatio(clamped);
      localStorage.setItem('terminal_split_ratio', String(clamped));
      requestAnimationFrame(() => {
        terminalRef.current?.fit();
        splitTerminalRef.current?.fit();
      });
    };

    const onMouseUp = () => {
      isDraggingSplitterRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      terminalRef.current?.fit(true);
      splitTerminalRef.current?.fit(true);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  const handleSplitterTouchStart = useCallback((e: React.TouchEvent) => {
    isDraggingSplitterRef.current = true;

    const onTouchMove = (moveEvent: TouchEvent) => {
      if (!isDraggingSplitterRef.current || !splitContainerRef.current || moveEvent.touches.length === 0) return;
      const touch = moveEvent.touches[0];
      const rect = splitContainerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const rawRatio = ((touch.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(20, Math.min(80, Math.round(rawRatio)));
      setSplitRatio(clamped);
      localStorage.setItem('terminal_split_ratio', String(clamped));
      requestAnimationFrame(() => {
        terminalRef.current?.fit();
        splitTerminalRef.current?.fit();
      });
    };

    const onTouchEnd = () => {
      isDraggingSplitterRef.current = false;
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      terminalRef.current?.fit(true);
      splitTerminalRef.current?.fit(true);
    };

    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
  }, []);

  const handleSplitterDoubleClick = useCallback(() => {
    setSplitRatio(50);
    localStorage.setItem('terminal_split_ratio', '50');
    setTimeout(() => {
      terminalRef.current?.fit(true);
      splitTerminalRef.current?.fit(true);
    }, 50);
  }, []);

  useEffect(() => {
    if (subTab !== 'interactive') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey) return;

      if (e.code === 'KeyD' || e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (isSplitMode) {
          closeSplitPane(true);
        } else {
          openSplitPane();
        }
        return;
      }

      if (e.code === 'KeyW' || e.key.toLowerCase() === 'w') {
        if (isSplitMode) {
          e.preventDefault();
          closeSplitPane(true);
        }
        return;
      }

      if (e.key === 'ArrowLeft' || e.code === 'ArrowLeft') {
        if (isSplitMode) {
          e.preventDefault();
          setActivePane('main');
          terminalRef.current?.focus();
        }
        return;
      }

      if (e.key === 'ArrowRight' || e.code === 'ArrowRight') {
        if (isSplitMode) {
          e.preventDefault();
          setActivePane('split');
          splitTerminalRef.current?.focus();
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [subTab, isSplitMode, openSplitPane, closeSplitPane]);

  const handleSubTabChange = useCallback((newTab: TerminalSubTab) => {
    setSubTab(newTab);
    if (newTab === 'interactive') {
      setTimeout(() => {
        fitAllPanes(true);
      }, 50);
      setTimeout(() => {
        fitAllPanes(true);
      }, 200);
    }
  }, [fitAllPanes]);

  const handleFullscreenToggle = useCallback(() => {
    toggleBrowserFullscreen(isMobile).catch(() => {});
  }, [isMobile]);

  const handleResetSession = useCallback(() => {
    if (window.confirm(t('webTerminal.resetConfirm'))) {
      getActiveTerminalRef()?.resetSession();
    }
  }, [t, getActiveTerminalRef]);

  const handleToggleSelectMode = useCallback(() => {
    getActiveTerminalRef()?.toggleSelectMode();
  }, [getActiveTerminalRef]);

  useEffect(() => {
    if (subTab === 'interactive' && activeHostId) {
      const t1 = setTimeout(() => {
        terminalRef.current?.fit(true);
        splitTerminalRef.current?.fit(true);
      }, 60);
      const t2 = setTimeout(() => {
        terminalRef.current?.fit();
        splitTerminalRef.current?.fit();
      }, 200);
      const t3 = setTimeout(() => {
        terminalRef.current?.fit();
        splitTerminalRef.current?.fit();
      }, 500);
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
        fitAllPanes();
      }
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [subTab, isMobile, fitAllPanes]);

  return (
    <div
      className={`mx-auto flex flex-col bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-hidden shadow-2xl font-mono text-xs transition-none ${
        isStandalone
          ? 'fixed inset-0 z-50 rounded-none h-[100dvh] w-screen overflow-hidden overscroll-none border-none'
          : 'w-full h-full flex-1 min-h-[420px] md:max-w-7xl md:h-[calc(100vh-140px)] md:min-h-[500px] rounded-none md:rounded-2xl border-x-0 md:border-x border-t-0 md:border-t'
      }`}
    >
      {/* Top Window Bar */}
      <div ref={headerRef} className="bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)] px-2 sm:px-4 py-1.5 sm:py-2 flex items-center justify-between gap-1.5 sm:gap-2 select-none shrink-0 sticky top-0 z-30">
        <div className="flex items-center space-x-1 sm:space-x-2 min-w-0 flex-1 overflow-hidden">
          {/* Back to Console (Standalone Mode) */}
          {isStandalone && onExitStandalone && (
            <button
              type="button"
              onClick={onExitStandalone}
              className="mr-1 px-1.5 sm:px-2 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-slate-300 hover:text-white border border-white/[0.08] transition-all flex items-center space-x-1 text-xs active:scale-95 shrink-0"
              title={t('webTerminal.backToDashboard')}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span className="hidden lg:inline font-sans text-[11px]">{t('webTerminal.backToDashboard')}</span>
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

          <div className="h-4 w-px bg-[var(--border-subtle)] hidden sm:block shrink-0" />

          {/* SubTab Toggle Pills */}
          <div className="flex items-center p-0.5 rounded-xl bg-[var(--bg-surface-sub)] border border-[var(--border-subtle)] shrink-0">
            <button
              type="button"
              onClick={() => handleSubTabChange('interactive')}
              title={t('terminal.interactiveTab', '命令行终端')}
              className={`flex items-center space-x-1 lg:space-x-1.5 px-2 lg:px-2.5 py-1 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                subTab === 'interactive'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <TerminalSquare className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden md:inline">{t('terminal.interactiveTab', '命令行终端')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSubTabChange('files')}
              title={t('files.title', '文件管理')}
              className={`flex items-center space-x-1 lg:space-x-1.5 px-2 lg:px-2.5 py-1 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                subTab === 'files'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FolderOpen className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden md:inline">{t('files.title', '文件管理')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSubTabChange('cron')}
              title={t('cron.title', '定时任务')}
              className={`flex items-center space-x-1 lg:space-x-1.5 px-2 lg:px-2.5 py-1 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                subTab === 'cron'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Clock className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden md:inline">{t('cron.title', '定时任务')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSubTabChange('tasks')}
              title={t('tasks.tabName', '任务管理')}
              className={`flex items-center space-x-1 lg:space-x-1.5 px-2 lg:px-2.5 py-1 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                subTab === 'tasks'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Activity className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden md:inline">{t('tasks.tabName', '任务管理')}</span>
            </button>
            <button
              type="button"
              data-testid="subtab-proxy"
              onClick={() => handleSubTabChange('proxy')}
              title={t('proxy.tabName', '网络代理')}
              className={`flex items-center space-x-1 lg:space-x-1.5 px-2 lg:px-2.5 py-1 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                subTab === 'proxy'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Globe className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden md:inline">{t('proxy.tabName', '网络代理')}</span>
            </button>
          </div>

          {/* Global Server Timezone Badge (Concise UTC Offset format, e.g. UTC+8) */}
          {serverTimezone && (
            <div
              className="hidden sm:flex items-center space-x-1 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-lg bg-black/30 border border-white/[0.06] text-slate-300 font-mono text-[11px] shrink-0 whitespace-nowrap cursor-default"
              title={`${t('common.serverTimezone', '服务器时区')}: ${serverTimezone}`}
            >
              <span className="text-xs">🌐</span>
              <span>{formatTimezoneOffset(serverTimezone)}</span>
            </div>
          )}
        </div>


        {/* Action Buttons */}
        <div className="flex items-center space-x-0.5 sm:space-x-1 lg:space-x-1.5 shrink-0">
          {subTab === 'interactive' && (
            <>
              {/* Zoom Out */}
              <button
                type="button"
                onClick={() => {
                  terminalRef.current?.zoomOut();
                  if (isSplitMode) {
                    splitTerminalRef.current?.zoomOut();
                  }
                }}
                className="hidden lg:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
                title="Zoom Out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>

              {/* Zoom In */}
              <button
                type="button"
                onClick={() => {
                  terminalRef.current?.zoomIn();
                  if (isSplitMode) {
                    splitTerminalRef.current?.zoomIn();
                  }
                }}
                className="hidden lg:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
                title="Zoom In"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>

              {/* Reconnect */}
              <button
                type="button"
                onClick={() => getActiveTerminalRef()?.reconnect()}
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
                className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white border border-white/[0.06] transition-all items-center space-x-1 text-xs whitespace-nowrap"
                onClick={() => getActiveTerminalRef()?.openScriptDrawer()}
                title={t('scripts.title', '常用脚本库')}
              >
                <ScrollText className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span className="hidden xl:inline font-sans text-[11px]">{t('scripts.title', '常用脚本库')}</span>
              </button>

              {/* Split Terminal Toggle Button */}
              <button
                type="button"
                data-testid="split-terminal-btn"
                onClick={() => {
                  if (isSplitMode) {
                    closeSplitPane(true);
                  } else {
                    openSplitPane();
                  }
                }}
                className={`p-1 sm:p-1.5 rounded-lg border transition-all ${
                  isSplitMode
                    ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
                    : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06]'
                }`}
                title={isSplitMode ? t('webTerminal.closeSplitPane', '关闭分屏') : t('webTerminal.splitPane', '左右分屏')}
              >
                <Columns2 className="w-3.5 h-3.5" />
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

          {subTab === 'proxy' && (
            <button
              type="button"
              onClick={() => proxyRef.current?.refresh()}
              className="p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
              title={t('proxy.refresh', '刷新')}
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
                      data-testid="mobile-split-terminal-btn"
                      onClick={() => {
                        if (isSplitMode) {
                          closeSplitPane(true);
                        } else {
                          openSplitPane();
                        }
                        setIsMoreMenuOpen(false);
                      }}
                      className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
                    >
                      <Columns2 className="w-3.5 h-3.5 text-indigo-400" />
                      <span>{isSplitMode ? t('webTerminal.closeSplitPane', '关闭分屏') : t('webTerminal.splitPane', '左右分屏')}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        getActiveTerminalRef()?.openScriptDrawer();
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
                        getActiveTerminalRef()?.reconnect();
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
        <div
          ref={splitContainerRef}
          className={`flex-1 min-h-0 ${subTab === 'interactive' ? 'flex' : 'hidden'} ${isSplitMode ? 'flex-row' : 'flex-col'} relative overflow-hidden`}
        >
          {/* Main Terminal Pane */}
          <div
            style={isSplitMode ? { width: `${splitRatio}%` } : undefined}
            className={`h-full flex flex-col min-w-0 min-h-0 relative ${
              isSplitMode
                ? activePane === 'main'
                  ? 'border-r border-indigo-500/40 ring-1 ring-indigo-500/20'
                  : 'border-r border-white/[0.06]'
                : 'w-full flex-1'
            }`}
          >
            {isSplitMode && (
              <div className="flex items-center justify-between px-2 py-0.5 bg-black/40 border-b border-white/[0.06] text-[10px] select-none text-slate-400 shrink-0">
                <div className="flex items-center space-x-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${activePane === 'main' ? 'bg-indigo-400 ring-2 ring-indigo-400/30' : 'bg-slate-600'}`} />
                  <span className={activePane === 'main' ? 'font-semibold text-slate-200' : 'text-slate-400'}>
                    {t('webTerminal.paneMain', '终端 #1')}
                  </span>
                </div>
              </div>
            )}
            <div className="flex-1 min-h-0 min-w-0 h-full relative">
              <WebTerminalView
                ref={terminalRef}
                paneId="main"
                isFocusedPane={!isSplitMode || activePane === 'main'}
                onFocusPane={() => setActivePane('main')}
                adminKey={adminKey}
                hideHeader={true}
                standalone={Boolean(isStandalone)}
                isActive={subTab === 'interactive'}
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
          </div>

          {/* Draggable Vertical Splitter Divider */}
          {isSplitMode && (
            <div
              data-testid="terminal-split-divider"
              onMouseDown={handleSplitterMouseDown}
              onTouchStart={handleSplitterTouchStart}
              onDoubleClick={handleSplitterDoubleClick}
              className="w-1.5 hover:w-2 bg-[var(--border-subtle)] hover:bg-indigo-500/50 cursor-col-resize transition-all shrink-0 z-20 flex items-center justify-center select-none"
              title="双击恢复 50% 居中，拖拽调整比例"
            >
              <div className="w-0.5 h-6 bg-slate-500/40 rounded-full" />
            </div>
          )}

          {/* Secondary Split Terminal Pane */}
          {isSplitMode && (
            <div
              style={{ width: `${100 - splitRatio}%` }}
              className={`h-full flex flex-col min-w-0 min-h-0 relative ${
                activePane === 'split'
                  ? 'ring-1 ring-indigo-500/20'
                  : ''
              }`}
            >
              <div className="flex items-center justify-between px-2 py-0.5 bg-black/40 border-b border-white/[0.06] text-[10px] select-none text-slate-400 shrink-0">
                <div className="flex items-center space-x-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${activePane === 'split' ? 'bg-indigo-400 ring-2 ring-indigo-400/30' : 'bg-slate-600'}`} />
                  <span className={activePane === 'split' ? 'font-semibold text-slate-200' : 'text-slate-400'}>
                    {t('webTerminal.paneSplit', '终端 #2')}
                  </span>
                </div>
                <button
                  type="button"
                  data-testid="close-split-pane-btn"
                  onClick={() => closeSplitPane(true)}
                  className="p-0.5 rounded hover:bg-white/[0.1] text-slate-400 hover:text-white transition-colors"
                  title={t('webTerminal.closeSplitPane', '关闭分屏')}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="flex-1 min-h-0 min-w-0 h-full relative">
                <WebTerminalView
                  ref={splitTerminalRef}
                  paneId="split"
                  isFocusedPane={activePane === 'split'}
                  onFocusPane={() => setActivePane('split')}
                  onPaneExit={() => closeSplitPane(false)}
                  adminKey={adminKey}
                  hideHeader={true}
                  standalone={Boolean(isStandalone)}
                  isActive={subTab === 'interactive'}
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
            </div>
          )}
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

        <div className={`flex-1 min-h-0 ${subTab === 'proxy' ? 'flex' : 'hidden'} flex-col`}>
          <TerminalProxyView
            ref={proxyRef}
            adminKey={adminKey}
            activeHostId={activeHostId}
            isConnected={connectionStatus.isConnected}
            isActive={subTab === 'proxy'}
            onRequestAddNode={() => setIsAddNodeModalOpen(true)}
          />
        </div>
      </div>

    </div>
  );
}
