import { execFileSync } from 'node:child_process';
const gate = await import(process.cwd() + '/scripts/ts-equivalence.mjs');
for (const stem of process.argv.slice(2)) {
  const ext = (rev, exts) => { for (const e of exts) { try { return [e, execFileSync('git', ['show', `${rev}:${stem}${e}`], { encoding: 'utf8' })]; } catch {} } return [null, null]; };
  const [be, b] = ext(process.env.PAIR_BASE || '44072b7db', ['.js', '.jsx']); const [he, h] = ext('HEAD', ['.ts', '.tsx']);
  const same = JSON.stringify(await gate.compile(b)) === JSON.stringify(await gate.compile(h));
  console.log(`${same ? 'IDENTICAL' : 'DIFFERENT'}  ${stem}${be} -> ${stem}${he}`);
}
