import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

const scriptPathCache = new Map<string, string>();

function resolveScriptFile(filename: string): string | null {
  const cached = scriptPathCache.get(filename);
  if (cached && fs.existsSync(cached)) {
    return cached;
  }

  const candidates = [
    path.join(__dirname, '../../../../dist', filename),
    path.join(__dirname, '../../../dist', filename),
    path.join(__dirname, '../../dist', filename),
    path.join(process.cwd(), 'dist', filename),
    path.join(__dirname, '../../../../scripts', filename),
    path.join(__dirname, '../../../scripts', filename),
    path.join(__dirname, '../../scripts', filename),
    path.join(process.cwd(), 'scripts', filename),
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || null;
  if (found) {
    scriptPathCache.set(filename, found);
  }
  return found;
}

function sanitizeProto(raw?: string): string {
  const cleaned = (raw || '').trim().toLowerCase();
  if (cleaned === 'https' || cleaned === 'http') {
    return cleaned;
  }
  return 'http';
}

function sanitizeHost(raw?: string): string {
  const cleaned = (raw || '').trim().replace(/\/+$/, '');
  // Reject shell metacharacters, quotes, backticks, newlines, spaces, or semicolons
  if (!cleaned || /["'`\\\r\n\s;|&<>()]/.test(cleaned)) {
    return 'localhost';
  }
  return cleaned;
}

export class DownloadController {
  static getInstallScript(req: Request, res: Response): void {
    const scriptPath = resolveScriptFile('install-gt.sh');
    if (!scriptPath) {
      res.status(404).send('Installer script not found.');
      return;
    }

    try {
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Dynamic Host and Protocol detection
      const protoHeader = req.headers['x-forwarded-proto'];
      const rawProto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
      const proto = sanitizeProto(rawProto?.split(',')[0]?.trim() || req.protocol || 'http');

      const hostHeader = req.headers['x-forwarded-host'];
      const rawHost = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
      const fallbackHost = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
      const host = sanitizeHost(rawHost?.split(',')[0]?.trim() || fallbackHost?.split(',')[0]?.trim() || 'localhost');

      const hubUrl = `${proto}://${host}`;

      // Dynamically inject the Hub URL into INJECTED_HUB_URL="..."
      const injectedContent = content.replace(
        /^INJECTED_HUB_URL=.*$/m,
        () => `INJECTED_HUB_URL="${hubUrl}"`
      );

      res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
      res.send(injectedContent);
    } catch (err) {
      res.status(500).send('Failed to read installer script.');
    }
  }

  static getGtBundle(req: Request, res: Response): void {
    // Prefer standalone dist/gt.js bundle, fallback to scripts/gt.js
    const scriptPath = resolveScriptFile('gt.js');
    if (scriptPath) {
      res.sendFile(scriptPath);
    } else {
      res.status(404).send('gt.js script not found.');
    }
  }
}
