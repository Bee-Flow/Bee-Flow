/**
 * App Studio canonicalizer — the id allocator: one pass hands out every final
 * id and records the old → new renames pass 2 rewrites references with.
 */

'use strict';

const { ID_RE, newId } = require('../componentSpecs');

// ---------------------------------------------------------------------------
// Ids — generate/replace with global uniqueness, tracking old → new renames
// so references can be rewritten when the old value was unambiguous.
// ---------------------------------------------------------------------------

function makeIdAllocator(push) {
    const seen = new Set();          // every FINAL id handed out
    const renameMap = new Map();     // invalid old id → generated id (unambiguous only)
    const ambiguousOld = new Set();  // invalid old ids used more than once

    function fresh(kind) {
        let id;
        do { id = newId(kind); } while (seen.has(id));
        seen.add(id);
        return id;
    }

    function canonId(raw, kind, path) {
        if (typeof raw === 'string' && ID_RE.test(raw)) {
            if (!seen.has(raw)) { seen.add(raw); return raw; }
            // Duplicate of a valid id: re-key this later occurrence. References
            // keep pointing at the first occurrence — rewriting is ambiguous.
            const id = fresh(kind);
            push('id.duplicate', path, `Duplicate id "${raw}" — this occurrence was re-keyed to "${id}". References to "${raw}" still resolve to the first occurrence.`);
            return id;
        }
        const id = fresh(kind);
        if (typeof raw === 'string' && raw) {
            if (renameMap.has(raw) || ambiguousOld.has(raw)) {
                renameMap.delete(raw);
                ambiguousOld.add(raw);
                push('id.duplicate', path, `Invalid id ${JSON.stringify(raw)} was used by multiple entities — references to it cannot be rewritten unambiguously.`);
                push('id.generated', path, `Invalid id ${JSON.stringify(raw)} replaced with "${id}".`);
            } else {
                renameMap.set(raw, id);
                push('id.generated', path, `Invalid id ${JSON.stringify(raw)} replaced with "${id}"; references to the old value are rewritten.`);
            }
        } else {
            push('id.generated', path, `Missing id — generated "${id}".`);
        }
        return id;
    }

    return { canonId, renameMap, seen };
}

module.exports = { makeIdAllocator };
