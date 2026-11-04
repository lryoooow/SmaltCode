/** Fail before building rather than silently generating an unsigned public DMG. */
export function validateMacBuild({ platform, arch, targetArch, env }) {
  if (platform !== 'darwin') throw new Error('macOS 安装包必须在 Mac 上构建、签名、公证和验收；Windows 无法替代这些步骤。');
  if (!['arm64', 'x64'].includes(targetArch) || targetArch !== arch) throw new Error('请在对应架构的 Mac/Node 环境分别构建 arm64 或 x64；尚未验收 Universal 合并包。');
  if (!env.CSC_NAME?.startsWith('Developer ID Application:')) throw new Error('请在本机钥匙串准备 Developer ID Application 证书，并用 CSC_NAME 选择签名身份。');
  if (!env.APPLE_KEYCHAIN_PROFILE) throw new Error('请先在 Mac 钥匙串保存 notarytool 凭据，并设置 APPLE_KEYCHAIN_PROFILE；不会生成跳过公证的正式包。');
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') throw new Error('正式包不能禁用签名身份发现。');
  // Builder 25 prioritizes these over the requested Keychain profile. Ambiguous
  // credentials must not silently select a different Apple account.
  if (['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].some(key => env[key])) throw new Error('请清除其他公证环境变量，仅使用当前 APPLE_KEYCHAIN_PROFILE。');
  return targetArch;
}
