const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const target = process.argv[2] || 'all';

function watchApp(appName, dirPath) {
  const pkgPath = path.join(dirPath, 'package.json');
  let proc = null;

  function startApp() {
    if (proc) {
      proc.kill();
    }
    console.log(`[Watch Script] Starting ${appName}...`);
    proc = spawn('npm', ['run', 'dev'], {
      cwd: dirPath,
      stdio: 'inherit',
      shell: true
    });
  }

  function installAndRestart() {
    console.log(`[Watch Script] ${appName}/package.json changed! Reinstalling dependencies...`);
    try {
      execSync('npm install', { cwd: dirPath, stdio: 'inherit' });
      console.log(`[Watch Script] ${appName} dependencies reinstalled successfully.`);
      startApp();
    } catch (err) {
      console.error(`[Watch Script] Error reinstalling ${appName} dependencies:`, err.message);
    }
  }

  if (fs.existsSync(pkgPath)) {
    startApp();
    fs.watchFile(pkgPath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        installAndRestart();
      }
    });
  } else {
    console.log(`[Watch Script] ${pkgPath} not found, skipping watcher.`);
  }
}

if (target === 'server' || target === 'all') {
  watchApp('server', path.join(__dirname, '../server'));
}
if (target === 'client' || target === 'all') {
  watchApp('client', path.join(__dirname, '../client'));
}