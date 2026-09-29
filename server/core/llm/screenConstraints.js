// @typecheck
/**
 * What the person said about the app's SCREENS, read off their own words and
 * turned into something the server enforces.
 *
 * "Only a dashboard", "one screen", "no detail page" — the designer prompt has
 * asked the model to honour such sentences since 2026-09-16, and a small model
 * still adds a detail screen now and then: its own guideline says a detail
 * screen is good practice, and a rule in prose loses to a habit. So the intent
 * is derived HERE, deterministically, from the description the person typed
 * (and the goal/brief the composer wrote from it), then (1) stated to the
 * designer as a binding line, (2) applied to the design that comes back — an
 * extra screen is folded into the first one, detail elements are dropped — and
 * (3) repeated to the app builder in the design block. Doctrine: repair
 * server-side, never rely on the model reading prose.
 *
 * Pure module: no model, no store. Dutch and English, the two demo languages.
 * Lives in core/llm because two features read it — playbooks (composer,
 * designer) and App Studio (the add-screen guard) — and features may not
 * require each other (layering.test.js).
 */

'use strict';

const NUMBER_WORDS = {
    one: 1, single: 1, a: 1, '1': 1, een: 1, één: 1, enkel: 1, enkele: 1,
    two: 2, '2': 2, twee: 2, three: 3, '3': 3, drie: 3, four: 4, '4': 4, vier: 4, five: 5, '5': 5, vijf: 5,
};

const SCREEN_WORD = '(?:screens?|pages?|schermen|scherm|pagina\'?s|pagina|views?|weergaven?)';

// "only/just/alleen/enkel/slechts … dashboard|overview|screen|page" — a
// single-screen ask. The gap lets "only a data insight dashboard" through.
const ONLY_ONE_RE = /\b(?:only|just|alleen|enkel|slechts|uitsluitend|louter)\b[^.\n;]{0,60}?\b(?:dashboard|overzicht|overview|scherm|screen|pagina|page)\b/i;
// "dashboard only", "dashboard alleen".
const DASHBOARD_ONLY_RE = /\bdashboard\s+(?:only|alleen)\b/i;
// "one screen", "a single screen", "één scherm", "one-page", "op één scherm".
const SINGLE_RE = /\b(?:one|single|1|één|een\s+enkel|enkel\s+één)[\s-]+(?:screen|page|scherm|pagina|view|weergave)\b/i;
const ON_ONE_RE = /\b(?:on|op)\s+(?:one|a\s+single|één|een)\s+(?:screen|page|scherm|pagina)\b/i;
// "no/without (a) detail page|screen|view", "geen detailpagina/detailscherm".
const NO_DETAIL_RE = /\b(?:no|without|geen|zonder|never|nooit)\s+(?:a\s+|an\s+|een\s+)?(?:details?\s*-?\s*(?:page|screen|view|pagina|scherm|weergave)|detailpagina|detailscherm|detailweergave|record\s+(?:page|screen|view)|drill-?down)/i;
// A detail screen asked for in so many words wins over "only a dashboard" —
// "with a detail page", and on a revision "add a detail screen".
const DETAIL_WORD = '(?:details?\\s*-?\\s*(?:page|screen|view|pagina|scherm|weergave)|detailpagina|detailscherm|detailweergave|record\\s+(?:page|screen|view)|drill-?down)';
const WANTS_DETAIL_RE = new RegExp(`\\b(?:with|met|and|en|plus|including|inclusief|also|ook)\\s+(?:a\\s+|an\\s+|een\\s+)?${DETAIL_WORD}`, 'i');
const ASKS_DETAIL_RE = new RegExp(`\\b(?:add|create|make|include|want|need|give|voeg|maak|wil|graag|toevoegen)\\b[^.\\n;]{0,40}?\\b${DETAIL_WORD}`, 'i');
// "two screens", "drie schermen", "3 pages" — an explicit count.
const COUNT_RE = new RegExp(`\\b(one|single|1|een|één|two|2|twee|three|3|drie|four|4|vier|five|5|vijf)\\s+${SCREEN_WORD}\\b`, 'i');

/**
 * @param {...(string|null|undefined)} texts  the person's ask first, then the
 *   goal/brief written from it — the first text that states a constraint wins,
 *   and a text that says nothing leaves the answer to the next one.
 * @returns {{ screens: number|null, exact: boolean, noDetail: boolean, source: string }|null}
 *   null when nobody said anything about screens.
 */
function deriveScreenConstraints(...texts) {
    for (const raw of texts) {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (!text) continue;
        const found = readOne(text);
        if (found) return found;
    }
    return null;
}

