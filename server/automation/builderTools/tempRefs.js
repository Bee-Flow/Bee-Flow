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

const TEMP_ID_RX = /^[A-Za-z][A-Za-z0-9_]{0,24}$/;

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
        if (onBareTempId) {
            const bare = /\bsteps\.(?!\$)([A-Za-z][A-Za-z0-9_]*)/g;
            let m;
            while ((m = bare.exec(value))) {
                if (Object.prototype.hasOwnProperty.call(idMap, m[1])) onBareTempId(m[1], idMap[m[1]]);
            }
        }
        return value.replace(/\bsteps\.\$([A-Za-z][A-Za-z0-9_]*)/g, (m, t) => {
            const real = idMap[t];
            if (!real) { onMissing(t); return m; }
            return `steps.${real}`;
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
 * be correct as written. It was not: measured 2026-09-16 on a live routine
 * build, the batch was refused for a bare `steps.find_invoice` and the
 * suggestion handed back carried that same bare handle plus a tempId anchor,
 * so obeying it failed for exactly the same reason and the model looped.
 *
 * Only handles present in `idMap` are touched; anything else is left as-is so
 * a genuinely unknown name still reads as unknown.
 */
function resolveHandlesForResend(value, idMap) {
    if (typeof value === 'string') {
        return value.replace(/\bsteps\.\$?([A-Za-z][A-Za-z0-9_]*)/g, (m, t) => (
            Object.prototype.hasOwnProperty.call(idMap, t) ? `steps.${idMap[t]}` : m
        ));
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
    return Object.prototype.hasOwnProperty.call(idMap, bare) ? idMap[bare] : anchor;
}

module.exports = { TEMP_ID_RX, rewriteTempRefs, resolveHandlesForResend, resolveAnchor };
