import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { AntigravityCliExecutor, type AntigravityChildProcess } from './client.js';

class Stream extends EventEmitter {}

class HungChild extends EventEmitter implements AntigravityChildProcess {
  readonly stdout = new Stream();
  readonly stderr = new Stream();
  readonly killedWith: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedWith.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

describe('AntigravityCliExecutor', () => {
  it('spawns without a shell and caps oversized stdout', async () => {
    const child = new HungChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.emit('spawn');
        child.stdout.emit('data', 'x'.repeat(20));
      });
      return child;
    });
    const executor = new AntigravityCliExecutor({
      executable: 'agy-test',
      spawnProcess,
      commandTimeoutMs: 100,
      shutdownTimeoutMs: 1,
      maxStdoutBytes: 10,
    });
    const result = await executor.run(['-p', '/quota', '--output-format', 'json']);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toHaveLength(10);
    expect(child.killedWith).toEqual(['SIGTERM', 'SIGKILL']);
    await executor.close();
  });
});