function readOne(text) {
    const wantsDetail = WANTS_DETAIL_RE.test(text) || ASKS_DETAIL_RE.test(text);
    const noDetail = !wantsDetail && NO_DETAIL_RE.test(text);
    let screens = null;
    const count = text.match(COUNT_RE);
    if (count) {
        const n = NUMBER_WORDS[count[1].toLowerCase()];
        if (Number.isFinite(n)) screens = n;
    }
    if (screens === null && (SINGLE_RE.test(text) || ON_ONE_RE.test(text) || DASHBOARD_ONLY_RE.test(text) || ONLY_ONE_RE.test(text))) screens = 1;
    // "Only a dashboard, with a detail page" — the detail page was asked for.
    if (screens === 1 && wantsDetail) screens = 2;
    // A detail screen asked for and nothing else said: not a constraint, but
    // an ANSWER — it stops an earlier "only a dashboard" from carrying over.
    if (screens === null && !noDetail && !wantsDetail) return null;
    const evidence = (count && count[0]) || (text.match(SINGLE_RE) || text.match(ON_ONE_RE) || text.match(DASHBOARD_ONLY_RE) || text.match(ONLY_ONE_RE) || text.match(NO_DETAIL_RE) || text.match(WANTS_DETAIL_RE) || text.match(ASKS_DETAIL_RE) || [''])[0];
    return { screens, exact: screens !== null, noDetail, wantsDetail, source: String(evidence).trim().slice(0, 80) };
}

/** True when the constraint actually binds something (a count or no-detail). */
function isBinding(c) {
    return !!c && (c.exact || c.noDetail);
}

/**
 * The constraint as a model-facing sentence (English: the builders' and the
 * designer's instruction language; only labels follow the person's language).
 */
function describeScreenConstraints(c) {
    if (!isBinding(c)) return '';
    const parts = [];
    if (c.exact && c.screens === 1) parts.push('exactly ONE screen — everything the person needs lives on that single screen; never add a second screen, a detail screen or a navigation to another screen');
    else if (c.exact && c.screens > 1) parts.push(`exactly ${c.screens} screens — never more, never fewer`);
    if (c.noDetail && !(c.exact && c.screens === 1)) parts.push('no detail screen and no record/drill-down screen — the record\'s fields belong on the list itself');
    return parts.length ? `SCREENS (binding, from the person's own words "${c.source}"): ${parts.join('; ')}.` : '';
}

/**
 * The design after the constraint. Extra screens are folded INTO the first
 * screen rather than thrown away — "one screen" means one screen with
 * everything on it — and detail elements go when none was wanted.
 *
 * @returns {{ design: object, changes: string[] }}  `changes` is empty when
 *   the design already complied; each entry is a short past-tense note.
 */
function applyScreenConstraints(design, c, { maxSections = 6 } = {}) {
    if (!design || !Array.isArray(design.screens) || !isBinding(c)) return { design, changes: [] };
    const changes = [];
    let screens = design.screens.map((s) => ({ ...s, sections: (s.sections || []).map((sec) => ({ ...sec, elements: [...(sec.elements || [])] })) }));
    if (c.noDetail || (c.exact && c.screens === 1)) {
        let dropped = 0;
        screens = screens.map((s) => ({
            ...s,
            sections: s.sections
                .map((sec) => {
                    const kept = sec.elements.filter((e) => e.kind !== 'detail');
                    dropped += sec.elements.length - kept.length;
                    return { ...sec, elements: kept };
                })
                .filter((sec) => sec.elements.length),
        })).filter((s) => s.sections.length);
        if (dropped) changes.push(`dropped ${dropped} detail element${dropped === 1 ? '' : 's'}`);
    }
    if (c.exact && Number.isFinite(c.screens) && screens.length > c.screens) {
        const keep = screens.slice(0, c.screens);
        const extra = screens.slice(c.screens);
        const last = keep[keep.length - 1];
        if (last) {
            let merged = 0;
            for (const s of extra) {
                for (const sec of s.sections) {
                    if (last.sections.length >= maxSections) break;
                    // A section from another screen keeps that screen's name as
                    // its title when it had none — the reader still knows what it was.
                    last.sections.push({ ...sec, title: sec.title || s.name });
                    merged += 1;
                }
            }
            changes.push(`folded ${extra.length} extra screen${extra.length === 1 ? '' : 's'} (${extra.map((s) => `"${s.name}"`).join(', ')}) into "${last.name}"${merged ? ` — ${merged} section${merged === 1 ? '' : 's'} moved` : ''}`);
        }
        screens = keep;
    }
    if (!changes.length) return { design, changes };
    return { design: { ...design, screens }, changes };
}

module.exports = { deriveScreenConstraints, describeScreenConstraints, applyScreenConstraints, isBinding };
