import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomInt } from 'node:crypto';

test('server starts through a symlinked project path', { timeout: 15_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'xmd-server-'));
  let child;
  try {
    const project = join(temp, 'project');
    symlinkSync(fileURLToPath(new URL('../', import.meta.url)), project, 'dir');
    const port = randomInt(18792, 28792);
    child = spawn(process.execPath, [join(project, 'src/server.js')], {
      env: { ...process.env, XMD_HOST: '127.0.0.1', XMD_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    try {
      let healthy = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        assert.equal(child.exitCode, null, `Server exited early: ${output}`);
        assert.equal(child.signalCode, null, `Server terminated early: ${output}`);
        if (output.includes(`listening on 127.0.0.1:${port}`)) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
            healthy = response.status === 200 && await response.text() === 'ok';
          } catch { /* Retry until the startup deadline. */ }
          if (healthy) break;
        }
        await delay(50);
      }
      assert.ok(healthy, `Server did not become healthy: ${output}`);
      assert.match(output, new RegExp(`listening on 127\\.0\\.0\\.1:${port}`));
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
