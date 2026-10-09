# gt-hub

Centralized WebSocket Hub and WebTerminal Service for Gemini Terminal (`gt`).

## Features
- **Centralized WebSocket Hub**: Multiplexed WebSocket endpoints for web clients, agent connections, and CLI streaming execution.
- **Web Terminal**: Built-in full-featured web terminal with multi-host management, file explorer, command audit logs.
- **CLI (`gt`)**: Modern commander-based standalone CLI for multi-context Hub management, remote execution, streaming, host listing, and file transfers.

## Getting Started

### Installation
```bash
npm install
npm run build
```

### Running the Server
```bash
npm start
```

### gt CLI Overview

The `gt` CLI is bundled as a self-contained, zero-dependency executable (`dist/gt.js`) with Docker/kubectl-style ergonomic commands.

```bash
npm run gt -- --help
# Or link globally:
npm link
gt --help
```

#### Authentication (`gt auth`)
Manage authentication credentials against target Hub instances:
```bash
# Authenticate against Hub server and save credentials
gt auth login http://localhost:8000 <secret-key>

# Authenticate for a specific named context
gt auth login http://hub.prod.example.com <prod-key> -c prod

# View connection and authentication status
gt auth status

# Log out of current context (or all contexts with --all)
gt auth logout
gt auth logout --all
```

#### Multi-Context Management (`gt config`)
Switch environments seamlessly with `kubectl`-style multi-context architecture:
```bash
# List all configured contexts (* marks active context)
gt config get-contexts

# Show current active context
gt config current-context

# Switch to another context
gt config use-context prod

# Create or update a named context
gt config set-context staging --server http://staging-hub:8000 --key staging-secret

# Delete a context (active context falls back to default)
gt config delete-context staging

# View full configuration (keys masked by default, or use --raw)
gt config view
```

#### Remote Cluster Management (`gt nodes`, `gt exec`, `gt cp`, `gt task`)
Manage and interact with remote agent hosts connected to the Hub:
```bash
# List connected hosts (alias: gt hosts)
gt nodes
gt nodes -a               # Include offline nodes
gt nodes prune            # Remove offline hosts

# Execute command on a remote host (streaming output with exit code forwarding)
gt exec my-server uptime
gt exec -it my-server bash
gt exec -d my-server "sleep 30"    # Run detached in background

# Copy files between local machine and remote host
gt cp ./file.txt my-server:/tmp/file.txt
gt cp my-server:/var/log/app.log ./app.log

# Inspect and manage remote execution tasks
gt task ls my-server
gt task logs -f my-server <task-id>
gt task kill my-server <task-id>
```

#### Local Machine Agent Management (`gt agent`)
Manage the reverse agent daemon on the local host:
```bash
# Run agent in foreground or detached background daemon
gt agent run
gt agent run -d worker-1
gt agent start worker-1

# View agent status and logs
gt agent status           # Alias: gt agent ps
gt agent logs -f worker-1

# Stop, restart, or clean up agents
gt agent stop worker-1
gt agent restart worker-1
gt agent rm worker-1
gt agent prune
```
