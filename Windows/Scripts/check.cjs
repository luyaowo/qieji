const { spawnSync } = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(python, ['-X', 'utf8', 'Scripts/check-windows.py', ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
