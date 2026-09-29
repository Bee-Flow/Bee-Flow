/**
 * _suggestedPatch — a rejection that carries its own fix.
 *
 * A rejected mutator rolls back whole, so the model has to re-send the call
 * with the one thing the error names changed. Measured with the fast local
 * model (2026-09-12): after "source is required" it re-sent the byte-identical
 * batch three rounds running, and a builder_update_steps fifteen times before
 * that — the error was read, the repair was not made. When the server already
 * knows the exact edit (a ref path that should be `loop.f.path`, a field that
 * belongs inside spec), it attaches that edit here as machine-readable ops.
 * The build loop applies them itself the moment the identical call comes
 * back, and says so in `_warnings`; a model that made its own edit instead is
 * left alone, because the ops then no longer match what it sent.
 *
 * Pure: no draft, no I/O. `canonicalJson` is exported because "is this the
 * same call?" needs the same answer whether the model serialised its keys in
 * the same order or not — a raw JSON.stringify signature misses a resend
 * whose only difference is key order.
 *
 * Path grammar: dotted keys with `[i]` indexes — `steps[1].spec.inputs.path`,
 * `inputs.path`, `forEach.itemVar`. `steps[?]` means "the entry whose
 * canonicalJson equals the op's entrySig": a batch resent with only the
 * entries that failed has shifted every index, and the signature is what
 * still finds the entry. A concrete index on an op that carries an entrySig
 * is checked against it for the same reason — applying a patch to whatever
 * now sits at steps[1] would be the silent coercion this module exists to
 * avoid.
 */

'use strict';

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * JSON with object keys sorted at every depth; arrays keep their order.
 * Always a string (JSON.stringify(undefined) is undefined, and a signature
 * that is sometimes not a string is a comparison that sometimes throws).
 */
function canonicalJson(value) {
    const out = JSON.stringify(value, (_k, v) => {
        if (!isPlainObject(v)) return v;
        const sorted = {};
        for (const key of Object.keys(v).sort()) sorted[key] = v[key];
        return sorted;
    });
    return out === undefined ? 'undefined' : out;
}

// Tool args come in as JSON; anything that is not a plain object or array is
// a leaf and is shared by reference (there is nothing else in a tool call).
function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (isPlainObject(v)) {
        const o = {};
        for (const [k, x] of Object.entries(v)) o[k] = clone(x);
        return o;
    }
    return v;
}

function describeType(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'missing';
    if (Array.isArray(v)) return 'an array';
    return `${/^[aeiou]/.test(typeof v) ? 'an' : 'a'} ${typeof v}`;
}

// ── Paths ────────────────────────────────────────────────────────────────

// One dotted segment: an optional key followed by any number of `[i]` / `[?]`.
const SEG_RX = /^([^.[\]]+)?((?:\[(?:\d+|\?)\])*)$/;

/** `steps[1].spec.x` → [{key:'steps'},{index:1},{key:'spec'},{key:'x'}]; null when malformed. */
function parsePath(path) {
    if (typeof path !== 'string') return null;
    if (path === '') return [];
    const tokens = [];
    for (const seg of path.split('.')) {
        const m = SEG_RX.exec(seg);
        if (!m || (!m[1] && !m[2])) return null;
        if (m[1]) tokens.push({ key: m[1] });
        for (const idx of m[2].match(/\[(\d+|\?)\]/g) || []) {
            const inner = idx.slice(1, -1);
            tokens.push({ index: inner === '?' ? '?' : Number(inner) });
        }
    }
    return tokens;
}

function renderPath(tokens) {
    let s = '';
    for (const t of tokens) s += ('key' in t) ? `${s ? '.' : ''}${t.key}` : `[${t.index}]`;
    return s;
}

function firstIndexAt(tokens) { return tokens.findIndex(t => 'index' in t); }

/**
 * Bind the FIRST index of a path to the entry the op was made for. `[?]` is
 * resolved by the entrySig; a concrete index whose entry no longer has that
 * signature is re-found by it (the batch was resent with entries dropped or
 * reordered) or refused. Done ONCE, up front, on tokens rather than during
 * the walk: a move removes `from` before it places `to`, and removing a
 * field from an entry changes that entry's signature — checking `to` after
 * the removal refused every lifted move.
 * Returns { tokens, note } (tokens concretised) or { reason }.
 */
