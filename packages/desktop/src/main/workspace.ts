/**
 * Workspace selection rules for the desktop app.
 *
 * The kernel enforces "writes stay inside the workspace"; this module makes
 * sure that workspace is a real project folder, not the user's home or a
 * system directory (which would nullify the boundary).
 */

import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { smaltHome } from '@smalt/kernel';

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** Reject home, drive roots, Windows/system dirs, and the agent config dir. */
export function isValidWorkspace(dir: string): { ok: true } | { ok: false; reason: string } {
  let real: string;
  try {
    real = norm(realpathSync(dir));
    if (!statSync(dir).isDirectory()) return { ok: false, reason: '请选择文件夹，不能选择文件' };
  } catch {
    return { ok: false, reason: 'folder does not exist' };
  }
  const home = norm(homedir());
  const parent = norm(dirname(real));

  if (real === home) {
    return { ok: false, reason: 'the user home directory cannot be a workspace — pick a project folder' };
  }
  if (real === parent) {
    return { ok: false, reason: 'drive/system roots cannot be a workspace' };
  }
  if (/^[a-z]:\/windows(\/|$)/.test(real)) {
    return { ok: false, reason: 'system directories cannot be a workspace' };
  }
  const config = norm(resolve(smaltHome()));
  if (real === config || real.startsWith(`${config}/`)) {
    return { ok: false, reason: 'the agent config directory cannot be a workspace' };
  }
  return { ok: true };
}

export function workspaceLabel(dir: string): string {
  return basename(dir) || dir;
}
