// electron-builder config for a release build: Developer ID signing, hardened runtime, notarization.
//
//   CSC_LINK=/path/to/developer-id.p12 CSC_KEY_PASSWORD=… npm run release:mac
//
// The certificate can also simply be in the login keychain (then leave CSC_LINK out). Never commit
// the .p12 or its password.
//
// Notarization runs when credentials are in the environment — APPLE_KEYCHAIN_PROFILE (from
// `xcrun notarytool store-credentials`), or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID,
// or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER. Without them the build is signed but
// not notarized, and Gatekeeper still warns on other Macs.
// Local builds (`npm run dist:mac`) stay ad-hoc signed and need none of this.
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
    notarize: Boolean(process.env.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_ID || process.env.APPLE_API_KEY)
  }
}
