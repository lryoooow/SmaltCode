/**
 * Workspace guard — the filesystem-level trust boundary.
 *
 * All checks resolve SYMLINKS first (realpath) so an in-workspace junction
 * pointing outside cannot smuggle writes or reads past the boundary. Case
 * sensitivity follows the platform (Windows/macOS compare case-insensitively,
 * Linux exactly). Paths that don't exist yet resolve via their nearest
 * existing ancestor.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { smaltHome } from '../config/settings.js';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function norm(p: string): string {
  const withSlashes = p.replace(/\\/g, '/');
  return CASE_INSENSITIVE ? withSlashes.toLowerCase() : withSlashes;
}

/** realpath that walks up to the nearest existing ancestor for new files. */
export function realPathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    const realParent = realPathOf(parent);
    return realParent === dirname(p) ? resolve(realParent, basename(p)) : resolve(realParent, basename(p));
  }
}

/** true when target resolves inside cwd (symlink-safe). */
export function isInsideWorkspace(cwd: string, target: string): boolean {
  const root = norm(realPathOf(cwd));
  const abs = norm(realPathOf(resolve(cwd, target)));
  return abs === root || abs.startsWith(`${root}/`);
}

/**
 * Directories no agent should ever touch without explicit human intent:
 * the agent's own config (self-privilege-escalation) and OS credential
 * stores. Reads AND writes are denied here outright.
 */
export function sensitivePaths(cwd: string): string[] {
  const home = homedir();
  const paths = [
    smaltHome(), // agent config incl. allow rules — never touchable by tools
    resolve(home, '.ssh'),
    resolve(home, '.aws'),
    resolve(home, '.gnupg'),
    resolve(home, '.config/gnupg'),
    resolve(home, '.kube'),
    resolve(home, '.docker'),
    // credential FILES (N6)
    resolve(home, '.npmrc'),
    resolve(home, '.git-credentials'),
    resolve(home, '.netrc'),
    resolve(home, '.gitconfig'), // aliases can execute commands
  ];
  // project-local config that could escalate privileges on next run (N2)
  paths.push(resolve(cwd, '.smalt'));
  paths.push(resolve(cwd, '.git', 'hooks'));
  if (process.platform === 'win32') {
    paths.push(
      resolve(home, 'AppData/Roaming/Microsoft/Protect'),
      resolve(home, 'AppData/Roaming/Microsoft/Credentials'),
      resolve(home, 'AppData/Roaming/Microsoft/Crypto'),
    );
  } else if (process.platform === 'darwin') {
    paths.push(resolve(home, 'Library/Keychains'));
  }
  return paths;
}

/** true when the target resolves inside (or equals) a sensitive path. */
export function isSensitivePath(cwd: string, target: string): boolean {
  const abs = norm(realPathOf(resolve(cwd, target)));
  return sensitivePaths(cwd).some((dir) => {
    const d = norm(realPathOf(dir));
    return abs === d || abs.startsWith(`${d}/`);
  });
}
