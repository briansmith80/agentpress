// Small Windows OS-probe helpers shared by doctor.mjs and laragon.mjs.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

export function tcpProbe(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** Spawns the real powershell.exe with an argv array (shell:false) — not a .bat, so no cmd.exe quoting hazard. */
export function psCapture(command) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { shell: false });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: null, stdout, stderr: String(err) }));
  });
}

export async function processRunning(name) {
  const { stdout } = await psCapture(`if (Get-Process -Name '${name}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
  return stdout.trim() === 'yes';
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
