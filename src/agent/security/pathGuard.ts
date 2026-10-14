import path from 'path';
import fs from 'fs';
import os from 'os';

export type PermissionMode = 'default' | 'bypass';

export interface PathCheckResult {
  allowed: boolean;
  reason?: string;
}

export function isSubpath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function checkPathPermission(
  targetPath: string,
  mode: PermissionMode = 'default',
  workspace?: string
): PathCheckResult {
  if (mode === 'bypass') {
    return { allowed: true };
  }

  const resolved = path.resolve(targetPath);
  const home = os.homedir();

  // Resolve symlinks to target real path even if broken
  let realTarget = resolved;
  try {
    let current = resolved;
    let depth = 0;
    while (depth++ < 20) {
      try {
        const lstat = fs.lstatSync(current);
        if (lstat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(current);
          current = path.resolve(path.dirname(current), linkTarget);
          realTarget = current;
        } else {
          break;
        }
      } catch {
        break;
      }
    }

    if (fs.existsSync(realTarget)) {
      realTarget = fs.realpathSync(realTarget);
    } else {
      let parent = path.dirname(realTarget);
      while (parent && !fs.existsSync(parent) && parent !== path.dirname(parent)) {
        parent = path.dirname(parent);
      }
      if (fs.existsSync(parent)) {
        const realParent = fs.realpathSync(parent);
        realTarget = path.join(realParent, path.relative(parent, realTarget));
      }
    }
  } catch {
    // Keep resolved if resolution fails
  }

  const pathsToCheck = [resolved, realTarget];

  for (const checkPath of pathsToCheck) {
    // 1. SSH & GPG Keys
    const sshDir = path.join(home, '.ssh');
    if (isSubpath(sshDir, checkPath) || checkPath === sshDir) {
      return { allowed: false, reason: 'Access to sensitive SSH credentials directory is restricted' };
    }
    const gpgDir = path.join(home, '.gnupg');
    if (isSubpath(gpgDir, checkPath) || checkPath === gpgDir) {
      return { allowed: false, reason: 'Access to sensitive GPG credentials directory is restricted' };
    }

    // 2. Agent Config Files
    const gtDir = path.join(home, '.gt');
    const agentJson = path.join(gtDir, 'agent.json');
    const configJson = path.join(gtDir, 'config.json');
    if (checkPath === agentJson || checkPath === configJson) {
      return { allowed: false, reason: 'Modification or inspection of agent credentials is restricted' };
    }

    // 3. Unix system sensitive paths
    if (os.platform() !== 'win32') {
      const sensitiveFiles = [
        '/etc/shadow',
        '/etc/gshadow',
        '/etc/sudoers',
      ];
      for (const f of sensitiveFiles) {
        if (checkPath === f) {
          return { allowed: false, reason: `Access to system sensitive file ${f} is restricted` };
        }
      }
      if (checkPath.startsWith('/etc/sudoers.d') || checkPath.startsWith('/etc/pam.d')) {
        return { allowed: false, reason: 'Access to sudoers or PAM configuration is restricted' };
      }
    }

    // 4. Windows system credentials
    if (os.platform() === 'win32') {
      const lower = checkPath.toLowerCase();
      if (lower.includes('\\system32\\config\\sam') || lower.includes('\\system32\\config\\system')) {
        return { allowed: false, reason: 'Access to Windows system security accounts manager is restricted' };
      }
    }
  }

  // 5. Workspace restriction (if configured)
  if (workspace) {
    const resolvedWorkspace = path.resolve(workspace);
    if (!isSubpath(resolvedWorkspace, resolved) && !isSubpath(resolvedWorkspace, realTarget)) {
      return { allowed: false, reason: `Path "${resolved}" is outside workspace "${resolvedWorkspace}"` };
    }
  }

  return { allowed: true };
}
