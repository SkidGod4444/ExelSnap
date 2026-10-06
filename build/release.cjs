// electron-builder config for a release build: Developer ID signing, hardened runtime, notarization.
//   npm run release:mac
// Needs a "Developer ID Application" certificate in the login keychain and notarization credentials
// in the environment — either APPLE_KEYCHAIN_PROFILE (from `xcrun notarytool store-credentials`),
// or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID. Local builds (`npm run dist:mac`)
// stay ad-hoc signed and need none of this.
const base = require('../package.json').build
const { identity: _adHoc, ...mac } = base.mac

module.exports = {
  ...base,
  mac: {
    ...mac,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: true
  }
}
