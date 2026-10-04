#!/usr/bin/env node
// Status of the Learning Center lesson videos, read straight from the files (no agent, no app needed).
// Usage: node .claude/handoff/lesson-videos/status.mjs [--json] [--all]
//   default: the priority set (data/priority.json + the lessons finished before it); --all adds data/later.json.
// Per lesson: storyboard, final video (-heart-subs), QA verdict, length, whether its takes predate the
// recording fixes (light nav dim, no focus ring: 2026-10-03 13:00), and whether it is in the media pack
// mapping (clip-studio learn-videos.json) and wired into a lesson (curriculum.json `video`).
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CS = process.env.CLIP_STUDIO || '/home/tom/Projects/Bee-Flow-AI-internal/clip-studio';
const CURRICULUM = path.resolve(HERE, '../curriculum/curriculum.json');
const FIX_CUTOFF = new Date('2026-10-03T13:00:18+02:00').getTime(); // src/record/focusring.mjs + spotdim.mjs
const MAX_SECONDS = 180;

const args = new Set(process.argv.slice(2));
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

const FINISHED_BEFORE = ['chat-answer-depth', 'chat-attachments', 'chat-history-hygiene', 'chat-voice-and-dictation',
  'compliance-dsr-and-incidents', 'settings-preferences', 'prompt-basics', 'org-context-and-reuse'];
const BLOCKED = { 'chat-create-media': 'needs an image-generation key in the demo org (not approved)',
  'admin-plan-and-billing': 'cloud-only page; no video by decision' };
// storyboard names that differ from lesson-<id>
const STORYBOARD = { 'org-context-and-reuse': 'lesson-org-context-and-reuse-split' };

const priority = readJson(path.join(HERE, 'data/priority.json'), []);
const later = args.has('--all') ? readJson(path.join(HERE, 'data/later.json'), []) : [];
const ids = [...new Set([...FINISHED_BEFORE, ...priority, ...later, ...Object.keys(BLOCKED)])];

const pack = readJson(path.join(CS, 'learn-videos.json'), { videos: {} }).videos || {};
const curriculum = readJson(CURRICULUM, { courses: [] });
const wired = new Set(curriculum.courses.flatMap((c) => c.lessons || []).filter((l) => l.video).map((l) => l.id));

function takesMtime(sb) {
  const dir = path.join(CS, 'out/takes');
  let newest = 0, oldest = Infinity, n = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.startsWith(sb + '-') || !f.endsWith('.mp4') || f.startsWith('.')) continue;
    const t = fs.statSync(path.join(dir, f)).mtimeMs; n++;
    newest = Math.max(newest, t); oldest = Math.min(oldest, t);
  }
  return n ? { n, oldest, newest } : null;
}

const rows = ids.map((id) => {
  const sb = STORYBOARD[id] || `lesson-${id}`;
  const cut = path.join(CS, 'out/cuts', sb);
  const mp4 = path.join(cut, `${sb}-heart-subs.mp4`);
  const qa = readJson(path.join(cut, `${sb}-heart-subs.qa.json`), null);
  const takes = takesMtime(sb);
  const row = {
    id, storyboard: sb,
    hasStoryboard: fs.existsSync(path.join(CS, 'drafts/storyboards', `${sb}.yaml`)),
    video: fs.existsSync(mp4) ? mp4 : null,
    verdict: qa?.verdict ?? null, fails: qa?.counts?.fail ?? null,
    seconds: qa?.duration ? Math.round(qa.duration) : null,
    oldTakes: takes ? takes.oldest < FIX_CUTOFF : null,
    inPack: pack[id] === sb, wired: wired.has(id),
    blocked: BLOCKED[id] || null,
  };
  row.state = row.blocked ? 'blocked'
    : row.video && row.fails === 0 ? 'done'
    : row.video ? 'qa-fail'
    : row.hasStoryboard ? 'in-progress' : 'todo';
  row.todo = [
    row.state === 'done' && row.oldTakes ? 're-record (old dim/focus ring)' : null,
    row.state === 'done' && row.seconds > MAX_SECONDS ? `shorten (${row.seconds}s > ${MAX_SECONDS}s)` : null,
    row.state === 'done' && !row.inPack ? 'add to learn-videos.json' : null,
    row.state === 'done' && !row.wired ? 'add video entry to curriculum.json' : null,
  ].filter(Boolean);
  return row;
});

if (args.has('--json')) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }

const count = (s) => rows.filter((r) => r.state === s).length;
console.log(`Lesson videos (${args.has('--all') ? 'priority + later' : 'priority set'}): ${rows.length}`);
console.log(`  done ${count('done')} · qa-fail ${count('qa-fail')} · in progress ${count('in-progress')} · todo ${count('todo')} · blocked ${count('blocked')}`);
console.log('');
const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(pad('lesson', 36) + pad('state', 12) + pad('sec', 5) + pad('QA', 6) + 'to do');
for (const r of rows) console.log(pad(r.id, 36) + pad(r.state, 12) + pad(r.seconds ?? '', 5) + pad(r.verdict ?? '', 6) + (r.blocked || r.todo.join('; ')));
