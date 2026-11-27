/**
 * path-mentions: which `server/<path>` mentions of moved files are rewritten, which are a
 * split, which name the whole package, and when a split stands as a value of its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMentionResolver, rewriteMentions, standalone } from './path-mentions.mjs';

test('mentions: files, stems, globs, the package and splits', () => {
    const dest = new Map([['a/x.js', 'm'], ['a/y.js', 'm'], ['b/z.js', 'core'], ['b/w.js', 'm']]);
    const r = createMentionResolver(dest, new Map([['a/x.js', 'm'], ['a/y.js', 'm'], ['b/w.js', 'm']]));
    const out = rewriteMentions("'server/a/x.js', server/a/y. modules/m/server/a/x.js server/a/*.js server/b/ server/**/*.js my-server/a/x.js (^|/)server/a/x\\.js", r);
    assert.equal(out.text, "'modules/m/server/a/x.js', modules/m/server/a/y. modules/m/server/a/x.js modules/m/server/a/*.js server/b/ server/**/*.js my-server/a/x.js (^|/)modules/m/server/a/x\\.js");
    assert.deepEqual(out.splits.map((s) => [s.mention, s.roots]), [['server/b/', ['core', 'm']]]);
    assert.deepEqual(out.packageWide.map((p) => p.mention), ['server/**/*.js']);
});

test('a split mention blocks only as a value of its own, not in prose or a comment', () => {
    const at = (text) => standalone(text, text.indexOf('server/'), 'server/b/'.length);
    assert.equal(at('  "server/b/",'), true);
    assert.equal(at("paths: ['server/b/']"), true);
    assert.equal(at('      - server/b/'), true);
    assert.equal(at('  watch: server/b/'), true);
    assert.equal(at('  "reason": "generated from server/b/ by a script"'), false);
    assert.equal(at('  # the files in server/b/ stay'), false);
});
