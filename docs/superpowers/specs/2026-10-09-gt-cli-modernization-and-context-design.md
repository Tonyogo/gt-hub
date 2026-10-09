# gt CLI Modernization and Context Architecture Design Spec

## 1. Overview & Objectives
This specification outlines the modernization and structural redesign of the `gt` Command Line Interface (CLI).

Primary objectives:
1. **Clear Command Separation**: Disentangle remote cluster management (`nodes`, `exec`, `cp`, `task`) from local machine agent management (`agent run|start|stop|restart|status|logs|prune`).
2. **Multi-Environment Context Management**: Adopt a `kubectl`-style multi-context architecture under `gt config` (`get-contexts`, `current-context`, `use-context`, `set-context`, `delete-context`) with automatic zero-config fallback to the `default` context.
3. **Dedicated Authentication Lifecycle**: Consolidate authentication actions under `gt auth` (`login`, `status`, `logout`), decoupling runtime identity checks from static configuration.
4. **Standardized CLI Parser**: Replace fragile manual `process.argv` loop scanning with `commander`, fully bundled by `esbuild` into a self-contained, zero-dependency executable (`dist/gt.js`).
5. **Deterministic Exit Codes & Error Handling**: Standardize POSIX process exit codes (0 for success, 1 for runtime error, 2 for CLI parse/usage error, 124 for timeout, 130 for SIGINT).

---

## 2. Command Tree & Specification

```text
gt [GLOBAL_OPTIONS] <COMMAND> [ARGS...]

Global Options:
  -c, --context <name>      Target Hub context to use (overrides current-context)
  -s, --server <url>        Target Hub server URL (overrides context and env GT_SERVER)
  -k, --key <secret>        Target Hub admin secret key (overrides context and env GT_KEY)
  --json                    Format output in JSON
  -v, --version             Output the version number
  -h, --help                Display help for command
```

### 2.1 Remote Cluster Management (Client Operations)
* **`gt nodes [options]`** (Alias: `gt hosts`)
  - List registered agent hosts connected to the target Hub.
  - Options:
    - `-a, --all`: Include offline hosts.
    - `--format <template>`: Format output with Docker/Go template.
* **`gt nodes prune`**
  - Prune offline nodes from the target Hub.
* **`gt exec [options] <node> <cmd...>`**
  - Execute a command on a remote node.
  - Options:
    - `-i, --interactive`: Keep standard input open.
    - `-t, --tty`: Allocate a pseudo-TTY.
    - `-it`: Combine interactive input with pseudo-TTY allocation.
    - `-d, --detach`: Run command in the background on the remote host and print Task ID.
    - `-w, --workdir <dir>`: Remote working directory.
    - `--timeout <ms>`: Remote command execution timeout (default: 300000 ms).
    - `-e, --env <KEY=VAL>`: Set remote environment variable (repeatable).
    - `--verbose`: Show start banner and elapsed duration footer.
    - `--poll-interval <ms>`: Log streaming polling interval (default: 500 ms).
* **`gt cp <src> <dest>`**
  - Copy files/directories between the local filesystem and a remote node (e.g. `gt cp file.txt worker:/tmp/`).
* **`gt task <subcommand>`**
  - `gt task ls <node>`: List recent execution tasks on a node.
  - `gt task logs <node> <taskId> [-f]`: View or stream logs for a remote task.
  - `gt task kill <node> <taskId>`: Terminate a running task on a remote node.

### 2.2 Local Machine Agent Management (`gt agent`)
All operations targeting the local machine's daemon/process are scoped under `gt agent`:
* **`gt agent run [options] [name]`**
  - Run the reverse agent tunnel on the current machine (default: foreground).
  - `-d, --detach`: Start as a background daemon (alias for `gt agent start`).
* **`gt agent start [options] [name]`**
  - Start the reverse agent as a detached background daemon.
* **`gt agent stop [name] [--all]`**
  - Stop the running local agent daemon(s).
* **`gt agent restart [name]`**
  - Restart the local agent daemon.
* **`gt agent status [name]`** (Alias: `gt agent ps`)
  - Display running status, PID, and target Hub for local agent daemon(s).
  - `-a, --all`: Show stopped agent records in addition to active ones.
* **`gt agent logs [name] [-f] [-n <lines>]`**
  - View or follow the local log file of an agent daemon.
* **`gt agent rm [name] [--all]`**
  - Remove stopped local agent daemon records and log files.
* **`gt agent prune`**
  - Prune all stopped local agent daemon records and logs.

### 2.3 Authentication Lifecycle (`gt auth`)
* **`gt auth login [server] [key] [options]`**
  - Probe and authenticate against the target Hub, verifying secret key validity.
  - Options:
    - `-c, --context <name>`: Associate credentials with a named context. If omitted, updates the `currentContext` (defaults to `default`).
* **`gt auth status`**
  - Display the current active context, target Hub URL, connectivity, and authentication state.
* **`gt auth logout [--all]`**
  - Clear credentials for the current context (or all contexts with `--all`).

