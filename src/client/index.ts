import { Command } from 'commander';
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
import { handleAuthLogin, handleAuthLogout, handleAuthStatus, handleLogin, handleLogout } from './commands/auth';
import { handleRemotePs, handleRemotePrune } from './commands/hosts';
import { handleNodesCommand, handleNodesPruneCommand } from './commands/nodes';
import { handleTaskLs, handleTaskLogs, handleTaskKill } from './commands/task';
import {
  handleConfigGetContexts,
  handleConfigCurrentContext,
  handleConfigUseContext,
  handleConfigSetContext,
  handleConfigDeleteContext,
  handleConfigView,
  handleConfigList,
} from './commands/config';
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

export function createProgram(rawArgs: string[] = []): Command {
  const program = new Command();

  program
    .name('gt')
    .usage('[GLOBAL_OPTIONS] COMMAND [ARGS...]')
    .description('gt (Gemini Terminal) - Unified Docker-Style Terminal CLI')
    .version(`gt version ${VERSION}`, '-v, --version', 'Output the version number')
    .helpOption('-h, --help', 'Display help for command')
    .option('-c, --context <name>', 'Target Hub context to use (overrides current-context)')
    .option('-s, --server <url>', 'Hub server URL (Default: env GT_SERVER or http://localhost:8000)')
    .option('-k, --key <secret>', 'Admin secret key (Default: env GT_KEY)')
    .option('--json', 'Output in JSON format')
    .option('--format <template>', 'Format output using Go/Docker template (e.g. \'table {{.ID}}\\t{{.Name}}\')')
    .enablePositionalOptions(true);

  program.addHelpText('after', `
Agent Daemon Commands:
  agent start                     Start the local agent daemon in background
  agent stop                      Stop the running local agent daemon
  agent restart                   Restart the local agent daemon
  agent status                    Display local agent daemon running status
  agent logs [-f] [-n 50]         View local agent daemon logs
  agent name [newName]            View or set the agent node name for this machine

Remote Execution Commands:
  task ls <node> [OPTIONS]        List recent tasks on a host

Command Shortcuts:
  gt ps [-a|--all]
  gt exec <node> <cmd...>
  gt logs [NAME]
  gt kill <node> <taskId>
  gt prune
  gt login [server] [key]
  gt logout
`);

  function resolveEffective(opts: Record<string, any> = {}, extra?: { server?: string; key?: string; context?: string }) {
    const globalOpts = program.opts();
    const server = extra?.server || opts.server || globalOpts.server;
    const key = extra?.key !== undefined ? extra.key : (opts.key !== undefined ? opts.key : globalOpts.key);
    const context = extra?.context || opts.context || globalOpts.context;
    return ConfigStore.getEffectiveConfig({ server, key, context });
  }

  function resolveJson(opts: Record<string, any> = {}): boolean {
    const globalOpts = program.opts();
    return !!(opts.json || globalOpts.json);
  }

  function resolveFormat(opts: Record<string, any> = {}): string | undefined {
    const globalOpts = program.opts();
    return opts.format || globalOpts.format;
  }

  // --- Remote Cluster Management: gt nodes (alias: hosts) ---
  const nodesCmd = program
    .command('nodes')
    .alias('hosts')
    .description('List registered agent hosts connected to the target Hub')
    .option('-a, --all', 'Include offline hosts')
    .option('-s, --server <url>', 'Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--json', 'Output in JSON format')
    .option('--format <template>', 'Format output with Docker/Go template')
    .action(async (opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      await handleNodesCommand({
        server: eff.server,
        key: eff.key,
        all: opts.all,
        json: resolveJson(opts),
        format: resolveFormat(opts),
      });
    });

  nodesCmd
    .command('prune')
    .description('Prune offline nodes from the target Hub')
    .option('-s, --server <url>', 'Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--json', 'Output in JSON format')
    .action(async (opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      await handleNodesPruneCommand({
        server: eff.server,
        key: eff.key,
        json: resolveJson(opts),
      });
    });

  // Backward compatibility alias: gt host
  const hostCmd = program
    .command('host')
    .description('Manage hosts (alias for nodes)');

  hostCmd
    .command('ls')
    .alias('list')
    .description('List hosts')
    .option('-a, --all', 'Include offline hosts')
    .option('-s, --server <url>', 'Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--json', 'Output in JSON format')
    .option('--format <template>', 'Format output template')
    .action(async (opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      await handleRemotePs({
        server: eff.server,
        key: eff.key,
        args: opts.all ? ['-a'] : [],
        jsonOutput: resolveJson(opts),
        formatTemplateStr: resolveFormat(opts),
      });
    });

  hostCmd
    .command('prune')
    .description('Prune offline hosts')
    .option('-s, --server <url>', 'Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--json', 'Output in JSON format')
    .action(async (opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      await handleRemotePrune({
        server: eff.server,
        key: eff.key,
        args: [],
        jsonOutput: resolveJson(opts),
      });
    });

  // Backward compatibility alias: gt ps
  program
    .command('ps')
    .description('List connected hosts (default: remote; -l for local)')
    .option('-a, --all', 'Include offline hosts or stopped local agents')
    .option('-l, --local', 'List local agent daemons')
    .option('-s, --server <url>', 'Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--json', 'Output in JSON format')
    .option('--format <template>', 'Format output template')
    .action(async (opts: Record<string, any>) => {
      if (opts.local) {
        AgentDaemonManager.printAgentsTable(!!opts.all);
        return;
      }
      const eff = resolveEffective(opts);
      await handleRemotePs({
        server: eff.server,
        key: eff.key,
        args: opts.all ? ['-a'] : [],
        jsonOutput: resolveJson(opts),
        formatTemplateStr: resolveFormat(opts),
      });
    });

  // Backward compatibility alias: gt prune
  program
    .command('prune')
    .description('Remove offline remote nodes (or -l for local agents)')
    .option('-a, --all', 'Prune all')
    .option('-l, --local', 'Prune local stopped agents')
    .option('-s, --server <url>', 'Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--json', 'Output in JSON format')
    .action(async (opts: Record<string, any>) => {
      if (opts.local) {
        const { removed } = AgentDaemonManager.prune();
        if (removed.length === 0) {
          console.log('No stopped agents to prune.');
        } else {
          console.log(`Pruned ${removed.length} stopped agent(s): ${removed.join(', ')}`);
        }
        process.exit(0);
      }
      if (opts.all) {
        const { removed } = AgentDaemonManager.prune();
        if (removed.length > 0) {
          console.log(`Pruned ${removed.length} local stopped agent(s): ${removed.join(', ')}`);
        }
      }
      const eff = resolveEffective(opts);
      await handleRemotePrune({
        server: eff.server,
        key: eff.key,
        args: [],
        jsonOutput: resolveJson(opts),
      });
    });

  // --- Remote Execution: gt exec ---
  program
    .command('exec [args...]')
    .description('Execute a command on a remote host')
    .allowUnknownOption(true)
    .passThroughOptions(true)
    .option('-i, --interactive', 'Keep STDIN open for live or piped input')
    .option('-t, --tty', 'Allocate a pseudo-TTY with raw terminal input')
    .option('-d, --detach', 'Run command in background and print task ID')
    .option('-w, --workdir <dir>', 'Working directory on remote host')
    .option('--timeout <ms>', 'Execution timeout in ms (Default: 300000 / 5 min)')
    .option('-e, --env <KEY=VAL>', 'Set remote environment variable (can be repeated)')
    .option('--verbose', 'Show execution header and duration footer banners')
    .option('-q, --quiet', 'Quiet mode (suppress banners)')
    .option('--poll-interval <ms>', 'Polling interval for log stream in ms (Default: 500)')
    .action(async (passedArgs: string[]) => {
      const execIdx = rawArgs.indexOf('exec');
      const rawCmdArgs = execIdx !== -1 ? rawArgs.slice(execIdx + 1) : (passedArgs || []);

      let cliServer: string | undefined;
      let cliKey: string | undefined;
      let cliContext: string | undefined;
      let jsonOutput = false;

      const cleanCmdArgs: string[] = [];
      let hostFound = false;

      for (let i = 0; i < rawCmdArgs.length; i++) {
        const a = rawCmdArgs[i];
        if (hostFound) {
          cleanCmdArgs.push(a);
          continue;
        }
        if (a === '--') {
          cleanCmdArgs.push(a);
          hostFound = true;
          continue;
        }
        if (a === '-s' || a === '--server') {
          cliServer = rawCmdArgs[++i];
        } else if (a.startsWith('--server=')) {
          cliServer = a.slice(9);
        } else if (a === '-k' || a === '--key') {
          cliKey = rawCmdArgs[++i];
        } else if (a.startsWith('--key=')) {
          cliKey = a.slice(6);
        } else if (a === '-c' || a === '--context') {
          cliContext = rawCmdArgs[++i];
        } else if (a.startsWith('--context=')) {
          cliContext = a.slice(10);
        } else if (a === '--json') {
          jsonOutput = true;
        } else {
          if (!a.startsWith('-')) {
            hostFound = true;
          }
          cleanCmdArgs.push(a);
        }
      }

      const eff = resolveEffective({}, { server: cliServer, key: cliKey, context: cliContext });
      await runExecCommand({
        server: eff.server,
        key: eff.key,
        cmdArgs: cleanCmdArgs,
        jsonOutput: jsonOutput || resolveJson(),
      });
    });

  // --- Copy: gt cp ---
  program
    .command('cp [args...]')
    .description('Copy files between local filesystem and remote host')
    .action(async (args: string[]) => {
      if (!args || args.length < 2) {
        console.error('Error: Missing arguments. Usage: gt cp <src> <dest>');
        process.exit(125);
      }
      const eff = resolveEffective();
      try {
        const code = await runCp(eff.server, eff.key, args);
        process.exit(code);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // --- Task Management: gt task ---
  const taskCmd = program
    .command('task')
    .description('Manage remote execution tasks');

  taskCmd
    .command('ls <node>')
    .alias('list')
    .description('List recent tasks on a host')
    .option('-s, --server <url>', 'Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--json', 'Output in JSON format')
    .option('--format <template>', 'Format output template')
    .action(async (node: string, opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      await handleTaskLs({
        server: eff.server,
        key: eff.key,
        node,
        json: resolveJson(opts),
        format: resolveFormat(opts),
      });
    });

  taskCmd
    .command('logs <node> [taskId]')
    .description('View or follow task execution logs')
    .option('-f, --follow', 'Follow logs')
    .option('--poll-interval <ms>', 'Polling interval in ms')
    .option('-s, --server <url>', 'Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--json', 'Output in JSON format')
    .action(async (node: string, taskId: string | undefined, opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      await handleTaskLogs({
        server: eff.server,
        key: eff.key,
        node,
        taskId,
        follow: !!opts.follow,
        json: resolveJson(opts),
      });
    });

  taskCmd
    .command('kill <node> <taskId>')
    .description('Terminate a running task on a remote node')
    .option('--signal <sig>', 'Signal to send')
    .option('-s, --server <url>', 'Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--json', 'Output in JSON format')
    .action(async (node: string, taskId: string, opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      await handleTaskKill({
        server: eff.server,
        key: eff.key,
        node,
        taskId,
        signal: opts.signal,
        json: resolveJson(opts),
      });
    });

  // Top-level shortcut: gt kill
  program
    .command('kill [args...]')
    .description('Shortcut for gt task kill')
    .allowUnknownOption(true)
    .action(async (args: string[]) => {
      const eff = resolveEffective();
      await handleRemoteKill({
        server: eff.server,
        key: eff.key,
        args: args || [],
        jsonOutput: resolveJson(),
      });
    });

  // Top-level shortcut: gt logs
  program
    .command('logs [args...]')
    .description('View agent or task logs')
    .allowUnknownOption(true)
    .action(async (args: string[]) => {
      const eff = resolveEffective();
      await handleLogsDispatcher({
        server: eff.server,
        key: eff.key,
        args: args || [],
        jsonOutput: resolveJson(),
      });
    });

  // --- Local Agent Management: gt agent ---
  const agentCmd = program
    .command('agent')
    .description('Manage local machine reverse agent daemon lifecycle');

  agentCmd
    .command('start')
    .description('Start the local agent daemon in background')
    .option('-s, --server <url>', 'Override target Hub URL')
    .option('-k, --key <secret>', 'Override Hub admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--internal-daemon', 'Internal daemon flag')
    .action(async (opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      const args = ['start'];
      if (opts.internalDaemon) args.push('--internal-daemon');
      await runAgent(args, { server: eff.server, key: eff.key, context: eff.context });
    });

  agentCmd
    .command('stop')
    .description('Stop the running local agent daemon')
    .action(async () => {
      await runAgent(['stop'], {});
    });

  agentCmd
    .command('restart')
    .description('Restart the local agent daemon')
    .option('-s, --server <url>', 'Override target Hub URL')
    .option('-k, --key <secret>', 'Override Hub admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--internal-daemon', 'Internal daemon flag')
    .action(async (opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      const args = ['restart'];
      if (opts.internalDaemon) args.push('--internal-daemon');
      await runAgent(args, { server: eff.server, key: eff.key, context: eff.context });
    });

  agentCmd
    .command('status')
    .description('Display local agent daemon running status')
    .action(async () => {
      await runAgent(['status'], {});
    });

  agentCmd
    .command('logs')
    .description('View local agent daemon logs')
    .option('-f, --follow', 'Follow log stream')
    .option('-n, --lines <number>', 'Number of lines to show', '50')
    .action(async (opts: Record<string, any>) => {
      const args = ['logs'];
      if (opts.follow) args.push('-f');
      if (opts.lines) args.push(`-n=${opts.lines}`);
      await runAgent(args, {});
    });

  agentCmd
    .command('name [newName]')
    .description('View or set the agent node name for this machine')
    .action((newName?: string) => {
      if (!newName) {
        const res = ConfigStore.resolveAgentName();
        console.log(`${res.name} (${res.source})`);
      } else {
        ConfigStore.setAgentName(newName);
        const updated = ConfigStore.getAgentName();
        console.log(`✓ Agent name set to "${updated}". Run 'gt agent restart' to apply changes if running.`);
      }
    });

  // --- Authentication: gt auth ---
  const authCmd = program
    .command('auth')
    .description('Authentication lifecycle commands');

  authCmd
    .command('login [server] [key]')
    .description('Probe and authenticate against the target Hub')
    .option('-c, --context <name>', 'Associate credentials with a named context')
    .option('-s, --server <url>', 'Target Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .action(async (serverArg: string | undefined, keyArg: string | undefined, opts: Record<string, any>) => {
      const subArgs: string[] = [];
      if (serverArg) subArgs.push(serverArg);
      if (keyArg) subArgs.push(keyArg);
      const eff = resolveEffective(opts);
      await handleAuthLogin({
        server: eff.server,
        key: eff.key,
        context: opts.context || eff.context,
        subArgs,
      });
    });

  authCmd
    .command('status')
    .description('Display authentication status')
    .option('-c, --context <name>', 'Target context')
    .option('-s, --server <url>', 'Target Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .action(async (opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      await handleAuthStatus({
        server: eff.server,
        key: eff.key,
        context: eff.context,
      });
    });

  authCmd
    .command('logout')
    .description('Remove stored credentials')
    .option('--all', 'Log out of all contexts')
    .action((opts: Record<string, any>) => {
      handleAuthLogout(!!opts.all);
    });

  // Top-level aliases for auth
  program
    .command('login [server] [key]')
    .description('Verify and save admin credentials')
    .option('-c, --context <name>', 'Associate credentials with a named context')
    .option('-s, --server <url>', 'Target Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .action(async (serverArg: string | undefined, keyArg: string | undefined, opts: Record<string, any>) => {
      const subArgs: string[] = [];
      if (serverArg) subArgs.push(serverArg);
      if (keyArg) subArgs.push(keyArg);
      const eff = resolveEffective(opts);
      await handleAuthLogin({
        server: eff.server,
        key: eff.key,
        context: eff.context,
        subArgs,
      });
    });

  program
    .command('logout')
    .description('Remove stored credentials')
    .action(() => {
      handleAuthLogout();
    });

  // --- Configuration: gt config ---
  const configCmd = program
    .command('config')
    .description('Manage client contexts and configuration');

  configCmd
    .command('get-contexts')
    .description('List all stored contexts')
    .action(() => {
      handleConfigGetContexts();
    });

  configCmd
    .command('current-context')
    .description('Print active context name')
    .action(() => {
      handleConfigCurrentContext();
    });

  configCmd
    .command('use-context <name>')
    .description('Switch active context')
    .action((name: string) => {
      handleConfigUseContext(name);
    });

  configCmd
    .command('set-context <name>')
    .description('Create or update a named context')
    .option('-s, --server <url>', 'Target Hub server URL')
    .option('-k, --key <secret>', 'Target Hub secret key')
    .action((name: string, opts: Record<string, any>) => {
      handleConfigSetContext(name, {
        server: opts.server,
        key: opts.key,
      });
    });

  configCmd
    .command('delete-context <name>')
    .description('Delete a named context')
    .action((name: string) => {
      handleConfigDeleteContext(name);
    });

  configCmd
    .command('view')
    .description('Display entire configuration in JSON format')
    .option('--raw', 'Show unmasked secret keys')
    .action((opts: Record<string, any>) => {
      handleConfigView(!!opts.raw);
    });

  configCmd
    .command('list')
    .description('List configuration settings (legacy format)')
    .option('-s, --server <url>', 'Hub server URL')
    .action((opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      handleConfigList(eff.server);
    });

  return program;
}

export function printHelp(): void {
  const prog = createProgram();
  console.log(prog.helpInformation());
}

export async function runClient(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  if (rawArgs.length === 0) {
    printHelp();
    process.exit(0);
  }

  const program = createProgram(rawArgs);

  function applyExitOverride(cmd: Command) {
    cmd.exitOverride();
    for (const sub of cmd.commands) {
      applyExitOverride(sub);
    }
  }
  applyExitOverride(program);

  try {
    await program.parseAsync([process.argv[0] || 'node', 'gt', ...rawArgs]);
  } catch (err: any) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      process.exit(0);
    }
    if (err.code && typeof err.code === 'string' && err.code.startsWith('commander.')) {
      process.exit(2);
    }
    if (typeof err.exitCode === 'number') {
      process.exit(err.exitCode);
    }
    console.error(err.message || err);
    process.exit(1);
  }
}
