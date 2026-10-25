/**
 * The marks in the Code tab: which line gets which tint?
 *
 * ── THIS MODULE SEARCHES FOR NOTHING ────────────────────────────────
 *
 * There is not a single regex and not a single tag name here. WHERE a `bf-*`
 * element sits comes from the server, from the same parser as the rest of W4
 * (`core/webpages/webpageBindings.js` → `GET /api/webpages/:id/bindings`),
 * which in turn takes the vocabulary from `core/webpages/bfElements.js`.
 *
 * A second regex here would be a second reading of the same vocabulary, and two
 * readings drift apart — that is exactly what already happened with
 * `window.beeflowAI`. This file does one thing: it translates marks into
 * Monaco decorations.
 *
 * ── THE FAMILIES ─────────────────────────────────────────────────────
 *
 * One tint per FAMILY, not per element: what an element hangs on is what the
 * author wants to see, not what it is called. The families come from the
 * vocabulary itself (`binding.kind` in the mirrored registry), plus two that are
 * NOT bindings but still deserve their own colour:
 *
 *   incomplete  the element is there, but a required attribute is missing —
 *               so it hangs on nothing. That is something different from no
 *               element, and also different from an address that the page builds
 *               on the spot (`dynamic`): there the author DID write it down,
 *               so that keeps its own family;
 *   unknown     the server did not know this `bf-*` element. In the public
 *               snapshot DOMPurify quietly strips something like that, so here
 *               it should stand out.
 *
 * If the registry adds a family tomorrow, it appears in `BF_FAMILIES` by itself;
 * `bfDecorations.test.js` then requires a tint in vscode-theme.css, so that a new
 * family cannot silently stay colourless.
 */

import { BF_ELEMENTS } from '../../utils/bfElements';

/** Eén markering zoals de server hem teruggeeft (`GET /api/webpages/:id/bindings`). */
export interface BfMark {
    line?: number;
    known?: boolean;
    missing?: string[];
    family?: string;
    tag?: string;
}

/** De markeringen van één regel, met de familie van de eerste. */
export interface BfMarkGroup {
    line: number;
    marks: BfMark[];
    family: string;
}

interface MonacoDecorationOptions {
    isWholeLine: boolean;
    className: string;
    linesDecorationsClassName: string;
    after?: { content: string; inlineClassName: string };
    hoverMessage?: { value: string };
}

export interface BfDecoration {
    range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
    };
    options: MonacoDecorationOptions;
}

interface DecorationOpts {
    label?: (group: BfMarkGroup) => string;
    hover?: (group: BfMarkGroup) => string;
}

/** Families that are not bindings, but do have their own tint. */
const EXTRA_FAMILIES = Object.freeze(['incomplete', 'unknown']);

/** Elke familie die een markering kan dragen, in vocabulairevolgorde. */
export const BF_FAMILIES = Object.freeze([
    ...BF_ELEMENTS.reduce((acc: string[], def) => {
        const kind = def.binding && def.binding.kind;
        if (kind && !acc.includes(kind)) acc.push(kind);
        return acc;
    }, []),
    ...EXTRA_FAMILIES,
]);

/**
 * The family of one mark.
 *
 * The order of the questions is deliberate:
 *
 *   1. "do we know this element?" — an unknown element must never be drawn as
 *      an ordinary element without a connection;
 *   2. "is something required missing?" — then it hangs on nothing, which the
 *      author probably has to finish themselves. The server keeps the family of
 *      the KIND of element (a `bf-table` without a source is still a table
 *      element), so this distinction reads `missing`, not `family`;
 *   3. otherwise the family itself.
 */
export function familyOf(mark?: BfMark | null): string {
    if (!mark) return 'unknown';
    if (mark.known === false) return 'unknown';
    if (Array.isArray(mark.missing) && mark.missing.length > 0) return 'incomplete';
    if (mark.family && BF_FAMILIES.includes(mark.family)) return mark.family;
    return 'incomplete';
}

