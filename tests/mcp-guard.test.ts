import { MCP_TOOLS, listMcpTools } from '../src/shared/mcp/tools';
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  filterAllowedNodes,
  resolveTargetNode,
  checkToolPermission,
  truncateText,
} from '../src/shared/mcp/guard';
import { McpHostEntry } from '../src/shared/mcp/types';

describe('MCP Tools & Security Guardrails', () => {
  const sampleHosts: McpHostEntry[] = [
    { id: 'host-alpha-01', name: 'Prod-Web-1', status: 'online' },
    { id: 'host-alpha-02', name: 'Prod-Web-2', status: 'online' },
    { id: 'host-beta-01', name: 'Staging-DB', status: 'offline' },
  ];

  test('exposes all 17 tools by default and only 7 read-only tools when readOnly=true', () => {
    expect(MCP_TOOLS).toHaveLength(17);
    const allTools = listMcpTools({ readOnly: false });
    expect(allTools).toHaveLength(17);

    const roTools = listMcpTools({ readOnly: true });
    expect(roTools.map((t: any) => t.name)).toEqual([
      'gt_list_nodes',
      'gt_task_list',
      'gt_task_status',
      'gt_list_files',
      'gt_read_file',
      'gt_cron_list',
      'gt_cron_logs',
    ]);
  });

  test('checkToolPermission blocks write tools in read-only mode', () => {
    const denied = checkToolPermission('gt_exec', { readOnly: true });
    expect(denied).toEqual({
      ok: false,
      error: 'Permission denied: tool "gt_exec" is disabled in read-only mode.',
    });

    const allowed = checkToolPermission('gt_read_file', { readOnly: true });
    expect(allowed.ok).toBe(true);
  });

  test('resolveTargetNode resolves exact ID, case-insensitive name, and unique prefix within allowlist', () => {
    expect(resolveTargetNode('host-alpha-01', sampleHosts)).toEqual({
      ok: true,
      hostId: 'host-alpha-01',
      host: sampleHosts[0],
    });
    expect(resolveTargetNode('prod-web-2', sampleHosts)).toEqual({
      ok: true,
      hostId: 'host-alpha-02',
      host: sampleHosts[1],
    });
    expect(resolveTargetNode('staging', sampleHosts)).toEqual({
      ok: true,
      hostId: 'host-beta-01',
      host: sampleHosts[2],
    });
  });

  test('resolveTargetNode rejects disallowed nodes and ambiguous prefixes', () => {
    const denied = resolveTargetNode('Staging-DB', sampleHosts, {
      allowedNodes: ['Prod-Web-1', 'Prod-Web-2'],
    });
    expect(denied).toEqual({
      ok: false,
      error: 'Access denied: node "Staging-DB" is not in the allowed nodes list.',
    });

    const ambiguous = resolveTargetNode('Prod-Web', sampleHosts);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.error).toContain('Ambiguous node identifier "Prod-Web"');
      expect(ambiguous.error).toContain('host-alpha-01');
      expect(ambiguous.error).toContain('host-alpha-02');
    }
  });

  test('filterAllowedNodes filters host list by id or name case-insensitively', () => {
    const filtered = filterAllowedNodes(sampleHosts, { allowedNodes: ['prod-web-1', 'host-beta-01'] });
    expect(filtered.map((h: any) => h.id)).toEqual(['host-alpha-01', 'host-beta-01']);
  });

  test('truncateText truncates strings exceeding maxChars and calculates nextOffset', () => {
    expect(DEFAULT_MAX_OUTPUT_CHARS).toBe(32768);
    const raw = '0123456789abcdef';
    const res = truncateText(raw, 10, 5);
    expect(res.truncated).toBe(true);
    expect(res.totalChars).toBe(16);
    expect(res.nextOffset).toBe(15);
    expect(res.text).toBe(
      '0123456789\n...[TRUNCATED: showing 10 of 16 chars. Use offset=15 to read more]'
    );
  });
});
