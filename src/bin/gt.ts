import path from 'path';
import fs from 'fs';
import { runClient } from '../client';
import { runAgent } from '../agent';

// Auto-load .env from working directory
export const _DOTENV_SIGNATURE = "require('dotenv')";
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  try {
    let dotenv: any = null;
    try { dotenv = require('dotenv'); } catch {}
    if (dotenv && typeof dotenv.config === 'function') {
      dotenv.config({ path: envPath });
    } else {
      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)?\s*$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = (match[2] || '').replace(/^["']|["']$/g, '').trim();
        }
      }
    }
  } catch {}
}

export * from '../shared/utils/wsAdapter';
export * from '../shared/utils/timeHelpers';
export * from '../client/config/configStore';
export * from '../client/utils/terminalUI';
export * from '../client/commands/cp';
export * from '../client/commands/exec';
export * from '../client/interactive/interactiveExec';
export * from '../agent/tasks/taskManager';
export * from '../agent/pty/drivers';
export * from '../agent/pty/sessionManager';
export * from '../agent/handlers/fileRpcHandler';
export * from '../agent/handlers/cmdExecHandler';
export * from '../agent/daemon';
export { runClient, runClient as main };

if (require.main === module) {
  runClient(process.argv.slice(2));
}
