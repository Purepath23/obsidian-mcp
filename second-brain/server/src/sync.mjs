import { spawn } from 'node:child_process';

let pending = Promise.resolve();

export function syncVault(vaultDir, { command = 'ob', timeoutMs = 180000 } = {}) {
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(command, ['sync', '--path', vaultDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let errorOutput = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Obsidian Sync non riuscita (${code ?? 'timeout'}): ${errorOutput.trim()}`));
    });
  });
  const result = pending.then(run, run);
  pending = result.catch(() => {});
  return result;
}