function bindEntry(root, tokens, entrySig) {
    const at = firstIndexAt(tokens);
    if (at < 0) return { tokens, note: '' };
    const prefix = renderPath(tokens.slice(0, at)) || 'args';
    // One signature, or the two shapes a legitimate identical resend can
    // take (see liftEntryPatch). Measured: the resend that obeyed resendAs
    // was counted as a repeat by the ladder but the patch skipped it — the
    // op was signed on the raw entry only — so the repair landed one round
    // late, behind a hint that printed the same unfixed call back.
    const sigs = typeof entrySig === 'string' ? [entrySig]
        : Array.isArray(entrySig) ? entrySig.filter(s => typeof s === 'string') : [];
    if (!sigs.length) {
        if (tokens[at].index === '?') return { reason: `${prefix}[?] needs an entrySig on the op` };
        return { tokens, note: '' };
    }
    let cur = root;
    for (let i = 0; i < at; i++) {
        if (!isPlainObject(cur)) return { reason: `${renderPath(tokens.slice(0, i)) || 'args'} is ${describeType(cur)}, not an object` };
        cur = cur[tokens[i].key];
    }
    if (!Array.isArray(cur)) return { reason: `${prefix} is ${describeType(cur)}, not an array` };
    const found = cur.findIndex(e => sigs.includes(canonicalJson(e)));
    const want = tokens[at].index;
    let note = '';
    if (want === '?') {
        if (found < 0) return { reason: `no entry of ${prefix} matches the op's entrySig` };
    } else if (want >= cur.length || !sigs.includes(canonicalJson(cur[want]))) {
        if (found < 0) return { reason: `${prefix}[${want}] is not the entry this patch was made for, and no entry of ${prefix} matches its signature` };
        note = ` (found by entry signature — it is no longer at ${prefix}[${want}])`;
    } else {
        return { tokens, note };
    }
    const bound = tokens.slice();
    bound[at] = { index: found };
    return { tokens: bound, note };
}

/**
 * Walk `root` to the parent of the last token. Returns { parent, slot, path }
 * or { reason }. With `create`, missing intermediates are made (an object,
 * or an array when the next token is an index) and an array slot equal to
 * its length is allowed — that is an append. Nothing that exists with the
 * wrong shape is ever replaced: a string where an object is needed is a
 * reason, not a coercion. Every `[?]` must have been bound already.
 */
function locate(root, tokens, { create = false } = {}) {
    if (!tokens.length) return { reason: 'the path is empty' };
    let cur = root;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const last = i === tokens.length - 1;
        const here = renderPath(tokens.slice(0, i)) || 'args';
        let slot;
        if ('key' in t) {
            if (!isPlainObject(cur)) return { reason: `${here} is ${describeType(cur)}, not an object` };
            slot = t.key;
        } else {
            if (!Array.isArray(cur)) return { reason: `${here} is ${describeType(cur)}, not an array` };
            if (t.index === '?') return { reason: `${here}[?] — only the first index of a path can be resolved by the entrySig` };
            slot = t.index;
            if (slot > cur.length || (slot === cur.length && !create)) return { reason: `${here}[${slot}] is out of range (${cur.length} ${cur.length === 1 ? 'entry' : 'entries'})` };
        }
        if (last) return { parent: cur, slot, path: renderPath(tokens) };
        let next = cur[slot];
        if (next === undefined || next === null) {
            if (!create) return { reason: `nothing at ${renderPath(tokens.slice(0, i + 1))}` };
            next = ('key' in tokens[i + 1]) ? {} : [];
            cur[slot] = next;
        }
        cur = next;
    }
    return { reason: 'unreachable' };
}

// Parse + bind in one go for the single-path ops.
function resolve(root, path, entrySig, opts) {
    const tokens = parsePath(path);
    if (!tokens) return { reason: `malformed path ${JSON.stringify(path)}` };
    const b = bindEntry(root, tokens, entrySig);
    if (b.reason) return b;
    const at = locate(root, b.tokens, opts);
    if (at.reason) return at;
    return { ...at, note: b.note };
}

function exists(parent, slot) {
    return Array.isArray(parent) ? slot < parent.length : Object.prototype.hasOwnProperty.call(parent, slot);
}

function removeAt(parent, slot) {
    if (Array.isArray(parent)) return parent.splice(slot, 1)[0];
    const v = parent[slot];
    delete parent[slot];
    return v;
}

// Values are shown, not just named — "set inputs.path" tells the model less
// than what it was set to — but a whole spec would drown the line.
const VALUE_CAP = 160;
function short(value) {
    const s = canonicalJson(value);
    return s.length > VALUE_CAP ? `${s.slice(0, VALUE_CAP - 1)}…` : s;
}

// Literal replace-all: String.prototype.replaceAll reads `$&`-style patterns
// in the replacement, and ref paths are full of `$handles`.
function rewriteStrings(v, from, to, counter) {
    if (typeof v === 'string') {
        if (!v.includes(from)) return v;
        counter.n += 1;
        return v.split(from).join(to);
    }
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) v[i] = rewriteStrings(v[i], from, to, counter);
        return v;
    }
    if (isPlainObject(v)) {
        for (const k of Object.keys(v)) v[k] = rewriteStrings(v[k], from, to, counter);
        return v;
    }
    return v;
}

