// electron-builder afterPack hook: hardens the packaged Electron binary with fuses.
// https://www.electronjs.org/docs/latest/tutorial/fuses
const path = require('node:path')
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses')

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  const { productFilename, executableName } = context.packager.appInfo
  const binary =
    platform === 'darwin'
      ? path.join(context.appOutDir, `${productFilename}.app`)
      : platform === 'win32'
        ? path.join(context.appOutDir, `${productFilename}.exe`)
        : path.join(context.appOutDir, context.packager.executableName ?? executableName)

  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // The app never uses file://, so it gets no extra privileges.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  })
}
