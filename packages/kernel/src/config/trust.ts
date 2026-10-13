/**
 * Project trust — the missing config layer.
 *
 * A cloned repository can ship `.smalt/settings.json`. Until the user has
 * explicitly trusted that directory, project settings may only TIGHTEN
 * security (merge deny/ask rules, pick a stricter mode) — never relax it,
 * never redirect providers (API-key exfiltration), never register hooks
 * (arbitrary command execution at startup).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { smaltHome } from './settings.js';
import { createHash } from 'node:crypto';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

interface TrustStore {
  version: 2;
  projects: Array<{ dir: string; sha256: string; restricted: { deny: string[]; ask: string[] } }>;
}

function trustFile(): string {
  return join(smaltHome(), 'trusted-projects.json');
}

function canonical(dir: string): string {
  try {
    const real = realpathSync(dir).replace(/\\/g, '/');
    return CASE_INSENSITIVE ? real.toLowerCase() : real;
  } catch {
    const fallback = dir.replace(/\\/g, '/');
    return CASE_INSENSITIVE ? fallback.toLowerCase() : fallback;
  }
}

function loadStore(): TrustStore {
  try {
    const raw = JSON.parse(readFileSync(trustFile(), 'utf8')) as TrustStore;
    if (raw?.version === 2 && Array.isArray(raw.projects)) return raw;
  } catch {
    /* fresh */
  }
  return { version: 2, projects: [] };
}

function fingerprint(cwd: string): { sha256: string; restricted: { deny: string[]; ask: string[] } } | null {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, '.smalt', 'settings.json'), 'utf8')) as Record<string, unknown>;
    const perms = { ...((raw.permissions ?? {}) as Record<string, unknown>) };
    const restricted = { deny: Array.isArray(perms.deny) ? perms.deny.filter((v): v is string => typeof v === 'string') : [], ask: Array.isArray(perms.ask) ? perms.ask.filter((v): v is string => typeof v === 'string') : [] };
    delete perms.deny;
    delete perms.ask;
    const canonicalJson = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
      return JSON.stringify(value);
    };
    const dangerous = { ...raw, permissions: perms };
    return { sha256: createHash('sha256').update(canonicalJson(dangerous)).digest('hex'), restricted };
  } catch { return null; }
}

function saveStore(store: TrustStore): void {
  mkdirSync(smaltHome(), { recursive: true });
  writeFileSync(trustFile(), `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/** does this directory have a project-level settings file at all? */
export function hasProjectSettings(cwd: string): boolean {
  return existsSync(join(cwd, '.smalt', 'settings.json'));
}

export function isProjectTrusted(cwd: string): boolean {
  if (!hasProjectSettings(cwd)) return true; // nothing to distrust
  const key = canonical(cwd);
  const current = fingerprint(cwd);
  const saved = loadStore().projects.find(p => p.dir === key);
  return !!(saved && current && saved.sha256 === current.sha256 &&
    saved.restricted.deny.every(r => current.restricted.deny.includes(r)) &&
    saved.restricted.ask.every(r => current.restricted.ask.includes(r)));
}

export function trustProject(cwd: string, snapshot = fingerprint(cwd)): void {
  const store = loadStore();
  const key = canonical(cwd);
  const current = snapshot;
  if (!current) throw new Error('Invalid project configuration');
  store.projects = store.projects.filter(p => p.dir !== key);
  store.projects.push({ dir: key, ...current });
  saveStore(store);
}

export function untrustProject(cwd: string): void {
  const store = loadStore();
  const key = canonical(cwd);
  store.projects = store.projects.filter((p) => p.dir !== key);
  saveStore(store);
}

/**
 * Prompt-and-record flow for a first run in a directory with project
 * settings. `prompt` decides interactively (terminal/dialog); returning
 * false leaves the project untrusted (its settings are loaded in
 * restrictive mode).
 */
export async function ensureProjectTrust(
  cwd: string,
  prompt: (dir: string) => Promise<boolean>,
  log: (msg: string) => void = () => {},
): Promise<boolean> {
  if (!hasProjectSettings(cwd)) return true;
  if (isProjectTrusted(cwd)) { trustProject(cwd); return true; }
  const reviewed = fingerprint(cwd);
  let answer = false;
  try {
    answer = await prompt(cwd);
  } catch (err) {
    log(`trust prompt failed: ${err instanceof Error ? err.message : err}`);
  }
  const current = fingerprint(cwd);
  if (answer && reviewed && current && reviewed.sha256 === current.sha256 && reviewed.restricted.deny.every(r => current.restricted.deny.includes(r)) && reviewed.restricted.ask.every(r => current.restricted.ask.includes(r))) {
    trustProject(cwd, current);
    log(`project trusted: ${cwd}`);
  } else {
    answer = false;
    log(`project NOT trusted — .smalt/settings.json applies in restrictive mode: ${cwd}`);
  }
  return answer;
}
