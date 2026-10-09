import { ConfigStore, DEFAULT_SERVER_URL } from './config/configStore';
import {
  exitWithError,
  formatTemplate,
  resolveTaskId,
  resolveHost,
  isRemoteSpec,
  parseRemoteSpec,
  quoteShellArg,
  resolveWebSocketUrl,
  parseControlMessage,
  makeRequest,
} from './utils/terminalUI';
import { formatRelativeTime } from '../shared/utils/timeHelpers';
import { parseCpArgs, uploadLocalFile, downloadRemoteFile, runCp } from './commands/cp';
import { parseExecArgs, runExecCommand } from './commands/exec';
import { runInteractiveExec } from './interactive/interactiveExec';
import { handleLogin, handleLogout } from './commands/auth';
import { handleRemotePs, handleRemotePrune } from './commands/hosts';
import { handleLogsDispatcher, handleRemoteLogs } from './commands/logs';
import { handleRemoteKill, handleConfig } from './commands/manage';
import { AgentDaemonManager, runAgent } from '../agent/daemon';

export const VERSION = '1.0.0';

export {
  DEFAULT_SERVER_URL,
  ConfigStore,
  exitWithError,
  formatTemplate,
  resolveTaskId,
  resolveHost,
  isRemoteSpec,
  parseRemoteSpec,
  quoteShellArg,
  resolveWebSocketUrl,
  parseControlMessage,
  makeRequest,
  formatRelativeTime,
  parseCpArgs,
  uploadLocalFile,
  downloadRemoteFile,
  runCp,
  parseExecArgs,
  runInteractiveExec,
};

export function printHelp(): void {
  console.log(`
gt (Gemini Terminal) - Unified Docker-Style Terminal CLI

Usage:
  gt [GLOBAL_OPTIONS] COMMAND [ARGS...]

Agent Lifecycle Commands:
  run [-d] [NAME]                 Run reverse terminal agent (foreground or daemon)
  ps [-a] [-l|--local]            List connected hosts (default: remote; -l for local)
  logs [-f] [-n 50] [NAME]        View local agent daemon logs
  stop [NAME] [--all]             Stop running agent daemon(s)
  restart [NAME]                  Restart local agent daemon
  rm [NAME] [--all]               Remove stopped agent daemon record(s)
  prune [-l|--local] [-a|--all]   Remove offline remote nodes (or -l for local agents)

Remote Execution Commands:
  exec [OPTIONS] <node> <cmd...>  Execute a command on a remote host
  cp <src> <dest>                 Copy files between local and remote host
  task ls <node> [OPTIONS]        List recent tasks on a host
  task logs [-f] <node> [taskId]  View or follow task execution logs
  task kill <node> <taskId>       Terminate a running task on a remote host

Authentication & Config:
  login [SERVER] [KEY]            Verify and save admin credentials
  logout                          Remove stored credentials
  config <list|get|set>           Manage local client configuration settings

Exec Options:
  -i, --interactive       Keep STDIN open for live or piped input
  -t, --tty               Allocate a pseudo-TTY with raw terminal input
  -it                     Interactive pseudo-terminal session (like 'docker exec -it')
  -d, --detach            Run command in background and print task ID
  -w, --workdir <dir>     Working directory on remote host
  --timeout <ms>          Execution timeout in ms (Default: 300000 / 5 min)
  -e, --env <KEY=VAL>     Set remote environment variable (can be repeated)
  --verbose               Show execution header and duration footer banners
  --poll-interval <ms>    Polling interval for log stream in ms (Default: 500)

Global Options:
  -s, --server <url>              Hub server URL (Default: env GT_SERVER or http://localhost:8000)
  -k, --key <secret>              Admin secret key (Default: env GT_KEY)
  --json                          Output in JSON format
  --format <template>             Format output using Go/Docker template (e.g. 'table {{.ID}}\\t{{.Name}}')
  -v, --version                   Print version information
  -h, --help                      Show this help menu

Aliases & Compatibility:
  agent run [-d] [NAME]           Alias for 'gt run'
  agent ps [-a|--all]             Alias for 'gt ps -l'
  agent logs [-f] [-n 50] [NAME]  Alias for 'gt logs'
  agent stop [NAME] [--all]       Alias for 'gt stop'
  agent restart [NAME]            Alias for 'gt restart'
  agent rm [NAME] [--all]         Alias for 'gt rm'
  agent prune                     Alias for 'gt prune -l'
  kill <node> <taskId>            Shortcut for 'gt task kill'

Examples:
  gt login http://localhost:8000 secret
  gt logout
  gt run -d worker-1
  gt ps [-a|--all]
  gt ps -l
  gt logs -f worker-1
  gt stop worker-1
  gt prune -l
  gt exec my-server uptime
  gt exec -it my-server bash
  gt task logs -f my-server task-123
  gt kill my-server task-123
  gt cp local.txt my-server:/tmp/remote.txt
  gt agent run -d worker-1
`);
}

