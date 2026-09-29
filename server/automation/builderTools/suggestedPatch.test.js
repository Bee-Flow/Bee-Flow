/**
 * _suggestedPatch — the machine-readable fix a rejection can carry.
 *
 * REGRESSION (2026-09-12): told "source is required", the fast local model
 * re-sent the byte-identical batch three rounds running; a bad ref path cost
 * fifteen builder_update_steps calls before that. When the server knows the
 * exact edit it now attaches it as ops, and applies them itself when the
 * identical call comes back. These tests pin the op semantics, the
 * signature-based entry lookup that survives a reshuffled batch, and the
 * rule that a model's own edit is never overridden.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/suggestedPatch.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { canonicalJson, applyPatchOps, liftEntryPatch, describePatch, parsePath } = require('./suggestedPatch');

const ref = (path) => ({ kind: 'ref', path });

const batch = () => ({
    steps: [
        { tempId: 'read', type: 'integration_action', spec: { tool: 'nextcloud_read_file', inputs: { path: ref('loop.item.path') } } },
        { tempId: 'ai', type: 'ai_step', spec: { prompt: 'Extract', inputs: { content: ref('steps.$read.output.content') } } },
        { type: 'notification', spec: { title: 'done: {{steps.$ai.output.text}}' } },
    ],
});

// ── canonicalJson ────────────────────────────────────────────────────────

test('canonicalJson: key order does not matter at any depth, array order does', () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: 'x' } };
    const b = { a: { x: 'x', y: [1, { p: 2, q: 1 }] }, b: 1 };
    assert.strictEqual(canonicalJson(a), canonicalJson(b));
    assert.strictEqual(canonicalJson(a), '{"a":{"x":"x","y":[1,{"p":2,"q":1}]},"b":1}');
    assert.notStrictEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});

test('canonicalJson: always a string, even where JSON.stringify gives up', () => {
    assert.strictEqual(typeof canonicalJson(undefined), 'string');
    assert.strictEqual(canonicalJson(null), 'null');
    assert.strictEqual(canonicalJson('s'), '"s"');
});

// ── set ──────────────────────────────────────────────────────────────────

test('set: replaces a value and reports the exact line', () => {
    const r = applyPatchOps(batch(), [{ op: 'set', path: 'steps[1].spec.inputs.path', value: ref('loop.f.path') }]);
    assert.deepStrictEqual(r.args.steps[1].spec.inputs.path, ref('loop.f.path'));
    assert.deepStrictEqual(r.applied, ['steps[1].spec.inputs.path = {"kind":"ref","path":"loop.f.path"}']);
    assert.deepStrictEqual(r.skipped, []);
});

test('set: creates missing intermediate objects, and an array where the next token is an index', () => {
    const r = applyPatchOps({ steps: [{ type: 'notification', spec: { title: 't' } }] }, [
        { op: 'set', path: 'steps[0].spec.inputs.path', value: ref('trigger.output.path') },
        { op: 'set', path: 'steps[0].spec.fields[0].name', value: 'total' },
        { op: 'set', path: 'steps[1]', value: { type: 'notification', spec: { title: 'appended' } } },
    ]);
    assert.deepStrictEqual(r.args.steps[0].spec.inputs, { path: ref('trigger.output.path') });
    assert.deepStrictEqual(r.args.steps[0].spec.fields, [{ name: 'total' }]);
    assert.strictEqual(r.args.steps[1].spec.title, 'appended');
    assert.strictEqual(r.applied.length, 3);
    assert.deepStrictEqual(r.skipped, []);
});

test('set: never coerces a primitive into a container, never reaches past the end of an array', () => {
    const r = applyPatchOps({ inputs: 'oops', steps: [{}] }, [
        { op: 'set', path: 'inputs.path', value: 'x' },
        { op: 'set', path: 'steps[5].spec', value: {} },
        { op: 'set', path: 'steps[0].spec' },
    ]);
    assert.strictEqual(r.args.inputs, 'oops');
    assert.strictEqual(r.args.steps.length, 1);
    assert.deepStrictEqual(r.applied, []);
    assert.match(r.skipped[0], /^set inputs\.path: inputs is a string, not an object$/);
    assert.match(r.skipped[1], /steps\[5\] is out of range \(1 entry\)/);
    assert.match(r.skipped[2], /needs a value/);
});

test('set: the stored value is a copy, not the op\'s own object', () => {
    const value = { a: 1 };
    const r = applyPatchOps({}, [{ op: 'set', path: 'x', value }]);
    r.args.x.a = 2;
    assert.strictEqual(value.a, 1);
});

// ── delete ───────────────────────────────────────────────────────────────

test('delete: an object key and an array entry; a missing one is a skip, not a no-op', () => {
    const r = applyPatchOps(batch(), [
        { op: 'delete', path: 'steps[0].tempId' },
        { op: 'delete', path: 'steps[2]' },
        { op: 'delete', path: 'steps[0].spec.nope' },
    ]);
    assert.ok(!('tempId' in r.args.steps[0]));
    assert.strictEqual(r.args.steps.length, 2);
    assert.deepStrictEqual(r.applied, ['deleted steps[0].tempId', 'deleted steps[2]']);
    assert.deepStrictEqual(r.skipped, ['delete steps[0].spec.nope: nothing at steps[0].spec.nope']);
});

// ── move ─────────────────────────────────────────────────────────────────

test('move: within an array, `to` is the final index in both directions', () => {
    const ids = (r) => r.args.steps.map(s => s.tempId || s.type);
    const down = applyPatchOps(batch(), [{ op: 'move', from: 'steps[0]', to: 'steps[2]' }]);
    assert.deepStrictEqual(ids(down), ['ai', 'notification', 'read']);
    assert.deepStrictEqual(down.applied, ['moved steps[0] → steps[2]']);
    const up = applyPatchOps(batch(), [{ op: 'move', from: 'steps[2]', to: 'steps[0]' }]);
    assert.deepStrictEqual(ids(up), ['notification', 'read', 'ai']);
});

test('move: a field placed beside spec goes inside it — the batch repair the model kept failing at', () => {
    const args = { steps: [{ type: 'data_extraction', source: ref('trigger.output.file'), spec: { fields: [] } }] };
    const r = applyPatchOps(args, [{ op: 'move', from: 'steps[0].source', to: 'steps[0].spec.source' }]);
    assert.deepStrictEqual(r.args.steps[0], { type: 'data_extraction', spec: { fields: [], source: ref('trigger.output.file') } });
    assert.deepStrictEqual(r.applied, ['moved steps[0].source → steps[0].spec.source']);
});

test('move: never overwrites an occupied key, and puts the value back when the target cannot be resolved', () => {
    const args = { steps: [{ type: 'x', source: 'beside', spec: { source: 'inside' } }] };
    const r = applyPatchOps(args, [
        { op: 'move', from: 'steps[0].source', to: 'steps[0].spec.source' },
        { op: 'move', from: 'steps[0].source', to: 'steps[0].type.source' },
        { op: 'move', from: 'steps[0].gone', to: 'steps[0].spec.gone' },
    ]);
    assert.deepStrictEqual(r.args, args, 'nothing changed');
    assert.deepStrictEqual(r.applied, []);
    assert.match(r.skipped[0], /already exists — a move never overwrites/);
    assert.match(r.skipped[1], /steps\[0\]\.type is a string, not an object/);
    assert.match(r.skipped[2], /nothing at steps\[0\]\.gone/);
});

// ── rewrite ──────────────────────────────────────────────────────────────

test('rewrite: touches every string in the subtree and nothing else', () => {
    const args = {
        steps: [
            { spec: { a: 'steps.$read.x', n: 7, ok: true, nested: { list: ['steps.$read.y', 'plain', 3] }, 'steps.$read': 'key untouched' } },
            { spec: { a: 'steps.$read.outside' } },
        ],
    };
    const r = applyPatchOps(args, [{ op: 'rewrite', path: 'steps[0].spec', from: 'steps.$read', to: 'steps.read' }]);
    assert.deepStrictEqual(r.args.steps[0].spec, { a: 'steps.read.x', n: 7, ok: true, nested: { list: ['steps.read.y', 'plain', 3] }, 'steps.$read': 'key untouched' });
    assert.strictEqual(r.args.steps[1].spec.a, 'steps.$read.outside', 'outside the subtree');
    assert.deepStrictEqual(r.applied, ['rewrote "steps.$read" → "steps.read" in 2 strings under steps[0].spec']);
});

test('rewrite: replaces every occurrence literally ($ is not a pattern), also when the path is the string itself or the root', () => {
    const one = applyPatchOps({ s: 'a$1a$1' }, [{ op: 'rewrite', path: 's', from: 'a$1', to: '$&' }]);
    assert.strictEqual(one.args.s, '$&$&');
    const root = applyPatchOps({ a: 'x', b: { c: 'xx' } }, [{ op: 'rewrite', from: 'x', to: 'y' }]);
    assert.deepStrictEqual(root.args, { a: 'y', b: { c: 'yy' } });
    assert.match(root.applied[0], /in 2 strings under args$/);
});

test('rewrite: nothing matched, an empty `from` or a missing path is a skip with the reason', () => {
    const r = applyPatchOps({ s: 'abc' }, [
        { op: 'rewrite', path: 's', from: 'zzz', to: 'y' },
        { op: 'rewrite', path: 's', from: '', to: 'y' },
        { op: 'rewrite', path: 'nope', from: 'a', to: 'y' },
    ]);
    assert.strictEqual(r.args.s, 'abc');
    assert.deepStrictEqual(r.skipped, [
        'rewrite s: no string under s contains "zzz"',
        'rewrite s: rewrite needs a non-empty string `from`',
        'rewrite nope: nothing at nope',
    ]);
});

// ── steps[?] / entrySig ──────────────────────────────────────────────────

test('steps[?] finds the entry by signature after the batch came back with entries 1.. only', () => {
    const full = batch();
    const sig = canonicalJson(full.steps[1]);
    const ops = [{ op: 'set', path: 'steps[?].spec.inputs.content', value: ref('steps.$read.output.text'), entrySig: sig }];
    // The resend dropped entry 0 and reordered the rest: the signed entry is now last.
    const resend = { steps: [full.steps[2], full.steps[1]] };
    const r = applyPatchOps(resend, ops);
    assert.deepStrictEqual(r.args.steps[1].spec.inputs.content, ref('steps.$read.output.text'));
    assert.strictEqual(r.args.steps[0].spec.title, full.steps[2].spec.title, 'the other entry was not touched');
    assert.deepStrictEqual(r.applied, ['steps[1].spec.inputs.content = {"kind":"ref","path":"steps.$read.output.text"}']);
});

test('steps[?]: no matching entry, or no entrySig at all, is a skip with the reason', () => {
    const r = applyPatchOps(batch(), [
        { op: 'set', path: 'steps[?].spec.x', value: 1, entrySig: canonicalJson({ type: 'unknown' }) },
        { op: 'set', path: 'steps[?].spec.x', value: 1 },
    ]);
    assert.deepStrictEqual(r.applied, []);
    assert.match(r.skipped[0], /no entry of steps matches the op's entrySig/);
    assert.match(r.skipped[1], /steps\[\?\] needs an entrySig/);
});

test('a concrete index with an entrySig is re-found by signature when the entries shifted, and refused when the entry changed', () => {
    const full = batch();
    const patch = liftEntryPatch({ ops: [{ op: 'set', path: 'inputs.path', value: ref('loop.f.path') }] }, 1, full.steps[1]);
    // Same call, entry 0 dropped: steps[1] is now the notification, the signed entry sits at steps[0].
    const shifted = applyPatchOps({ steps: [full.steps[1], full.steps[2]] }, patch.ops);
    assert.deepStrictEqual(shifted.args.steps[0].spec.inputs.path, ref('loop.f.path'));
    assert.ok(!shifted.args.steps[1].spec.inputs, 'the entry that merely inherited the index was left alone');
    assert.strictEqual(shifted.applied[0], 'steps[0].spec.inputs.path = {"kind":"ref","path":"loop.f.path"} (found by entry signature — it is no longer at steps[1])');
    // The model made its own edit to that entry: the patch no longer applies to it.
    const edited = batch();
    edited.steps[1].spec.inputs.content = ref('steps.$read.output.text');
    const own = applyPatchOps(edited, patch.ops);
    assert.deepStrictEqual(own.applied, []);
    assert.match(own.skipped[0], /steps\[1\] is not the entry this patch was made for, and no entry of steps matches its signature/);
    assert.deepStrictEqual(own.args, edited);
});

// ── robustness ───────────────────────────────────────────────────────────

test('unknown and malformed paths are skipped with a reason, never thrown', () => {
    const r = applyPatchOps(batch(), [
        { op: 'set', path: 'steps[0].spec.inputs.path.path.deeper.x', value: 1 },
        { op: 'delete', path: 'steps[1]x' },
        { op: 'delete', path: 'steps..spec' },
        { op: 'delete', path: 42 },
        { op: 'delete', path: '' },
        { op: 'delete', path: 'steps.spec' },
    ]);
    assert.deepStrictEqual(r.applied, []);
    assert.match(r.skipped[0], /steps\[0\]\.spec\.inputs\.path\.path is a string, not an object/);
    assert.match(r.skipped[1], /malformed path "steps\[1\]x"/);
    assert.match(r.skipped[2], /malformed path "steps\.\.spec"/);
    assert.match(r.skipped[3], /malformed path 42/);
    assert.match(r.skipped[4], /the path is empty/);
    assert.match(r.skipped[5], /steps is an array, not an object/);
});

test('garbage ops and non-object args are skipped lines, not exceptions', () => {
    const r = applyPatchOps(batch(), [null, 'set', { op: 'frob', path: 'x' }, { op: 'set' }]);
    assert.deepStrictEqual(r.applied, []);
    assert.strictEqual(r.skipped.length, 4);
    assert.match(r.skipped[0], /^op #1: not an object$/);
    assert.match(r.skipped[1], /^op #2: not an object$/);
    assert.match(r.skipped[2], /unknown op "frob"/);
    assert.match(r.skipped[3], /^set undefined: set needs a value/);
    const scalar = applyPatchOps('nope', [{ op: 'set', path: 'x', value: 1 }]);
    assert.strictEqual(scalar.args, 'nope');
    assert.match(scalar.skipped[0], /args is a string, nothing to patch/);
    const none = applyPatchOps({ a: 1 }, undefined);
    assert.deepStrictEqual(none, { args: { a: 1 }, applied: [], skipped: [] });
});

test('applyPatchOps never mutates its input and accepts a { ops } patch as well as a bare array', () => {
    const args = batch();
    const before = JSON.stringify(args);
    const patch = { ops: [
        { op: 'set', path: 'steps[1].spec.inputs.path', value: ref('loop.f.path') },
        { op: 'delete', path: 'steps[0].tempId' },
        { op: 'move', from: 'steps[2]', to: 'steps[0]' },
        { op: 'rewrite', path: 'steps', from: 'steps.$read', to: 'steps.read' },
    ] };
    const r = applyPatchOps(args, patch);
    assert.strictEqual(JSON.stringify(args), before, 'input untouched');
    assert.strictEqual(r.applied.length, 4);
    assert.notStrictEqual(r.args.steps, args.steps);
    r.args.steps[0].spec.title = 'changed on the copy';
    assert.strictEqual(JSON.stringify(args), before);
});

// ── liftEntryPatch ───────────────────────────────────────────────────────

test('liftEntryPatch prefixes every path with steps[i].spec. and signs each op with the entry', () => {
    const entry = { tempId: 'x', type: 'integration_action', spec: { tool: 't', inputs: { path: 'p' } } };
    const patch = {
        why: 'the loop variable is f, not item.',
        ops: [
            { op: 'set', path: 'inputs.path', value: ref('loop.f.path') },
            { op: 'delete', path: 'steps[3].spec.extra' },
            { op: 'move', from: 'source', to: 'inputs.source' },
            { op: 'rewrite', from: 'loop.item', to: 'loop.f' },
            { op: 'rewrite', path: '', from: 'a', to: 'b' },
        ],
    };
    const snapshot = JSON.stringify(patch);
    const lifted = liftEntryPatch(patch, 1, entry);
    const sig = canonicalJson(entry);
    assert.strictEqual(lifted.why, patch.why);
    assert.deepStrictEqual(lifted.ops.map(o => o.path), ['steps[1].spec.inputs.path', 'steps[3].spec.extra', undefined, 'steps[1].spec', 'steps[1].spec']);
    assert.strictEqual(lifted.ops[2].from, 'steps[1].spec.source');
    assert.strictEqual(lifted.ops[2].to, 'steps[1].spec.inputs.source');
    assert.strictEqual(lifted.ops[3].from, 'loop.item', 'a rewrite\'s from/to are strings, not paths');
    assert.strictEqual(lifted.ops[3].to, 'loop.f');
    assert.ok(lifted.ops.every(o => o.entrySig === sig));
    assert.strictEqual(JSON.stringify(patch), snapshot, 'the source patch is not mutated');
});

test('liftEntryPatch → applyPatchOps: the identical resend is repaired, with the entry-relative path made absolute', () => {
    const args = {
        overRef: 'trigger.output.files', itemVar: 'f',
        steps: [
            { type: 'integration_action', spec: { tool: 'nextcloud_read_file', inputs: { path: ref('loop.item.path') } } },
        ],
    };
    // What a per-type builder would attach when it rejected entry 0.
    const lifted = liftEntryPatch({ ops: [{ op: 'rewrite', from: 'loop.item.', to: 'loop.f.' }] }, 0, args.steps[0]);
    const r = applyPatchOps(args, lifted.ops);
    assert.deepStrictEqual(r.args.steps[0].spec.inputs.path, ref('loop.f.path'));
    assert.strictEqual(r.args.itemVar, 'f', 'outside the entry nothing moved');
    assert.deepStrictEqual(r.applied, ['rewrote "loop.item." → "loop.f." in 1 string under steps[0].spec']);
});

test('a lifted move works although removing the field changes the entry\'s signature', () => {
    // REGRESSION: `to` used to be signature-checked AFTER `from` was removed —
    // by then the entry no longer matched its own signature, so every lifted
    // move (the "field beside spec" repair) was refused and put back.
    const entry = { type: 'data_extraction', spec: { source: ref('trigger.output.file'), fields: [] } };
    const lifted = liftEntryPatch({ ops: [{ op: 'move', from: 'source', to: 'inputs.source' }] }, 0, entry);
    const r = applyPatchOps({ steps: [entry] }, lifted.ops);
    assert.deepStrictEqual(r.args.steps[0].spec, { fields: [], inputs: { source: ref('trigger.output.file') } });
    assert.deepStrictEqual(r.applied, ['moved steps[0].spec.source → steps[0].spec.inputs.source']);
    // Resent with another entry in front: both ends follow the signed entry.
    const shifted = applyPatchOps({ steps: [{ type: 'notification', spec: { title: 'x' } }, entry] }, lifted.ops);
    assert.deepStrictEqual(shifted.args.steps[1].spec, { fields: [], inputs: { source: ref('trigger.output.file') } });
    assert.strictEqual(shifted.args.steps[0].spec.title, 'x');
    assert.match(shifted.applied[0], /^moved steps\[1\]\.spec\.source → steps\[1\]\.spec\.inputs\.source \(found by entry signature/);
});

test('move: a whole-element `to` is a literal position (the signature never rebinds it), and [?] there is refused', () => {
    const full = batch();
    const sig = canonicalJson(full.steps[2]);
    const r = applyPatchOps(full, [{ op: 'move', from: 'steps[?]', to: 'steps[0]', entrySig: sig }]);
    assert.deepStrictEqual(r.args.steps.map(s => s.tempId || s.type), ['notification', 'read', 'ai']);
    assert.deepStrictEqual(r.applied, ['moved steps[2] → steps[0]']);
    const bad = applyPatchOps(batch(), [{ op: 'move', from: 'steps[0]', to: 'steps[?]', entrySig: sig }]);
    assert.deepStrictEqual(bad.applied, []);
    assert.match(bad.skipped[0], /whole-element target cannot be \[\?\]/);
});

test('liftEntryPatch tolerates a missing or shapeless patch', () => {
    assert.deepStrictEqual(liftEntryPatch(null, 0, {}), { ops: [] });
    assert.deepStrictEqual(liftEntryPatch({ ops: ['junk'] }, 0, {}).ops, ['junk']);
});

// ── describePatch ────────────────────────────────────────────────────────

test('describePatch: one sentence naming each op, with the why folded in when present', () => {
    assert.strictEqual(
        describePatch({ ops: [{ op: 'set', path: 'steps[1].spec.inputs.path', value: 1 }] }),
        'A ready-made patch is attached as _suggestedPatch: set steps[1].spec.inputs.path.',
    );
    assert.strictEqual(
        describePatch({ why: 'the loop variable is f.', ops: [
            { op: 'set', path: 'a', value: 1 },
            { op: 'delete', path: 'b' },
            { op: 'move', from: 'c', to: 'd' },
            { op: 'rewrite', path: 'e', from: 'x', to: 'y' },
            { op: 'frob' },
        ] }),
        'A ready-made patch is attached as _suggestedPatch: set a, delete b, move c → d, rewrite "x" → "y" under e — the loop variable is f.',
    );
    assert.strictEqual(describePatch({ ops: [] }), '');
    assert.strictEqual(describePatch(null), '');
});

// ── parsePath ────────────────────────────────────────────────────────────

test('parsePath: the grammar, incl. a leading index and a trailing [?]', () => {
    assert.deepStrictEqual(parsePath('steps[1].spec.inputs.path'), [{ key: 'steps' }, { index: 1 }, { key: 'spec' }, { key: 'inputs' }, { key: 'path' }]);
    assert.deepStrictEqual(parsePath('[0].x'), [{ index: 0 }, { key: 'x' }]);
    assert.deepStrictEqual(parsePath('steps[?]'), [{ key: 'steps' }, { index: '?' }]);
    assert.deepStrictEqual(parsePath('a[1][2]'), [{ key: 'a' }, { index: 1 }, { index: 2 }]);
    assert.deepStrictEqual(parsePath(''), []);
    assert.strictEqual(parsePath('a[b]'), null);
    assert.strictEqual(parsePath('a.'), null);
    assert.strictEqual(parsePath(null), null);
});
