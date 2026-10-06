/**
 * `steps.$handle` — call-local handles that resolve to real step ids.
 *
 * Shared by builder_add_steps (tempIds across a batch) and builder_add_loop
 * (ids across a loop body). The model learns the `$handle` idiom from the
 * batch tool and, measured on real builds, carries it into loop bodies —
 * where it used to be stored verbatim and surface a round later as
 * `ref.unknown_step` on an `lb_…` id the model had never been shown. One
 * resolver, so both places agree on what a handle is and how it fails.
 */

const { readPath } = require('../expr');
const { rewriteRefPath } = require('../stepIdRewrite');

const TEMP_ID_RX = /^[A-Za-z][A-Za-z0-9_]{0,24}$/;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// What may sit right before `steps` for it to START a path rather than be the
// tail of a longer name or a member (`vars.steps.x`, `my_steps.x`). A run of
// `$` or `.` directly before `steps` is the model's own dialect
// (`$steps.$calc…`, `.steps.$calc…`, which aiPaths.js strips) and is looked
// past: the test applies to the character before that run.
const NOT_A_START = /[\p{L}\p{N}\p{M}_$@.\-\]]/u;

function startsAPath(text, i) {
    let j = i;
    while (j > 0 && (text[j - 1] === '$' || text[j - 1] === '.')) j--;
    return j === 0 || !NOT_A_START.test(text[j - 1]);
}

/**
 * Every step address in a piece of text (`steps.<id>`, `steps["<id>"]`,
 * `steps['<id>']`), read with the runner's path reader wherever it sits — a
 * ref path, a `{{ }}` placeholder, an expression, prose — and handed to
 * `rename(id)`. A string it returns replaces the id; only that token changes
 * (stepIdRewrite.rewriteRefPath keeps the spelling and the rest of the path).
 *
 * The handle resolver used to find `steps.$x` with a regex, so the bracket
 * spelling of a handle was stored verbatim and dangled, and `vars.steps.$x`
 * (a member called `steps`) was rewritten as if it addressed a step.
 */
function mapStepIds(text, rename) {
    if (!text.includes('steps')) return text;
    let out = '';
    let last = 0;
    let i = text.indexOf('steps');
    while (i >= 0) {
        let next = i + 5;
        if (startsAPath(text, i)) {
            // Read from `steps` itself: only the id token changes, a leading
            // `$`/`.` stays for bindings and the template repair to strip.
            const r = readPath(text, i);
            const idTok = r && r.tokens[0].key === 'steps' ? r.tokens[1] : null;
            if (idTok && idTok.type === 'prop') {
                const id = String(idTok.key);
                const to = rename(id);
                if (typeof to === 'string' && to && to !== id) {
                    const seg = text.slice(i, r.end);
                    const map = Object.create(null);
                    map[id] = to;
                    const rewritten = rewriteRefPath(seg, map);
                    if (rewritten !== seg) {
                        out += text.slice(last, i) + rewritten;
                        last = r.end;
                    }
                }
                next = Math.max(next, r.end);
            }
        }
        i = text.indexOf('steps', next);
    }
    return last ? out + text.slice(last) : text;
}

/**
 * Deep-rewrite `steps.$tempId` → `steps.<realId>` in every string of a spec
 * (covers ref paths, {{template}} bodies, exprs, forEach.overRef, arrayRef —
 * one uniform transform). `onMissing` fires for a $tempId that is not an
 * EARLIER entry's handle (forward ref / typo).
 */
function rewriteTempRefs(value, idMap, onMissing, onBareTempId) {
    if (typeof value === 'string') {
        // A BARE tempId — `steps.foo` where `foo` is a handle from this very
        // batch — used to pass through untouched and unwarned, because only
        // `steps.$foo` is rewritten. The step was then minted as `foo_<hash>`
        // and the dangling ref surfaced a round later as ref.unknown_step, far
        // from the call that caused it. The handles are right here in idMap, so
        // say so now.
        return mapStepIds(value, (id) => {
            if (!id.startsWith('$')) {
                if (onBareTempId && hasOwn(idMap, id)) onBareTempId(id, idMap[id]);
                return null;
            }
            const t = id.slice(1);
            const real = hasOwn(idMap, t) ? idMap[t] : null;
            if (!real) onMissing(t);
            return real;
        });
    }
    if (Array.isArray(value)) return value.map(v => rewriteTempRefs(v, idMap, onMissing, onBareTempId));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = rewriteTempRefs(v, idMap, onMissing, onBareTempId);
        return out;
    }
    return value;
}

/**
 * Resolve EVERY handle a resend suggestion carries — `steps.$foo` AND the bare
 * `steps.foo` — to the id that entry was actually minted as.
 *
 * `rewriteTempRefs` deliberately leaves a bare handle alone and only reports
 * it: in a real call that is the model's mistake to fix, and rewriting it
 * silently would teach the wrong syntax. A `resendAs` suggestion is the
 * opposite case — it is the SERVER saying "send exactly this" — so it has to
 * be correct as written. It was not: measured 2026-09-16 on a live automation
 * build, the batch was refused for a bare `steps.find_invoice` and the
 * suggestion handed back carried that same bare handle plus a tempId anchor,
 * so obeying it failed for exactly the same reason and the model looped.
 *
 * Only handles present in `idMap` are touched; anything else is left as-is so
 * a genuinely unknown name still reads as unknown.
 */
function resolveHandlesForResend(value, idMap) {
    if (typeof value === 'string') {
        return mapStepIds(value, (id) => {
            const t = id.startsWith('$') ? id.slice(1) : id;
            return hasOwn(idMap, t) ? idMap[t] : null;
        });
    }
    if (Array.isArray(value)) return value.map(v => resolveHandlesForResend(v, idMap));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = resolveHandlesForResend(v, idMap);
        return out;
    }
    return value;
}

/** A step id or handle as the resend should name it: minted id where known. */
function resolveAnchor(anchor, idMap) {
    if (typeof anchor !== 'string' || !anchor) return anchor;
    const bare = anchor.startsWith('$') ? anchor.slice(1) : anchor;
    return hasOwn(idMap, bare) ? idMap[bare] : anchor;
}

module.exports = { TEMP_ID_RX, rewriteTempRefs, resolveHandlesForResend, resolveAnchor };
