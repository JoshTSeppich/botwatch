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

// Electron's fuses, flipped here rather than through electron-builder's
// electronFuses setting: that flips them after this hook, which breaks the
// signature made below. Run-as-node stays on — the guard hook and the MCP
// relay run on this binary in node mode. --inspect and NODE_OPTIONS are off.
exports.FUSES = {
  runAsNode: true,
  enableNodeCliInspectArguments: false,
  enableNodeOptionsEnvironmentVariable: false,
};

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  await context.packager.addElectronFuses(context, await context.packager.generateFuseConfig(exports.FUSES));
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // Taken from the build config rather than repeated here: two copies of an
  // identifier that macOS keys permission grants on is one too many.
  const id = context.packager.appInfo.id;
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--identifier', id, app],
    { stdio: 'inherit' },
  );
};
