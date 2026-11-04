import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const root = process.cwd(), assets = join(root, 'packages/desktop/assets');
describe('macOS distribution contract', () => {
  it('keeps the verified Windows brand and provides an ICNS with 16–1024px PNG representations', () => {
    const hash = (name: string) => createHash('sha256').update(readFileSync(join(assets, name))).digest('hex');
    expect(hash('smalt.ico')).toBe('d7eb9b68ecdd9f3399681aab266f5021ec623f88bddf1d62430cea35fed6e22f');
    expect(hash('smalt.png')).toBe('eaad8e4bac9998c016c468a14a595edde5b3c49e81f24de2f43cba3a02caab10');
    const icon = readFileSync(join(assets, 'smalt.icns')), sizes: number[] = [];
    expect(icon.subarray(0, 4).toString()).toBe('icns'); expect(icon.readUInt32BE(4)).toBe(icon.length);
    let offset = 8;
    while (offset < icon.length) {
      const length = icon.readUInt32BE(offset + 4), png = icon.subarray(offset + 8, offset + length);
      expect(length).toBeGreaterThan(32); expect(offset + length).toBeLessThanOrEqual(icon.length);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      sizes.push(png.readUInt32BE(16)); expect(png.readUInt32BE(20)).toBe(sizes.at(-1)); offset += length;
    }
    expect(offset).toBe(icon.length); expect(sizes).toEqual([16, 32, 64, 128, 256, 512, 1024]);
    for (const [name, size] of [['smalt-trayTemplate.png', 22], ['smalt-trayTemplate@2x.png', 44]] as const) {
      const png = readFileSync(join(assets, name)); expect(png.readUInt32BE(16)).toBe(size); expect(png[25]).toBe(6); // RGBA
    }
  });
  it('requires signing/notarization and minimal entitlements in an isolated Mac output', () => {
    const config: any = load(readFileSync(join(root, 'packages/desktop/electron-builder.mac.yml'), 'utf8'));
    expect(config.forceCodeSigning).toBe(true); expect(config.mac.notarize).toBe(true); expect(config.mac.hardenedRuntime).toBe(true);
    expect(config.mac.minimumSystemVersion).toBe('13.0'); expect(config.directories.output).toBe('release-mac');
    expect(config.mac.target).toEqual(['dmg', 'zip']); expect(config.dmg.sign).toBe(true);
    const entitlements = readFileSync(join(root, 'packages/desktop/build/entitlements.mac.plist'), 'utf8');
    expect(entitlements.match(/<key>.*?<\/key>/g)).toEqual(['<key>com.apple.security.cs.allow-jit</key>']);
  });
  it('validates the Mac configuration against the installed electron-builder schema', async () => {
    const { validateConfiguration } = await import('app-builder-lib/out/util/config/config.js');
    const base: any = load(readFileSync(join(root, 'packages/desktop/electron-builder.yml'), 'utf8'));
    const mac: any = load(readFileSync(join(root, 'packages/desktop/electron-builder.mac.yml'), 'utf8'));
    await expect(validateConfiguration({ ...base, ...mac }, { isEnabled: false } as any)).resolves.toBeUndefined();
  });
  it('fails closed on Windows, mismatched native architectures and incomplete or ambiguous Apple credentials', async () => {
    const { validateMacBuild } = await import('../../../scripts/macos-build-policy.mjs');
    const options = { platform: 'darwin', arch: 'arm64', targetArch: 'arm64', env: { CSC_NAME: 'Developer ID Application: Example (TESTTEAM)', APPLE_KEYCHAIN_PROFILE: 'example-profile' } };
    expect(validateMacBuild(options)).toBe('arm64');
    expect(validateMacBuild({ ...options, arch: 'x64', targetArch: 'x64' })).toBe('x64');
    expect(() => validateMacBuild({ ...options, platform: 'win32' })).toThrow('必须在 Mac');
    expect(() => validateMacBuild({ ...options, targetArch: 'x64' })).toThrow('对应架构');
    expect(() => validateMacBuild({ ...options, env: {} })).toThrow('Developer ID');
    expect(() => validateMacBuild({ ...options, env: { CSC_NAME: options.env.CSC_NAME } })).toThrow('KEYCHAIN_PROFILE');
    expect(() => validateMacBuild({ ...options, env: { ...options.env, APPLE_ID: 'other-account' } })).toThrow('其他公证');
    expect(() => validateMacBuild({ ...options, env: { ...options.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })).toThrow('不能禁用');
  });
});
