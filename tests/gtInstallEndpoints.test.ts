import request from 'supertest';
import app from '../src/app';

describe('Public gt CLI and installer download endpoints', () => {
  it('serves install.sh on GET /install.sh and /api/terminal/install', async () => {
    const res1 = await request(app).get('/install.sh');
    expect(res1.status).toBe(200);
    expect(res1.text).toContain('Gemini Terminal (gt) CLI One-Line Installer');

    const res2 = await request(app).get('/api/terminal/install');
    expect(res2.status).toBe(200);
    expect(res2.text).toContain('Gemini Terminal (gt) CLI One-Line Installer');
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
