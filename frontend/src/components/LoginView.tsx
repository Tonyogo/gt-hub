import React, { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useTranslation } from '../i18n/LanguageContext';
import { useTheme } from '../theme/ThemeContext';
import { KeyRound, Lock, Eye, EyeOff, Languages, Sun, Moon, ArrowRight, Loader2 } from 'lucide-react';

export default function LoginView() {
  const { login, error, setError } = useAuth();
  const { t, language, setLanguage } = useTranslation();
  const { setTheme, resolvedTheme } = useTheme();

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
    <div className="flex flex-col h-[100dvh] w-screen bg-[var(--bg-canvas)] text-[var(--text-primary)] select-none relative overflow-hidden">
      {/* Top Utilities */}
      <header className="absolute top-0 right-0 p-3 sm:p-4 flex items-center space-x-2 z-10">
        <button
          type="button"
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
          className="p-2 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] transition-colors shadow-xs"
          title="Toggle Language"
        >
          <Languages className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          className="p-2 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] transition-colors shadow-xs"
          title="Toggle Theme"
        >
          {resolvedTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </header>

      {/* Centered Login Card */}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-6 sm:p-8 shadow-2xl relative">
          {/* Logo & Header */}
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center font-mono font-bold text-lg mb-3 shadow-inner">
              gt
            </div>
            <h1 className="text-xl font-bold tracking-tight">gt-hub</h1>
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
              <div className="relative flex items-center">
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
                  className="w-full pl-9 pr-10 py-2.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/50 text-sm font-mono transition-all outline-hidden text-[var(--text-primary)]"
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
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-start space-x-1.5 animate-fadeIn">
                <KeyRound className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isSubmitting || !keyInput.trim()}
              className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-medium text-sm flex items-center justify-center space-x-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-emerald-950/20"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
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
