// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One key, one sentence.
 *
 * The ISO tabs route every failure through `_isoMutate(…, errKey, errFallback)`,
 * which does call `t(errKey, errFallback)` properly. The bug was upstream of
 * that: FOUR call sites shared `compliance.risk_toast_failed` while passing
 * three DIFFERENT English sentences ("Could not save the risk" / "…the
 * treatment" / "Could not seed risks"), and `compliance.obl_toast_failed`
 * carried two. Nothing was wrong until the key landed in the dictionary — at
 * which point the dictionary value wins over the fallback (useTranslation.jsx),
 * and "Could not seed risks" would have silently become "Could not save the
 * risk" on screen.
 *
 * The i18n guard cannot catch this: its helper regex is `\b(helper)\(([^()]*)\)`
 * and `[^()]*` cannot cross the nested `() => fetchJson(...)` argument these
 * call sites all carry, so it sees exactly one of the four.
 *
 * Reading the source is the point — the claim is about every call site in the
 * file, including ones no rendered test would reach.
 */
// The redesign moved the handlers out of index.jsx into data/*.js (the hooks);
// the claim is about every call site, so the scan covers the whole data
// folder plus the hub file.
const SRC = [
    path.join(__dirname, 'index.jsx'),
    ...fs.readdirSync(path.join(__dirname, 'data')).filter(f => /\.jsx?$/.test(f) && !/\.test\./.test(f)).map(f => path.join(__dirname, 'data', f)),
].map(f => fs.readFileSync(f, 'utf8')).join('\n');

/** Every `'compliance.some_key', 'Some English'` pair, whichever call it sits in. */
function keyFallbackPairs(src) {
    const rx = /'(compliance\.[A-Za-z0-9_.]+)',\s*\n?\s*'((?:[^'\\]|\\.)*)'/g;
    const out = [];
    for (const m of src.matchAll(rx)) out.push({ key: m[1], en: m[2] });
    return out;
}

describe('compliance toast keys', () => {
    it('never gives one key two different English sentences', () => {
        const byKey = new Map();
        for (const { key, en } of keyFallbackPairs(SRC)) {
            if (!byKey.has(key)) byKey.set(key, new Set());
            byKey.get(key).add(en);
        }
        const clashes = [...byKey].filter(([, vals]) => vals.size > 1)
            .map(([key, vals]) => `${key}: ${[...vals].join(' | ')}`);
        expect(clashes).toEqual([]);
    });

    it('the four ISO failure toasts each carry their own key and sentence', () => {
        // Named explicitly so a future edit that folds two of them back
        // together fails here with the sentence it would have swallowed.
        const pairs = keyFallbackPairs(SRC);
        const enOf = (key) => [...new Set(pairs.filter(p => p.key === key).map(p => p.en))];
        expect(enOf('compliance.risk_toast_failed')).toEqual(['Could not save the risk']);
        expect(enOf('compliance.risk_treatment_toast_failed')).toEqual(['Could not save the treatment']);
        expect(enOf('compliance.risk_seed_toast_failed')).toEqual(['Could not seed risks']);
        expect(enOf('compliance.audit_toast_failed')).toEqual(['Could not save — try again']);
        expect(enOf('compliance.training_toast_failed')).toEqual(['Could not record the attestation']);
        expect(enOf('compliance.obl_toast_failed')).toEqual(['Could not save the obligation']);
        expect(enOf('compliance.obl_complete_toast_failed')).toEqual(['Could not complete the obligation']);
    });

    it('leaves the scc / dpia / incident toasts exactly as they were', () => {
        // These three already had their keys in both dictionaries; renaming or
        // resplitting them would orphan a landed translation.
        const pairs = keyFallbackPairs(SRC);
        const enOf = (key) => [...new Set(pairs.filter(p => p.key === key).map(p => p.en))];
        expect(enOf('compliance.scc_toast_failed')).toEqual(['Could not update the SCC attestation']);
        expect(enOf('compliance.dpia_toast_failed')).toEqual(['Could not save the DPIA']);
        expect(enOf('compliance.inc_toast_failed')).toEqual(['Could not save the incident']);
    });
});
