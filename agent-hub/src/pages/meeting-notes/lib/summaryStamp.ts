/**
 * WHICH TEMPLATE THIS SUMMARY WAS WRITTEN WITH — the pure half (plan M4 step 3, "Template (v4)").
 *
 * The server stamps a note when writing the summary: `summaryTemplateId` ('builtin:<key>' or the id of a saved template) and `summaryTemplateVersion`. This function turns that pair into a STATE — not a sentence. The sentence (and therefore the plural, the order, the translation) belongs in the formatting, because a key choice is not a string choice.
 *
 * ── THE VERSION COMES FROM THE NOTE, NEVER FROM THE TEMPLATE ────────
 * The template may today be at v9 while this note was written with v2. Showing the version of the ROW would be a statement about the past read off the present — precisely the silent untruth that this program keeps running into. The row supplies only the NAME.
 *
 * ── FIVE STATES, AND FOUR OF THEM PREFER TO KEEP QUIET ──────────────
 * `NONE`     the note carries no (readable) stamp — e.g. every note from before these columns, and every summary written with a one-off prompt. Show nothing. NOT "v1": inventing a version number for a note whose template you do not know is a claim that nobody ever checked.
 * `LOADING`  there is a stamp, but the template list has not yet arrived (or cannot be read). Then the name is unknown — keep quiet, and certainly do not say "no longer exists" about a template that is simply there.
 * `BUILTIN`  a built-in template. Those live in code, not in a table: there is no version, and none is invented.
 * `CUSTOM`   a saved template that the reader can still see — name from the list, version from the note.
 * `GONE`     a stamp whose template is not in the list: deleted, or no longer visible to this reader. We know WHICH version, but not which name — and then no name is guessed. Which of the two it is cannot be established here: the list is the reader's own. The sentence around it (detail/SummaryView.jsx) may therefore not claim deletion — for every shared note that was written with a personal template, the second reading is the ordinary one.
 */

import type { MeetingNote } from '../detail/meetingDetailTypes';
import type { SummaryTemplates } from '../detail/summaryTemplates.types';

export interface SummaryStamp {
    state: string;
    name: string | null;
    nameKey: string | null;
    version: number | null;
}

/** Zo markeert de server een ingebouwd sjabloon (core/meetingNotes/summaryStamp.js). */
export const BUILTIN_STAMP_PREFIX = 'builtin:';

export const SUMMARY_STAMP = Object.freeze({
    NONE: 'none',
    LOADING: 'loading',
    BUILTIN: 'builtin',
    CUSTOM: 'custom',
    GONE: 'gone',
});

const NOTHING = Object.freeze({ state: SUMMARY_STAMP.NONE, name: null, nameKey: null, version: null });

/** A usable, non-empty name? */
function nonEmpty(v: unknown): v is string {
    return typeof v === 'string' && v.trim() !== '';
}

/** A version number, or null. Anything that is not a positive integer does not count. */
function readVersion(raw: number | null | undefined): number | null {
    return Number.isInteger(raw) && (raw as number) > 0 ? (raw as number) : null;
}

/**
 * Read the stamp of a note.
 *
 * @param {object|null} meeting detail payload; only `summaryTemplateId` and `summaryTemplateVersion` are read.
 * @param {object|null} templates the answer from GET /api/summary-templates
 *        (`{ builtins, custom }`); `null`/unreadable = not yet usable.
 * @returns {{state: string, name: string|null, nameKey: string|null, version: number|null}}
 */
function builtinStamp(key: string, templates: SummaryTemplates | null | undefined): SummaryStamp {
    const builtins = Array.isArray(templates?.builtins) ? templates.builtins : null;
    // No list, no name. Keep quiet, do not guess.
    if (!builtins) return { state: SUMMARY_STAMP.LOADING, name: null, nameKey: null, version: null };
    const hit = builtins.find((b) => b && b.id === key);
    // No row, or a row without a usable name: both are "we cannot name this
    // template". Filling in an empty name would put "Template: " on the screen —
    // a sentence with a hole in it.
    if (!hit || !(nonEmpty(hit.name) || nonEmpty(hit.nameKey))) {
        return { state: SUMMARY_STAMP.GONE, name: null, nameKey: null, version: null };
    }
    // Built-in = no version, even if the note does carry one anyway.
    return {
        state: SUMMARY_STAMP.BUILTIN,
        name: nonEmpty(hit.name) ? hit.name.trim() : null,
        nameKey: nonEmpty(hit.nameKey) ? hit.nameKey.trim() : null,
        version: null,
    };
}

function customStamp(id: string, templates: SummaryTemplates | null | undefined, version: number | null): SummaryStamp {
    const custom = Array.isArray(templates?.custom) ? templates.custom : null;
    if (!custom) return { state: SUMMARY_STAMP.LOADING, name: null, nameKey: null, version };
    const hit = custom.find((c) => c && c.id === id);
    // Gone or invisible: we still know the version from the note, but not the name.
    if (!hit || !nonEmpty(hit.name)) return { state: SUMMARY_STAMP.GONE, name: null, nameKey: null, version };
    // De naam van NU (die verandert bij hernoemen zonder de tekst te raken),
    // de versie van TOEN.
    return { state: SUMMARY_STAMP.CUSTOM, name: hit.name.trim(), nameKey: null, version };
}

export function buildSummaryStamp(meeting: Pick<MeetingNote, 'summaryTemplateId' | 'summaryTemplateVersion'> | null | undefined, templates: SummaryTemplates | null | undefined): SummaryStamp {
    const raw = meeting?.summaryTemplateId;
    if (typeof raw !== 'string' || !raw.trim()) return { ...NOTHING };
    const id = raw.trim();
    const version = readVersion(meeting?.summaryTemplateVersion);

    if (!id.startsWith(BUILTIN_STAMP_PREFIX)) return customStamp(id, templates, version);
    const key = id.slice(BUILTIN_STAMP_PREFIX.length);
    if (!key) return { ...NOTHING };
    return builtinStamp(key, templates);
}
