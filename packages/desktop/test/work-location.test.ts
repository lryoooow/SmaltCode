import { describe, expect, it } from 'vitest'
import { workLocation } from '../src/renderer/src/c/work-location'

const cwd = 'D:\\unrelated-local-bookkeeping'
const ssh = { profileId: 'ssh', name: 'server', host: 'fixture.invalid', port: 2222, username: 'developer', root: '/srv/project', fingerprint: 'test-only' }
const container = { profileId: 'container', name: 'project-box', context: 'fixture', endpoint: 'fixture', engineId: 'engine', contextFingerprint: 'context', containerId: 'f'.repeat(64), imageId: 'image', root: '/workspace', user: '1000:1000', startedAt: '', readOnly: false }

describe('execution location across conversation surfaces', () => {
  it('labels an ordinary directory explicitly as local and preserves its full path', () => {
    expect(workLocation({ cwd })).toEqual({ label: '本机 · unrelated-local-bookkeeping', detail: cwd })
  })
  it('keeps the remote host/root visible even when the connection needs new authorization', () => {
    const display = workLocation({ cwd, sshTarget: ssh })
    expect(display.label).toContain(ssh.host)
    expect(display.detail).toContain(ssh.root)
    expect(JSON.stringify(display)).not.toContain(cwd)
    expect(JSON.stringify(display)).not.toContain('本机')
  })
  it('prioritizes the full container target and SSH chain over both bookkeeping and a stale SSH target', () => {
    const display = workLocation({ cwd, sshTarget: ssh, containerTarget: { ...container, ssh: { ...ssh, socket: '/run/docker.sock' } } })
    expect(display.label).toBe('容器 · project-box')
    expect(display.detail).toContain(container.containerId)
    expect(display.detail).toContain('/workspace')
    expect(display.detail).toContain('developer@fixture.invalid:2222')
    expect(JSON.stringify(display)).not.toContain(cwd)
  })
})
