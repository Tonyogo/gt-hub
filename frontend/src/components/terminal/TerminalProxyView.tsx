import React, { useState, useEffect, useRef, useCallback, useImperativeHandle } from 'react';
import {
  Globe,
  Radio,
  ExternalLink,
  Copy,
  Check,
  RefreshCw,
  Send,
  ShieldAlert,
  Loader2,
  Terminal,
  Code2,
  Maximize2,
  Minimize2,
  X,
  Server,
  Zap,
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { apiFetch, getStoredAdminKey } from '../../utils/apiClient';
import { TerminalEmptyState } from './components/TerminalEmptyState';

export interface ListeningPortInfo {
  port: number;
  address: string;
  pid?: number;
  process?: string;
}

export interface TerminalProxyHandle {
  refresh: () => void;
}

export interface TerminalProxyViewProps {
  adminKey?: string;
  activeHostId?: string;
  isConnected?: boolean;
  onRequestAddNode?: () => void;
  isActive?: boolean;
}

interface DebuggerResponse {
  status: number;
  statusText: string;
  latency: number;
  headers: Record<string, string>;
  body: string;
}

export const TerminalProxyView = React.forwardRef<TerminalProxyHandle, TerminalProxyViewProps>(
  ({ adminKey, activeHostId, isConnected = true, onRequestAddNode, isActive = false }, ref) => {
    const { t, language } = useTranslation();
    const isZh = language === 'zh';

    const [mode, setMode] = useState<'port' | 'request'>('port');

    // Port Forwarding / Preview State
    const [listeningPorts, setListeningPorts] = useState<ListeningPortInfo[]>([]);
    const [isLoadingPorts, setIsLoadingPorts] = useState<boolean>(false);
    const [proto, setProto] = useState<'http' | 'https'>('http');
    const [targetHost, setTargetHost] = useState<string>('127.0.0.1');
    const [port, setPort] = useState<string>('3000');
    const [subpath, setSubpath] = useState<string>('/');
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isLoadingPreview, setIsLoadingPreview] = useState<boolean>(false);

    // HTTP Request Debugger State
    const [method, setMethod] = useState<string>('GET');
    const [requestUrl, setRequestUrl] = useState<string>('http://127.0.0.1:3000/');
    const [customHeaders, setCustomHeaders] = useState<string>('');
    const [requestBody, setRequestBody] = useState<string>('');
    const [insecure, setInsecure] = useState<boolean>(false);
    const [isSending, setIsSending] = useState<boolean>(false);
    const [responseData, setResponseData] = useState<DebuggerResponse | null>(null);
    const [responseTab, setResponseTab] = useState<'body' | 'headers'>('body');

    // Toast & feedback
    const [copiedCli, setCopiedCli] = useState<string | null>(null);
    const [toastMessage, setToastMessage] = useState<{ text: string; type: 'error' | 'success' } | null>(null);

    const showToast = useCallback((text: string, type: 'error' | 'success' = 'success') => {
      setToastMessage({ text, type });
      setTimeout(() => setToastMessage(null), 3000);
    }, []);

    const getHeaders = useCallback(() => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      const key = adminKey || getStoredAdminKey();
      if (key) {
        headers['x-admin-key'] = key;
      }
      return headers;
    }, [adminKey]);

    const activeHostIdRef = useRef<string | undefined>(activeHostId);
    activeHostIdRef.current = activeHostId;
    const isActiveRef = useRef<boolean>(isActive);
    isActiveRef.current = isActive;

    const fetchListeningPorts = useCallback(
      async (silent = false) => {
        if (!activeHostId) {
          setListeningPorts([]);
          return;
        }

        const requestHostId = activeHostId;
        if (!silent) {
          setIsLoadingPorts(true);
        }

        try {
          const res = await apiFetch(`/api/proxy/${encodeURIComponent(activeHostId)}/ports`, {
            headers: getHeaders(),
          });
          if (activeHostIdRef.current !== requestHostId) return;

          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.ports)) {
              setListeningPorts(data.ports);
              if (data.ports.length > 0 && !port) {
                setPort(String(data.ports[0].port));
              }
            } else {
              setListeningPorts([]);
            }
          } else {
            setListeningPorts([]);
          }
        } catch (err: any) {
          if (activeHostIdRef.current !== requestHostId) return;
          if (!silent) {
            showToast(err.message || t('proxy.scanFailed', '获取监听端口失败'), 'error');
          }
        } finally {
          if (activeHostIdRef.current === requestHostId && !silent) {
            setIsLoadingPorts(false);
          }
        }
      },
      [activeHostId, getHeaders, port, showToast, t]
    );

    // Imperative handle for parent subtab refresh
    useImperativeHandle(ref, () => ({
      refresh: () => {
        if (mode === 'port') {
          fetchListeningPorts(false);
        }
      },
    }));

    useEffect(() => {
      if (isActive && activeHostId && mode === 'port') {
        fetchListeningPorts(false);
      }
    }, [isActive, activeHostId, mode, fetchListeningPorts]);

    const buildProxyPortUrl = async (): Promise<string | null> => {
      if (!activeHostId) return null;
      const targetP = parseInt(port, 10);
      if (isNaN(targetP) || targetP < 1 || targetP > 65535) {
        showToast('Invalid port number', 'error');
        return null;
      }

      const cleanSubpath = subpath ? (subpath.startsWith('/') ? subpath : '/' + subpath) : '/';
      let url = `/api/proxy/${encodeURIComponent(activeHostId)}/port/${targetP}${cleanSubpath}`;

      const params = new URLSearchParams();
      const key = adminKey || getStoredAdminKey();
      if (key) {
        try {
          const ticketRes = await apiFetch('/api/auth/ticket', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
          });
          if (ticketRes.ok) {
            const ticketData = await ticketRes.json();
            if (ticketData?.ticket) {
              params.set('ticket', ticketData.ticket);
            }
          }
        } catch {}
      }

      if (targetHost && targetHost !== '127.0.0.1') {
        params.set('_gt_host', targetHost);
      }
      if (proto && proto !== 'http') {
        params.set('_gt_proto', proto);
      }

      const qs = params.toString();
      if (qs) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
      return url;
    };

    const handleLoadPreview = async () => {
      setIsLoadingPreview(true);
      try {
        const url = await buildProxyPortUrl();
        if (url) {
          setPreviewUrl(url);
        }
      } finally {
        setIsLoadingPreview(false);
      }
    };

    const handleOpenTab = async () => {
      const url = await buildProxyPortUrl();
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    };

    const handleCopyForward = () => {
      const targetP = parseInt(port, 10);
      if (isNaN(targetP) || targetP < 1 || targetP > 65535) {
        showToast('Invalid port', 'error');
        return;
      }
      const cmd =
        targetHost && targetHost !== '127.0.0.1'
          ? `gt forward ${activeHostId} ${targetP}:${targetHost}:${targetP}`
          : `gt forward ${activeHostId} ${targetP}:${targetP}`;
      navigator.clipboard.writeText(cmd);
      setCopiedCli('forward');
      setTimeout(() => setCopiedCli(null), 2000);
      showToast(t('proxy.copied', '已复制到剪贴板'), 'success');
    };

    const handleCopyProxy = () => {
      const cmd = `gt proxy ${activeHostId} -p 1080`;
      navigator.clipboard.writeText(cmd);
      setCopiedCli('proxy');
      setTimeout(() => setCopiedCli(null), 2000);
      showToast(t('proxy.copied', '已复制到剪贴板'), 'success');
    };

    const handleSelectDiscoveredPort = (p: ListeningPortInfo) => {
      setPort(String(p.port));
      if (p.address && p.address !== '0.0.0.0' && p.address !== '::' && p.address !== '127.0.0.1' && p.address !== '::1') {
        setTargetHost(p.address);
      } else {
        setTargetHost('127.0.0.1');
      }
    };

    const handleSendRequest = async () => {
      if (!activeHostId) return;
      if (!requestUrl) {
        showToast('Request URL is required', 'error');
        return;
      }

      setIsSending(true);
      setResponseData(null);
      const startTime = Date.now();

      try {
        const headers: Record<string, string> = {};
        const key = adminKey || getStoredAdminKey();
        if (key) {
          headers['x-admin-key'] = key;
        }
        headers['x-gt-target-url'] = requestUrl;
        if (insecure) {
          headers['x-gt-insecure'] = '1';
        }

        if (customHeaders.trim()) {
          try {
            if (customHeaders.trim().startsWith('{')) {
              const parsed = JSON.parse(customHeaders.trim());
              Object.assign(headers, parsed);
            } else {
              const lines = customHeaders.split('\n');
              for (const line of lines) {
                const colon = line.indexOf(':');
                if (colon !== -1) {
                  const hKey = line.slice(0, colon).trim();
                  const hVal = line.slice(colon + 1).trim();
                  if (hKey) headers[hKey] = hVal;
                }
              }
            }
          } catch (err: any) {
            showToast(`Invalid custom headers format: ${err.message}`, 'error');
            setIsSending(false);
            return;
          }
        }

        const fetchOptions: RequestInit = {
          method,
          headers,
        };
        if (method !== 'GET' && method !== 'HEAD' && requestBody) {
          fetchOptions.body = requestBody;
        }

        const res = await apiFetch(`/api/proxy/${encodeURIComponent(activeHostId)}/request`, fetchOptions);
        const latency = Date.now() - startTime;
        const resHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          resHeaders[k] = v;
        });

        const text = await res.text();
        let formattedBody = text;
        try {
          const json = JSON.parse(text);
          formattedBody = JSON.stringify(json, null, 2);
        } catch {}

        setResponseData({
          status: res.status,
          statusText: res.statusText,
          latency,
          headers: resHeaders,
          body: formattedBody,
        });
      } catch (err: any) {
        const latency = Date.now() - startTime;
        setResponseData({
          status: 0,
          statusText: 'Error',
          latency,
          headers: {},
          body: err.message || 'Request failed',
        });
      } finally {
        setIsSending(false);
      }
    };

    if (!activeHostId) {
      return (
        <div className="relative w-full h-full flex items-center justify-center bg-[var(--bg-canvas)]">
          <TerminalEmptyState visible={true} onRequestAddNode={onRequestAddNode} t={t} />
        </div>
      );
    }

    return (
      <div className="flex-1 min-h-0 flex flex-col bg-[var(--bg-canvas)] text-slate-200 overflow-hidden relative">
        {/* Toast Notification */}
        {toastMessage && (
          <div className="absolute top-3 right-4 z-50 flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs shadow-lg border bg-slate-900 border-white/[0.1] animate-in fade-in slide-in-from-top-2">
            <span className={toastMessage.type === 'error' ? 'text-rose-400' : 'text-emerald-400'}>
              {toastMessage.type === 'error' ? '●' : '✓'}
            </span>
            <span>{toastMessage.text}</span>
          </div>
        )}

        {/* Top Mode Segmented Bar */}
        <div className="px-4 py-2 border-b border-white/[0.08] flex items-center justify-between bg-black/20 shrink-0">
          <div className="flex items-center space-x-1.5 bg-black/40 p-1 rounded-lg border border-white/[0.06]">
            <button
              type="button"
              onClick={() => setMode('port')}
              className={`flex items-center space-x-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
                mode === 'port'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>{t('proxy.portMode', '端口转发与网页预览')}</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('request')}
              className={`flex items-center space-x-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
                mode === 'request'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{t('proxy.requestMode', 'HTTP 请求调试器')}</span>
            </button>
          </div>

          <div className="flex items-center space-x-2">
            {mode === 'port' && (
              <button
                type="button"
                data-testid="proxy-copy-forward-btn"
                onClick={handleCopyForward}
                className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 text-xs border border-white/[0.08] transition-all"
                title="Copy gt forward command"
              >
                {copiedCli === 'forward' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-indigo-400" />}
                <span className="font-mono text-[11px]">{t('proxy.copyCliForward', '复制 gt forward')}</span>
              </button>
            )}
            {mode === 'request' && (
              <button
                type="button"
                onClick={handleCopyProxy}
                className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 text-xs border border-white/[0.08] transition-all"
                title="Copy gt proxy command"
              >
                {copiedCli === 'proxy' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-indigo-400" />}
                <span className="font-mono text-[11px]">{t('proxy.copyCliProxy', '复制 gt proxy')}</span>
              </button>
            )}
          </div>
        </div>

        {/* Mode 1: Port Forward & Web Preview */}
        {mode === 'port' && (
          <div className="flex-1 min-h-0 flex flex-col p-4 space-y-3 overflow-y-auto">
            {/* Discovered Listening Ports Bar */}
            <div className="p-3 rounded-xl bg-black/20 border border-white/[0.06] flex flex-col space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 text-xs font-medium text-slate-300">
                  <Server className="w-3.5 h-3.5 text-indigo-400" />
                  <span>{t('proxy.listeningPorts', '发现监听端口')}</span>
                  <span className="px-1.5 py-0.2 bg-white/[0.06] rounded text-[10px] text-slate-400 font-mono">
                    {listeningPorts.length}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => fetchListeningPorts(false)}
                  disabled={isLoadingPorts}
                  className="flex items-center space-x-1 text-[11px] text-slate-400 hover:text-white transition-all disabled:opacity-50"
                  title="Refresh ports"
                >
                  <RefreshCw className={`w-3 h-3 ${isLoadingPorts ? 'animate-spin text-indigo-400' : ''}`} />
                  <span>{t('proxy.refresh', '刷新')}</span>
                </button>
              </div>

              {listeningPorts.length === 0 ? (
                <div className="text-xs text-slate-500 py-1 font-mono">
                  {isLoadingPorts ? 'Scanning listening ports on agent...' : t('proxy.noListeningPorts', '未在此节点上发现监听端口')}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 pt-1">
                  {listeningPorts.map((p) => {
                    const isSelected = port === String(p.port);
                    return (
                      <button
                        key={`${p.address}-${p.port}`}
                        type="button"
                        onClick={() => handleSelectDiscoveredPort(p)}
                        className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-mono border transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-indigo-600/30 text-indigo-200 border-indigo-500/50 ring-1 ring-indigo-500/30'
                            : 'bg-white/[0.03] text-slate-300 border-white/[0.06] hover:bg-white/[0.08]'
                        }`}
                      >
                        <span className="font-semibold text-indigo-400">:{p.port}</span>
                        {p.process && <span className="text-slate-400 text-[10px]">({p.process})</span>}
                        <span className="text-slate-500 text-[10px]">{p.address}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Target Controls Row */}
            <div className="p-3 rounded-xl bg-black/20 border border-white/[0.06] flex flex-wrap items-center gap-3">
              {/* Protocol */}
              <div className="flex flex-col space-y-1">
                <label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{t('proxy.protocol', '协议')}</label>
                <select
                  value={proto}
                  onChange={(e) => setProto(e.target.value as 'http' | 'https')}
                  className="bg-black/40 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
              </div>

              {/* Target Host */}
              <div className="flex flex-col space-y-1">
                <label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{t('proxy.targetHost', '目标主机')}</label>
                <input
                  type="text"
                  value={targetHost}
                  onChange={(e) => setTargetHost(e.target.value)}
                  placeholder="127.0.0.1"
                  className="bg-black/40 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono w-32 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Port */}
              <div className="flex flex-col space-y-1">
                <label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{t('proxy.targetPort', '端口')}</label>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="3000"
                  min={1}
                  max={65535}
                  className="bg-black/40 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono w-24 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Subpath */}
              <div className="flex-1 min-w-[140px] flex flex-col space-y-1">
                <label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{t('proxy.subpath', '子路径')}</label>
                <input
                  type="text"
                  value={subpath}
                  onChange={(e) => setSubpath(e.target.value)}
                  placeholder="/"
                  className="bg-black/40 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono w-full focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex items-center space-x-2 self-end pt-1">
                <button
                  type="button"
                  data-testid="proxy-load-preview-btn"
                  onClick={handleLoadPreview}
                  disabled={isLoadingPreview}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all shadow-xs cursor-pointer disabled:opacity-50"
                >
                  {isLoadingPreview ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
                  <span>{t('proxy.preview', '加载预览')}</span>
                </button>

                <button
                  type="button"
                  data-testid="proxy-open-tab-btn"
                  onClick={handleOpenTab}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-200 text-xs font-medium border border-white/[0.08] transition-all cursor-pointer"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>{t('proxy.openNewTab', '新窗口打开')}</span>
                </button>
              </div>
            </div>

            {/* Embedded Iframe Preview Container */}
            <div className="flex-1 min-h-[350px] rounded-xl bg-black/30 border border-white/[0.08] flex flex-col overflow-hidden relative">
              {previewUrl ? (
                <>
                  <div className="px-3 py-1.5 bg-black/50 border-b border-white/[0.08] flex items-center justify-between text-xs font-mono text-slate-400">
                    <span className="truncate pr-2">{previewUrl}</span>
                    <button
                      type="button"
                      onClick={() => setPreviewUrl(null)}
                      className="p-1 text-slate-400 hover:text-white rounded hover:bg-white/[0.06]"
                      title="Close Preview"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <iframe
                    data-testid="proxy-preview-iframe"
                    src={previewUrl}
                    className="w-full flex-1 border-0 bg-white"
                    title="Agent Web Service Preview"
                  />
                </>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center select-none text-slate-500 space-y-2">
                  <Globe className="w-10 h-10 text-slate-600" />
                  <p className="text-sm font-medium text-slate-400">
                    {t('proxy.preview', '选择端口并点击“加载预览”')}
                  </p>
                  <p className="text-xs text-slate-500 max-w-sm">
                    {t(
                      'proxy.previewDesc',
                      '通过 Hub 反向代理安全预览 Agent 本地或局域网运行的 Web 服务，自动签发代理会话 Cookie 支持页面静态资源加载。'
                    )}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Mode 2: HTTP Request Debugger */}
        {mode === 'request' && (
          <div className="flex-1 min-h-0 flex flex-col p-4 space-y-3 overflow-y-auto">
            {/* Request Builder */}
            <div className="p-3.5 rounded-xl bg-black/20 border border-white/[0.06] flex flex-col space-y-3">
              {/* Method + URL + Send */}
              <div className="flex items-center space-x-2">
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  className="bg-black/40 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs font-mono font-semibold text-indigo-300 focus:outline-none focus:border-indigo-500"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                  <option value="PATCH">PATCH</option>
                  <option value="HEAD">HEAD</option>
                  <option value="OPTIONS">OPTIONS</option>
                </select>

                <input
                  type="text"
                  data-testid="proxy-request-url-input"
                  value={requestUrl}
                  onChange={(e) => setRequestUrl(e.target.value)}
                  placeholder="http://127.0.0.1:3000/api/health"
                  className="flex-1 min-w-0 bg-black/40 border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                />

                <button
                  type="button"
                  data-testid="proxy-send-request-btn"
                  onClick={handleSendRequest}
                  disabled={isSending}
                  className="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all shadow-xs cursor-pointer disabled:opacity-50 shrink-0"
                >
                  {isSending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  <span>{isSending ? t('proxy.sending', '发送中...') : t('proxy.sendRequest', '发送请求')}</span>
                </button>
              </div>

              {/* Insecure Checkbox */}
              <div className="flex items-center space-x-2 text-xs text-slate-400">
                <label className="flex items-center space-x-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={insecure}
                    onChange={(e) => setInsecure(e.target.checked)}
                    className="rounded bg-black/40 border-white/[0.1] text-indigo-600 focus:ring-0"
                  />
                  <span>{t('proxy.insecure', '忽略证书错误 (insecure)')}</span>
                </label>
              </div>

              {/* Custom Headers and Body Inputs */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                <div className="flex flex-col space-y-1">
                  <label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{t('proxy.headers', '请求头 (JSON 或 Key: Value)')}</label>
                  <textarea
                    value={customHeaders}
                    onChange={(e) => setCustomHeaders(e.target.value)}
                    placeholder={`Content-Type: application/json\nAuthorization: Bearer test`}
                    rows={4}
                    className="w-full bg-black/40 border border-white/[0.08] rounded-lg p-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500 resize-none"
                  />
                </div>

                {method !== 'GET' && method !== 'HEAD' && (
                  <div className="flex flex-col space-y-1">
                    <label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{t('proxy.body', '请求体')}</label>
                    <textarea
                      value={requestBody}
                      onChange={(e) => setRequestBody(e.target.value)}
                      placeholder={`{\n  "key": "value"\n}`}
                      rows={4}
                      className="w-full bg-black/40 border border-white/[0.08] rounded-lg p-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500 resize-none"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Response Inspector */}
            <div className="flex-1 min-h-[250px] rounded-xl bg-black/30 border border-white/[0.08] flex flex-col overflow-hidden">
              <div className="px-4 py-2 bg-black/40 border-b border-white/[0.08] flex items-center justify-between text-xs">
                <div className="flex items-center space-x-3">
                  <span className="font-medium text-slate-300">Response</span>
                  {responseData && (
                    <div className="flex items-center space-x-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-mono font-semibold ${
                          responseData.status >= 200 && responseData.status < 300
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                            : responseData.status >= 300 && responseData.status < 400
                            ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                            : responseData.status >= 400 && responseData.status < 500
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                            : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                        }`}
                      >
                        {responseData.status} {responseData.statusText}
                      </span>
                      <span className="text-slate-400 font-mono text-[11px]">{responseData.latency} ms</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center space-x-1 bg-black/40 p-0.5 rounded border border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => setResponseTab('body')}
                    className={`px-2.5 py-0.5 rounded text-[11px] font-medium transition-all ${
                      responseTab === 'body' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t('proxy.responseBody', '响应内容')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setResponseTab('headers')}
                    className={`px-2.5 py-0.5 rounded text-[11px] font-medium transition-all ${
                      responseTab === 'headers' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t('proxy.responseHeaders', '响应头')}
                  </button>
                </div>
              </div>

              <div className="flex-1 p-3 overflow-auto font-mono text-xs text-slate-300">
                {!responseData ? (
                  <div className="h-full flex items-center justify-center text-slate-500">
                    {isSending ? 'Sending request via agent proxy...' : 'Send a request to inspect response'}
                  </div>
                ) : responseTab === 'body' ? (
                  <pre className="whitespace-pre-wrap break-all">{responseData.body || '<Empty Body>'}</pre>
                ) : (
                  <div className="space-y-1">
                    {Object.entries(responseData.headers).map(([k, v]) => (
                      <div key={k} className="flex space-x-2">
                        <span className="text-indigo-400 font-medium">{k}:</span>
                        <span className="text-slate-300 break-all">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
);

TerminalProxyView.displayName = 'TerminalProxyView';
export default TerminalProxyView;
