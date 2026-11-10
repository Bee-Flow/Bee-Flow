import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    FIXED_NOW, THEMES, VIEWPORT_NAMES, buildJobs, compareKeySets, diffImageData, diffPixels, main, parseArgs, prepareDocument, safeName,
} from './app-compat-pixels.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(os.tmpdir(), 'compat-pixels-baseline');
const BASE_ARGS = ['--write', OUT, '--bundle', '/b', '--chrome', '/usr/bin/chrome'];

test('parseArgs: a write run with a local browser', () => {
    const opts = parseArgs(BASE_ARGS);
    assert.equal(opts.mode, 'write');
    assert.equal(opts.baseline, OUT);
    assert.equal(opts.bundle, path.resolve('/b'));
    assert.equal(opts.chrome, path.resolve('/usr/bin/chrome'));
    assert.equal(opts.concurrency, 2);
    assert.equal(opts.tolerance, 0);
});

test('parseArgs: compare with options, the browser from BROWSER_WS_ENDPOINT', () => {
    const opts = parseArgs(['--compare', OUT, '--bundle', '/b', '--only', 'a, b', '--concurrency', '3', '--tolerance', '2', '--diff', '/d'], { BROWSER_WS_ENDPOINT: 'ws://browser:9222/x' });
    assert.equal(opts.mode, 'compare');
    assert.equal(opts.ws, 'ws://browser:9222/x');
    assert.deepEqual(opts.only, ['a', 'b']);
    assert.equal(opts.concurrency, 3);
    assert.equal(opts.tolerance, 2);
    assert.equal(opts.diff, path.resolve('/d'));
});

test('parseArgs: refuses what it cannot run', () => {
    const cases = [
        [[], /--write/],
        [['--write', OUT, '--compare', OUT, '--bundle', '/b', '--chrome', '/c'], /one of/],
        [['--write', OUT, '--chrome', '/c'], /--bundle/],
        [['--write', OUT, '--bundle', '/b'], /--chrome/],
        [['--write', OUT, '--bundle'], /needs a value/],
        [['--nope', 'x'], /unknown argument/],
        [[...BASE_ARGS, '--concurrency', '0'], /whole number/],
        [[...BASE_ARGS, '--tolerance', '300'], /whole number/],
        [['--write', path.join(REPO, 'baseline'), '--bundle', '/b', '--chrome', '/c'], /outside the repository/],
    ];
    for (const [argv, re] of cases) {
        const opts = parseArgs(argv);
        assert.match(String(opts.error), re, argv.join(' '));
    }
});

test('safeName keeps letters, digits, dash and underscore', () => {
    assert.equal(safeName('scr_Home-1'), 'scr_Home-1');
    assert.equal(safeName('a/b c'), 'a_b_c');
    assert.equal(safeName(''), '_');
});

test('buildJobs: every screen at every viewport in every theme, in a stable order', () => {
    const apps = [
        { name: 'one', definition: { screens: [{ id: 's1' }, { id: 's/2' }, null, { name: 'no id' }] } },
        { name: 'two', definition: { screens: [] } },
        { name: 'three', definition: {} },
    ];
    const jobs = buildJobs(apps);
    assert.equal(jobs.length, 2 * VIEWPORT_NAMES.length * THEMES.length);
    assert.deepEqual(jobs[0], { name: 'one', screenId: 's1', viewport: 'desktop', theme: 'light', key: 'one/s1/desktop-light.png' });
    assert.equal(jobs.at(-1).key, 'one/s_2/mobile-high-contrast.png');
    assert.equal(new Set(jobs.map((j) => j.key)).size, jobs.length);
});

test('prepareDocument: theme on <html>, a fixed clock first in <head>, the rest untouched', () => {
    const doc = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body><script type="application/json">{"a":"\\u003chtml>"}</script></body>\n</html>';
    const out = prepareDocument(doc, 'high-contrast');
    assert.ok(out.startsWith('<!DOCTYPE html>\n<html data-theme="high-contrast">\n<head>\n<script>'));
    assert.ok(out.includes(`var F=${Date.parse(FIXED_NOW)},`));
    assert.ok(out.endsWith('<meta charset="utf-8">\n</head>\n<body><script type="application/json">{"a":"\\u003chtml>"}</script></body>\n</html>'));
    assert.throws(() => prepareDocument('<p>no document</p>', 'light'), /no <html>/);
});

test('prepareDocument: the clock script fixes now and leaves explicit dates alone', () => {
    const out = prepareDocument('<html><head></head></html>', 'dark', '2026-01-15T12:00:00.000Z');
    const script = out.slice(out.indexOf('<script>') + '<script>'.length, out.indexOf('</script>'));
    const window = {};
    new Function('window', 'Date', script)(window, Date);
    const D = window.Date;
    assert.equal(new D().toISOString(), '2026-01-15T12:00:00.000Z');
    assert.equal(D.now(), Date.parse('2026-01-15T12:00:00.000Z'));
    assert.equal(new D('2020-05-01T00:00:00Z').toISOString(), '2020-05-01T00:00:00.000Z');
    assert.equal(new D(2020, 0, 2).getFullYear(), 2020);
    assert.ok(new D() instanceof Date);
    assert.equal(typeof D(), 'string');
});

const img = (width, height, fill) => ({ width, height, data: Buffer.from(Array.from({ length: width * height * 4 }, (_, i) => fill(i))) });

test('diffPixels: same, off by one channel, past the tolerance, other size', () => {
    const a = img(2, 2, () => 100);
    assert.deepEqual({ ...diffPixels(a, img(2, 2, () => 100)), mask: undefined }, { sameSize: true, differing: 0, total: 4, mask: undefined });
    const b = img(2, 2, (i) => (i === 5 ? 103 : 100));
    assert.equal(diffPixels(a, b).differing, 1);
    assert.deepEqual([...diffPixels(a, b).mask], [0, 1, 0, 0]);
    assert.equal(diffPixels(a, b, 3).differing, 0);
    assert.equal(diffPixels(a, b, 2).differing, 1);
    assert.equal(diffPixels(a, img(1, 4, () => 100)).sameSize, false);
});

test('diffImageData: red where it differs, opaque grey elsewhere', () => {
    const base = img(2, 1, () => 0);
    const out = diffImageData(base, Uint8Array.from([1, 0]));
    assert.deepEqual([...out.subarray(0, 4)], [255, 0, 0, 255]);
    assert.deepEqual([...out.subarray(4, 8)], [200, 200, 200, 255]);
});

test('compareKeySets: what the baseline lacks and what it has extra', () => {
    assert.deepEqual(compareKeySets(['a', 'b', 'c'], ['c', 'd', 'a']), { missing: ['d'], added: ['b'] });
});

test('main: a usage error exits 2 before anything loads', async () => {
    const write = process.stderr.write;
    let err = '';
    process.stderr.write = (s) => { err += s; return true; };
    try {
        assert.equal(await main(['--write', OUT], { env: {} }), 2);
    } finally {
        process.stderr.write = write;
    }
    assert.match(err, /--bundle/);
});
