// electron-builder afterPack hook: ad-hoc code-sign the macOS app.
// Without any signature, Apple Silicon refuses to run the binary and Gatekeeper
// reports the app as "damaged". An ad-hoc signature (identity "-") lets users
// open it with right-click → Open / "Open Anyway", no Apple Developer account needed.
const { execSync } = require('node:child_process')
const path = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  console.log(`  • ad-hoc signing ${appPath}`)
  execSync(`codesign --force --deep --sign - --timestamp=none "${appPath}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' })
}
