import { AgentDaemonManager } from '../../agent/daemon';
import { handleRemotePs } from './hosts';

export async function runPsCommand({
  server,
  key,
  args = [],
  jsonOutput = false,
  formatTemplateStr = null,
}: {
  server: string;
  key: string;
  args?: string[];
  jsonOutput?: boolean;
  formatTemplateStr?: string | null;
}): Promise<void> {
  const isLocal = args.includes('-l') || args.includes('--local');
  if (isLocal) {
    const hasAll = args.includes('-a') || args.includes('--all');
    AgentDaemonManager.printAgentsTable(hasAll);
    return;
  }
  await handleRemotePs({ server, key, args, jsonOutput, formatTemplateStr });
}
