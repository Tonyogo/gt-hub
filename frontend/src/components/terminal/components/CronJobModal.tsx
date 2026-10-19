import React, { useState, useEffect } from 'react';
import {
  X,
  Clock,
  Terminal,
  FileCode,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Loader2,
  Check,
  Settings
} from 'lucide-react';
import { useTranslation } from '../../../i18n/LanguageContext';
import { apiFetch } from '../../../utils/apiClient';
import {
  CronJobSummary,
  CronJobConfig,
  CronScriptSource,
  CronConcurrencyPolicy,
  ScriptOption
} from '../types/cron';

export interface CronJobModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Partial<CronJobConfig>) => Promise<void>;
  initialData?: CronJobSummary | null;
  adminKey?: string;
  activeHostId?: string;
}

const CRON_PRESETS = [
  { labelKey: 'cron.modal.presets.everyMinute', expr: '* * * * *', fallback: '每 1 分钟' },
  { labelKey: 'cron.modal.presets.every5Min', expr: '*/5 * * * *', fallback: '每 5 分钟' },
  { labelKey: 'cron.modal.presets.hourly', expr: '0 * * * *', fallback: '每小时' },
  { labelKey: 'cron.modal.presets.daily2am', expr: '0 2 * * *', fallback: '每天凌晨 2 点' },
  { labelKey: 'cron.modal.presets.workdays9am', expr: '0 9 * * 1-5', fallback: '工作日 9 点' },
];

