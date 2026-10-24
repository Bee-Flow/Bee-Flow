// @typecheck
'use strict';

/**
 * Which template wrote THIS note, and which version of it.
 *
 * Two columns carry that fact: `transcriptions.summary_template_id` and
 * `transcriptions.summary_template_version`. This file is the only place where the shape of those two
 * values is determined; routes and the ingest call it, and nobody builds the pair by hand.
 *
 * ── WHY THE VERSION IS STORED ALONG ─────────────────────────────────
 * Storing only the id would seem to suffice: the version is after all looked up from the template. But that
 * is an assertion about the PAST, read off the PRESENT: a template that was updated after the summary is at
 * v5 today while the note was written with v2. The screen would then say "made with v5" about text that v5
 * never saw. The version therefore belongs to the note, stamped at the moment of writing.
 *
 * ── WHY A PREFIX FOR THE BUILT-IN TEMPLATES ─────────────────────────
 * A stored template has a UUID, a built-in one a readable key ('general', 'standup', …). Without a marker the
 * reader must guess from the FORM of the id which of the two it is: a UUID regex as semantics. With
 * `builtin:` it is simply there, and `parseStamp` returns the answer instead of a guess. Unknown stays unknown:
 * an id that has neither form yields null, not "then built-in after all".
 *
 * ── NOTHING IS ALSO AN ANSWER ───────────────────────────────────────
 * A one-off prompt ("try this", not saved) must NOT get a stamp, and it must precisely ERASE an old stamp: the
 * summary that is there now is not that of the previous template any more. `EMPTY_STAMP` is for that; it is an
 * explicit value, not "leave the fields out".
 */

const { BUILTIN_BY_ID } = require('./summaryTemplates');

const BUILTIN_STAMP_PREFIX = 'builtin:';

/** No template (one-off prompt). ERASES an earlier stamp: see the header. */
const EMPTY_STAMP = Object.freeze({ summaryTemplateId: null, summaryTemplateVersion: null });

/**
 * Stamp for a built-in template. An unknown key falls back, just like `builtinPrompt`, to 'general', and
 * the stamp then names 'general' too: the note was written with that prompt, so that is what it says.
 */
function stampForBuiltin(templateId) {
    const resolved = BUILTIN_BY_ID[templateId] ? templateId : 'general';
    return { summaryTemplateId: BUILTIN_STAMP_PREFIX + resolved, summaryTemplateVersion: null };
}

/**
 * Stamp for a stored template (row from summaryTemplateStore).
 * A row without a usable `version` (an old installation where the column was still empty) gives `null`:
 * not an invented 1. Then we know the id but not the version, and that difference must be visible on the screen.
 */
function stampForTemplate(template) {
    if (!template || typeof template.id !== 'string' || !template.id) return { ...EMPTY_STAMP };
    const v = Number(template.version);
    return {
        summaryTemplateId: template.id,
        summaryTemplateVersion: Number.isInteger(v) && v > 0 ? v : null,
    };
}

/**
 * Lees een opgeslagen stempel terug.
 * @returns {{kind: 'builtin'|'custom', key: string} | null} null = niets of onleesbaar.
 */
function parseStamp(summaryTemplateId) {
    if (typeof summaryTemplateId !== 'string') return null;
    const raw = summaryTemplateId.trim();
    if (!raw) return null;
    if (raw.startsWith(BUILTIN_STAMP_PREFIX)) {
        const key = raw.slice(BUILTIN_STAMP_PREFIX.length);
        return key ? { kind: 'builtin', key } : null;
    }
    return { kind: 'custom', key: raw };
}

module.exports = {
    BUILTIN_STAMP_PREFIX,
    EMPTY_STAMP,
    stampForBuiltin,
    stampForTemplate,
    parseStamp,
};
