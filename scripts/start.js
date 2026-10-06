// Launch the Electron app. Clears ELECTRON_RUN_AS_NODE, which VS Code (itself an
// Electron app) can leak into child shells and which would make Electron run as
// plain Node, breaking require('electron').
const { spawn } = require('child_process');
const path = require('path');
const electronBinary = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => process.exit(code ?? 0));
