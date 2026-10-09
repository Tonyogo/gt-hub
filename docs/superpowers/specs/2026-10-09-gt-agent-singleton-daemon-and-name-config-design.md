# gt Agent Singleton Daemon & Dedicated Name Configuration Spec

## 1. Overview & Objectives
This specification refactors `gt agent` from a Docker-like multi-container model into a pure **Host Daemon** singleton model.

Primary objectives:
1. **Zero-Parameter Lifecycle Operations**: `gt agent start`, `gt agent stop`, `gt agent restart`, and `gt agent status` operate strictly on the machine's singleton agent instance without requiring any `[name]` positional arguments or `--all` flags.
2. **Elimination of `run` Command**: Remove `gt agent run`. The agent only runs as a managed daemon process via `gt agent start`. Real-time output observation is handled by `gt agent logs -f`.
3. **Dedicated Name Configuration (`gt agent name [new-name]`)**: Decouple the agent node name from runtime flags. Remove `--name` entirely from `gt agent start`. Node names are configured once and persisted via `gt agent name <value>`, injected via `GT_AGENT_NAME`, or default to `os.hostname()`.
4. **Single-File Storage Consolidation**: Replace directory-based `~/.gt/agents/<name>.json` and `<name>.log` with single files: `~/.gt/agent.json` and `~/.gt/agent.log`.
5. **Removal of Redundant Commands**: Completely eliminate `agent run`, `agent rm`, `agent prune`, `agent ps`, and the redundant generic `config get` and `config set` commands.

---

## 2. Agent Name Resolution & Configuration

### 2.1 Storage Schema Update (`~/.gt/config.json`)
The root configuration persists `agentName`:
```json
{
  "currentContext": "default",
  "contexts": {
    "default": {
      "server": "http://localhost:8000",
      "key": ""
    }
  },
  "agentName": "worker-prod-01",
  "machineId": "e4f8b91c2d3a"
}
```

### 2.2 Three-Tier Name Resolution Hierarchy
When an agent starts or queries its name, it resolves the host node name in the following order:
1. **Environment Variable**: `process.env.GT_AGENT_NAME` (if non-empty).
2. **Persistent Configuration**: `ConfigStore.getAgentName()` (persisted `agentName` in `config.json`).
3. **System Hostname Fallback**: Normalized `os.hostname().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') || 'host'`.

### 2.3 Command: `gt agent name [new-name]`
- **Query Name**: `gt agent name`
  - Output format:
    - If configured in config: `<name> (configured)`
    - If set by environment: `<name> (environment: GT_AGENT_NAME)`
    - If using default: `<name> (default: hostname)`
- **Set Name**: `gt agent name <new-name>`
  - Sanitizes the input string (valid characters: lowercase alphanumeric, hyphens, underscores).
  - Updates `agentName` in `~/.gt/config.json`.
  - Prints confirmation:
    ```text
    ✓ Agent name set to "<sanitized-name>". Run 'gt agent restart' to apply changes if running.
    ```

---

## 3. Singleton Lifecycle Operations (`gt agent`)

### 3.1 Commands Specification
* **`gt agent start [options]`**
  - Starts the agent as a background detached daemon process.
  - Takes NO `--name` parameter.
  - Options:
    - `-s, --server <url>`: Override Target Hub URL for this startup.
    - `-k, --key <secret>`: Override Hub admin secret key for this startup.
    - `-c, --context <name>`: Resolve credentials from a specific context.
  - If an agent is already running on this machine, exits with status 1:
    `Error: Agent is already running (PID: <pid>). Use 'gt agent stop' or 'gt agent restart'.`
  - Writes PID and metadata to `~/.gt/agent.json`, directs stdout/stderr to `~/.gt/agent.log`.
* **`gt agent stop`**
  - Stops the running agent daemon on this machine.
  - Takes NO parameters or flags (no `[name]`, no `--all`).
  - Sends `SIGTERM` to the daemon PID, waiting up to 3s before escalating to `SIGKILL`.
  - Updates `~/.gt/agent.json` or clears status upon successful termination.
* **`gt agent restart [options]`**
  - Sequentially executes stop (if running) and start.
  - Accepts the same `-s`, `-k`, `-c` options as `start`.
* **`gt agent status`**
  - Displays singleton daemon status:
    ```text
    Status     : Running (or Stopped)
    PID        : 12345
    Agent Name : worker-prod-01
    Target Hub : http://localhost:8000
    Uptime     : 2 hours 15 minutes
    Log File   : ~/.gt/agent.log
    ```
  - Takes NO parameters.
* **`gt agent logs [options]`**
  - Displays or streams lines from `~/.gt/agent.log`.
  - Takes NO `[name]` parameter.
  - Options:
    - `-f, --follow`: Follow log stream.
    - `-n, --lines <number>`: Number of lines to show (default: 50).

---

## 4. State & File Storage

### 4.1 Paths
- Status File: `path.join(ConfigStore.getConfigDir(), 'agent.json')`
- Log File: `path.join(ConfigStore.getConfigDir(), 'agent.log')`
- No directory scans (`fs.readdirSync`) or dynamic agent file arrays.

### 4.2 Status Data Structure (`~/.gt/agent.json`)
```json
{
  "pid": 12345,
  "name": "worker-prod-01",
  "id": "e4f8b91c2d3a-worker-prod-01",
  "server": "http://localhost:8000",
  "startTime": "2026-10-09T08:00:00.000Z",
  "logFile": "/home/user/.gt/agent.log"
}
```

---

## 5. Cleanups in `gt config`

- Remove `gt config get <key>` and `gt config set <key> <val>`.
- Only keep structured context subcommands:
  - `gt config get-contexts`
  - `gt config current-context`
  - `gt config use-context <name>`
  - `gt config set-context <name>`
  - `gt config delete-context <name>`
  - `gt config view`

---

## 6. Verification Plan

1. **Unit Tests**:
   - `ConfigStore.getAgentName()` and `ConfigStore.setAgentName()` test suite.
   - Name resolution precedence: `GT_AGENT_NAME` > `config.agentName` > `os.hostname()`.
   - Single status file write and read (`agent.json`).
2. **CLI Integration Tests**:
   - `gt agent name` queries resolved name.
   - `gt agent name test-node` updates name in `config.json`.
   - `gt agent start` launches daemon with configured name (without `--name` argument).
   - `gt agent status` displays status without arguments.
   - `gt agent stop` cleanly terminates daemon without arguments.
   - Running `gt agent run` fails with unknown command (exit code 2).
   - Running `gt config get` fails with unknown command (exit code 2).
3. **Build & Regression**:
   - `npm run build:gt` builds standalone `dist/gt.js`.
   - All existing tests passing after adjusting to the singleton model.