function opLabel(op, n) {
    if (!isPlainObject(op)) return `op #${n}`;
    switch (op.op) {
        case 'set':
        case 'delete': return `${op.op} ${op.path}`;
        case 'move': return `move ${op.from} → ${op.to}`;
        case 'rewrite': return `rewrite ${op.path === undefined || op.path === '' ? 'args' : op.path}`;
        default: return `op #${n}`;
    }
}

// ── The ops ──────────────────────────────────────────────────────────────

function applySet(root, op) {
    if (!('value' in op) || op.value === undefined) return { reason: 'set needs a value (use delete to remove one)' };
    const at = resolve(root, op.path, op.entrySig, { create: true });
    if (at.reason) return at;
    at.parent[at.slot] = clone(op.value);
    return { line: `${at.path} = ${short(op.value)}${at.note}` };
}

function applyDelete(root, op) {
    const at = resolve(root, op.path, op.entrySig);
    if (at.reason) return at;
    if (!exists(at.parent, at.slot)) return { reason: `nothing at ${at.path}` };
    removeAt(at.parent, at.slot);
    return { line: `deleted ${at.path}${at.note}` };
}

/**
 * Remove at `from`, insert at `to`. Between two positions of one array this
 * is a reorder with `to` as the FINAL index (steps[0] → steps[2] on [a,b,c]
 * gives [b,c,a]); into an object key it is a rename/relocation, refused when
 * the key is taken. Both paths are bound to the entry BEFORE the removal
 * (see bindEntry); `to` is then located after it, so an array index counts
 * the array as it then is. When `to` cannot be placed the value goes back.
 *
 * A `to` that ends at its first index is a whole-element position and is
 * taken literally; a `to` that continues past it, inside the same array as
 * `from`, means "inside the same entry" and takes `from`'s binding.
 */
function applyMove(root, op) {
    const fromTokens = parsePath(op.from);
    const toTokens = parsePath(op.to);
    if (!fromTokens) return { reason: `malformed path ${JSON.stringify(op.from)}` };
    if (!toTokens) return { reason: `malformed path ${JSON.stringify(op.to)}` };
    const bf = bindEntry(root, fromTokens, op.entrySig);
    if (bf.reason) return bf;
    const fi = firstIndexAt(bf.tokens);
    const ti = firstIndexAt(toTokens);
    let bt = { tokens: toTokens, note: '' };
    const sameArray = fi >= 0 && ti === fi && renderPath(toTokens.slice(0, ti)) === renderPath(bf.tokens.slice(0, fi));
    if (ti >= 0 && toTokens.length === ti + 1) {
        if (toTokens[ti].index === '?') return { reason: `${op.to}: a whole-element target cannot be [?] — give the final index` };
    } else if (sameArray && (typeof op.entrySig === 'string' || Array.isArray(op.entrySig))) {
        const bound = toTokens.slice();
        bound[ti] = bf.tokens[fi];
        bt = { tokens: bound, note: '' };
    } else {
        bt = bindEntry(root, toTokens, op.entrySig);
        if (bt.reason) return bt;
    }
    const src = locate(root, bf.tokens);
    if (src.reason) return src;
    if (!exists(src.parent, src.slot)) return { reason: `nothing at ${src.path}` };
    const value = removeAt(src.parent, src.slot);
    const restore = () => {
        if (Array.isArray(src.parent)) src.parent.splice(src.slot, 0, value);
        else src.parent[src.slot] = value;
    };
    const dst = locate(root, bt.tokens, { create: true });
    if (dst.reason) { restore(); return dst; }
    if (Array.isArray(dst.parent)) {
        dst.parent.splice(dst.slot, 0, value);
    } else {
        if (exists(dst.parent, dst.slot)) { restore(); return { reason: `${dst.path} already exists — a move never overwrites` }; }
        dst.parent[dst.slot] = value;
    }
    return { line: `moved ${src.path} → ${dst.path}${bf.note || bt.note}` };
}

function applyRewrite(root, op) {
    if (typeof op.from !== 'string' || !op.from) return { reason: 'rewrite needs a non-empty string `from`' };
    if (typeof op.to !== 'string') return { reason: 'rewrite needs a string `to`' };
    const path = op.path === undefined ? '' : op.path;
    const counter = { n: 0 };
    let where = 'args';
    let note = '';
    if (path === '') {
        rewriteStrings(root, op.from, op.to, counter);
    } else {
        const at = resolve(root, path, op.entrySig);
        if (at.reason) return at;
        if (!exists(at.parent, at.slot)) return { reason: `nothing at ${at.path}` };
        at.parent[at.slot] = rewriteStrings(at.parent[at.slot], op.from, op.to, counter);
        where = at.path;
        note = at.note;
    }
    if (!counter.n) return { reason: `no string under ${where} contains ${JSON.stringify(op.from)}` };
    return { line: `rewrote ${JSON.stringify(op.from)} → ${JSON.stringify(op.to)} in ${counter.n} ${counter.n === 1 ? 'string' : 'strings'} under ${where}${note}` };
}

