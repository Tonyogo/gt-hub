# gt-hub

Centralized WebSocket Hub and WebTerminal Service for Gemini Terminal (`gt`).

## Features
- **Centralized WebSocket Hub**: Multiplexed WebSocket endpoints for web clients, agent connections, and CLI streaming execution.
- **Web Terminal**: Built-in full-featured web terminal with multi-host management, file explorer, command audit logs.
- **CLI (`gt`)**: Command-line tool for remote execution, streaming, host listing, and file transfers.

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

### gt CLI
```bash
npm run gt -- --help
# Or link globally:
npm link
gt --help
```
