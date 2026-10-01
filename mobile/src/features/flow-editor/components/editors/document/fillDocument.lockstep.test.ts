/**
 * The Fill in a document rules, held to the web's FillDocumentFields
 * (actionEditors/documentFields.jsx). The web keeps them inline in JSX, so
 * this is TEXTUAL: each rule's own line is looked up in the web source, and
 * the port is run over the cases that line decides. A failure means the web
 * editor changed: update the port, don't loosen the test.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { DocumentContract, DocumentParameter, DocumentTemplate } from '@/features/flow-editor/api';

import {
    exampleText,
    isPresentation,
    pickDocument,
    placeholderCount,
    placeholderHint,
    placeholderPrompt,
    placeholdersOf,
    plainSections,
    SECTION_CHOICES,
    sectionChoice,
    shortRevision,
    typedPlaceholderValue,
    updateAvailable,
} from './fillDocumentModel';
import { specFor } from '../declarative/specs';

const WEB = fs
    .readFileSync(path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow/settings/actionEditors/documentFields.jsx'), 'utf8')
    .replace(/\s+/g, ' ');

const param = (over: Partial<DocumentParameter>): DocumentParameter => ({
    key: 'k',
    label: '',
    type: '',
    kind: '',
    required: false,
    summary: '',
    instructions: '',
    fields: [],
    ...over,
});
const doc = (over: Partial<DocumentTemplate>): DocumentTemplate => ({ id: 'd1', name: 'Invoice', docType: 'invoice', versionId: 'v1', ...over });
const contract = (over: Partial<DocumentContract>): DocumentContract => ({
    documentId: 'd1',
    versionId: 'v1',
    name: 'Invoice',
    docType: 'invoice',
    instructions: '',
    parameters: [],
    sections: [],
    ...over,
});

describe('which placeholders the Values band shows', () => {
    it('is the first list that exists — contract, then the picked document, then its body', () => {
        expect(WEB).toContain('const placeholders = contract?.parameters || picked?.parameters || picked?.placeholders || [];');
        const fromBody = [param({ key: 'body' })];
        expect(placeholdersOf(contract({ parameters: [] }), doc({ placeholders: fromBody }))).toEqual([]);
        expect(placeholdersOf(null, doc({ parameters: [param({ key: 'p' })], placeholders: fromBody })).map((p) => p.key)).toEqual(['p']);
        expect(placeholdersOf(undefined, doc({ placeholders: fromBody }))).toBe(fromBody);
        expect(placeholdersOf(null, null)).toEqual([]);
    });
});

describe('picking a document', () => {
    it('sets the id, the name that rides along, its revision, and clears the section choices', () => {
        for (const line of [
            "set('documentId', id);",
            "set('documentName', doc?.name || '');",
            "set('documentVersionId', doc?.versionId);",
            "set('sectionOverrides', {});",
        ]) {
            expect(WEB).toContain(line);
        }
        expect(pickDocument('d1', doc({}))).toEqual({ documentId: 'd1', documentName: 'Invoice', documentVersionId: 'v1', sectionOverrides: {} });
        expect(pickDocument('gone', null)).toEqual({ documentId: 'gone', documentName: '', documentVersionId: '', sectionOverrides: {} });
    });

    it('lists each document with how many placeholders it has', () => {
        expect(WEB).toContain("d.placeholders?.length ? ` · ${d.placeholders.length} placeholder(s)` : ' · no placeholders'");
        expect(placeholderCount(doc({ placeholders: [param({}), param({ key: 'b' })] }))).toEqual(['mobile.flow.fill.placeholder_count', '{n} placeholder(s)', { n: 2 }]);
        expect(placeholderCount(doc({}))[1]).toBe('no placeholders');
    });
});

describe('a value row', () => {
    it('stores a number as a number and true / false as a yes/no, only for those types', () => {
        for (const line of [
            "if (p.type === 'number' && next.trim() && Number.isFinite(Number(next))) return Number(next);",
            "if (p.type === 'boolean' && ['true', 'false'].includes(next)) return next === 'true';",
        ]) {
            expect(WEB).toContain(line);
        }
        expect(typedPlaceholderValue(param({ type: 'number' }), '12.5')).toBe(12.5);
        expect(typedPlaceholderValue(param({ type: 'number' }), ' ')).toBe(' ');
        expect(typedPlaceholderValue(param({ type: 'number' }), '{{steps.a.output.n}}')).toBe('{{steps.a.output.n}}');
        expect(typedPlaceholderValue(param({ type: 'boolean' }), 'false')).toBe(false);
        expect(typedPlaceholderValue(param({ type: 'text' }), '3')).toBe('3');
    });

    it('offers a whole list as the example for a list, one value otherwise', () => {
        expect(WEB).toContain("placeholder={p.kind === 'list' ? '{{steps.rows.output.rows}}' : '{{steps.extract.output.naam}}'}");
        expect(placeholderPrompt(param({ kind: 'list' }))).toBe('{{steps.rows.output.rows}}');
        // A contract parameter says `type: 'list'` where a bare placeholder says `kind`.
        expect(placeholderPrompt(param({ type: 'list' }))).toBe('{{steps.rows.output.rows}}');
        expect(placeholderPrompt(param({ type: 'text' }))).toBe('{{steps.extract.output.naam}}');
    });

    it('explains itself: the contract’s words first, then what a list or a condition takes', () => {
        expect(WEB).toContain('hint={p.summary || p.instructions || (p.kind === ');
        expect(placeholderHint(param({ summary: 'S', instructions: 'I' }))).toBe('S');
        expect(placeholderHint(param({ instructions: 'I' }))).toBe('I');
        expect(placeholderHint(param({ kind: 'list', fields: ['qty', 'price'] }))).toEqual([
            'mobile.flow.fill.list_with_fields',
            'A list, one block per item with {fields}. Bind it to a whole list — one value and nothing else around it.',
            { fields: 'qty, price' },
        ]);
        expect(placeholderHint(param({ type: 'list' }))?.[0]).toBe('mobile.flow.fill.list_whole');
        expect(placeholderHint(param({ kind: 'condition' }))?.[1]).toBe('Decides whether its block is printed at all.');
        expect(placeholderHint(param({}))).toBeNull();
    });

    it('prints an example as the web does', () => {
        expect(WEB).toContain("typeof p.example==='object'?JSON.stringify(p.example):String(p.example)");
        expect(exampleText({ a: 1 })).toBe('{"a":1}');
        expect(exampleText(3)).toBe('3');
    });
});

describe('the revision and the sections', () => {
    it('shows the pinned revision short, and an update only when the document moved on', () => {
        expect(WEB).toContain('contract.versionId.slice(0,8)');
        expect(WEB).toContain('picked?.versionId && contract.versionId !== picked.versionId');
        expect(shortRevision('0123456789abcdef')).toBe('01234567');
        expect(updateAvailable(contract({ versionId: 'v1' }), doc({ versionId: 'v2' }))).toBe(true);
        expect(updateAvailable(contract({ versionId: 'v1' }), doc({ versionId: 'v1' }))).toBe(false);
        expect(updateAvailable(contract({ versionId: 'v1' }), null)).toBe(false);
        expect(updateAvailable(undefined, doc({}))).toBe(false);
    });

    it('asks the pinned revision, or the baseline when none is pinned', () => {
        expect(WEB).toContain("draft.documentVersionId ? `?versionId=${encodeURIComponent(draft.documentVersionId)}` : '?versionId=baseline'");
    });

    it('offers the web’s three section choices, in its order, defaulting to the rules', () => {
        const web = [...WEB.matchAll(/<option value="(automatic|include|exclude)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
        expect(SECTION_CHOICES.map((c) => [c.value, c.label[1]])).toEqual(web);
        expect(WEB).toContain("value={draft.sectionOverrides?.[s.id] || 'automatic'}");
        expect(sectionChoice({ terms: 'exclude' }, 'terms')).toBe('exclude');
        expect(sectionChoice({ terms: '' }, 'terms')).toBe('automatic');
        expect(sectionChoice(undefined, 'terms')).toBe('automatic');
    });
});

describe('the file band', () => {
    it('asks for a format for a presentation, reading PowerPoint unless PDF was chosen', () => {
        expect(WEB).toContain("(picked?.docType === 'presentation' || contract?.docType === 'presentation')");
        expect(WEB).toContain("value={draft.format === 'pdf' ? 'pdf' : 'pptx'}");
        expect(isPresentation(doc({ docType: 'presentation' }), null)).toBe(true);
        expect(isPresentation(null, contract({ docType: 'presentation' }))).toBe(true);
        expect(isPresentation(doc({}), contract({}))).toBe(false);

        const spec = specFor('fill_document');
        const sections = plainSections(spec?.sections ?? [], true);
        expect(sections.map((s) => s.key)).toEqual(['output', 'options']);
        const format = sections[0]?.fields.find((f) => f.key === 'format');
        const ctx = {} as never;
        expect(format?.visibleWhen?.({ format: '' }, ctx)).toBe(true);
        expect(format?.read?.({ format: '' }, ctx)).toBe('pptx');
        expect(format?.read?.({ format: 'pdf' }, ctx)).toBe('pdf');
        const plain = plainSections(spec?.sections ?? [], false)[0]?.fields.find((f) => f.key === 'format');
        expect(plain?.visibleWhen?.({ format: '' }, ctx)).toBe(false);
        expect(plain?.visibleWhen?.({ format: 'pdf' }, ctx)).toBe(true);
    });
});
