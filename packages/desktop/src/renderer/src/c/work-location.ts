import type { Session } from '../bridge'

/** Display the host-bound execution target, never its local bookkeeping cwd. */
export function workLocation(meta: Pick<Session['meta'], 'cwd' | 'sshTarget' | 'containerTarget' | 'localSpace'>) {
  const container = meta.containerTarget
  if (container) return { label: '容器 · ' + container.name, detail: `${container.ssh ? `${container.ssh.username}@${container.ssh.host}:${container.ssh.port} → ` : ''}${container.name} · ${container.containerId} · ${container.root}` }
  const ssh = meta.sshTarget
  if (ssh) return { label: 'SSH · ' + ssh.host, detail: `${ssh.username}@${ssh.host}:${ssh.port} · ${ssh.root}` }
  return { label: meta.localSpace ? '本地对话空间' : '本机 · ' + (meta.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || meta.cwd), detail: meta.cwd }
}
