// Small Windows OS-probe helpers shared by doctor.mjs and laragon.mjs.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { PS_EXE } from './paths.mjs';

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

/**
 * Spawns the real powershell.exe with an argv array (shell:false) — not a
 * .bat, so no cmd.exe quoting hazard. `-ExecutionPolicy Bypass` matters on
 * stock Windows (policy `Restricted`): without it the npm-global .ps1 shims
 * that `claude`/`codex` resolve to refuse to run — a machine set to
 * RemoteSigned (a dev-tools side effect) hides this, which is exactly how it
 * survived live testing on two machines. Process-scope bypass works under
 * Restricted unless locked by Group Policy.
 */
export function psCapture(command) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        shell: false,
      });
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

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Runs an external command via real `powershell.exe` (shell:false, no
 * cmd.exe quoting hazard) rather than spawning it directly — `claude`/`codex`
 * resolve to npm-global `.cmd`/`.ps1` shims on Windows, which
 * `spawn(shell:false)` cannot launch (confirmed live: `spawn ENOENT`, silent
 * unless the caller checks `.code`). Each token is single-quoted for
 * PowerShell; the call operator `&` is required because a leading quoted
 * string parses as an expression, not a command, otherwise.
 *
 * Args containing a double quote are rejected outright: Windows PowerShell
 * 5.1 re-builds the child command line when invoking a native exe and does
 * NOT escape embedded double quotes (fixed only in PS 7.3+), so such a value
 * would be corrupted silently. Nothing this tool passes contains one (all
 * generated secrets are alphanumeric/hyphen by construction) — the guard
 * keeps that invariant explicit for future callers.
 */
export function psRun(cmd, args) {
  for (const a of [cmd, ...args]) {
    if (String(a).includes('"')) {
      return Promise.resolve({ code: null, stdout: '', stderr: `psRun: refusing argument containing a double quote: ${a}` });
    }
  }
  return psCapture(`& ${[cmd, ...args].map(psQuote).join(' ')}`);
}

/** Absolute path for an executable on PATH, or null. Bare-name spawn on Windows searches the CURRENT DIRECTORY first, so anything we launch by name is CWD-hijackable. */
export async function resolveOnPath(cmd) {
  const { stdout } = await psCapture(`(Get-Command '${String(cmd).replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First 1).Source`);
  return stdout.trim() || null;
}

export async function processRunning(name) {
  const { stdout } = await psCapture(`if (Get-Process -Name '${name}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
  return stdout.trim() === 'yes';
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
