// Launches Electron with a sanitized environment. Some machines export
// NODE_OPTIONS=--openssl-legacy-provider globally, which Electron refuses to
// start with; strip it (and anything else Electron rejects) before spawning.
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const env = { ...process.env };
delete env['NODE_OPTIONS'];

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
