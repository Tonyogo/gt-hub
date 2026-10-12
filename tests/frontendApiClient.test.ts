import { apiFetch, onUnauthorized } from '../frontend/src/utils/apiClient';

describe('Frontend apiFetch and Unauthorized Interceptor', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('delegates to fetch and returns response', async () => {
    const mockResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const res = await apiFetch('/api/terminal/hosts');
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith('/api/terminal/hosts', undefined);
  });

  it('triggers onUnauthorized listener when status is 401 on protected endpoint', async () => {
    const mockResponse = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const listener = jest.fn();
    const unsubscribe = onUnauthorized(listener);

    try {
      const res = await apiFetch('/api/terminal/files/list');
      expect(res.status).toBe(401);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('does not trigger onUnauthorized listener for /api/auth/login or /api/auth/status', async () => {
    const mockResponse = new Response(JSON.stringify({ error: 'Bad credentials' }), { status: 401 });
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const listener = jest.fn();
    const unsubscribe = onUnauthorized(listener);

    try {
      await apiFetch('/api/auth/login');
      await apiFetch('/api/auth/status');
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('unsubscribes listener cleanly', async () => {
    const mockResponse = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const listener = jest.fn();
    const unsubscribe = onUnauthorized(listener);
    unsubscribe();

    await apiFetch('/api/terminal/hosts');
    expect(listener).not.toHaveBeenCalled();
  });
});
