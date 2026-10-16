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
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-150">
      <div
        className="bg-[#18181b] border border-white/10 rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden text-slate-200 my-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-slate-800/80 border border-white/10 text-slate-300">
              <Terminal className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">
                {t('tasks.createModal.title', '新建后台任务')}
              </h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {errorMessage && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Command input */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              {t('tasks.createModal.commandLabel', 'Shell 命令')}{' '}
              <span className="text-rose-400">*</span>
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
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all resize-y"
            />
          </div>

          {/* CWD input */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
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
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
            />
          </div>

          {/* Timeout input */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              {t('tasks.createModal.timeoutLabel', '超时时间 (秒，可选)')}
            </label>
            <input
              type="number"
              min="1"
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              placeholder={t('tasks.createModal.timeoutPlaceholder', '留空表示无限制')}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
            />
          </div>

          {/* Actions */}
          <div className="pt-2 flex items-center justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 text-xs font-medium transition-all disabled:opacity-50"
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
