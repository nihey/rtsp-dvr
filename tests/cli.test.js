import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(rootDir, 'index.js');

// RTSP_URL is stripped so the `url` command test can never start a recording.
const runCli = (...args) =>
  execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    env: { ...process.env, RTSP_URL: '' },
  });

test('CLI --help exits 0 and lists all recording commands', async () => {
  const { stdout } = await runCli('--help');
  assert.match(stdout, /imou-rtsp-dvr/);
  for (const command of ['cloud', 'local', 'url', 'list-devices']) {
    assert.match(stdout, new RegExp(`^\\s+${command}`, 'm'),
      `expected help output to list the "${command}" command`);
  }
});

test('CLI --version matches package.json version', async () => {
  const pkg = JSON.parse(
    await readFile(path.join(rootDir, 'package.json'), 'utf8'),
  );
  const { stdout } = await runCli('--version');
  assert.equal(stdout.trim(), pkg.version);
});

test('CLI url command exits 1 when no RTSP URL is provided', async () => {
  await assert.rejects(
    runCli('url'),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /RTSP URL is required/);
      return true;
    },
  );
});
