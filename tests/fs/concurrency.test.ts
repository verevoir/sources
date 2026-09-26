import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const activity = vi.hoisted(() => ({ active: 0, peak: 0 }));
vi.mock('node:child_process', () => ({
  execFile: (
    _command: string,
    _args: string[],
    _options: unknown,
    callback: (error: null, result: { stdout: string }) => void
  ) => {
    activity.active++;
    activity.peak = Math.max(activity.peak, activity.active);
    setTimeout(() => {
      activity.active--;
      callback(null, { stdout: '' });
    }, 10);
  },
}));

import { getRepoTree } from '../../src/fs/index.js';
let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it('overlaps sibling Git queries while bounding process concurrency', async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'fs-concurrency-'));
  for (let i = 0; i < 20; i++) {
    const dir = join(root, `repo-${i}`);
    await fs.mkdir(dir);
    await fs.writeFile(join(dir, '.git'), 'gitdir: unused');
    await fs.writeFile(join(dir, 'source.ts'), '');
  }
  const tree = await getRepoTree({ token: '', forkOrg: '' }, root);
  expect(tree.entries).toHaveLength(40);
  expect(tree.truncated).toBe(false);
  expect(activity.peak).toBeGreaterThan(1);
  expect(activity.peak).toBeLessThanOrEqual(8);
  expect(activity.active).toBe(0);
});