export async function runClient(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  let cliServer: string | null = null;
  let cliKey: string | null = null;
  let jsonOutput = false;
  let formatTemplateStr: string | null = null;

  const filteredArgs: string[] = [];
  let foundDoubleDash = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (foundDoubleDash) {
      filteredArgs.push(a);
      continue;
    }
    if (a === '--') {
      foundDoubleDash = true;
      filteredArgs.push(a);
      continue;
    }
    if (a === '-v' || a === '--version') {
      console.log(`gt version ${VERSION}`);
      process.exit(0);
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--format') {
      formatTemplateStr = rawArgs[++i];
    } else if (a.startsWith('--format=')) {
      formatTemplateStr = a.slice(9);
    } else if (a === '-s' || a === '--server') {
      cliServer = rawArgs[++i];
    } else if (a.startsWith('--server=')) {
      cliServer = a.slice(9);
    } else if (a === '-k' || a === '--key') {
      cliKey = rawArgs[++i];
    } else if (a.startsWith('--key=')) {
      cliKey = a.slice(6);
    } else {
      filteredArgs.push(a);
    }
  }

  const effectiveConfig = ConfigStore.getEffectiveConfig({ server: cliServer || undefined, key: cliKey || undefined });
  const server = effectiveConfig.server;
  const key = effectiveConfig.key;

  if (filteredArgs.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = filteredArgs[0].toLowerCase();
  const cmdArgs = filteredArgs.slice(1);

  const commandMigrationMap: Record<string, string> = {
    hosts: 'gt ps',
    nodes: 'gt ps',
  };

  if (commandMigrationMap[command]) {
    const target = commandMigrationMap[command];
    if (command === 'hosts' || command === 'nodes') {
      console.error(`Error: 'gt ${command}' has been deprecated. Use '${target}' instead.`);
      console.error(`Run 'gt --help' for modern Docker-style command usage.`);
    } else {
      console.error(`Error: 'gt ${command}' has been moved to '${target}'.`);
      console.error(`Run '${target}' instead.`);
      console.error(`Run 'gt --help' for modern Docker-style command usage.`);
    }
    process.exit(125);
  }

  switch (command) {
    case 'ps': {
      const isLocal = cmdArgs.includes('-l') || cmdArgs.includes('--local');
      if (isLocal) {
        const hasAll = cmdArgs.includes('-a') || cmdArgs.includes('--all');
        AgentDaemonManager.printAgentsTable(hasAll);
        break;
      }
      await handleRemotePs({ server, key, args: cmdArgs, jsonOutput, formatTemplateStr });
      break;
    }

    case 'prune': {
      const isLocal = cmdArgs.includes('-l') || cmdArgs.includes('--local');
      const isAll = cmdArgs.includes('-a') || cmdArgs.includes('--all');

      if (isLocal) {
        const { removed } = AgentDaemonManager.prune();
        if (removed.length === 0) {
          console.log('No stopped agents to prune.');
        } else {
          console.log(`Pruned ${removed.length} stopped agent(s): ${removed.join(', ')}`);
        }
        process.exit(0);
      }

      if (isAll) {
        const { removed } = AgentDaemonManager.prune();
        if (removed.length > 0) {
          console.log(`Pruned ${removed.length} local stopped agent(s): ${removed.join(', ')}`);
        }
        await handleRemotePrune({ server, key, args: cmdArgs, jsonOutput });
        break;
      }

      await handleRemotePrune({ server, key, args: cmdArgs, jsonOutput });
      break;
    }

    case 'login': {
      await handleLogin({ server, key, subArgs: cmdArgs });
      break;
    }

    case 'logout': {
      handleLogout();
      break;
    }

    case 'logs': {
      await handleLogsDispatcher({ server, key, args: cmdArgs, jsonOutput });
      break;
    }

    case 'kill': {
      await handleRemoteKill({ server, key, args: cmdArgs, jsonOutput });
      break;
    }

    case 'host':
    case 'node': {
      const subCommand = (cmdArgs[0] || '').toLowerCase();
      const subArgs = cmdArgs.slice(1);

      if (!subCommand) {
        console.error('Error: Missing host subcommand. Usage: gt host <ls|prune> [OPTIONS]');
        process.exit(125);
      }

      if (subCommand === 'ls' || subCommand === 'list') {
        await handleRemotePs({ server, key, args: subArgs, jsonOutput, formatTemplateStr });
      } else if (subCommand === 'prune') {
        await handleRemotePrune({ server, key, args: subArgs, jsonOutput });
      } else {
        console.error(`Error: Unknown host subcommand: '${subCommand}'.`);
        console.error("Usage: gt host <ls|prune> [OPTIONS]");
        process.exit(125);
      }
      break;
    }

    case 'task': {
      const subCommand = (cmdArgs[0] || '').toLowerCase();
      const subArgs = cmdArgs.slice(1);

      if (!subCommand) {
        console.error('Error: Missing task subcommand. Usage: gt task <ls|logs|kill> [ARGS...]');
        process.exit(125);
      }

      if (subCommand === 'ls' || subCommand === 'list') {
        let targetHost: string | null = null;
        for (let i = 0; i < subArgs.length; i++) {
          if (subArgs[i] === '--json') jsonOutput = true;
          else if (subArgs[i] === '--format') formatTemplateStr = subArgs[++i];
          else if (subArgs[i].startsWith('--format=')) formatTemplateStr = subArgs[i].slice(9);
          else if (!targetHost) targetHost = subArgs[i];
        }

        if (!targetHost) {
          console.error('Error: Missing target host. Usage: gt task ls <host> [OPTIONS]');
          process.exit(125);
        }

        let resolvedHost: { id: string; name: string };
        try {
          resolvedHost = await resolveHost(server, key, targetHost);
        } catch (err: any) {
          if (err.message && (err.message.includes('Ambiguous') || err.message.includes('No such host'))) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
          resolvedHost = { id: targetHost, name: targetHost };
        }

        try {
          const res = await makeRequest({
            serverUrl: server,
            endpoint: `/api/terminal/exec/${encodeURIComponent(resolvedHost.id)}`,
            method: 'GET',
            apiKey: key,
          });

          if (jsonOutput) {
            console.log(JSON.stringify(res.data, null, 2));
            process.exit(0);
          }

          if (res.data && res.data.success && Array.isArray(res.data.tasks)) {
            const tasks: any[] = res.data.tasks;
            if (formatTemplateStr) {
              const formatted = formatTemplate(formatTemplateStr, tasks);
              if (formatted) console.log(formatted);
              process.exit(0);
            }

            if (tasks.length === 0) {
              console.log(`No recent tasks recorded on [${resolvedHost.id}].`);
              process.exit(0);
            }

            console.log(
              'TASK ID'.padEnd(26) +
              'STATUS'.padEnd(12) +
              'EXIT'.padEnd(8) +
              'START TIME'.padEnd(14) +
              'COMMAND'
            );
            console.log('-'.repeat(80));

            for (const t of tasks) {
              const timeStr = new Date(t.startTime).toLocaleTimeString();
              const exitStr = t.exitCode !== null && t.exitCode !== undefined ? String(t.exitCode) : '-';
              console.log(
                t.taskId.padEnd(26) +
                t.status.padEnd(12) +
                exitStr.padEnd(8) +
                timeStr.padEnd(14) +
                t.command
              );
            }
            process.exit(0);
          } else {
            console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
            process.exit(1);
          }
        } catch (err: any) {
          console.error(`Failed to list tasks on [${resolvedHost.id}]: ${err.message}`);
          process.exit(1);
        }
      } else if (subCommand === 'logs') {
        await handleRemoteLogs({ server, key, args: subArgs, jsonOutput });
      } else if (subCommand === 'kill') {
        await handleRemoteKill({ server, key, args: subArgs, jsonOutput });
      } else {
        console.error(`Error: Unknown task subcommand: '${subCommand}'.`);
        console.error("Usage: gt task <ls|logs|kill> [ARGS...]");
        process.exit(125);
      }
      break;
    }

    case 'auth': {
      const subCommand = (cmdArgs[0] || '').toLowerCase();
      const subArgs = cmdArgs.slice(1);

      if (!subCommand) {
        console.error('Error: Missing auth subcommand. Usage: gt auth <login|logout> [ARGS...]');
        process.exit(125);
      }

      if (subCommand === 'login') {
        await handleLogin({ server, key, subArgs });
      } else if (subCommand === 'logout') {
        handleLogout();
      } else {
        console.error(`Error: Unknown auth subcommand: '${subCommand}'.`);
        console.error("Usage: gt auth <login|logout> [ARGS...]");
        process.exit(125);
      }
      break;
    }

    case 'cp': {
      if (cmdArgs.length < 2) {
        console.error('Error: Missing arguments. Usage: gt cp <src> <dest>');
        process.exit(125);
      }
      try {
        const code = await runCp(server, key, cmdArgs);
        process.exit(code);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'exec': {
      await runExecCommand({ server, key, cmdArgs, jsonOutput });
      break;
    }

    case 'config': {
      handleConfig({ cmdArgs, server, key });
      break;
    }

    case 'run': {
      await runAgent(['run', ...cmdArgs], { server, key, cliServer, cliKey });
      break;
    }

    case 'stop': {
      const hasAll = cmdArgs.includes('--all') || cmdArgs.includes('-a');
      if (hasAll) {
        const results = await AgentDaemonManager.stopAll();
        if (results.length === 0) {
          console.log('No running agents to stop.');
        } else {
          for (const r of results) {
            console.log(r.message);
          }
        }
        process.exit(0);
      }

      let targetName: string | null = null;
      for (const a of cmdArgs) {
        if (!a.startsWith('-')) {
          targetName = a;
          break;
        }
      }

      const resolved = AgentDaemonManager.resolveTarget(targetName || undefined, 'stop');
      if (resolved.error) {
        console.error(resolved.error);
        process.exit(1);
      }

      const res = await AgentDaemonManager.stop(resolved.agent.name);
      console.log(res.message);
      process.exit(0);
    }

    case 'restart': {
      let targetName: string | null = null;
      for (const a of cmdArgs) {
        if (!a.startsWith('-')) {
          targetName = a;
          break;
        }
      }

      const resolved = AgentDaemonManager.resolveTarget(targetName || undefined, 'restart');
      if (resolved.error) {
        console.error(resolved.error);
        process.exit(1);
      }

      const sName = resolved.agent.name;
      await AgentDaemonManager.stop(sName);
      await runAgent(['start', `--name=${sName}`], { server, key, cliServer, cliKey });
      break;
    }

    case 'rm': {
      const hasAll = cmdArgs.includes('--all') || cmdArgs.includes('-a');
      if (hasAll) {
        const { removed } = AgentDaemonManager.removeAll();
        if (removed.length === 0) {
          console.log('No stopped agents to remove.');
        } else {
          console.log(`Removed agents: ${removed.join(', ')}`);
        }
        process.exit(0);
      }

      let targetName: string | null = null;
      for (const a of cmdArgs) {
        if (!a.startsWith('-')) {
          targetName = a;
          break;
        }
      }

      if (!targetName) {
        const resolved = AgentDaemonManager.resolveTarget(undefined, 'remove');
        if (resolved.agent) {
          targetName = resolved.agent.name;
        } else {
          console.error('Error: Please specify agent NAME to remove (e.g. gt rm <NAME>).');
          process.exit(1);
        }
      }

      const res = AgentDaemonManager.remove(targetName, { removeLogs: true });
      if (!res.success) {
        console.error(res.message);
        process.exit(1);
      }
      console.log(res.message);
      process.exit(0);
    }

    case 'agent': {
      await runAgent(cmdArgs, { server, key, cliServer, cliKey });
      break;
    }

    default:
      console.error(`Error: Unknown command: ${command}`);
      console.error("Run 'gt --help' for usage.");
      process.exit(1);
  }
}