/**
 * WHAT REMAINS OF THIS ELEMENT ONCE THE PAGE IS PUBLISHED.
 *
 * The Code tab drew every bf element as an equal "Studio link", while three of
 * the five are dead on a published page: no JS runs there, so a button, a form
 * and an agent block become a visibly disabled block with a notice
 * (services/webpageBfTable.js). The ONLY screen that made the connections visible
 * did not make that difference — even though the data was already there: the
 * mirrored registry carries per element both the state and the sentence the
 * reader sees.
 *
 * Returns `null` for a tag that the
 *   vocabulary does not know — there is nothing to claim about it.
 */
export function publishedFate(tag: unknown): { state: string; notice: string } | null {
    const def = BF_ELEMENTS.find(e => e.tag === String(tag || '').toLowerCase());
    if (!def) return null;
    const vanilla = (def.surfaces && def.surfaces.vanillaSnapshot) || null;
    if (!vanilla) return null;
    return { state: vanilla.state, notice: vanilla.notice || '' };
}

/** Blijft dit element werken op de gepubliceerde pagina? */
export function survivesPublishing(tag: unknown): boolean {
    const fate = publishedFate(tag);
    // Unknown does NOT count as "survives it": DOMPurify quietly
    // strips such an element, and that is the opposite of surviving.
    if (!fate) return false;
    return fate.state === 'static' || fate.state === 'live';
}

/** De CSS-klasse van een familie. De tinten staan in vscode-theme.css. */
export function familyClass(family: string): string {
    return `bf-mark--${family}`;
}

/**
 * Marks of ONE file, grouped per line.
 *
 * Two elements on one line become one decoration: two tints on top of each other
 * produce a third colour that means nothing, and two labels next to each other
 * are unreadable. The line keeps the family of the first element, and the label
 * names both of them.
 */
export function groupMarksByLine(marks?: BfMark[] | null): BfMarkGroup[] {
    const byLine = new Map<number, BfMark[]>();
    for (const mark of (Array.isArray(marks) ? marks : [])) {
        const line = Number(mark && mark.line);
        if (!Number.isInteger(line) || line < 1) continue;
        if (!byLine.has(line)) byLine.set(line, []);
        (byLine.get(line) as BfMark[]).push(mark);
    }
    return [...byLine.entries()]
        .sort((a: [number, BfMark[]], b: [number, BfMark[]]) => a[0] - b[0])
        .map(([line, group]: [number, BfMark[]]) => ({ line, marks: group, family: familyOf(group[0]) }));
}

/**
 * Monaco decorations for one file.
 *
 * Pure: no Monaco import, no editor — a list of plain objects, so that this
 * translation can be tested without starting an editor.
 *
 * `opts.label` is the text after the line. It is made in the component with `t()` —
 * translated text does not belong in a pure model. `opts.hover` is the text of the
 * tooltip.
 */
export function buildBfDecorations(marks?: BfMark[] | null, { label, hover }: DecorationOpts = {}): BfDecoration[] {
    return groupMarksByLine(marks).map((group: BfMarkGroup) => {
        const text = typeof label === 'function' ? label(group) : '';
        const tip = typeof hover === 'function' ? hover(group) : '';
        const options: MonacoDecorationOptions = {
            isWholeLine: true,
            className: `bf-mark ${familyClass(group.family)}`,
            linesDecorationsClassName: `bf-mark-gutter ${familyClass(group.family)}`,
        };
        // An empty label would produce an empty injection that still shifts the
        // cursor; then prefer no injection at all.
        if (text) options.after = { content: `   ${text}`, inlineClassName: 'bf-mark-label' };
        if (tip) options.hoverMessage = { value: tip };
        return {
            range: {
                startLineNumber: group.line,
                startColumn: 1,
                endLineNumber: group.line,
                endColumn: 1,
            },
            options,
        };
    });
}

