/**
 * pepFunctions.mts: does a job title or function describe a prominent public function (PEP)?
 *
 *   checkPepFunction('Minister van Financiën')
 *   -> { isPep: true, former: false, matches: [{ id: 'nl.a.minister', list: 'nl', label: 'Ministers', matchedTerm: 'minister', ... }, { id: 'eu.a....' }] }
 *
 * The functions are the official lists, bundled as data (pepFunctions.json, versioned): the
 * Dutch list under article 2 of the Uitvoeringsbesluit Wwft 2018 and the EU list (Directive
 * (EU) 2015/849 article 3(9) and the Commission's list of prominent public functions). Only
 * functions, never names of people.
 *
 * A function matches when one of its terms appears in the title as whole words, in order
 * (folded like the sanctions names: case, diacritics and punctuation do not matter). A
 * function with `all` needs one term of every group ("director" AND "state-owned
 * enterprise"). Such matches, and the international organisations whose own lists decide,
 * carry `confidence: 'possible'`. "Former", "oud-" and "voormalig" set `former`: a PEP keeps
 * the status for at least twelve months after leaving, so a former function still matches.
 *
 * Pure: reads the bundled file once.
 */

import { createRequire } from 'node:module';
import { foldText } from './normalize.mts';

const nodeRequire = createRequire(import.meta.url);

export interface PepFunctionEntry {
    id: string;
    list: 'nl' | 'eu';
    category: string;
    label: string;
    terms?: string[];
    all?: string[][];
    confidence?: 'possible';
    caution?: string;
}

export interface PepSource { list: string; title: string; publisher: string; url: string; legalBasis: string }

export interface PepData { version: string; note: string; sources: PepSource[]; functions: PepFunctionEntry[] }

export interface PepMatch {
    id: string;
    list: 'nl' | 'eu';
    category: string;
    label: string;
    matchedTerm: string;
    confidence: 'match' | 'possible';
    caution: string | null;
    source: string | null;
}

export interface PepCheck {
    isPep: boolean;
    /** Only matches that need a check against the organisation's own list (confidence 'possible'). */
    possiblePep: boolean;
    former: boolean;
    matches: PepMatch[];
    version: string;
    note: string;
}

const FORMER = new Set(['former', 'formerly', 'ex', 'oud', 'voormalig', 'voormalige', 'gewezen', 'past', 'retired', 'emeritus']);

let data: PepData | null = null;

export function pepData(): PepData {
    data ??= nodeRequire('./pepFunctions.json') as PepData;
    return data;
}

const tokens = (s: string): string[] => foldText(s).split(' ').filter(Boolean);

/** Is `phrase` (folded tokens) a run of whole tokens inside `hay`? */
function hasPhrase(hay: string[], phrase: string[]): boolean {
    if (!phrase.length || phrase.length > hay.length) return false;
    for (let i = 0; i + phrase.length <= hay.length; i++) {
        let ok = true;
        for (let j = 0; j < phrase.length; j++) if (hay[i + j] !== phrase[j]) { ok = false; break; }
        if (ok) return true;
    }
    return false;
}

/** The longest term of `terms` found in the title, or null. */
function bestTerm(hay: string[], terms: string[]): string | null {
    let best: string | null = null;
    let bestLen = 0;
    for (const term of terms) {
        const t = tokens(term);
        if (t.length > bestLen && hasPhrase(hay, t)) { best = term; bestLen = t.length; }
    }
    return best;
}

function matchEntry(hay: string[], f: PepFunctionEntry): string | null {
    if (f.terms?.length) return bestTerm(hay, f.terms);
    if (f.all?.length) {
        const found = f.all.map((group) => bestTerm(hay, group));
        return found.every(Boolean) ? found.join(' + ') : null;
    }
    return null;
}

export const MAX_TITLE_CHARS = 300;

/** The PEP functions a job title describes, under either list. */
export function checkPepFunction(title: unknown, opts: { lists?: Array<'nl' | 'eu'> | null } = {}): PepCheck {
    const d = pepData();
    const hay = tokens(typeof title === 'string' ? title.slice(0, MAX_TITLE_CHARS) : '');
    const lists = opts.lists && opts.lists.length ? opts.lists : null;
    const sourceUrl = new Map(d.sources.map((s) => [s.list, s.url]));
    const matches: PepMatch[] = [];
    if (hay.length) {
        for (const f of d.functions) {
            if (lists && !lists.includes(f.list)) continue;
            const term = matchEntry(hay, f);
            if (!term) continue;
            matches.push({
                id: f.id, list: f.list, category: f.category, label: f.label, matchedTerm: term,
                confidence: f.confidence === 'possible' ? 'possible' : 'match', caution: f.caution ?? null,
                source: sourceUrl.get(f.list) ?? null,
            });
        }
    }
    return {
        isPep: matches.some((m) => m.confidence === 'match'),
        possiblePep: matches.length > 0 && matches.every((m) => m.confidence === 'possible'),
        former: hay.some((t) => FORMER.has(t)),
        matches, version: d.version, note: d.note,
    };
}
