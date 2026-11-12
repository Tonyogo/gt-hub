import { Request, Response } from 'express';
import { McpEngine } from '../../shared/mcp/server';
import { McpSecurityPolicy } from '../../shared/mcp/types';
import { mcpDirectAdapter } from '../adapters/mcpDirectAdapter';
import { getVersionInfo } from '../../shared/version';

export class TerminalMcpController {
  public extractMcpPolicy(req: Request): McpSecurityPolicy {
    const rawReadOnly = req.headers['x-mcp-readonly'] ?? req.query.readOnly;
    const readOnly = rawReadOnly === 'true' || rawReadOnly === '1';

    let allowedNodes: string[] | undefined = undefined;
    const rawNodes = (req.headers['x-mcp-nodes'] ?? req.query.nodes) as string | undefined;
    if (typeof rawNodes === 'string' && rawNodes.trim()) {
      allowedNodes = rawNodes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    let maxOutputChars: number | undefined = undefined;
    const rawMaxOutput = req.headers['x-mcp-max-output'] ?? req.query.maxOutput;
    if (rawMaxOutput !== undefined) {
      const parsed = parseInt(String(rawMaxOutput), 10);
      if (!isNaN(parsed) && parsed > 0) {
        maxOutputChars = parsed;
      }
    }

    return {
      readOnly,
      allowedNodes,
      maxOutputChars,
    };
  }

  public async handlePost(req: Request, res: Response): Promise<void> {
    try {
      const policy = this.extractMcpPolicy(req);
      const engine = new McpEngine(mcpDirectAdapter, policy);
      const result = await engine.handleMessage(req.body);

      if (result === null) {
        res.status(202).end();
        return;
      }

      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        error: {
          code: -32603,
          message: err.message || 'Internal error',
        },
      });
    }
  }

  public async handleGet(_req: Request, res: Response): Promise<void> {
    const versionInfo = getVersionInfo();
    res.status(200).json({
      success: true,
      name: 'gt-mcp',
      version: versionInfo.version,
      protocol: 'mcp-jsonrpc-2.0',
    });
  }
}

export const terminalMcpController = new TerminalMcpController();
export default terminalMcpController;
