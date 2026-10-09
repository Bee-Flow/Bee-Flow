/**
 * The pure half of "Fill in a document" — the web's FillDocumentFields
 * (actionEditors/documentFields.jsx) without its JSX: which placeholders the
 * step binds, how a typed value is stored, what the picker and the rows say.
 * fillDocument.lockstep.test.ts holds each rule to the web source.
 */

import type { DocumentContract, DocumentParameter, DocumentTemplate } from '@/features/flow-editor/api';
import type { FormDraft } from '@/features/flow-editor/formState';

import { msg, type FieldSpec, type Msg, type SectionSpec } from '../declarative/spec';

/**
 * The rows the Values band shows: the contract's parameters when the pinned
 * contract has been read, else the picked document's, else the placeholders
 * its body carries. The first list that EXISTS wins, even when it is empty —
 * an empty contract means "no placeholders", not "look further".
 */
export function placeholdersOf(contract: DocumentContract | null | undefined, picked: DocumentTemplate | null | undefined): DocumentParameter[] {
    return contract?.parameters ?? picked?.parameters ?? picked?.placeholders ?? [];
}

/** The draft keys a pick changes. The name rides along so the card can say WHICH document without a fetch. */
export function pickDocument(id: string, doc: DocumentTemplate | null): FormDraft {
    return { documentId: id, documentName: doc?.name ?? '', documentVersionId: doc?.versionId ?? '', sectionOverrides: {} };
}

const isList = (p: DocumentParameter) => p.kind === 'list' || p.type === 'list';

/** Under a value row: the contract's own words, else what a list or a condition asks of its binding. */
export function placeholderHint(p: DocumentParameter): Msg | string | null {
    if (p.summary || p.instructions) return p.summary || p.instructions;
    if (isList(p)) {
        return p.fields.length
            ? msg('mobile.flow.fill.list_with_fields', 'A list, one block per item with {fields}. Bind it to a whole list — one value and nothing else around it.', { fields: p.fields.join(', ') })
            : msg('mobile.flow.fill.list_whole', 'A list. Bind it to a whole list — one value and nothing else around it.');
    }
    if (p.kind === 'condition') return msg('mobile.flow.fill.condition_hint', 'Decides whether its block is printed at all.');
    return null;
}

/** The empty row's example: a whole list for a list, one value otherwise. */
export function placeholderPrompt(p: DocumentParameter): string {
    return isList(p) ? '{{steps.rows.output.rows}}' : '{{steps.extract.output.naam}}';
}

/** A number typed into a number parameter is stored as one, and so is true / false into a yes/no. */
export function typedPlaceholderValue(p: DocumentParameter, text: string): unknown {
    if (p.type === 'number' && text.trim() && Number.isFinite(Number(text))) return Number(text);
    if (p.type === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
    return text;
}

/** What a value row shows for what is stored. */
export function shownValue(value: unknown): string {
    return value == null ? '' : String(value);
}

/** A presentation is filled into a .pptx or a PDF deck, and only then is there a format to choose. */
export function isPresentation(picked: DocumentTemplate | null | undefined, contract: DocumentContract | null | undefined): boolean {
    return picked?.docType === 'presentation' || contract?.docType === 'presentation';
}

/** The pinned revision, as the web shows it: its first eight characters. */
export const shortRevision = (versionId: string): string => versionId.slice(0, 8);

/** The picked document has moved on since the step pinned its revision. */
export function updateAvailable(contract: DocumentContract | null | undefined, picked: DocumentTemplate | null | undefined): boolean {
    return !!contract?.versionId && !!picked?.versionId && contract.versionId !== picked.versionId;
}

/** An optional section of the document: printed by its rules, always, or never. */
export const SECTION_CHOICES = [
    { value: 'automatic', label: msg('automations.document_fields.automatic_rules', 'Automatic (rules)') },
    { value: 'include', label: msg('automations.document_fields.include', 'Include') },
    { value: 'exclude', label: msg('automations.document_fields.exclude', 'Exclude') },
] as const;

export function sectionChoice(overrides: unknown, sectionId: string): string {
    const v = overrides && typeof overrides === 'object' ? (overrides as Record<string, unknown>)[sectionId] : undefined;
    return typeof v === 'string' && v ? v : 'automatic';
}

/** An example as the web prints it: JSON for an object, the value itself otherwise. */
export function exampleText(example: unknown): string {
    return typeof example === 'object' && example !== null ? JSON.stringify(example) : String(example);
}

/** A picker row's second line: how many placeholders the document has. */
export function placeholderCount(doc: DocumentTemplate): Msg {
    const n = doc.placeholders?.length ?? 0;
    return n ? msg('mobile.flow.fill.placeholder_count', '{n} placeholder(s)', { n }) : msg('mobile.flow.fill.no_placeholders', 'no placeholders');
}

/**
 * The spec's plain bands for the editor to render after its own: the file
 * and the options (the stored-values band is the editor's fallback, not a
 * band of its own). The format picker shows for a presentation — known from
 * the document, not only from a format already stored — and reads as the
 * web's does: PowerPoint unless PDF was chosen.
 */
export function plainSections(sections: readonly SectionSpec[], presentation: boolean): SectionSpec[] {
    const format = (f: FieldSpec): FieldSpec =>
        f.key !== 'format'
            ? f
            : { ...f, visibleWhen: (d) => presentation || d.format === 'pdf' || d.format === 'pptx', read: (d) => (d.format === 'pdf' ? 'pdf' : 'pptx') };
    return sections.filter((s) => s.key !== 'values').map((s) => ({ ...s, fields: s.fields.map(format) }));
}
