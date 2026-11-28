import React, { useState, useEffect } from 'react';
import { Play, Loader2, Terminal, AlertCircle } from 'lucide-react';
import { useTranslation } from '../../../i18n/LanguageContext';
import { CreateTaskInput } from '../types/task';
import { ModalShell } from '../../ui/ModalShell';

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
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      disableClose={isLoading}
      maxWidthClassName="max-w-lg"
      title={t('tasks.createModal.title', '新建后台任务')}
      icon={
        <div className="p-2 rounded-lg bg-[var(--accent-soft-bg)] border border-[var(--accent-soft-border)] text-[var(--accent-text)]">
          <Terminal className="w-4 h-4" />
        </div>
      }
      footer={
        <div className="flex items-center justify-end space-x-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="ui-btn-secondary px-4 py-2 disabled:opacity-50"
          >
            {t('tasks.createModal.cancel', '取消')}
          </button>
          <button
            type="submit"
            form="create-task-form"
            disabled={isLoading || !command.trim()}
            className="ui-btn-primary px-4 py-2 flex items-center space-x-1.5 cursor-pointer"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-current" />
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
      }
    >
      <form id="create-task-form" onSubmit={handleSubmit} className="space-y-4">
        {errorMessage && (
          <div className="p-3 rounded-xl bg-[var(--status-danger-bg)] border border-[var(--status-danger-border)] text-[var(--status-danger-text)] text-xs flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Command input */}
        <div>
          <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">
            {t('tasks.createModal.commandLabel', 'Shell 命令')}{' '}
            <span className="text-[var(--status-danger-text)]">*</span>
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
            className="ui-input w-full font-mono resize-y"
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
            className="ui-input w-full font-mono"
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
            className="ui-input w-full font-mono tabular-nums"
          />
        </div>
      </form>
    </ModalShell>
  );
};

export default CreateTaskModal;
