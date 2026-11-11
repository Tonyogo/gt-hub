type UnauthorizedListener = () => void;

const unauthorizedListeners: Set<UnauthorizedListener> = new Set();

export const ADMIN_KEY_STORAGE_KEY = 'adminKey';
export const ADMIN_LOGGED_OUT_STORAGE_KEY = 'admin_logged_out';
export const DEFAULT_ADMIN_KEY = 'gt-hub';

/**
 * Retrieve stored admin secret key from localStorage with legacy fallback.
 * Defaults to DEFAULT_ADMIN_KEY ('gt-hub') unless explicitly logged out.
 */
export function getStoredAdminKey(): string {
  if (typeof window === 'undefined' || !window.localStorage) {
    return '';
  }
  try {
    const key =
      localStorage.getItem('adminKey') ||
      localStorage.getItem('admin_secret_key') ||
      localStorage.getItem('gt_admin_key');
    if (key && key.trim()) {
      return key.trim();
    }
    if (localStorage.getItem(ADMIN_LOGGED_OUT_STORAGE_KEY) === 'true') {
      return '';
    }
    return DEFAULT_ADMIN_KEY;
  } catch {
    return '';
  }
}

/**
 * Persist admin secret key to localStorage and clean up legacy keys.
 */
export function setStoredAdminKey(key: string): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, key);
    localStorage.removeItem('admin_secret_key');
    localStorage.removeItem('gt_admin_key');
    localStorage.removeItem(ADMIN_LOGGED_OUT_STORAGE_KEY);
  } catch {}
}

/**
 * Remove stored admin secret key and legacy keys from localStorage.
 */
export function clearStoredAdminKey(markLoggedOut = false): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    localStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
    localStorage.removeItem('admin_secret_key');
    localStorage.removeItem('gt_admin_key');
    if (markLoggedOut) {
      localStorage.setItem(ADMIN_LOGGED_OUT_STORAGE_KEY, 'true');
    }
  } catch {}
}

/**
 * Register a listener to be invoked when an API request returns HTTP 401 Unauthorized.
 * Returns an unregister cleanup function.
 */
export function onUnauthorized(callback: UnauthorizedListener): () => void {
  unauthorizedListeners.add(callback);
  return () => {
    unauthorizedListeners.delete(callback);
  };
}

/**
 * Trigger all registered unauthorized listeners.
 */
export function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch (err) {
      console.error('[ApiClient] Error in unauthorized listener', err);
    }
  }
}

/**
 * Request a short-lived single-use authentication ticket with timeout protection.
 */
export async function requestAuthTicket(adminKey?: string, timeoutMs: number = 5000, reusable: boolean = false): Promise<string | null> {
  const key = adminKey || getStoredAdminKey();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0
    ? setTimeout(() => {
        try {
          controller.abort();
        } catch {}
      }, timeoutMs)
    : null;

  try {
    const headers: Record<string, string> = {};
    if (key) {
      headers['x-admin-key'] = key;
    }
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
    };
    if (controller) {
      fetchOptions.signal = controller.signal;
    }
    const url = `/api/auth/ticket${reusable ? '?reusable=1' : ''}`;
    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    if (data && data.success && data.ticket) {
      return data.ticket;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Unified fetch wrapper that intercepts 401 Unauthorized responses without monkey-patching window.fetch.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);

  if (response.status === 401) {
    const url = typeof input === 'string'
      ? input
      : (input instanceof Request ? input.url : input.toString());

    // Do not trigger global logout on login attempts or initial status check
    if (!url.includes('/api/auth/login') && !url.includes('/api/auth/status')) {
      notifyUnauthorized();
    }
  }

  return response;
}

export default apiFetch;
