// electron-builder leaves the Electron binary's own linker signature in place,
// whose identifier is literally "Electron". macOS keys permission grants on
// that identifier, so without this every ad-hoc Electron app looks like the
// same app to TCC — and the Accessibility grant you just gave could apply to,
// or be taken by, something else entirely.
//
// Ad-hoc signing with the real bundle id is the most an unsigned build can do.
// It is not notarisation and does not get you past Gatekeeper's first open.

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--identifier', 'io.aetherx.session-pill', app],
    { stdio: 'inherit' },
  );
};
