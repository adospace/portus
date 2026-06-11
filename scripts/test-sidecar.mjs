// Smoke test for the sidecar: launches the published exe, then drives the
// named-pipe JSON protocol through save → list → usage.add → get → delete.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { rmSync } from 'node:fs';

const PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\portus-test' : '/tmp/portus-test.sock';
const EXE = 'dist/sidecar/Portus.Sidecar.exe';
const DB = 'scripts/.test.db';
rmSync(DB, { force: true });

const child = spawn(EXE, [DB, PIPE], { stdio: 'inherit' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpc(sock, pending, cmd, data) {
  const id = rpc.id = (rpc.id ?? 0) + 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sock.write(`${JSON.stringify({ id, cmd, data })}\n`);
  });
}

async function main() {
  await sleep(800); // let the sidecar create the pipe
  const sock = connect(PIPE);
  sock.setEncoding('utf8');
  await new Promise((res, rej) => {
    sock.once('connect', res);
    sock.once('error', rej);
  });

  const pending = new Map();
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const env = JSON.parse(line);
      const p = pending.get(env.id);
      pending.delete(env.id);
      env.ok ? p.resolve(env.data) : p.reject(new Error(env.error));
    }
  });

  const now = new Date().toISOString();
  const saved = await rpc(sock, pending, 'session.save', {
    id: 's1', folder: '/tmp/proj-a', claudeId: null,
    createdAt: now, lastActive: now, totalTokens: 0, totalCost: 0,
  });
  console.log('save ->', saved);

  const afterUsage = await rpc(sock, pending, 'usage.add', {
    sessionId: 's1', tokensIn: 1_000_000, tokensOut: 1_000_000,
  });
  console.log('usage.add ->', afterUsage, '(expect totalCost 18, totalTokens 2000000)');

  const list = await rpc(sock, pending, 'session.list', {});
  console.log('list ->', list);

  const got = await rpc(sock, pending, 'session.get', { id: 's1' });
  console.log('get ->', got);

  await rpc(sock, pending, 'session.delete', { id: 's1' });
  const listAfter = await rpc(sock, pending, 'session.list', {});
  console.log('list after delete ->', listAfter);

  const pass =
    saved.id === 's1' &&
    Math.abs(afterUsage.totalCost - 18) < 1e-9 &&
    afterUsage.totalTokens === 2_000_000 &&
    list.length === 1 &&
    listAfter.length === 0;

  sock.destroy();
  console.log(pass ? '\nSIDECAR SMOKE TEST: PASS' : '\nSIDECAR SMOKE TEST: FAIL');
  process.exitCode = pass ? 0 : 1;
}

main()
  .catch((e) => {
    console.error('test error:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    child.kill();
    // Give the sidecar a moment to release the SQLite file handle before cleanup.
    await sleep(300);
    try {
      rmSync(DB, { force: true });
    } catch {
      /* file still locked on Windows; harmless, it's gitignored */
    }
  });
