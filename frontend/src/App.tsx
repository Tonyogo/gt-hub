import React, { useState } from 'react';
import UnifiedTerminalView from './components/UnifiedTerminalView';
import TerminalLogsView from './components/TerminalLogsView';
import { useTranslation } from './i18n/LanguageContext';
import { useTheme } from './theme/ThemeContext';
import { Terminal, FileText, Sun, Moon, Languages, Key } from 'lucide-react';

export default function App() {
  const { t, language, setLanguage } = useTranslation();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<'terminal' | 'logs'>('terminal');
  const [adminKey, setAdminKey] = useState<string>(() => {
    return localStorage.getItem('admin_secret_key') || '';
  });
  const [showKeyInput, setShowKeyInput] = useState<boolean>(false);

  const handleKeySave = (newKey: string) => {
    setAdminKey(newKey);
    localStorage.setItem('admin_secret_key', newKey);
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Top Navigation Bar */}
      <header className="h-12 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] flex items-center justify-between px-3 md:px-4 shrink-0 select-none">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold font-mono text-sm border border-emerald-500/30">
              gt
            </div>
            <span className="font-bold text-sm tracking-tight hidden sm:inline">
              gt-hub
            </span>
          </div>

          <div className="h-4 w-px bg-[var(--border-subtle)]" />

          {/* Navigation Tabs */}
          <nav className="flex items-center space-x-1">
            <button
              type="button"
              onClick={() => setActiveTab('terminal')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'terminal'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>{t('terminal.interactiveTab', '终端 & 文件')}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('logs')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'logs'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>{t('terminal.logsTab', '审计日志')}</span>
            </button>
          </nav>
        </div>

        {/* Top Right Utilities */}
        <div className="flex items-center space-x-1.5">
          {showKeyInput ? (
            <div className="flex items-center space-x-1">
              <input
                type="password"
                value={adminKey}
                onChange={(e) => handleKeySave(e.target.value)}
                placeholder="Admin Secret Key"
                className="ui-input px-2 py-1 text-xs font-mono w-32 md:w-44"
                autoFocus
                onBlur={() => setShowKeyInput(false)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowKeyInput(true)}
              title="Configure Admin Secret Key"
              className={`p-1.5 rounded-lg text-xs transition-colors ${
                adminKey
                  ? 'text-emerald-400 hover:bg-emerald-500/10'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              <Key className="w-4 h-4" />
            </button>
          )}

          {/* Language Switcher */}
          <button
            type="button"
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className="p-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            title="Toggle Language"
          >
            <Languages className="w-4 h-4" />
          </button>

          {/* Theme Switcher */}
          <button
            type="button"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            className="p-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            title="Toggle Theme"
          >
            {resolvedTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 min-h-0 overflow-hidden relative">
        {activeTab === 'terminal' ? (
          <UnifiedTerminalView adminKey={adminKey} isStandalone={false} />
        ) : (
          <TerminalLogsView adminKey={adminKey} />
        )}
      </main>
    </div>
  );
}
