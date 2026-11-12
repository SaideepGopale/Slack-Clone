import { ChildProcess, spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

/**
 * Starts the real backend (server.ts) as its own process, for tests that need
 * the whole server under a particular environment (database or Redis down).
 * It runs from an empty temporary directory, so dotenv cannot load the
 * developer's .env; only the variables given here (plus PATH/HOME) are set.
 */
export interface ServerProcess {
  url: string;
  output: () => string;
  stop: () => Promise<void>;
}

export const freePort = () =>
  new Promise<number>((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => done(port));
    });
  });

export const startServerProcess = async (env: Record<string, string>): Promise<ServerProcess> => {
  const backendDir = resolve(__dirname, '..');
  const workDir = mkdtempSync(join(tmpdir(), 'sc-t34-'));
  const port = await freePort();
  // One node process with the tsx loader (the `tsx` CLI would add a wrapper process).
  const loader = pathToFileURL(join(backendDir, 'node_modules/tsx/dist/loader.mjs')).href;
  const proc: ChildProcess = spawn(process.execPath, ['--import', loader, join(backendDir, 'server.ts')], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-key',
      CLOUDINARY_API_SECRET: 'test-secret',
      ...env,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: string[] = [];
  proc.stdout!.on('data', (c: Buffer) => chunks.push(c.toString()));
  proc.stderr!.on('data', (c: Buffer) => chunks.push(c.toString()));
  const stop = async () => {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    rmSync(workDir, { recursive: true, force: true });
  };
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url}/api/health`); // any answer means it is listening
      return { url, output: () => chunks.join(''), stop };
    } catch {
      if (proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  await stop();
  throw new Error(`server did not start:\n${chunks.join('').slice(-2000)}`);
};
