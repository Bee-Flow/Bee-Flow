// @typecheck
/**
 * "Where may this knowledge base be used?" — the surface question, which is a
 * different question from "who may read it".
 *
 * `usage_contexts` is a jsonb array on `knowledge_bases` holding some of
 * 'agent', 'direct_chat', 'ai_step', 'webpage'. It is the owner's answer to
 * "Waar inzetbaar" in the Knowledge Studio's settings: a base of interview
 * notes belongs in one automation and nowhere else, and a base of public product
 * copy belongs everywhere.
 *
 * ── IT IS NOT AN ACCESS CONTROL, AND MUST NOT BE READ AS ONE ────────
 * Who may see the CONTENT is `core/kb/kbVisibility`, checked at retrieval on
 * every surface. This decides which pickers offer the base and which links are
 * accepted. Two independent questions: a base can be attachable to an agent
 * and still refuse to answer a particular person, and the reverse. Conflating
 * them would make a surface toggle look like a permission, and somebody would
 * eventually use it as one.
 *
 * ── A MISSING VALUE MEANS EVERYTHING, NEVER NOTHING ─────────────────
 * A NULL predates the column. Every picker has always read it as "no
 * restriction was expressed", so it must not start reading as "restricted from
 * everywhere" the moment something asks — that would remove bases from
 * surfaces their owner never touched. Same for a value that will not parse:
 * the safe direction for a SURFACE question is permissive, because the
 * retrieval filter is the thing standing between a person and the content.
 */

/** Every surface a base can be offered on. 'webpage' is set by the auto-create paths, not by hand. */
const SURFACES = Object.freeze(['agent', 'direct_chat', 'ai_step', 'webpage']);

/** The three the Studio offers; 'webpage' stays hidden (auto-created bases own it). */
const EDITABLE_SURFACES = Object.freeze(['agent', 'direct_chat', 'ai_step']);

/**
 * The contexts on a KB row, or `null` when none was ever expressed.
 * The column is jsonb, but some read paths hand back the raw TEXT.
 */
function contextsOf(kb) {
    const raw = kb?.usage_contexts;
    if (raw === null || raw === undefined) return null;
    let list = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw); } catch (_) { return null; }
    }
    return Array.isArray(list) ? list.filter(v => typeof v === 'string') : null;
}

/**
 * May this base be attached to / offered on `surface`?
 * @param {object} kb        a knowledge_bases row
 * @param {string} surface   one of SURFACES
 */
function kbUsableIn(kb, surface) {
    const list = contextsOf(kb);
    if (list === null) return true;   // never expressed → everywhere, as it always was
    return list.includes(surface);
}

/** Normalise a payload's contexts to storable values, or null to leave as-is. */
function normaliseContexts(input) {
    if (!Array.isArray(input)) return null;
    const out = input.filter(v => SURFACES.includes(v));
    return out.length ? [...new Set(out)] : null;
}

module.exports = { SURFACES, EDITABLE_SURFACES, contextsOf, kbUsableIn, normaliseContexts };
