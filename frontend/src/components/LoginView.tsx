import React, { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useTranslation } from '../i18n/LanguageContext';
import { useTheme, getEmbeddedShellVisibility } from '../theme/ThemeContext';
import { KeyRound, Lock, Eye, EyeOff, Languages, Sun, Moon, ArrowRight, Loader2, Github } from 'lucide-react';

export default function LoginView() {
  const { login, error, setError } = useAuth();
  const { t, language, setLanguage } = useTranslation();
  const { theme, resolvedTheme, isEmbedded, toggleTheme } = useTheme();
  const shellVisibility = getEmbeddedShellVisibility({
    isEmbedded,
    isSsoAuthenticated: false,
    hasLogout: false,
  });

  const [keyInput, setKeyInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyInput.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await login(keyInput.trim());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="ui-ambient-stage flex flex-col h-[100dvh] w-screen bg-[var(--bg-canvas)] text-[var(--text-primary)] select-none relative overflow-hidden">
      {/* Top Utilities */}
      <header className="absolute top-0 right-0 p-3 sm:p-4 flex items-center space-x-2 z-10">
        {shellVisibility.showGithub && (
          <a
            href="https://github.com/Tonyogo/gt-hub"
            target="_blank"
            rel="noopener noreferrer"
            className="ui-icon-btn p-2 flex items-center justify-center"
            title={t('nav.github', 'GitHub 仓库')}
          >
            <Github className="w-4 h-4" />
          </a>
        )}
        {shellVisibility.showLanguage && (
          <button
            type="button"
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className="ui-icon-btn p-2"
            title="Toggle Language"
          >
            <Languages className="w-4 h-4" />
          </button>
        )}
        {shellVisibility.showThemeToggle && (
          <button
            type="button"
            onClick={toggleTheme}
            className="ui-icon-btn p-2"
            title={`Toggle Theme (${theme}: ${resolvedTheme})`}
          >
            {resolvedTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        )}
      </header>

      {/* Centered Login Card */}
      <div className="flex-1 flex items-center justify-center p-4 relative z-10">
        <div className="w-full max-w-sm ui-card p-6 sm:p-8 relative">
          {/* Logo & Header */}
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-12 h-12 rounded-xl bg-[var(--accent-soft-bg)] border border-[var(--accent-soft-border)] text-[var(--accent-text)] flex items-center justify-center font-mono font-bold text-lg mb-3 dark:shadow-[0_0_24px_rgba(59,130,246,0.18)]">
              gt
            </div>
            <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">gt-hub</h1>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('webTerminal.loginSubtitle', '请输入管理员密钥以访问控制台与终端')}
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">
                {t('webTerminal.secretKeyLabel', 'Admin Secret Key')}
              </label>
              <div className="relative flex items-center ui-composer-shell">
                <span className="absolute left-3 text-[var(--text-muted)] pointer-events-none">
                  <Lock className="w-4 h-4" />
                </span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder={t('nav.adminKeyPlaceholder', '管理员密钥')}
                  autoFocus
                  required
                  className="w-full pl-9 pr-10 py-2.5 bg-transparent rounded-xl text-sm font-mono outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="p-2.5 rounded-lg bg-[var(--status-danger-bg)] border border-[var(--status-danger-border)] text-[var(--status-danger-text)] text-xs flex items-start space-x-1.5">
                <KeyRound className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isSubmitting || !keyInput.trim()}
              className="w-full py-2.5 px-4 ui-btn-primary text-sm flex items-center justify-center space-x-2 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-current" />
                  <span>{t('webTerminal.verifying', '正在验证...')}</span>
                </>
              ) : (
                <>
                  <span>{t('nav.login', '进入控制台')}</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
