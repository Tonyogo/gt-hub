import React, { useEffect, useState, useRef } from 'react';
import {
  Terminal as TerminalIcon,
  Search,
  Filter,
  Copy,
  Check,
  Trash2,
  Radio,
  ArrowDownCircle,
  Clock,
  Sparkles,
  Maximize2,
  Minimize2,
  TerminalSquare,
  FileText
} from 'lucide-react';
import { useTranslation } from '../i18n/LanguageContext';

interface LogEntry {
  id?: string;
  level: string;
  message: string;
  timestamp?: string;
  [key: string]: any;
}

export interface TerminalLogsViewProps {
  adminKey: string;
  subTab?: 'interactive' | 'logs';
  onSubTabChange?: (tab: 'interactive' | 'logs') => void;
}

export default function TerminalLogsView({
  adminKey,
  subTab,
  onSubTabChange
}: TerminalLogsViewProps) {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    const streamUrl = `/api/terminal/logs?stream=true${adminKey ? `&x-admin-key=${encodeURIComponent(adminKey)}` : ''}`;

    try {
      eventSource = new EventSource(streamUrl);

      eventSource.onopen = () => setIsConnected(true);
      eventSource.onerror = () => setIsConnected(false);

      eventSource.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === 'history') {
            setLogs(payload.logs || []);
          } else if (payload.type === 'log') {
            const entry = payload.entry || payload.log;
            if (entry) {
              setLogs(prev => [...prev.slice(-499), entry]);
            }
          }
        } catch {
          // ignore parse error
        }
      };
    } catch {
      setIsConnected(false);
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [adminKey]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter(item => {
    if (levelFilter !== 'ALL' && item.level?.toUpperCase() !== levelFilter) {
      return false;
    }
    if (searchTerm && !item.message?.toLowerCase().includes(searchTerm.toLowerCase())) {
      return false;
    }
    return true;
  });

  const handleCopyAll = () => {
    const rawText = filteredLogs.map(l => l.message).join('\n');
    navigator.clipboard.writeText(rawText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Syntax parser for terminal log line
  const renderFormattedLog = (rawMessage: string, defaultLevel: string) => {
    // Check for timestamp pattern like [2026-08-15 12:34:56.789] or 2026-08-15T12:34:56
    const timeMatch = rawMessage.match(/^(\[?\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?)\s*/);
    let remaining = rawMessage;
    let timestampStr = '';

    let shortTimeStr = '';

    if (timeMatch) {
      timestampStr = timeMatch[1];
      remaining = rawMessage.slice(timeMatch[0].length);
      // Extract clean HH:mm:ss for mobile display
      const timeOnlyMatch = timestampStr.match(/(\d{2}:\d{2}:\d{2})/);
      if (timeOnlyMatch) {
        shortTimeStr = timeOnlyMatch[1];
      }
    }

    // Check for level tag like [INFO], [WARN], [ERROR], [DEBUG]
    const levelMatch = remaining.match(/^(\[(INFO|WARN|ERROR|DEBUG|TRACE)\]|(INFO|WARN|ERROR|DEBUG|TRACE):?)\s*/i);
    let levelTag = '';
    let detectedLevel = defaultLevel?.toLowerCase() || 'info';

    if (levelMatch) {
      levelTag = levelMatch[1];
      detectedLevel = (levelMatch[2] || levelMatch[3]).toLowerCase();
      remaining = remaining.slice(levelMatch[0].length);
    }

    const levelBadgeClass = (() => {
      switch (detectedLevel) {
        case 'error':
          return 'text-rose-400 bg-rose-500/10 border-rose-500/20 font-semibold';
        case 'warn':
          return 'text-amber-400 bg-amber-500/10 border-amber-500/20 font-medium';
        case 'info':
          return 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20';
        case 'debug':
          return 'text-slate-400 bg-slate-800/60 border-slate-700/50';
        default:
          return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
      }
    })();

    const textColorClass = (() => {
      switch (detectedLevel) {
        case 'error':
          return 'text-rose-300';
        case 'warn':
          return 'text-amber-200';
        case 'info':
          return 'text-slate-200';
        case 'debug':
          return 'text-slate-400';
        default:
          return 'text-slate-300';
      }
    })();

    // Simple JSON highlighting if remainder looks like json object or array
    const isJsonLike = remaining.trim().startsWith('{') || remaining.trim().startsWith('[');

    return (
      <div className="flex items-start space-x-1.5 sm:space-x-2 py-0.5 hover:bg-white/[0.03] px-1.5 sm:px-2 rounded-md transition-colors leading-relaxed group">
        {timestampStr && (
          <span className="text-slate-500 select-none font-mono text-[10px] sm:text-[11px] shrink-0">
            <span className="hidden sm:inline">{timestampStr}</span>
            <span className="inline sm:hidden">{shortTimeStr || timestampStr}</span>
          </span>
        )}
        {levelTag && (
          <span className={`text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.2 rounded border shrink-0 uppercase select-none font-mono ${levelBadgeClass}`}>
            {levelTag.replace(/[\[\]]/g, '')}
          </span>
        )}
        <span className={`font-mono text-[11px] sm:text-xs flex-1 break-all select-text ${textColorClass} ${isJsonLike ? 'text-cyan-200/90' : ''}`}>
          {remaining}
        </span>
      </div>
    );
  };

  return (
    <div className={`mx-auto flex flex-col bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-hidden shadow-2xl font-mono text-xs transition-all ${
      isFullscreen
        ? 'fixed inset-0 z-50 rounded-none h-[100dvh] w-screen'
        : 'w-full h-full md:max-w-7xl md:h-[calc(100vh-140px)] md:min-h-[500px] rounded-none md:rounded-2xl border-x-0 md:border-x border-t-0 md:border-t'
    }`}>
      {/* Top macOS / Linear style window toolbar */}
      <div className="bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)] px-2 sm:px-4 py-1.5 sm:py-2 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 select-none shrink-0">
        {/* Left: Window Dots & Title & Connection Pill */}
        <div className="flex items-center justify-between sm:justify-start space-x-2 sm:space-x-3">
          <div className="flex items-center space-x-2">
            {/* macOS Action Dots */}
            <div className="flex items-center space-x-1.5 mr-0.5 sm:mr-1">
              <div className="w-2.5 h-2.5 rounded-full bg-[#EF4444]/90 border border-[#DC2626]/60 shadow-[0_0_6px_rgba(239,68,68,0.3)]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#F59E0B]/90 border border-[#D97706]/60 shadow-[0_0_6px_rgba(245,158,11,0.3)]" />
              <div
                onClick={() => setIsFullscreen(!isFullscreen)}
                className="w-2.5 h-2.5 rounded-full bg-[#10B981]/90 border border-[#059669]/60 shadow-[0_0_6px_rgba(16,185,129,0.3)] cursor-pointer hover:opacity-80"
                title={isFullscreen ? t('terminal.exitFullscreen', '退出全屏') : t('terminal.fullscreen', '全屏')}
              />
            </div>

            {onSubTabChange ? (
              <div className="ui-tab-container p-0.5 text-[11px] font-medium shrink-0">
                <button
                  type="button"
                  onClick={() => onSubTabChange('interactive')}
                  className={`flex items-center space-x-1.5 px-2 sm:px-2.5 py-1 rounded-lg transition-all ${
                    subTab === 'interactive'
                      ? 'ui-tab-pill-active font-semibold shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <TerminalSquare className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t('terminal.interactiveTab')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onSubTabChange('logs')}
                  className={`flex items-center space-x-1.5 px-2 sm:px-2.5 py-1 rounded-lg transition-all ${
                    (subTab || 'logs') === 'logs'
                      ? 'ui-tab-pill-active font-semibold shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t('terminal.logsTab')}</span>
                </button>
              </div>
            ) : null}
          </div>

          <div className="flex items-center space-x-2">
            {/* Connection Status Badge */}
            <div
              className={`flex items-center space-x-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                isConnected
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                  : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'
                }`}
              />
              <span className="hidden sm:inline tracking-wider uppercase">
                {isConnected ? t('terminal.live') : t('terminal.disconnected')}
              </span>
            </div>

            {logs.length > 0 && (
              <span className="text-[10px] sm:text-[11px] text-slate-500 font-mono">
                ({filteredLogs.length}/{logs.length})
              </span>
            )}
          </div>
        </div>

        {/* Right: Controls (Search, Filter, AutoScroll, Copy, Clear, Fullscreen) */}
        <div className="flex items-center gap-1.5 sm:gap-2 justify-between sm:justify-end">
          {/* Search Input */}
          <div className="relative flex-1 sm:flex-none">
            <Search className="w-3 h-3 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder={t('terminal.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full ui-input pl-7 pr-6 py-1 sm:w-32 md:w-44"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs"
              >
                ×
              </button>
            )}
          </div>

          {/* Level Filter Dropdown */}
          <div className="relative flex items-center shrink-0">
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] text-[11px] rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-500/50 appearance-none cursor-pointer hover:border-[var(--border-hover)] transition-all pr-5"
            >
              <option value="ALL">ALL</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
              <option value="DEBUG">DEBUG</option>
            </select>
            <div className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 text-[8px]">
              ▼
            </div>
          </div>

          {/* Auto-scroll Toggle Pill */}
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1.5 rounded-lg border text-xs font-medium flex items-center justify-center transition-all select-none shrink-0 ${
              autoScroll
                ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30 shadow-[0_0_8px_rgba(99,102,241,0.15)]'
                : 'bg-black/[0.02] dark:bg-white/[0.04] text-slate-500 dark:text-slate-400 border-[var(--border-subtle)] hover:text-slate-900 dark:hover:text-slate-200'
            }`}
            title={t('terminal.autoScroll')}
          >
            <ArrowDownCircle className={`w-3.5 h-3.5 ${autoScroll ? 'text-indigo-400 animate-bounce' : ''}`} />
          </button>

          {/* Copy All Button */}
          <button
            onClick={handleCopyAll}
            disabled={filteredLogs.length === 0}
            className="p-1.5 bg-black/[0.02] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] disabled:opacity-40 text-slate-600 dark:text-slate-300 border border-[var(--border-subtle)] rounded-lg text-xs font-medium flex items-center justify-center transition-all active:scale-95 shrink-0"
            title="Copy Logs"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5 text-slate-400" />
            )}
          </button>

          {/* Clear Button */}
          <button
            onClick={() => setLogs([])}
            disabled={logs.length === 0}
            className="p-1.5 bg-black/[0.02] dark:bg-white/[0.04] hover:bg-rose-500/20 hover:border-rose-500/30 text-slate-500 dark:text-slate-400 hover:text-rose-500 dark:hover:text-rose-300 disabled:opacity-40 border border-[var(--border-subtle)] rounded-lg transition-all shrink-0"
            title={t('terminal.clear')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* Fullscreen Toggle Button */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 bg-black/[0.02] dark:bg-white/[0.04] hover:bg-indigo-500/20 text-slate-500 dark:text-slate-400 hover:text-indigo-500 dark:hover:text-indigo-300 border border-[var(--border-subtle)] rounded-lg transition-all shrink-0"
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <Minimize2 className="w-3.5 h-3.5 text-indigo-400" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Terminal Viewport */}
      <div
        ref={containerRef}
        className="flex-1 p-4 overflow-y-auto space-y-0.5 bg-[var(--bg-canvas)] selection:bg-indigo-500/30 selection:text-indigo-200"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 italic py-16 space-y-2 select-none">
            <TerminalIcon className="w-8 h-8 text-slate-700" />
            <p className="text-xs">{t('terminal.noLogsRecorded')}</p>
          </div>
        ) : (
          filteredLogs.map((log, idx) => (
            <React.Fragment key={log.id || idx}>
              {renderFormattedLog(log.message, log.level)}
            </React.Fragment>
          ))
        )}
      </div>

      {/* Terminal Footer Info */}
      <div className="bg-[var(--bg-surface-sub)] border-t border-[var(--border-subtle)] px-4 py-2 flex items-center justify-between text-[11px] text-[var(--text-muted)] select-none">
        <div className="flex items-center space-x-2">
          <span>Buffer: {logs.length} lines</span>
          <span>•</span>
          <span>Filtered: {filteredLogs.length} lines</span>
        </div>
        <div className="flex items-center space-x-2 text-[10px] text-slate-600">
          <span>SSE Streaming Mode</span>
          <span>•</span>
          <span>UTF-8</span>
        </div>
      </div>
    </div>
  );
}
