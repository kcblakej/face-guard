// electron-builder configuration (https://www.electron.build).
//
//   npm run dist        -> release/FaceGuard-Setup-<version>.exe   (installer + uninstaller, for direct download)
//   npm run dist:store  -> release/FaceGuard-<version>-Store.appx  (MSIX package for the Microsoft Store)
//
// See docs/DISTRIBUTING.md for signing and Store submission.
const fs = require('node:fs');
const path = require('node:path');

const building = (target) => process.argv.some((a) => a.toLowerCase().includes(target));

/** Store identity from Partner Center (Product management → Product identity). */
function storeIdentity() {
  const file = path.join(__dirname, 'build', 'store-identity.json');
  const id = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (building('appx') && (id.identityName.startsWith('REPLACE') || id.publisher.includes('REPLACE'))) {
    console.warn(
      '\n  ! build/store-identity.json still has placeholder values. The package will build, but the Store\n' +
        '    will reject it. Copy the three values from Partner Center first (docs/DISTRIBUTING.md).\n',
    );
  }
  return id;
}

/**
 * Optional: sign the installer with Azure Artifact Signing (Microsoft's code-signing service).
 * Enabled only when these environment variables are set (locally or as GitHub secrets):
 *   AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_CERT_PROFILE, AZURE_SIGNING_PUBLISHER_NAME
 *   plus AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET for authentication.
 * A classic .pfx certificate also works: set CSC_LINK and CSC_KEY_PASSWORD instead.
 */
function azureSigning() {
  const e = process.env;
  if (!e.AZURE_SIGNING_ENDPOINT) return null;
  return {
    endpoint: e.AZURE_SIGNING_ENDPOINT,
    codeSigningAccountName: e.AZURE_SIGNING_ACCOUNT,
    certificateProfileName: e.AZURE_SIGNING_CERT_PROFILE,
    publisherName: e.AZURE_SIGNING_PUBLISHER_NAME,
  };
}

const store = storeIdentity();

module.exports = {
  appId: 'com.blakejordan.faceguard',
  productName: 'Face Guard',
  copyright: 'Copyright © 2026 Blake Jordan',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/web/**/*', 'dist/electron/**/*', '!**/*.map', 'package.json'],

  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
    azureSignOptions: azureSigning(),
  },

  // Direct-download installer. Includes an uninstaller, registered in Settings → Apps.
  nsis: {
    artifactName: 'FaceGuard-Setup-${version}.${ext}',
    oneClick: false, // show a normal setup wizard: license, install location, per-user or all users
    perMachine: false, // default to "just me": no admin rights needed
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Face Guard',
    uninstallDisplayName: 'Face Guard',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    license: 'build/license.txt',
    include: 'build/installer.nsh', // uninstall cleanup: startup entry + optional user data
    runAfterFinish: true,
  },

  // Microsoft Store package. The Store signs it on publish, so no certificate is needed.
  appx: {
    artifactName: 'FaceGuard-${version}-Store.${ext}',
    applicationId: 'FaceGuard',
    identityName: store.identityName,
    publisher: store.publisher,
    publisherDisplayName: store.publisherDisplayName,
    displayName: 'Face Guard',
    backgroundColor: '#0b1220',
    languages: ['en-US'],
    showNameOnTiles: true,
    capabilities: ['runFullTrust', 'webcam'],
    // Our own "start with Windows" task (users can turn it off in Settings → Apps → Startup).
    customExtensionsPath: 'build/appx-extensions.xml',
  },
};