export const CronJobModal: React.FC<CronJobModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialData,
  adminKey,
}) => {
  const { t } = useTranslation();

  const [name, setName] = useState('');
  const [cron, setCron] = useState('* * * * *');
  const [source, setSource] = useState<CronScriptSource>('command');
  const [command, setCommand] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [scriptArgsStr, setScriptArgsStr] = useState('');
  const [cwd, setCwd] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>('');
  const [concurrency, setConcurrency] = useState<CronConcurrencyPolicy>('forbid');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [scripts, setScripts] = useState<ScriptOption[]>([]);
  const [isLoadingScripts, setIsLoadingScripts] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Initialize or reset form values
  useEffect(() => {
    if (!isOpen) return;

    setErrorMessage(null);
    setIsSubmitting(false);

    if (initialData) {
      setName(initialData.name || '');
      setCron(initialData.cron || '* * * * *');
      setSource(initialData.source || 'command');
      setCommand(initialData.command || '');
      setScriptName(initialData.scriptName || '');
      setScriptArgsStr(Array.isArray(initialData.scriptArgs) ? initialData.scriptArgs.join(' ') : '');
      setCwd(initialData.cwd || '');
      setTimeoutSeconds(initialData.timeoutMs ? String(Math.round(initialData.timeoutMs / 1000)) : '');
      setConcurrency(initialData.concurrency || 'forbid');
    } else {
      setName('');
      setCron('*/5 * * * *');
      setSource('command');
      setCommand('');
      setScriptName('');
      setScriptArgsStr('');
      setCwd('');
      setTimeoutSeconds('');
      setConcurrency('forbid');
    }
  }, [isOpen, initialData]);

  // Fetch Hub scripts when modal opens
  useEffect(() => {
    if (!isOpen) return;

    let mounted = true;
    setIsLoadingScripts(true);

    const fetchScripts = async () => {
      try {
        const headers: Record<string, string> = {};
        const key = adminKey || (typeof window !== 'undefined' ? localStorage.getItem('gt_admin_key') || localStorage.getItem('admin_secret_key') : '');
        if (key) {
          headers['x-admin-key'] = key;
        }

        const res = await apiFetch('/api/admin/scripts', { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (mounted && data && data.success && Array.isArray(data.data)) {
          setScripts(data.data);
          if (!scriptName && data.data.length > 0 && !initialData) {
            setScriptName(data.data[0].name);
          }
        }
      } catch {
        if (mounted) {
          setScripts([]);
        }
      } finally {
        if (mounted) {
          setIsLoadingScripts(false);
        }
      }
    };

    fetchScripts();

    return () => {
      mounted = false;
    };
  }, [isOpen, adminKey]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage(t('cron.modal.nameRequired', '请输入任务名称'));
      return;
    }

    const trimmedCron = cron.trim();
    const cronRegex = /^(\S+\s+){4}\S+$/;
    if (!cronRegex.test(trimmedCron)) {
      setErrorMessage(t('cron.modal.invalidCron', 'Cron 表达式格式无效，须为标准的 5 字段格式 (例如: */5 * * * *)'));
      return;
    }

    if (source === 'command' && !command.trim()) {
      setErrorMessage(t('cron.modal.commandRequired', '请输入执行命令'));
      return;
    }

    if (source === 'hub' && !scriptName.trim()) {
      setErrorMessage(t('cron.modal.scriptRequired', '请选择要执行的托管脚本'));
      return;
    }

    const scriptArgs = scriptArgsStr.trim()
      ? scriptArgsStr.trim().split(/\s+/).filter(Boolean)
      : [];

    const timeoutMs = timeoutSeconds && Number(timeoutSeconds) > 0
      ? Number(timeoutSeconds) * 1000
      : undefined;

    const payload: Partial<CronJobConfig> = {
      name: trimmedName,
      cron: trimmedCron,
      source,
      concurrency,
      command: source === 'command' ? command.trim() : undefined,
      scriptName: source === 'hub' ? scriptName.trim() : undefined,
      scriptArgs: source === 'hub' ? scriptArgs : undefined,
      cwd: cwd.trim() || undefined,
      timeoutMs,
    };

    try {
      setIsSubmitting(true);
      await onSave(payload);
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || '保存失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in duration-150">
      <div
        className="bg-[#18181b] border-t sm:border border-white/10 rounded-t-2xl sm:rounded-2xl rounded-b-none sm:rounded-b-2xl shadow-2xl max-w-xl w-full overflow-hidden text-slate-200 my-0 sm:my-auto flex flex-col max-h-[90vh] sm:max-h-[85vh] pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile Pull Handle */}
        <div className="sm:hidden w-10 h-1 bg-white/20 rounded-full mx-auto my-2 shrink-0" />
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">
                {initialData ? t('cron.editJob', '编辑任务') : t('cron.addJob', '新建任务')}
              </h3>
              <p className="text-xs text-slate-400">
                {initialData ? `ID: ${initialData.id}` : t('cron.tabName', '定时任务')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body / Form */}
        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 text-sm flex-1">
          {errorMessage && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-start space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Job Name */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              {t('cron.modal.nameLabel', '任务名称')} <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. daily-db-backup"
              className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-slate-500 focus:outline-hidden focus:border-indigo-500 transition-all text-xs"
            />
          </div>

          {/* Cron Expression & Presets */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-slate-300">
                {t('cron.modal.cronLabel', 'Cron 表达式')} <span className="text-rose-400">*</span>
              </label>
              <span className="text-[11px] text-slate-400 font-mono">
                minute hour day month weekday
              </span>
            </div>
            <input
              type="text"
              required
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="*/5 * * * *"
              className="w-full px-3 py-2 rounded-xl bg-black/40 border border-white/[0.08] text-indigo-300 font-mono text-xs focus:outline-hidden focus:border-indigo-500 transition-all"
            />

            {/* Presets Capsules */}
            <div className="space-y-1">
              <div className="text-[11px] text-slate-400 font-medium">
                {t('cron.modal.presetLabel', '快捷预设')}
              </div>
              <div className="flex flex-wrap gap-1.5 overflow-x-auto scrollbar-none">
                {CRON_PRESETS.map((p) => {
                  const isActive = cron === p.expr;
                  return (
                    <button
                      type="button"
                      key={p.expr}
                      onClick={() => setCron(p.expr)}
                      className={`px-2 py-1 rounded-lg text-xs font-mono transition-all flex items-center space-x-1 border ${
                        isActive
                          ? 'bg-indigo-600 text-white border-indigo-500 shadow-xs'
                          : 'bg-white/[0.03] text-slate-300 border-white/[0.06] hover:bg-white/[0.08] hover:text-white'
                      }`}
                    >
                      {isActive && <Check className="w-3 h-3 text-indigo-200" />}
                      <span>{t(p.labelKey, p.fallback)}</span>
                      <span className="text-[10px] opacity-60">({p.expr})</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Execution Source Tabs */}
          <div className="space-y-2 pt-1">
            <label className="block text-xs font-medium text-slate-300">
              {t('cron.modal.sourceLabel', '执行来源')}
            </label>
            <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-black/30 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => setSource('command')}
                className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-center space-x-1.5 ${
                  source === 'command'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>{t('cron.sourceCommand', '直接命令')}</span>
              </button>
              <button
                type="button"
                onClick={() => setSource('hub')}
                className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-center space-x-1.5 ${
                  source === 'hub'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <FileCode className="w-3.5 h-3.5" />
                <span>{t('cron.sourceScript', 'Hub 托管脚本')}</span>
              </button>
            </div>
          </div>

          {/* Direct Command Content */}
          {source === 'command' && (
            <div className="space-y-1.5 animate-in fade-in duration-100">
              <label className="block text-xs font-medium text-slate-300">
                {t('cron.modal.commandLabel', 'Shell 命令')} <span className="text-rose-400">*</span>
              </label>
              <textarea
                required
                rows={4}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="e.g. echo 'Running backup...' &amp;&amp; tar -czf /tmp/backup.tar.gz /var/data"
                className="w-full px-3 py-2 rounded-xl bg-black/50 border border-white/[0.08] text-emerald-400 font-mono text-xs placeholder-slate-600 focus:outline-hidden focus:border-indigo-500 transition-all resize-y"
              />
            </div>
          )}

          {/* Hub Script Content */}
          {source === 'hub' && (
            <div className="space-y-3 animate-in fade-in duration-100">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  {t('cron.modal.scriptSelectLabel', '选择托管脚本')} <span className="text-rose-400">*</span>
                </label>
                {isLoadingScripts ? (
                  <div className="flex items-center space-x-2 py-2 text-xs text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                    <span>加载脚本列表中...</span>
                  </div>
                ) : scripts.length > 0 ? (
                  <select
                    value={scriptName}
                    onChange={(e) => setScriptName(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-black/50 border border-white/[0.08] text-white text-xs focus:outline-hidden focus:border-indigo-500 transition-all"
                  >
                    <option value="" disabled>-- 请选择脚本 --</option>
                    {scripts.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name} {s.title ? `(${s.title})` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
                    {t('cron.modal.noScripts', 'Hub 中暂无可用脚本，请选择“直接命令”或先前往脚本库创建')}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  {t('cron.modal.scriptArgsLabel', '脚本参数 (可选)')}
                </label>
                <input
                  type="text"
                  value={scriptArgsStr}
                  onChange={(e) => setScriptArgsStr(e.target.value)}
                  placeholder="--env production --verbose"
                  className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-slate-500 text-xs focus:outline-hidden focus:border-indigo-500 transition-all font-mono"
                />
              </div>
            </div>
          )}

          {/* Advanced Options Accordion */}
          <div className="border border-white/[0.06] rounded-xl overflow-hidden bg-black/20">
            <button
              type="button"
              onClick={() => setShowAdvanced((prev) => !prev)}
              className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-slate-300 hover:text-white hover:bg-white/[0.02] transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Settings className="w-3.5 h-3.5 text-indigo-400" />
                <span>高级选项 (并发策略、超时、工作目录)</span>
              </div>
              {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            {showAdvanced && (
              <div className="p-4 border-t border-white/[0.06] space-y-3 bg-white/[0.01]">
                {/* Concurrency Policy */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    {t('cron.modal.concurrencyLabel', '并发重叠策略')}
                  </label>
                  <select
                    value={concurrency}
                    onChange={(e) => setConcurrency(e.target.value as CronConcurrencyPolicy)}
                    className="w-full px-3 py-2 rounded-xl bg-black/40 border border-white/[0.08] text-white text-xs focus:outline-hidden focus:border-indigo-500 transition-all"
                  >
                    <option value="forbid">
                      {t('cron.modal.concurrencyForbid', '禁止重叠 (forbid - 上次未跑完则跳过本次)')}
                    </option>
                    <option value="allow">
                      {t('cron.modal.concurrencyAllow', '允许并发 (allow - 周期到达直接并行启动)')}
                    </option>
                  </select>
                </div>

                {/* Timeout */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    {t('cron.modal.timeoutLabel', '超时时间 (秒)')}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={timeoutSeconds}
                    onChange={(e) => setTimeoutSeconds(e.target.value)}
                    placeholder="默认不超时 (如: 300)"
                    className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-xs placeholder-slate-500 focus:outline-hidden focus:border-indigo-500 transition-all"
                  />
                </div>

                {/* Working Directory (CWD) */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    {t('cron.modal.cwdLabel', '工作目录 (CWD)')}
                  </label>
                  <input
                    type="text"
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    placeholder="默认节点根工作目录 (例如: /var/www/app)"
                    className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-xs placeholder-slate-500 focus:outline-hidden focus:border-indigo-500 transition-all font-mono"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-end space-x-2.5 pt-3 border-t border-white/[0.06]">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 text-xs font-medium transition-all"
            >
              {t('cron.modal.cancel', '取消')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium transition-all flex items-center space-x-1.5 shadow-md shadow-indigo-600/20"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t('cron.modal.saving', '正在保存...')}</span>
                </>
              ) : (
                <span>{t('cron.modal.save', '保存任务')}</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
