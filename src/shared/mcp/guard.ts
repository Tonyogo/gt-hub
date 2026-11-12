import { McpSecurityPolicy, McpHostEntry, McpToolDefinition } from './types';
import { getMcpToolByName } from './tools';

export const DEFAULT_MAX_OUTPUT_CHARS = 32768;

export function isNodeAllowed(host: McpHostEntry, allowedNodes?: string[]): boolean {
  if (!allowedNodes || allowedNodes.length === 0) {
    return true;
  }
  const hostId = (host.id || '').trim().toLowerCase();
  const hostName = (host.name || '').trim().toLowerCase();

  for (const raw of allowedNodes) {
    const item = raw.trim().toLowerCase();
    if (!item) continue;
    if (hostId === item || (hostName && hostName === item)) {
      return true;
    }
  }
  return false;
}

export function filterAllowedNodes(hosts: McpHostEntry[], policy?: McpSecurityPolicy): McpHostEntry[] {
  if (!policy?.allowedNodes || policy.allowedNodes.length === 0) {
    return hosts;
  }
  return hosts.filter((h) => isNodeAllowed(h, policy.allowedNodes));
}

export function resolveTargetNode(
  nodeInput: string,
  hosts: McpHostEntry[],
  policy?: McpSecurityPolicy
): { ok: true; hostId: string; host: McpHostEntry } | { ok: false; error: string } {
  const input = (nodeInput || '').trim();
  if (!input) {
    return { ok: false, error: 'Target node identifier is required.' };
  }

  const hasAllowlist = Boolean(policy?.allowedNodes && policy.allowedNodes.length > 0);
  const permittedHosts = hasAllowlist ? filterAllowedNodes(hosts, policy) : hosts;

  // 1. Exact ID match among permitted hosts
  const exactIdMatch = permittedHosts.find((h) => h.id === input);
  if (exactIdMatch) {
    return { ok: true, hostId: exactIdMatch.id, host: exactIdMatch };
  }

  // 2. Case-insensitive exact ID or Name match among permitted hosts
  const inputLower = input.toLowerCase();
  const exactCiMatches = permittedHosts.filter(
    (h) => h.id.toLowerCase() === inputLower || (h.name && h.name.toLowerCase() === inputLower)
  );
  if (exactCiMatches.length === 1) {
    return { ok: true, hostId: exactCiMatches[0].id, host: exactCiMatches[0] };
  }
  if (exactCiMatches.length > 1) {
    const matchedList = exactCiMatches.map((h) => `${h.id}${h.name ? ` (${h.name})` : ''}`).join(', ');
    return {
      ok: false,
      error: `Ambiguous node identifier "${input}": matches multiple nodes (${matchedList}).`,
    };
  }

  // 3. Prefix match on ID or Name among permitted hosts
  const prefixMatches = permittedHosts.filter(
    (h) =>
      h.id.toLowerCase().startsWith(inputLower) ||
      (h.name && h.name.toLowerCase().startsWith(inputLower))
  );
  if (prefixMatches.length === 1) {
    return { ok: true, hostId: prefixMatches[0].id, host: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    const matchedList = prefixMatches.map((h) => `${h.id}${h.name ? ` (${h.name})` : ''}`).join(', ');
    return {
      ok: false,
      error: `Ambiguous node identifier "${input}": matches multiple nodes (${matchedList}).`,
    };
  }

  // If no permitted host matched:
  if (hasAllowlist) {
    return {
      ok: false,
      error: `Access denied: node "${input}" is not in the allowed nodes list.`,
    };
  }

  return {
    ok: false,
    error: `Node "${input}" not found.`,
  };
}

export function checkToolPermission(
  toolName: string,
  policy?: McpSecurityPolicy
): { ok: true; tool: McpToolDefinition } | { ok: false; error: string; code?: number } {
  const tool = getMcpToolByName(toolName);
  if (!tool) {
    return {
      ok: false,
      error: `Unknown tool: ${toolName}`,
      code: -32601,
    };
  }

  if (policy?.readOnly && !tool.readOnly) {
    return {
      ok: false,
      error: `Permission denied: tool "${toolName}" is disabled in read-only mode.`,
    };
  }

  return { ok: true, tool };
}

export function truncateText(
  text: string,
  maxChars: number = DEFAULT_MAX_OUTPUT_CHARS,
  baseOffset: number = 0
): { text: string; truncated: boolean; totalChars: number; nextOffset?: number } {
  const effectiveMax = typeof maxChars === 'number' && maxChars > 0 ? maxChars : DEFAULT_MAX_OUTPUT_CHARS;
  const offset = typeof baseOffset === 'number' && !isNaN(baseOffset) && baseOffset >= 0 ? baseOffset : 0;
  const total = text.length;

  if (total <= effectiveMax) {
    return {
      text,
      truncated: false,
      totalChars: total,
    };
  }

  const shown = effectiveMax;
  const nextOffset = offset + shown;
  const sliced = text.slice(0, shown);
  const truncatedText = `${sliced}\n...[TRUNCATED: showing ${shown} of ${total} chars. Use offset=${nextOffset} to read more]`;

  return {
    text: truncatedText,
    truncated: true,
    totalChars: total,
    nextOffset,
  };
}
