import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL('../.github/antagonistic-review/aggregate.sh', import.meta.url)
);

/** A verdict.json body. `null` as a file body means "make the lens dir but no verdict
 * file" (the directory-exists-but-file-absent case). */
const verdict = (v: string, findings: string[] = [], summary = 's') =>
  JSON.stringify({ verdict: v, summary, findings });

/** Lay out `verdict-<lens>/verdict.json` files in a throwaway dir and run the aggregator
 * over a chosen lens set (default two lenses a, b), returning exit code + stdout. The
 * subprocess is bounded generously so a genuinely-hung script fails legibly rather than
 * hanging the suite, without flaking on a loaded CI runner. */
async function aggregate(
  files: Record<string, string | null>,
  lenses: string | false = 'a b'
): Promise<{ code: number; stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'agg-'));
  try {
    for (const [lens, body] of Object.entries(files)) {
      const d = join(dir, `verdict-${lens}`);
      await mkdir(d, { recursive: true });
      if (body !== null) await writeFile(join(d, 'verdict.json'), body);
    }
    // `lenses === false` leaves PANEL_LENSES unset, so the script uses its hardcoded
    // production default — the actual configuration the gate ships with.
    const env = { ...process.env } as NodeJS.ProcessEnv;
    if (lenses === false) delete env.PANEL_LENSES;
    else env.PANEL_LENSES = lenses;
    try {
      const { stdout } = await run('bash', [SCRIPT, dir], { env, timeout: 20000 });
      return { code: 0, stdout };
    } catch (e) {
      const err = e as { code?: number; stdout?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? '' };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const startsWithCommand = (stdout: string) =>
  stdout.split('\n').some((l) => l.startsWith('::add-mask'));

describe('aggregate.sh — union the panel and gate on unanimous approval', () => {
  it('exits 0 and reports success when every lens APPROVES', async () => {
    const { code, stdout } = await aggregate({ a: verdict('APPROVE'), b: verdict('APPROVE') });
    expect(code).toBe(0);
    expect(stdout).toContain('Every lens APPROVED');
  });

  it('fails closed when one lens REJECTS', async () => {
    expect((await aggregate({ a: verdict('APPROVE'), b: verdict('REJECT') })).code).toBe(1);
  });

  it('fails closed when every lens REJECTS', async () => {
    expect((await aggregate({ a: verdict('REJECT'), b: verdict('REJECT') })).code).toBe(1);
  });

  it('fails closed on an unexpected non-APPROVE verdict string', async () => {
    expect((await aggregate({ a: verdict('APPROVE'), b: verdict('MAYBE') })).code).toBe(1);
  });

  it('fails closed, naming the panelist, when a verdict is missing entirely', async () => {
    const { code, stdout } = await aggregate({ a: verdict('APPROVE') }); // b never produced a verdict
    expect(code).toBe(1);
    expect(stdout).toContain("Panelist 'b' produced no verdict");
  });

  it('fails closed when the lens directory exists but the verdict file is absent', async () => {
    expect((await aggregate({ a: verdict('APPROVE'), b: null })).code).toBe(1);
  });

  it('fails closed on a malformed verdict json', async () => {
    expect((await aggregate({ a: verdict('APPROVE'), b: '{ not json' })).code).toBe(1);
  });

  it('fails closed when the verdict key is absent', async () => {
    expect(
      (await aggregate({ a: verdict('APPROVE'), b: JSON.stringify({ summary: 'x' }) })).code
    ).toBe(1);
  });

  it('fails closed rather than passing vacuously when the lens set is empty', async () => {
    const { code, stdout } = await aggregate({}, '');
    expect(code).toBe(1);
    expect(stdout).toContain('checked nothing');
  });

  it('fails closed on a lens set containing anything but [a-z0-9-] tokens', async () => {
    const { code, stdout } = await aggregate({}, '../evil');
    expect(code).toBe(1);
    expect(stdout).toContain('only [a-z0-9-]');
  });

  it('fails closed on matrix/aggregator drift — a verdict for a lens outside the gated set', async () => {
    const { code, stdout } = await aggregate(
      { a: verdict('APPROVE'), b: verdict('APPROVE'), extra: verdict('APPROVE') },
      'a b'
    );
    expect(code).toBe(1);
    expect(stdout).toContain("'extra' produced a verdict but is not in the gated set");
  });

  it('fails with a usage error when called with no verdicts directory', async () => {
    await expect(
      run('bash', [SCRIPT], { env: { ...process.env, PANEL_LENSES: 'a b' }, timeout: 20000 })
    ).rejects.toThrow(/usage/);
  });

  it('approves the real production lens set (PANEL_LENSES unset) when all five APPROVE', async () => {
    const lenses = ['correctness', 'security', 'testing', 'docs', 'resilience'];
    const files = Object.fromEntries(lenses.map((l) => [l, verdict('APPROVE')]));
    const { code } = await aggregate(files, false);
    expect(code).toBe(0);
  });

  it('fails closed on an oversize verdict file, refusing to parse untrusted bulk', async () => {
    const huge = JSON.stringify({
      verdict: 'APPROVE',
      summary: 'x'.repeat(1_100_000),
      findings: [],
    });
    expect((await aggregate({ a: verdict('APPROVE'), b: huge })).code).toBe(1);
  });

  it('prints each lens, its verdict, and its findings', async () => {
    const { stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: verdict('REJECT', ['first problem', 'second problem']),
    });
    expect(stdout).toContain('### a — APPROVE');
    expect(stdout).toContain('### b — REJECT');
    expect(stdout).toContain('  - first problem');
    expect(stdout).toContain('  - second problem');
  });

  it('handles a verdict with an empty summary without crashing', async () => {
    expect(
      (await aggregate({ a: verdict('APPROVE', [], ''), b: verdict('APPROVE', [], '') })).code
    ).toBe(0);
  });

  it('neutralises a workflow-command smuggled through a newline in the verdict field', async () => {
    const { stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: JSON.stringify({ verdict: 'APPROVE\n::add-mask::X', summary: 's', findings: [] }),
    });
    expect(startsWithCommand(stdout)).toBe(false);
  });

  it('neutralises a workflow-command smuggled through a newline in a finding', async () => {
    const { stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: verdict('REJECT', ['first line\n::add-mask::Y']),
    });
    expect(startsWithCommand(stdout)).toBe(false);
  });
});