const APPLY = { set: applySet, delete: applyDelete, move: applyMove, rewrite: applyRewrite };

/**
 * Apply `ops` (an array, or a { ops } patch) to a deep clone of `args`.
 * Returns { args, applied, skipped }: one human line per op that landed, one
 * `label: reason` line per op that did not. Never throws — a bad op is a
 * skipped line, because this runs inside the tool loop where a throw would
 * turn a helpful patch into a 500 for a call that was otherwise fine.
 */
function applyPatchOps(args, ops) {
    const list = Array.isArray(ops) ? ops : (Array.isArray(ops?.ops) ? ops.ops : []);
    const next = clone(args);
    const applied = [];
    const skipped = [];
    const rootOk = isPlainObject(next) || Array.isArray(next);
    list.forEach((op, n) => {
        const label = opLabel(op, n + 1);
        if (!isPlainObject(op)) { skipped.push(`${label}: not an object`); return; }
        const fn = APPLY[op.op];
        if (!fn) { skipped.push(`${label}: unknown op ${JSON.stringify(op.op)} (set, delete, move, rewrite)`); return; }
        if (!rootOk) { skipped.push(`${label}: args is ${describeType(next)}, nothing to patch`); return; }
        let r;
        try { r = fn(next, op); } catch (e) { r = { reason: `internal: ${e && e.message ? e.message : e}` }; }
        if (r.reason) skipped.push(`${label}: ${r.reason}`);
        else applied.push(r.line);
    });
    return { args: next, applied, skipped };
}

// ── Building patches ─────────────────────────────────────────────────────

/**
 * A per-type builder describes its fix relative to its own args (`inputs.path`).
 * Inside builder_add_steps those args are `steps[i].spec`, so the paths are
 * prefixed and the entry is signed — the signature is what still finds the
 * entry when the batch comes back with a different shape. Paths already
 * rooted at `steps[` are left alone; a rewrite without a path scopes to the
 * entry's spec rather than the whole batch. `from`/`to` are lifted only on a
 * move (on a rewrite they are strings, not paths).
 *
 * A batch resend repeats EITHER the raw entry (the whole batch again) OR the
 * entry the partial result handed back as `resendAs` (real ids, anchored) —
 * the ladder's isRepeat accepts both, so the op is signed on both. When the
 * two shapes coincide (no anchor was added, no handle rewritten) the sig
 * stays a plain string.
 */
function liftEntryPatch(patch, i, entry, resendEntry) {
    const prefix = `steps[${i}].spec`;
    const lift = (p) => {
        if (typeof p !== 'string') return p;
        if (p.startsWith('steps[')) return p;
        if (p === '') return prefix;
        return p.startsWith('[') ? `${prefix}${p}` : `${prefix}.${p}`;
    };
    const rawSig = canonicalJson(entry);
    const resendSig = resendEntry === undefined ? rawSig : canonicalJson(resendEntry);
    const entrySig = resendSig === rawSig ? rawSig : [rawSig, resendSig];
    const ops = (Array.isArray(patch?.ops) ? patch.ops : []).map((op) => {
        if (!isPlainObject(op)) return op;
        const out = { ...op, entrySig };
        if (op.op === 'move') { out.from = lift(op.from); out.to = lift(op.to); }
        else out.path = lift(op.op === 'rewrite' && op.path === undefined ? '' : op.path);
        return out;
    });
    return { ...(isPlainObject(patch) ? patch : {}), ops };
}

function opSummary(op) {
    if (!isPlainObject(op)) return null;
    switch (op.op) {
        case 'set':
        case 'delete': return `${op.op} ${op.path}`;
        case 'move': return `move ${op.from} → ${op.to}`;
        case 'rewrite': return `rewrite ${JSON.stringify(op.from)} → ${JSON.stringify(op.to)} under ${op.path === undefined || op.path === '' ? 'args' : op.path}`;
        default: return null;
    }
}

/** One sentence for the model; '' for a patch with nothing in it. */
function describePatch(patch) {
    const parts = (Array.isArray(patch?.ops) ? patch.ops : []).map(opSummary).filter(Boolean);
    if (!parts.length) return '';
    const why = typeof patch.why === 'string' && patch.why.trim() ? ` — ${patch.why.trim().replace(/\.+$/, '')}` : '';
    return `A ready-made patch is attached as _suggestedPatch: ${parts.join(', ')}${why}.`;
}

module.exports = { canonicalJson, applyPatchOps, liftEntryPatch, describePatch, parsePath };
