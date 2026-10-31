import React, { useState, useEffect } from 'react';
import { X, Play, Loader2, Terminal, AlertCircle } from 'lucide-react';
import { useTranslation } from '../../../i18n/LanguageContext';
import { CreateTaskInput } from '../types/task';

export interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: CreateTaskInput) => Promise<void>;
  isLoading: boolean;
}

export const CreateTaskModal: React.FC<CreateTaskModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  isLoading,
}) => {
  const { t } = useTranslation();

  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setCommand('');
      setCwd('');
      setTimeoutSeconds('');
      setErrorMessage(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      setErrorMessage(t('cron.modal.commandRequired', '请输入执行命令'));
      return;
    }

    let timeoutMs: number | undefined;
    if (timeoutSeconds.trim()) {
      const parsedSec = parseInt(timeoutSeconds.trim(), 10);
      if (isNaN(parsedSec) || parsedSec <= 0) {
        setErrorMessage('超时时间必须为正整数');
        return;
      }
      timeoutMs = parsedSec * 1000;
    }

    setErrorMessage(null);
    try {
      await onSubmit({
        command: trimmedCommand,
        cwd: cwd.trim() ? cwd.trim() : undefined,
        timeoutMs,
      });
    } catch (err: any) {
      setErrorMessage(err.message || '启动任务失败');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg-overlay)] backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in duration-150">
      <div
        className="bg-[var(--bg-elevated)] border-t sm:border border-[var(--border-default)] rounded-t-2xl sm:rounded-2xl rounded-b-none sm:rounded-b-2xl shadow-2xl max-w-lg w-full overflow-hidden text-[var(--text-primary)] my-0 sm:my-auto flex flex-col max-h-[90vh] sm:max-h-[85vh] pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile Pull Handle */}
        <div className="sm:hidden w-10 h-1 bg-[var(--border-default)] rounded-full mx-auto my-2 shrink-0" />
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between bg-[var(--bg-surface-sub)]">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
              <Terminal className="w-5 h-5 text-indigo-500" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-[var(--text-primary)]">
                {t('tasks.createModal.title', '新建后台任务')}
              </h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-control-hover)] transition-all disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {errorMessage && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-300 text-xs flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Command input */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">
              {t('tasks.createModal.commandLabel', 'Shell 命令')}{' '}
              <span className="text-rose-500 dark:text-rose-400">*</span>
            </label>
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t(
                'tasks.createModal.commandPlaceholder',
                '例如: npm run build 或 python3 script.py'
              )}
              rows={4}
              required
              className="w-full px-3 py-2 bg-[var(--bg-surface-sub)] border border-[var(--border-default)] rounded-xl text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all resize-y"
            />
          </div>

          {/* CWD input */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">
              {t('tasks.createModal.cwdLabel', '工作目录 (CWD，可选)')}
            </label>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={t(
                'tasks.createModal.cwdPlaceholder',
                '留空默认为 Agent 运行主目录'
              )}
              className="w-full px-3 py-2 bg-[var(--bg-surface-sub)] border border-[var(--border-default)] rounded-xl text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
            />
          </div>

          {/* Timeout input */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">
              {t('tasks.createModal.timeoutLabel', '超时时间 (秒，可选)')}
            </label>
            <input
              type="number"
              min="1"
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              placeholder={t('tasks.createModal.timeoutPlaceholder', '留空表示无限制')}
              className="w-full px-3 py-2 bg-[var(--bg-surface-sub)] border border-[var(--border-default)] rounded-xl text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
            />
          </div>

          {/* Actions */}
          <div className="pt-2 flex items-center justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="px-4 py-2 rounded-xl bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] text-xs font-medium transition-all disabled:opacity-50"
            >
              {t('tasks.createModal.cancel', '取消')}
            </button>
            <button
              type="submit"
              disabled={isLoading || !command.trim()}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all flex items-center space-x-1.5 disabled:opacity-50 cursor-pointer shadow-xs"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>正在启动...</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>{t('tasks.createModal.submit', '启动任务')}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateTaskModal;
