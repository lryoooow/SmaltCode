const { signAsync } = require(process.env.SMALT_OSX_SIGN_PATH || '@electron/osx-sign');

/**
 * Custom ad-hoc Mach-O code-signing hook for community/test macOS builds.
 * Apple Silicon requires valid ad-hoc (`-`) code signatures on the `.app` bundle,
 * nested Electron frameworks, and unpacked native `.node` / helper binaries.
 */
module.exports = async function signMacAdhoc(opts) {
  await signAsync({
    app: opts.app,
    identity: '-',
    identityValidation: false,
    platform: 'darwin',
    binaries: opts.binaries,
    ignore: opts.ignore,
  });
};
