/**
 * Workspace guard — the filesystem-level trust boundary.
 *
 * All checks resolve SYMLINKS first (realpath) so an in-workspace junction
 * pointing outside cannot smuggle writes or reads past the boundary. Case
 * sensitivity follows the platform (Windows/macOS compare case-insensitively,
 * Linux exactly). Paths that don't exist yet resolve via their nearest
 * existing ancestor.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { smaltHome } from '../config/settings.js';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** Rejects UNC/device paths, NUL bytes, NTFS Alternate Data Streams (`::$DATA` / `:stream`), and Windows drive-relative paths (`D:foo`). */
export function isNetworkPath(path: unknown): boolean {
  if (typeof path !== 'string' || path.includes('\0') || /^(?:[\\/]{2}|\\\?\?\\)/.test(path)) return true;
  if (path.includes('::')) return true;
  if (/^[A-Za-z]:(?![\\/]|$)/.test(path)) return true;
  if (process.platform === 'win32') {
    const rest = path.replace(/^[A-Za-z]:/, '');
    if (rest.includes(':')) return true;
    const segments = rest.split(/[\\/]/).filter(Boolean);
    if (segments.some(seg => seg !== '.' && seg !== '..' && /[. ]$/.test(seg))) return true;
  }
  return false;
}

function credentialFile(path: string): boolean {
  const rawName = path.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase();
  const name = rawName.split(':')[0]!.replace(/[. ]+$/, '');
  if (/^\.env(?:\.|$)/.test(name)) return !/^\.env\.(?:example|sample|template)(?:\.|$)/.test(name);
  return /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|\.git-credentials|\.netrc)$/.test(name) || /\.(?:key|pem|p12|pfx)$/.test(name);
}

function norm(p: string): string {
  const withSlashes = p.replace(/\\/g, '/');
  return CASE_INSENSITIVE ? withSlashes.toLowerCase() : withSlashes;
}

/** realpath that resolves dangling symlinks and walks up to the nearest existing ancestor for new files. */
export function realPathOf(p: string, depth = 0): string {
  if (depth > 16) return '\\\\symlink-loop-exceeded';
  if (isNetworkPath(p)) return p;
  try {
    return realpathSync(p);
  } catch {
    try {
      if (lstatSync(p).isSymbolicLink()) {
        const target = resolve(dirname(p), readlinkSync(p));
        return realPathOf(target, depth + 1);
      }
    } catch { /* ENOENT — walk up parent */ }
    const parent = dirname(p);
    if (parent === p) return p;
    const realParent = realPathOf(parent, depth + 1);
    if (isNetworkPath(realParent)) return realParent;
    return resolve(realParent, basename(p));
  }
}

/** true when target resolves inside cwd (symlink-safe). */
export function isInsideWorkspace(cwd: string, target: string): boolean {
  if (isNetworkPath(cwd) || isNetworkPath(target)) return false;
  const root = norm(realPathOf(cwd));
  const abs = norm(realPathOf(resolve(cwd, target)));
  if (isNetworkPath(root) || isNetworkPath(abs)) return false;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return abs === root || abs.startsWith(prefix);
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
  paths.push(resolve(cwd, '.local-preview')); // development profile can also hold credentials
  paths.push(resolve(cwd, '.git', 'hooks'));
  paths.push(resolve(cwd, '.git', 'config'));
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
  if (isNetworkPath(cwd) || isNetworkPath(target) || credentialFile(target)) return true;
  const abs = norm(realPathOf(resolve(cwd, target)));
  if (isNetworkPath(abs) || credentialFile(abs)) return true;
  return sensitivePaths(cwd).some((dir) => {
    const d = norm(realPathOf(dir));
    const prefix = d.endsWith('/') ? d : `${d}/`;
    return abs === d || abs.startsWith(prefix);
  });
}
