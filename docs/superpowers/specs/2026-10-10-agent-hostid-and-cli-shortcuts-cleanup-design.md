# Agent HostId Machine Identity and CLI Shortcuts Cleanup Spec

## 1. Overview & Objectives
This specification covers:
1. **Machine-Unique Agent HostId**: Simplify Agent registration `hostId` so it strictly equals the machine's unique `machineId`, eliminating the legacy `${machineId}-${hostName}` suffix. The node name is solely a display name and does not mutate the host identifier.
2. **CLI Shortcuts Cleanup**: Clean up redundant top-level command shortcuts and legacy aliases from `src/client/index.ts`:
   - Drop the `hosts` alias from `gt nodes` (keeping only `gt nodes`).
   - Drop the `gt host` command group.
   - Drop top-level `gt kill` (use `gt task kill <node> <taskId>`).
   - Drop top-level `gt logs` (use `gt agent logs` or `gt task logs`).
   - Drop top-level `gt prune` (use `gt nodes prune`).
   - Preserve `gt ps` strictly as a shortcut for listing remote nodes (`gt nodes`), removing local agent options (`-l / --local`).

---

## 2. Technical Design

### 2.1 Agent Registration HostId
In `src/agent/daemon.ts`:
```typescript
const machineId = ConfigStore.getMachineId();
const hostId = options.id || options.hostId || machineId;
```
- No appending of `${machineId}-${hostName}` even if a custom `agentName` is configured.
- `hostId` uniquely represents the physical/virtual machine on the Hub.

### 2.2 CLI Command Tree Adjustments
In `src/client/index.ts`:
- **`gt nodes`**: Remove `.alias('hosts')`.
- **Remove `gt host`**: Delete the entire `hostCmd` block.
- **`gt ps`**: Kept as a pure remote node listing command (forwarding to `handleNodesCommand`). Remove `-l, --local` option.
- **Remove `gt kill`**: Delete top-level `killCmd`.
- **Remove `gt logs`**: Delete top-level `logsCmd`.
- **Remove `gt prune`**: Delete top-level `pruneCmd` (use `gt nodes prune`).

### 2.3 Tests & Documentation
- Update `tests/gtCommanderCli.test.ts` to assert that `gt host`, `gt kill`, `gt logs`, `gt prune` are rejected with code 2, while `gt nodes` and `gt ps` work as expected.
- Update `tests/gtAgentDaemon.test.ts` to verify `hostId` matches `machineId` directly regardless of `agentName`.
- Update `README.md` to reflect the streamlined command tree.
