import request from 'supertest';
import app from '../src/app';

describe('Public gt CLI and installer download endpoints', () => {
  it('serves install.sh on GET /install.sh and /api/terminal/install with proper content-type', async () => {
    const res1 = await request(app).get('/install.sh');
    expect(res1.status).toBe(200);
    expect(res1.headers['content-type']).toContain('text/x-shellscript');
    expect(res1.text).toContain('Gemini Terminal (gt) CLI One-Line Installer');
    expect(res1.text).toContain('INJECTED_HUB_URL=');

    const res2 = await request(app).get('/api/terminal/install');
    expect(res2.status).toBe(200);
    expect(res2.headers['content-type']).toContain('text/x-shellscript');
    expect(res2.text).toContain('Gemini Terminal (gt) CLI One-Line Installer');
  });

  it('dynamically injects Hub URL based on Host header', async () => {
    const res = await request(app)
      .get('/install.sh')
      .set('Host', 'hub.mycompany.internal:8000');

    expect(res.status).toBe(200);
    expect(res.text).toContain('INJECTED_HUB_URL="http://hub.mycompany.internal:8000"');
    expect(res.text).toContain('gt login \\"$EFFECTIVE_HUB_URL\\" <your-admin-key>');
    expect(res.text).toContain('gt run -d --name=\\"my-server\\"');
  });

  it('dynamically injects Hub URL prioritizing X-Forwarded-Proto and X-Forwarded-Host', async () => {
    const res = await request(app)
      .get('/api/terminal/install')
      .set('Host', '10.0.0.5:3000')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'terminal.example.com');

    expect(res.status).toBe(200);
    expect(res.text).toContain('INJECTED_HUB_URL="https://terminal.example.com"');
    expect(res.text).toContain('gt login \\"$EFFECTIVE_HUB_URL\\" <your-admin-key>');
  });

  it('handles comma-separated multi-proxy X-Forwarded-Host and X-Forwarded-Proto', async () => {
    const res = await request(app)
      .get('/install.sh')
      .set('X-Forwarded-Proto', 'https, http')
      .set('X-Forwarded-Host', 'first-proxy.org, second-proxy.internal');

    expect(res.status).toBe(200);
    expect(res.text).toContain('INJECTED_HUB_URL="https://first-proxy.org"');
  });

  it('handles array and multi-value header formats with trailing slashes and special characters safely', async () => {
    const res = await request(app)
      .get('/install.sh')
      .set('X-Forwarded-Proto', ['https, http'] as any)
      .set('X-Forwarded-Host', ['edge.example.com:8443/, backup.example.com'] as any);

    expect(res.status).toBe(200);
    expect(res.text).toContain('INJECTED_HUB_URL="https://edge.example.com:8443"');

    // Test with dollar signs in host without regex replacement substitution corruption
    const resDollar = await request(app)
      .get('/install.sh')
      .set('Host', 'my-$1-host.internal');

    expect(resDollar.status).toBe(200);
    expect(resDollar.text).toContain('INJECTED_HUB_URL="http://my-$1-host.internal"');
  });

  it('contains strict Node.js >= 18 check and multi-OS installation guide in installer script', async () => {
    const res = await request(app).get('/install.sh');
    expect(res.status).toBe(200);
    // Strict Node 18 check
    expect(res.text).toContain('[ "$NODE_MAJOR" -lt 18 ]');
    // Multi-OS installation commands
    expect(res.text).toContain('brew install node@20');
    expect(res.text).toContain('https://deb.nodesource.com/setup_20.x');
    expect(res.text).toContain('https://rpm.nodesource.com/setup_20.x');
  });

  it('serves gt.js on GET /gt and /api/terminal/gt', async () => {
    const res1 = await request(app).get('/gt');
    expect(res1.status).toBe(200);
    expect(res1.text).toContain('gt (Gemini Terminal)');

    const res2 = await request(app).get('/api/terminal/gt');
    expect(res2.status).toBe(200);
    expect(res2.text).toContain('gt (Gemini Terminal)');
  });
});
