/**
 * The PATCH bodies the editor sends, built from the document as the write
 * queue has it. `settings` is ONE column on the server: every builder here
 * spreads the current settings and replaces only its own key, as the web does
 * ("merge, never replace").
 */

import { escapeText } from './htmlRuns';
import type { DocKind, DocumentContract, DocumentPatch, DocumentSettings, StudioDocument, Visibility } from './types';

type Loose = Record<string, unknown>;

const record = (value: unknown): Loose => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {});
const settingsOf = (doc: Pick<StudioDocument, 'settings'> | undefined): DocumentSettings => doc?.settings ?? {};

/** The stored customer values, keyed by the parameter's dotted key. */
export const sampleValuesOf = (doc: Pick<StudioDocument, 'settings'>): Loose => record(doc.settings.sampleValues);
export const sectionOverridesOf = (doc: Pick<StudioDocument, 'settings'>): Record<string, string> =>
    record(doc.settings.sectionOverrides) as Record<string, string>;
export const designOf = (doc: Pick<StudioDocument, 'settings'>): Loose => record(doc.settings.design);

/** `settings.houseStyle === false` is the only "no"; absent means nobody decided, which reads as yes. */
export const usesHouseStyle = (doc: Pick<StudioDocument, 'settings'>): boolean => doc.settings.houseStyle !== false;

export interface ContractDraft {
    contract: DocumentContract;
    kind: DocKind;
    visibility: Visibility;
}

/** A plain document is always private; only templates and sections are shared. */
export function contractPatch(draft: ContractDraft, current: StudioDocument | undefined): DocumentPatch {
    return {
        settings: { ...settingsOf(current), contract: draft.contract },
        kind: draft.kind,
        visibility: draft.kind === 'document' ? 'private' : draft.visibility,
    };
}

export interface ValuesDraft {
    sampleValues: Loose;
    sectionOverrides: Record<string, string>;
}

export function valuesPatch(draft: ValuesDraft, current: StudioDocument | undefined): DocumentPatch {
    return { settings: { ...settingsOf(current), sampleValues: draft.sampleValues, sectionOverrides: draft.sectionOverrides } };
}

export function designPatch(design: Loose, current: StudioDocument | undefined): DocumentPatch {
    return { settings: { ...settingsOf(current), design } };
}

export function houseStylePatch(on: boolean, current: StudioDocument | undefined): DocumentPatch {
    return { settings: { ...settingsOf(current), houseStyle: on } };
}

/**
 * A new conditional section: declared in the contract and appended to the
 * body in the same save, as the web's "Add section" does — a section the
 * contract names must appear in the body exactly once.
 */
export function addSectionPatch(
    section: { id: string; title: string; body: string },
    current: StudioDocument | undefined,
): DocumentPatch {
    const contract = current?.contract ?? { instructions: '', parameters: [], sections: [] };
    const next: DocumentContract = {
        ...contract,
        sections: [...contract.sections, { id: section.id, title: section.title, summary: '', condition: null }],
    };
    // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- not an Express handler: the rule reads (section, current) as (req, res) and section.body as req.body; title and body are escaped with escapeText and the id comes from newSectionId, section-[0-9a-z]{8}
    const html = `<section data-doc-section="${section.id}"><h2>${escapeText(section.title)}</h2><p>${escapeText(section.body)}</p></section>`;
    return {
        settings: { ...settingsOf(current), contract: next },
        bodyHtml: `${current?.bodyHtml ?? ''}${html}`,
    };
}

/** An id the server accepts for a section (letters, digits, `-`, `_`). */
export function newSectionId(random: () => number = Math.random): string {
    return `section-${Math.floor(random() * 36 ** 8).toString(36).padStart(8, '0')}`;
}
