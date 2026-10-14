import { requestAuthTicket } from '../frontend/src/utils/apiClient';

describe('Frontend Auth Ticket Utility', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches ticket from /api/auth/ticket with x-admin-key header', async () => {
    let capturedUrl = '';
    let capturedHeaders: any = {};

    global.fetch = jest.fn().mockImplementation((url: string, init: any) => {
      capturedUrl = url;
      capturedHeaders = init?.headers || {};
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, ticket: 'test-mock-ticket-48char', expiresIn: 30 }),
      });
    });

    const ticket = await requestAuthTicket('my-secret-key');
    expect(ticket).toBe('test-mock-ticket-48char');
    expect(capturedUrl).toContain('/api/auth/ticket');
    expect(capturedHeaders['x-admin-key']).toBe('my-secret-key');
  });

  it('returns null if no secret key is provided and server reports success false/unauthorized', async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: false,
        status: 401,
      });
    });

    const ticket = await requestAuthTicket('');
    expect(ticket).toBeNull();
  });
});
