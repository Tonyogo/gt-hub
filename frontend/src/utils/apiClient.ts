type UnauthorizedListener = () => void;

const unauthorizedListeners: Set<UnauthorizedListener> = new Set();

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
 * Request a short-lived single-use authentication ticket.
 */
export async function requestAuthTicket(adminKey?: string): Promise<string | null> {
  const key = adminKey || (typeof window !== 'undefined' ? localStorage.getItem('gt_admin_key') : '') || '';
  try {
    const headers: Record<string, string> = {};
    if (key) {
      headers['x-admin-key'] = key;
    }
    const res = await fetch('/api/auth/ticket', {
      method: 'POST',
      headers,
    });
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
