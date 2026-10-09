import { handleRemotePs, handleRemotePrune } from './hosts';

export async function handleNodesCommand({
  server,
  key,
  all,
  json,
  format,
}: {
  server: string;
  key: string;
  all?: boolean;
  json?: boolean;
  format?: string;
}): Promise<void> {
  const args = all ? ['-a'] : [];
  await handleRemotePs({
    server,
    key,
    args,
    jsonOutput: !!json,
    formatTemplateStr: format || null,
  });
}

export async function handleNodesPruneCommand({
  server,
  key,
  json,
}: {
  server: string;
  key: string;
  json?: boolean;
}): Promise<void> {
  await handleRemotePrune({
    server,
    key,
    args: [],
    jsonOutput: !!json,
  });
}