### 2.4 Configuration & Context Management (`gt config`)
`kubectl`-style context management:
* **`gt config get-contexts`**
  - List all stored contexts with an asterisk (`*`) indicating the active one:
    ```text
    CURRENT   NAME      SERVER                          KEY
    *         default   http://localhost:8000           <not set>
              prod      https://hub.prod.example.com    ******
              dev       http://192.168.1.10:8000        ******
    ```
* **`gt config current-context`**
  - Print the name of the currently active context.
* **`gt config use-context <name>`**
  - Switch the active context. Errors if the context does not exist.
* **`gt config set-context <name> --server <url> [--key <key>]`**
  - Create or update a context with explicit server and key.
* **`gt config delete-context <name>`**
  - Delete a named context. If deleting the active context, falls back to `default`.
  - When invoked with `default`, resets `default` context to default values (`http://localhost:8000`, empty key) rather than deleting it.
* **`gt config view`**
  - Print the entire configuration (sanitizing secret keys unless `--raw` is specified).
* **`gt config get <key>`**
  - Read a top-level property from configuration.
* **`gt config set <key> <val>`**
  - Set a top-level property in configuration.

---

## 3. Configuration Store & Context Persistence

### 3.1 Storage Schema (`~/.gt/config.json`)
```json
{
  "currentContext": "default",
  "contexts": {
    "default": {
      "server": "http://localhost:8000",
      "key": ""
    },
    "prod": {
      "server": "https://hub.prod.example.com",
      "key": "secret-prod"
    }
  },
  "machineId": "4a7c8d9e0f12"
}
```

### 3.2 Auto-Initialization & Default Context Invariants
1. **Zero-Config Bootstrap**: When `~/.gt/config.json` does not exist or has an empty contexts map, `ConfigStore.load()` automatically initializes:
   - `currentContext: "default"`
   - `contexts.default: { server: "http://localhost:8000", key: "" }`
   - `machineId: <generated-hex-id>`
2. **Deletion Protection**: Context `default` cannot be deleted. Attempting `gt config delete-context default` resets its fields to default values.
3. **Active Fallback**: Deleting an active non-default context automatically resets `currentContext` to `default`.

### 3.3 Credential Resolution Precedence
For any operation requiring a Hub connection (`nodes`, `exec`, `cp`, `task`, `agent`):
1. Explicit CLI flags: `-s, --server <url>` and `-k, --key <secret>`.
2. Environment variables: `GT_SERVER` and `GT_KEY`.
3. Context specified via flag: `-c, --context <name>` -> `contexts[name]`.
4. Currently active context: `contexts[currentContext]`.
5. Hardcoded fallbacks: `http://localhost:8000` and `""`.

---

## 4. Implementation & Bundling Details

### 4.1 CLI Framework (`commander`)
- Implement CLI using `commander` (version `^12.x` or `^11.x`).
- Structure subcommands into modular definitions:
  - `src/client/cli/nodes.ts`
  - `src/client/cli/exec.ts`
  - `src/client/cli/cp.ts`
  - `src/client/cli/task.ts`
  - `src/client/cli/agent.ts`
  - `src/client/cli/auth.ts`
  - `src/client/cli/config.ts`
  - `src/client/index.ts` (Program root setup and global option binding)

### 4.2 Single-File Bundling with `esbuild`
- `commander` is bundled inline via `npm run build:gt`:
  ```bash
  esbuild src/bin/gt.ts --bundle --platform=node --target=node18 --outfile=dist/gt.js --banner:js="#!/usr/bin/env node" --external:node-pty --external:ws
  ```
- Resulting `dist/gt.js` remains standalone without requiring `node_modules` on remote execution targets.

### 4.3 Standardized Exit Codes
- `0`: Successful execution.
- `1`: General runtime or network failure.
- `2`: CLI argument syntax error, unknown command, or invalid option (handled natively by Commander via `process.exitCode = 2` on exitOverride).
- `124`: Remote command timeout (`--timeout`).
- `130`: Terminated by SIGINT (Ctrl+C).

---

## 5. Verification Plan

1. **Context Operations Unit Tests**:
   - Verify `ConfigStore` auto-creates `default` context.
   - Verify adding, switching, updating, and deleting contexts.
   - Verify deleting active context falls back to `default`.
   - Verify deleting `default` resets `default` rather than removing it.
2. **Credential Resolution Tests**:
   - Verify `-s / -k` overrides `-c <context>`, which overrides active context.
   - Verify `GT_SERVER` / `GT_KEY` overrides context settings.
3. **Commander CLI Subcommand Tests**:
   - `gt nodes` calls node listing handler.
   - `gt agent run`, `gt agent start`, `gt agent stop`, `gt agent status` invoke agent lifecycle handlers.
   - `gt auth login` stores credentials in active/specified context.
   - `gt config get-contexts`, `use-context`, `current-context` operate as expected.
4. **End-to-End Build & Execution**:
   - `npm run build:gt` generates standalone `dist/gt.js`.
   - `node dist/gt.js --help` outputs modern, formatted help menu with all command groups.
