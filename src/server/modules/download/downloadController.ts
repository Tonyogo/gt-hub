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
  if (!cleaned) {
    return 'localhost';
  }

  // IPv6 bracketed host: ^\[[0-9a-fA-F:]+\](?::\d{1,5})?$
  const ipv6Match = cleaned.match(/^\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?$/);
  if (ipv6Match) {
    const port = ipv6Match[2] ? parseInt(ipv6Match[2], 10) : undefined;
    if (port !== undefined && (port < 1 || port > 65535)) {
      return 'localhost';
    }
    return cleaned;
  }

  // Standard hostname / IPv4: ^[a-zA-Z0-9._-]+(?::\d{1,5})?$
  const hostMatch = cleaned.match(/^([a-zA-Z0-9._-]+)(?::(\d{1,5}))?$/);
  if (hostMatch) {
    const port = hostMatch[2] ? parseInt(hostMatch[2], 10) : undefined;
    if (port !== undefined && (port < 1 || port > 65535)) {
      return 'localhost';
    }
    return cleaned;
  }

  return 'localhost';
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

      const publicUrlEnv = process.env.GT_PUBLIC_URL ? process.env.GT_PUBLIC_URL.trim() : '';
      let hubUrl: string | null = null;

      if (publicUrlEnv && !/["'`\\$\s]/.test(publicUrlEnv)) {
        try {
          const parsed = new URL(publicUrlEnv);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            hubUrl = publicUrlEnv.replace(/\/+$/, '');
          }
        } catch {
          // Ignore invalid URL and fall through
        }
      }

      if (!hubUrl) {
        res.setHeader('Cache-Control', 'no-store');

        // Dynamic Host and Protocol detection
        const protoHeader = req.headers['x-forwarded-proto'];
        const rawProto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
        const proto = sanitizeProto(rawProto?.split(',')[0]?.trim() || req.protocol || 'http');

        const hostHeader = req.headers['x-forwarded-host'];
        const rawHost = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
        const fallbackHost = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
        const host = sanitizeHost(rawHost?.split(',')[0]?.trim() || fallbackHost?.split(',')[0]?.trim() || 'localhost');

        hubUrl = `${proto}://${host}`;
      }

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
