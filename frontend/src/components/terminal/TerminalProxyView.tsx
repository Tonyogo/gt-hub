import React, { useState, useEffect, useRef, useCallback, useImperativeHandle } from 'react';
import {
  Globe,
  Copy,
  Check,
  RefreshCw,
  Send,
  Loader2,
  Server,
  Zap,
  Gauge,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  XCircle,
  Activity,
  ChevronDown,
  ChevronUp,
  Terminal,
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

export interface TargetProbeResult {
  url: string;
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
}

export const TerminalProxyView = React.forwardRef<TerminalProxyHandle, TerminalProxyViewProps>(
  ({ adminKey, activeHostId, isConnected = true, onRequestAddNode, isActive = false }, ref) => {
    const { t, language } = useTranslation();
    const isZh = language === 'zh';

    // Mobile section switcher ('speedtest' | 'request'); on desktop (lg+) both are visible side-by-side
    const [mobileSection, setMobileSection] = useState<'speedtest' | 'request'>('speedtest');
    const [showAdvancedRequest, setShowAdvancedRequest] = useState<boolean>(false);

    // Port Forwarding / CLI State
    const [listeningPorts, setListeningPorts] = useState<ListeningPortInfo[]>([]);
    const [isLoadingPorts, setIsLoadingPorts] = useState<boolean>(false);
    const [targetHost, setTargetHost] = useState<string>('127.0.0.1');
    const [port, setPort] = useState<string>('8000');

    // Speedtest State
    const [speedtestSizeMb, setSpeedtestSizeMb] = useState<number>(1);
    const [isRunningSpeedtest, setIsRunningSpeedtest] = useState<boolean>(false);
    const [speedtestPhase, setSpeedtestPhase] = useState<'idle' | 'ping' | 'download' | 'upload' | 'done'>('idle');
    const [dlProgress, setDlProgress] = useState<number>(0);
    const [dlCurrentMbps, setDlCurrentMbps] = useState<number>(0);
    const [ulProgress, setUlProgress] = useState<number>(0);
    const [ulCurrentMbps, setUlCurrentMbps] = useState<number>(0);
    const [latencyMetrics, setLatencyMetrics] = useState<{
      avgTotalRttMs: number;
      avgHubAgentRttMs: number;
      avgClientHubRttMs: number;
      minRttMs: number;
      maxRttMs: number;
      jitterMs: number;
      samples: number;
    } | null>(null);
    const [downloadMetrics, setDownloadMetrics] = useState<{
      mbps: number;
      mbPerSec: number;
      bytes: number;
      durationMs: number;
    } | null>(null);
    const [uploadMetrics, setUploadMetrics] = useState<{
      mbps: number;
      mbPerSec: number;
      bytes: number;
      durationMs: number;
    } | null>(null);
    const [probeResults, setProbeResults] = useState<TargetProbeResult[]>([]);
    const [isProbing, setIsProbing] = useState<boolean>(false);
    const [customProbeUrl, setCustomProbeUrl] = useState<string>('');
    const speedtestAbortRef = useRef<AbortController | null>(null);

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
      setTimeout(() => setToastMessage(null), 2600);
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

    useImperativeHandle(ref, () => ({
      refresh: () => {
        fetchListeningPorts(false);
      },
    }));

    useEffect(() => {
      if (isActive && activeHostId) {
        fetchListeningPorts(false);
      }
    }, [isActive, activeHostId, fetchListeningPorts]);

    const buildForwardCmd = (customPort?: number, customHost?: string) => {
      const p = customPort ?? 8000;
      const h = customHost ?? '127.0.0.1';
      if (isNaN(p) || p < 1 || p > 65535) return null;
      const isDefaultHost = !h || h === '127.0.0.1' || h === '0.0.0.0' || h === '::' || h === '::1';
      return isDefaultHost
        ? `gt forward ${activeHostId} ${p}:${p}`
        : `gt forward ${activeHostId} ${p}:${h}:${p}`;
    };

    const handleCopyForward = (customPort?: number, customHost?: string) => {
      const cmd = buildForwardCmd(customPort, customHost);
      if (!cmd) {
        showToast(isZh ? '无效的端口号' : 'Invalid port', 'error');
        return;
      }
      navigator.clipboard.writeText(cmd);
      const badgeKey = customPort ? `port-${customPort}` : 'forward';
      setCopiedCli(badgeKey);
      setTimeout(() => setCopiedCli(null), 2000);
      showToast(`${t('proxy.copied', '已复制')}: ${cmd}`, 'success');
    };

    const handleCopyProxy = () => {
      const cmd = `gt proxy ${activeHostId} -p 1080`;
      navigator.clipboard.writeText(cmd);
      setCopiedCli('proxy');
      setTimeout(() => setCopiedCli(null), 2000);
      showToast(`${t('proxy.copied', '已复制')}: ${cmd}`, 'success');
    };

    const handleCopySpeedtest = () => {
      const cmd = `gt speedtest ${activeHostId} --size ${speedtestSizeMb}`;
      navigator.clipboard.writeText(cmd);
      setCopiedCli('speedtest');
      setTimeout(() => setCopiedCli(null), 2000);
      showToast(`${t('proxy.copied', '已复制')}: ${cmd}`, 'success');
    };

    const handlePortChipClick = (p: ListeningPortInfo) => {
      setPort(String(p.port));
      const cleanHost =
        p.address && p.address !== '0.0.0.0' && p.address !== '::' && p.address !== '127.0.0.1' && p.address !== '::1'
          ? p.address
          : '127.0.0.1';
      setTargetHost(cleanHost);
      setRequestUrl(`http://${cleanHost}:${p.port}/`);
      handleCopyForward(p.port, cleanHost);
    };

    const handleProbeTargets = async (customUrl?: string) => {
      if (!activeHostId) return;
      setIsProbing(true);
      try {
        const targetToTest = customUrl?.trim() || customProbeUrl.trim();
        const targets = targetToTest ? [targetToTest] : undefined;
        const res = await apiFetch(`/api/proxy/${encodeURIComponent(activeHostId)}/speedtest/probe`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ targets, timeoutMs: 8000 }),
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.results)) {
            if (targets) {
              setProbeResults((prev) => {
                const map = new Map(prev.map((p) => [p.url, p]));
                for (const r of data.results) {
                  map.set(r.url, r);
                }
                return Array.from(map.values());
              });
              setCustomProbeUrl('');
            } else {
              setProbeResults(data.results);
            }
          }
        } else {
          const err = await res.json().catch(() => ({}));
          showToast(err.error || 'Probe failed', 'error');
        }
      } catch (err: any) {
        showToast(err.message || 'Probe failed', 'error');
      } finally {
        setIsProbing(false);
      }
    };

    const handleStartSpeedtest = async () => {
      if (!activeHostId) return;

      if (isRunningSpeedtest) {
        speedtestAbortRef.current?.abort();
        speedtestAbortRef.current = null;
        setIsRunningSpeedtest(false);
        setSpeedtestPhase('idle');
        return;
      }

      const controller = new AbortController();
      speedtestAbortRef.current = controller;
      setIsRunningSpeedtest(true);
      setSpeedtestPhase('ping');
      setLatencyMetrics(null);
      setDownloadMetrics(null);
      setUploadMetrics(null);
      setDlProgress(0);
      setUlProgress(0);
      setDlCurrentMbps(0);
      setUlCurrentMbps(0);

      try {
        // Phase 1: Ping
        const totalSamples: number[] = [];
        const hubAgentSamples: number[] = [];
        const clientHubSamples: number[] = [];

        for (let i = 0; i < 5; i++) {
          if (controller.signal.aborted) return;
          const start = performance.now();
          const res = await apiFetch(`/api/proxy/${encodeURIComponent(activeHostId)}/speedtest/ping`, {
            headers: getHeaders(),
            signal: controller.signal,
          });
          const totalRtt = Math.max(0.01, performance.now() - start);
          if (!res.ok) {
            throw new Error(`Ping failed (${res.status})`);
          }
          const data = await res.json();
          const hubAgentRtt = typeof data.hubAgentRttMs === 'number' ? data.hubAgentRttMs : 0;
          const clientHubRtt = Math.max(0, totalRtt - hubAgentRtt);
          totalSamples.push(totalRtt);
          hubAgentSamples.push(hubAgentRtt);
          clientHubSamples.push(clientHubRtt);
        }

        let jitterSum = 0;
        for (let j = 1; j < totalSamples.length; j++) {
          jitterSum += Math.abs(totalSamples[j] - totalSamples[j - 1]);
        }
        const jitterMs = totalSamples.length > 1 ? jitterSum / (totalSamples.length - 1) : 0;
        setLatencyMetrics({
          avgTotalRttMs: Number((totalSamples.reduce((a, b) => a + b, 0) / totalSamples.length).toFixed(2)),
          avgHubAgentRttMs: Number((hubAgentSamples.reduce((a, b) => a + b, 0) / hubAgentSamples.length).toFixed(2)),
          avgClientHubRttMs: Number((clientHubSamples.reduce((a, b) => a + b, 0) / clientHubSamples.length).toFixed(2)),
          minRttMs: Number(Math.min(...totalSamples).toFixed(2)),
          maxRttMs: Number(Math.max(...totalSamples).toFixed(2)),
          jitterMs: Number(jitterMs.toFixed(2)),
          samples: totalSamples.length,
        });

        // Phase 2: Download
        if (controller.signal.aborted) return;
        setSpeedtestPhase('download');
        const sizeBytes = speedtestSizeMb * 1024 * 1024;
        const dlStart = performance.now();
        const dlRes = await fetch(`/api/proxy/${encodeURIComponent(activeHostId)}/speedtest/download?bytes=${sizeBytes}`, {
          headers: getHeaders(),
          signal: controller.signal,
        });
        if (!dlRes.ok || !dlRes.body) {
          throw new Error(`Download failed (${dlRes.status})`);
        }

        const reader = dlRes.body.getReader();
        const onAbortReader = () => {
          reader.cancel().catch(() => {});
        };
        controller.signal.addEventListener('abort', onAbortReader, { once: true });

        let received = 0;
        try {
          while (true) {
            if (controller.signal.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            received += value?.length || 0;
            const elapsedSec = Math.max(0.001, (performance.now() - dlStart) / 1000);
            const mbps = (received * 8) / (elapsedSec * 1_000_000);
            setDlProgress(Math.min(100, Math.round((received / sizeBytes) * 100)));
            setDlCurrentMbps(Number(mbps.toFixed(2)));
          }
        } finally {
          controller.signal.removeEventListener('abort', onAbortReader);
        }

        if (controller.signal.aborted) return;

        const dlDurationMs = Math.max(1, performance.now() - dlStart);
        const dlSec = dlDurationMs / 1000;
        setDownloadMetrics({
          bytes: received,
          durationMs: Math.round(dlDurationMs),
          mbps: Number(((received * 8) / (dlSec * 1_000_000)).toFixed(2)),
          mbPerSec: Number((received / (dlSec * 1024 * 1024)).toFixed(2)),
        });

        // Phase 3: Upload (Sliced in <= 512KB batches so abort is instant and reverse proxies don't buffer 16MB+)
        if (controller.signal.aborted) return;
        setSpeedtestPhase('upload');

        const seedChunk = new Uint8Array(32 * 1024);
        if (typeof window !== 'undefined' && window.crypto) {
          window.crypto.getRandomValues(seedChunk);
        }
        const batchMaxBytes = Math.min(512 * 1024, sizeBytes);
        const batchBuf = new Uint8Array(batchMaxBytes);
        for (let offset = 0; offset < batchMaxBytes; offset += seedChunk.byteLength) {
          const copyLen = Math.min(seedChunk.byteLength, batchMaxBytes - offset);
          batchBuf.set(seedChunk.subarray(0, copyLen), offset);
        }

        let uploaded = 0;
        const ulStart = performance.now();

        while (uploaded < sizeBytes) {
          if (controller.signal.aborted) return;
          const remaining = sizeBytes - uploaded;
          const currentBatchSize = Math.min(batchMaxBytes, remaining);
          const payloadSlice =
            currentBatchSize === batchMaxBytes ? batchBuf : batchBuf.subarray(0, currentBatchSize);

          const ulRes = await fetch(`/api/proxy/${encodeURIComponent(activeHostId)}/speedtest/upload`, {
            method: 'POST',
            headers: {
              ...getHeaders(),
              'Content-Type': 'application/octet-stream',
            },
            body: new Blob([payloadSlice]),
            signal: controller.signal,
          });
          if (!ulRes.ok) throw new Error(`Upload failed (${ulRes.status})`);

          uploaded += currentBatchSize;
          const elapsedSec = Math.max(0.001, (performance.now() - ulStart) / 1000);
          const mbps = (uploaded * 8) / (elapsedSec * 1_000_000);
          setUlProgress(Math.min(100, Math.round((uploaded / sizeBytes) * 100)));
          setUlCurrentMbps(Number(mbps.toFixed(2)));
        }

        const ulDurationMs = Math.max(1, performance.now() - ulStart);
        const ulSec = ulDurationMs / 1000;
        setUploadMetrics({
          bytes: uploaded,
          durationMs: Math.round(ulDurationMs),
          mbps: Number(((uploaded * 8) / (ulSec * 1_000_000)).toFixed(2)),
          mbPerSec: Number((uploaded / (ulSec * 1024 * 1024)).toFixed(2)),
        });

        setSpeedtestPhase('done');

        if (probeResults.length === 0) {
          handleProbeTargets();
        }
      } catch (err: any) {
        if (!controller.signal.aborted) {
          showToast(err.message || 'Speedtest benchmark failed', 'error');
        }
      } finally {
        setIsRunningSpeedtest(false);
        speedtestAbortRef.current = null;
      }
    };

    useEffect(() => {
      return () => {
        if (speedtestAbortRef.current) {
          speedtestAbortRef.current.abort();
          speedtestAbortRef.current = null;
        }
      };
    }, []);

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
      <div className="flex-1 min-h-0 flex flex-col bg-[var(--bg-canvas)] text-slate-200 overflow-y-auto lg:overflow-hidden relative">
        {/* Toast Notification */}
        {toastMessage && (
          <div className="fixed sm:absolute top-3 right-3 sm:right-4 z-50 flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs shadow-lg border bg-slate-900/95 border-white/[0.12] animate-in fade-in slide-in-from-top-2 max-w-[90vw]">
            <span className={toastMessage.type === 'error' ? 'text-rose-400 shrink-0' : 'text-emerald-400 shrink-0'}>
              {toastMessage.type === 'error' ? '●' : '✓'}
            </span>
            <span className="truncate font-mono">{toastMessage.text}</span>
          </div>
        )}

        {/* Top Compact Bar: Discovered Listening Ports & CLI Command Shortcuts */}
        <div className="px-3 sm:px-4 py-2.5 border-b border-white/[0.08] bg-black/25 shrink-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center space-x-2 min-w-0">
              <Server className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="text-xs font-medium text-slate-200 truncate">
                {t('proxy.listeningPorts', '监听端口 (点击复制 gt forward)')}
              </span>
              <span className="px-1.5 py-0.5 bg-white/[0.06] rounded text-[10px] text-slate-400 font-mono shrink-0">
                {listeningPorts.length}
              </span>
              <button
                type="button"
                onClick={() => fetchListeningPorts(false)}
                disabled={isLoadingPorts}
                className="p-1 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white transition-all disabled:opacity-50"
                title={t('proxy.refresh', '刷新')}
              >
                <RefreshCw className={`w-3 h-3 ${isLoadingPorts ? 'animate-spin text-indigo-400' : ''}`} />
              </button>
            </div>

            {/* Quick CLI Copy Buttons */}
            <div className="flex items-center flex-wrap gap-1.5">
              <button
                type="button"
                data-testid="proxy-copy-forward-btn"
                onClick={() => handleCopyForward(8000, '127.0.0.1')}
                className="flex items-center space-x-1 px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 text-[11px] border border-white/[0.08] transition-all cursor-pointer"
                title={`gt forward ${activeHostId} 8000:8000`}
              >
                {copiedCli === 'forward' || copiedCli === 'port-8000' ? (
                  <Check className="w-3 h-3 text-emerald-400" />
                ) : (
                  <Copy className="w-3 h-3 text-indigo-400" />
                )}
                <span className="font-mono">{t('proxy.copyCliForward', '复制 gt forward')}</span>
              </button>

              <button
                type="button"
                data-testid="proxy-copy-proxy-btn"
                onClick={handleCopyProxy}
                className="flex items-center space-x-1 px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 text-[11px] border border-white/[0.08] transition-all cursor-pointer"
                title={`gt proxy ${activeHostId} -p 1080`}
              >
                {copiedCli === 'proxy' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-indigo-400" />}
                <span className="font-mono">{t('proxy.copyCliProxy', '复制 gt proxy')}</span>
              </button>
            </div>
          </div>

          {/* Horizontal scrollable port pills on mobile, wrap on desktop */}
          {listeningPorts.length === 0 ? (
            <div className="text-[11px] text-slate-500 font-mono py-0.5">
              {isLoadingPorts
                ? isZh
                  ? '正在扫描节点监听端口...'
                  : 'Scanning listening ports on agent...'
                : t('proxy.noListeningPorts', '未在此节点上发现监听端口')}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 overflow-x-auto sm:flex-wrap pb-0.5 no-scrollbar">
              {listeningPorts.map((p) => {
                const badgeKey = `port-${p.port}`;
                const isCopied = copiedCli === badgeKey;
                return (
                  <button
                    key={`${p.address}-${p.port}`}
                    type="button"
                    onClick={() => handlePortChipClick(p)}
                    title={isZh ? `点击复制 gt forward 并填入调试地址` : `Click to copy gt forward & fill debugger URL`}
                    className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-mono border transition-all cursor-pointer shrink-0 ${
                      isCopied
                        ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'
                        : 'bg-white/[0.03] text-slate-300 border-white/[0.06] hover:bg-indigo-600/20 hover:border-indigo-500/40'
                    }`}
                  >
                    {isCopied ? (
                      <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                    ) : (
                      <Copy className="w-3 h-3 text-indigo-400/80 shrink-0" />
                    )}
                    <span className="font-semibold text-indigo-300">:{p.port}</span>
                    {p.process && <span className="text-slate-400 text-[10px]">({p.process})</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Mobile-only Section Switcher (Hidden on Desktop lg+) */}
        <div className="lg:hidden px-3 py-2 border-b border-white/[0.06] bg-black/15 flex items-center gap-2 shrink-0">
          <button
            type="button"
            data-testid="mobile-tab-speedtest"
            onClick={() => setMobileSection('speedtest')}
            className={`flex-1 flex items-center justify-center space-x-1.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              mobileSection === 'speedtest'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'bg-white/[0.04] text-slate-400 hover:text-slate-200'
            }`}
          >
            <Gauge className="w-3.5 h-3.5" />
            <span>{t('proxy.speedtestMode', '网络测速与探测')}</span>
          </button>
          <button
            type="button"
            data-testid="mobile-tab-request"
            onClick={() => setMobileSection('request')}
            className={`flex-1 flex items-center justify-center space-x-1.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              mobileSection === 'request'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'bg-white/[0.04] text-slate-400 hover:text-slate-200'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            <span>{t('proxy.requestMode', 'HTTP 请求调试')}</span>
          </button>
        </div>

        {/* Main Unified Workbench: Dual-Column on Desktop (lg:grid-cols-12), Tabbed on Mobile */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-3 p-3 sm:p-4 lg:overflow-hidden">
          {/* Left Column (5 cols on lg): Speedtest & Outbound Connectivity Probe */}
          <div
            className={`lg:col-span-5 min-h-0 flex-col space-y-3 lg:overflow-y-auto lg:pr-1 ${
              mobileSection === 'speedtest' ? 'flex' : 'hidden lg:flex'
            }`}
          >
            {/* Speedtest Header & Controls */}
            <div className="p-3 rounded-xl bg-black/20 border border-white/[0.06] flex flex-col space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center space-x-1.5 text-xs font-medium text-slate-200">
                  <Gauge className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>{t('proxy.speedtestMode', '隧道延迟与带宽测速')}</span>
                </div>
                <button
                  type="button"
                  onClick={handleCopySpeedtest}
                  className="flex items-center space-x-1 px-2 py-0.5 rounded bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-slate-200 text-[10px] border border-white/[0.06] font-mono transition-all cursor-pointer"
                  title="Copy gt speedtest CLI command"
                >
                  {copiedCli === 'speedtest' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>gt speedtest</span>
                </button>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center space-x-2">
                  <span className="text-[11px] text-slate-400">{t('proxy.payloadSize', '数据量')}:</span>
                  <select
                    data-testid="speedtest-size-select"
                    value={speedtestSizeMb}
                    onChange={(e) => setSpeedtestSizeMb(parseInt(e.target.value, 10))}
                    disabled={isRunningSpeedtest}
                    className="bg-black/40 border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  >
                    <option value={1}>1 MB</option>
                    <option value={4}>4 MB</option>
                    <option value={16}>16 MB</option>
                    <option value={32}>32 MB</option>
                    <option value={64}>64 MB</option>
                  </select>
                </div>

                <button
                  type="button"
                  data-testid="speedtest-start-btn"
                  onClick={handleStartSpeedtest}
                  className={`flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all shadow-xs cursor-pointer ${
                    isRunningSpeedtest
                      ? 'bg-rose-600 hover:bg-rose-500 text-white'
                      : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                  }`}
                >
                  {isRunningSpeedtest ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>{t('proxy.stopSpeedtest', '停止')} ({speedtestPhase})</span>
                    </>
                  ) : (
                    <>
                      <Gauge className="w-3.5 h-3.5" />
                      <span>{t('proxy.startSpeedtest', '开始测速')}</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* 2x2 Compact Metric Cards (Works cleanly on both mobile & desktop) */}
            <div className="grid grid-cols-2 gap-2.5">
              {/* Card 1: Total RTT */}
              <div className="p-2.5 sm:p-3 rounded-xl bg-black/20 border border-white/[0.06] flex flex-col justify-between space-y-1.5">
                <div className="flex items-center justify-between text-slate-400 text-[11px]">
                  <span className="font-medium truncate">{t('proxy.totalRtt', '总往返延迟')}</span>
                  <Activity className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                </div>
                <div>
                  <div className="text-lg sm:text-xl font-bold font-mono text-slate-100">
                    {latencyMetrics ? `${latencyMetrics.avgTotalRttMs} ms` : '--'}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5 leading-tight">
                    {latencyMetrics ? (
                      <>
                        <div>Browser↔Hub: {latencyMetrics.avgClientHubRttMs}ms</div>
                        <div>Hub↔Agent: {latencyMetrics.avgHubAgentRttMs}ms</div>
                      </>
                    ) : (
                      <span>Browser↔Hub / Hub↔Agent</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Card 2: Jitter */}
              <div className="p-2.5 sm:p-3 rounded-xl bg-black/20 border border-white/[0.06] flex flex-col justify-between space-y-1.5">
                <div className="flex items-center justify-between text-slate-400 text-[11px]">
                  <span className="font-medium truncate">{t('proxy.jitter', '网络抖动')}</span>
                  <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                </div>
                <div>
                  <div className="text-lg sm:text-xl font-bold font-mono text-slate-100">
                    {latencyMetrics ? `±${latencyMetrics.jitterMs} ms` : '--'}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5 leading-tight">
                    {latencyMetrics ? (
                      <>
                        <div>Min: {latencyMetrics.minRttMs}ms</div>
                        <div>Max: {latencyMetrics.maxRttMs}ms</div>
                      </>
                    ) : (
                      <span>Min: -- / Max: --</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Card 3: Download Speed */}
              <div className="p-2.5 sm:p-3 rounded-xl bg-black/20 border border-white/[0.06] flex flex-col justify-between space-y-1.5">
                <div className="flex items-center justify-between text-slate-400 text-[11px]">
                  <span className="font-medium truncate">{t('proxy.downloadSpeed', '下行带宽')}</span>
                  <ArrowDown className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                </div>
                <div>
                  <div className="text-lg sm:text-xl font-bold font-mono text-emerald-400">
                    {downloadMetrics
                      ? `${downloadMetrics.mbps} Mbps`
                      : dlCurrentMbps > 0
                      ? `${dlCurrentMbps} Mbps`
                      : '--'}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">
                    {downloadMetrics ? `${downloadMetrics.mbPerSec} MB/s` : '-- MB/s'}
                  </div>
                  <div className="w-full bg-white/[0.05] h-1 rounded-full overflow-hidden mt-1.5">
                    <div className="bg-emerald-500 h-full transition-all duration-150" style={{ width: `${dlProgress}%` }} />
                  </div>
                </div>
              </div>

              {/* Card 4: Upload Speed */}
              <div className="p-2.5 sm:p-3 rounded-xl bg-black/20 border border-white/[0.06] flex flex-col justify-between space-y-1.5">
                <div className="flex items-center justify-between text-slate-400 text-[11px]">
                  <span className="font-medium truncate">{t('proxy.uploadSpeed', '上行带宽')}</span>
                  <ArrowUp className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                </div>
                <div>
                  <div className="text-lg sm:text-xl font-bold font-mono text-indigo-400">
                    {uploadMetrics
                      ? `${uploadMetrics.mbps} Mbps`
                      : ulCurrentMbps > 0
                      ? `${ulCurrentMbps} Mbps`
                      : '--'}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">
                    {uploadMetrics ? `${uploadMetrics.mbPerSec} MB/s` : '-- MB/s'}
                  </div>
                  <div className="w-full bg-white/[0.05] h-1 rounded-full overflow-hidden mt-1.5">
                    <div className="bg-indigo-500 h-full transition-all duration-150" style={{ width: `${ulProgress}%` }} />
                  </div>
                </div>
              </div>
            </div>

            {/* Outbound Target Connectivity Probes */}
            <div className="p-3 rounded-xl bg-black/20 border border-white/[0.06] flex flex-col space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center space-x-1.5 text-xs font-medium text-slate-200">
                  <Globe className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span className="truncate">{t('proxy.outboundProbe', 'Agent 出网连通性探测')}</span>
                </div>
                <button
                  type="button"
                  data-testid="speedtest-probe-btn"
                  onClick={() => handleProbeTargets()}
                  disabled={isProbing}
                  className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.08] text-slate-200 text-[11px] font-medium border border-white/[0.08] transition-all disabled:opacity-50 cursor-pointer shrink-0"
                >
                  {isProbing ? <Loader2 className="w-3 h-3 animate-spin text-indigo-400" /> : <RefreshCw className="w-3 h-3" />}
                  <span>{isProbing ? t('proxy.probing', '探测中...') : t('proxy.probeNow', '探测默认目标')}</span>
                </button>
              </div>

              <div className="flex items-center space-x-1.5">
                <input
                  type="text"
                  data-testid="speedtest-custom-probe-input"
                  value={customProbeUrl}
                  onChange={(e) => setCustomProbeUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customProbeUrl.trim()) {
                      handleProbeTargets(customProbeUrl.trim());
                    }
                  }}
                  placeholder={t('proxy.customTargetPlaceholder', '自定义探测 URL (https://...)')}
                  className="flex-1 min-w-0 bg-black/40 border border-white/[0.08] rounded-lg px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => handleProbeTargets(customProbeUrl.trim())}
                  disabled={isProbing || !customProbeUrl.trim()}
                  className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all disabled:opacity-50 cursor-pointer shrink-0"
                >
                  {t('proxy.probeNow', '探测')}
                </button>
              </div>

              <div className="space-y-1.5">
                {probeResults.length === 0 ? (
                  <div className="text-[11px] text-slate-500 py-2 text-center font-mono">
                    {isProbing
                      ? isZh
                        ? '正在从 Agent 节点探测目标...'
                        : 'Probing outbound targets from agent...'
                      : isZh
                      ? '点击“探测默认目标”测试 Agent 到常用公网地址的延迟'
                      : 'Click "Probe" to test Agent reachability & latency'}
                  </div>
                ) : (
                  probeResults.map((probe) => (
                    <div
                      key={probe.url}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.04] text-xs font-mono"
                    >
                      <div className="flex items-center space-x-2 truncate pr-2">
                        {probe.ok ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        ) : (
                          <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                        )}
                        <span className="text-slate-300 truncate text-[11px]">{probe.url}</span>
                      </div>

                      <div className="flex items-center space-x-2 shrink-0">
                        <span
                          className={`px-1.5 py-0.2 rounded text-[10px] font-semibold ${
                            probe.ok
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          }`}
                        >
                          {probe.ok ? `${probe.statusCode || 200}` : probe.error || 'ERR'}
                        </span>
                        <span className="text-slate-400 text-[11px] w-14 text-right">{probe.latencyMs} ms</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right Column (7 cols on lg): HTTP Request Debugger */}
          <div
            className={`lg:col-span-7 min-h-0 flex-col space-y-3 lg:overflow-hidden ${
              mobileSection === 'request' ? 'flex' : 'hidden lg:flex'
            }`}
          >
            {/* Request Builder Card */}
            <div className="p-3 rounded-xl bg-black/20 border border-white/[0.06] flex flex-col space-y-2.5 shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-1.5 text-xs font-medium text-slate-200">
                  <Zap className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>{t('proxy.requestMode', 'HTTP 请求调试器 (由 Agent 节点发出)')}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAdvancedRequest((v) => !v)}
                  className="flex items-center space-x-1 text-[11px] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                >
                  <span>{isZh ? 'Headers / Body / 证书' : 'Headers / Body / TLS'}</span>
                  {showAdvancedRequest ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
              </div>

              {/* Method + URL + Send (Responsive stack on ultra-narrow screens, row on sm+) */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <select
                    value={method}
                    onChange={(e) => {
                      setMethod(e.target.value);
                      if (e.target.value !== 'GET' && e.target.value !== 'HEAD') {
                        setShowAdvancedRequest(true);
                      }
                    }}
                    className="bg-black/40 border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs font-mono font-semibold text-indigo-300 focus:outline-none focus:border-indigo-500 shrink-0"
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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleSendRequest();
                      }
                    }}
                    placeholder="http://127.0.0.1:3000/ or https://api.github.com"
                    className="flex-1 min-w-0 bg-black/40 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <button
                  type="button"
                  data-testid="proxy-send-request-btn"
                  onClick={handleSendRequest}
                  disabled={isSending}
                  className="flex items-center justify-center space-x-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all shadow-xs cursor-pointer disabled:opacity-50 shrink-0"
                >
                  {isSending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  <span>{isSending ? t('proxy.sending', '发送中...') : t('proxy.sendRequest', '发送请求')}</span>
                </button>
              </div>

              {/* Collapsible Headers, Body & Insecure TLS */}
              {showAdvancedRequest && (
                <div className="pt-2 border-t border-white/[0.06] space-y-2.5 animate-in fade-in duration-150">
                  <div className="flex items-center space-x-2 text-xs text-slate-400">
                    <label className="flex items-center space-x-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={insecure}
                        onChange={(e) => setInsecure(e.target.checked)}
                        className="rounded bg-black/40 border-white/[0.1] text-indigo-600 focus:ring-0"
                      />
                      <span>{t('proxy.insecure', '忽略自签名 TLS 证书错误 (insecure)')}</span>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div className="flex flex-col space-y-1">
                      <label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">
                        {t('proxy.headers', '请求头 (JSON 或 Key: Value)')}
                      </label>
                      <textarea
                        value={customHeaders}
                        onChange={(e) => setCustomHeaders(e.target.value)}
                        placeholder={`Content-Type: application/json\nAuthorization: Bearer token`}
                        rows={3}
                        className="w-full bg-black/40 border border-white/[0.08] rounded-lg p-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500 resize-none"
                      />
                    </div>

                    {method !== 'GET' && method !== 'HEAD' && (
                      <div className="flex flex-col space-y-1">
                        <label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">
                          {t('proxy.body', '请求体 (Request Body)')}
                        </label>
                        <textarea
                          value={requestBody}
                          onChange={(e) => setRequestBody(e.target.value)}
                          placeholder={`{\n  "key": "value"\n}`}
                          rows={3}
                          className="w-full bg-black/40 border border-white/[0.08] rounded-lg p-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500 resize-none"
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Response Inspector Card */}
            <div className="flex-1 min-h-[260px] rounded-xl bg-black/30 border border-white/[0.08] flex flex-col overflow-hidden">
              <div className="px-3 py-2 bg-black/40 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
                <div className="flex items-center space-x-2">
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
                    {t('proxy.responseBody', '响应体')}
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
                  <div className="h-full flex items-center justify-center text-slate-500 text-center px-4">
                    {isSending
                      ? isZh
                        ? '正在通过 Agent 代理发送请求...'
                        : 'Sending request via agent proxy...'
                      : isZh
                      ? '输入目标 URL 并点击“发送请求”，或点击上方监听端口快速填入地址'
                      : 'Enter target URL and click Send, or click a listening port above'}
                  </div>
                ) : responseTab === 'body' ? (
                  <pre className="whitespace-pre-wrap break-all leading-relaxed">{responseData.body || '<Empty Body>'}</pre>
                ) : (
                  <div className="space-y-1">
                    {Object.entries(responseData.headers).map(([k, v]) => (
                      <div key={k} className="flex space-x-2">
                        <span className="text-indigo-400 font-medium shrink-0">{k}:</span>
                        <span className="text-slate-300 break-all">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

TerminalProxyView.displayName = 'TerminalProxyView';
export default TerminalProxyView;
