/**
 * The Fill in a document rules, held to the web's FillDocumentFields
 * (actionEditors/documentFields.tsx, and documentOptionLabel.ts for a shared name). The web keeps them inline in JSX, so
 * this is TEXTUAL: each rule's own line is looked up in the web source, and
 * the port is run over the cases that line decides. A failure means the web
 * editor changed: update the port, don't loosen the test.
 */

import fs from 'node:fs';
import path from 'node:path';

import { _reset } from '@/core/i18n';
import type { DocumentContract, DocumentParameter, DocumentTemplate } from '@/features/flow-editor/api';

import {
    duplicateNameSuffix,
    exampleText,
    isConditionPlaceholder,
    isListPlaceholder,
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
    .readFileSync(path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow/settings/actionEditors/documentFields.tsx'), 'utf8')
    .replace(/\s+/g, ' ');
const WEB_LABEL = fs
    .readFileSync(path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow/settings/actionEditors/documentOptionLabel.ts'), 'utf8')
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

    it('lists each document with how many placeholders it has, one and many worded apart', () => {
        expect(WEB).toContain('{d.name}{duplicateNameSuffix(d, templates || [], locale)} · {placeholderCount(d.placeholders?.length ?? 0)}');
        expect(WEB).toContain("t('builder_polish.fill_no_placeholders', 'no placeholders')");
        expect(WEB).toContain("t('builder_polish.fill_placeholder_count_one', '{count} placeholder', { count })");
        expect(WEB).toContain("t('builder_polish.fill_placeholder_count_other', '{count} placeholders', { count })");
        expect(placeholderCount(doc({ placeholders: [param({}), param({ key: 'b' })] }))).toEqual(['builder_polish.fill_placeholder_count_other', '{count} placeholders', { count: 2 }]);
        expect(placeholderCount(doc({ placeholders: [param({})] }))).toEqual(['builder_polish.fill_placeholder_count_one', '{count} placeholder', { count: 1 }]);
        expect(placeholderCount(doc({}))).toEqual(['builder_polish.fill_no_placeholders', 'no placeholders']);
        expect(placeholderCount(doc({ placeholders: [] }))[0]).toBe('builder_polish.fill_no_placeholders');
    });

    it('tells documents that share a name apart by when each last changed', () => {
        expect(WEB_LABEL).toContain("if (!all.some((other) => other.id !== doc.id && (other.name || '').trim() === name)) return '';");
        expect(WEB_LABEL).toContain("{ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }");
        expect(WEB_LABEL).toContain('return ` · ${text}`;');
        _reset();
        const a = doc({ id: 'a', name: 'Quote', updatedAt: '2026-11-23T12:22:00Z' });
        const b = doc({ id: 'b', name: 'Quote ', updatedAt: '2026-11-20T12:05:00Z' });
        const c = doc({ id: 'c', name: 'Letter', updatedAt: '2026-11-20T12:05:00Z' });
        const all = [a, b, c];
        expect(duplicateNameSuffix(a, all)).toMatch(/^ · (?=.*23)(?=.*Nov)/);
        expect(duplicateNameSuffix(a, all)).not.toBe(duplicateNameSuffix(b, all));
        expect(duplicateNameSuffix(c, all)).toBe('');
        expect(duplicateNameSuffix(doc({ id: 'd', name: 'Quote' }), all)).toBe('');
    });
});

describe('a value row', () => {
    it('stores a number as a number and true / false as a yes/no, only for those types', () => {
        expect(WEB).toContain("p.type === 'number' && next.trim() && Number.isFinite(Number(next)) ? Number(next) : p.type === 'boolean' && ['true','false'].includes(next) ? next === 'true' : next");
        expect(typedPlaceholderValue(param({ type: 'number' }), '12.5')).toBe(12.5);
        expect(typedPlaceholderValue(param({ type: 'number' }), ' ')).toBe(' ');
        expect(typedPlaceholderValue(param({ type: 'number' }), '{{steps.a.output.n}}')).toBe('{{steps.a.output.n}}');
        expect(typedPlaceholderValue(param({ type: 'boolean' }), 'false')).toBe(false);
        expect(typedPlaceholderValue(param({ type: 'text' }), '3')).toBe('3');
    });

    it('tells a list from a condition by the server’s shape, not only a placeholder’s kind', () => {
        expect(WEB).toContain("const isListParameter = (p: DocumentParameter) => p.type === 'list' || p.kind === 'list';");
        expect(WEB).toContain("const isConditionParameter = (p: DocumentParameter) => p.kind === 'condition' || (p.type === 'boolean' && (p.conditionForSections?.length ?? 0) > 0);");
        expect(WEB).toContain("(typeof f === 'string' ? f : f.label || f.key)");
        expect(isListPlaceholder(param({ kind: 'list' }))).toBe(true);
        expect(isListPlaceholder(param({ type: 'list' }))).toBe(true);
        expect(isListPlaceholder(param({ type: 'text' }))).toBe(false);
        expect(isConditionPlaceholder(param({ kind: 'condition' }))).toBe(true);
        expect(isConditionPlaceholder(param({ type: 'boolean', conditionForSections: ['terms'] }))).toBe(true);
        expect(isConditionPlaceholder(param({ type: 'boolean', conditionForSections: [] }))).toBe(false);
        expect(isConditionPlaceholder(param({ type: 'boolean' }))).toBe(false);
    });

    it('prompts for a whole list for a list, one value otherwise, in words rather than a made-up path', () => {
        expect(WEB).toContain("placeholder={isListParameter(p) ? t('builder_polish.fill_list_placeholder', 'Click a list in the right panel') : t('builder_polish.fill_value_placeholder', 'Type a value, or click one in the right panel')}");
        expect(WEB).not.toContain('{{steps.extract.output.naam}}');
        expect(placeholderPrompt(param({ kind: 'list' }))).toEqual(['mobile.flow.fill.list_prompt', 'Tap Insert data to pick a whole list']);
        expect(placeholderPrompt(param({ type: 'list' }))[0]).toBe('mobile.flow.fill.list_prompt');
        expect(placeholderPrompt(param({ type: 'text' }))).toEqual(['mobile.flow.fill.value_prompt', 'Type a value, or tap Insert data to pick one']);
    });

    it('explains itself: the contract’s words first, then what a list or a condition takes', () => {
        expect(WEB).toContain('if (p.summary || p.instructions) return p.summary || p.instructions;');
        expect(WEB).toContain("t('builder_polish.fill_list_hint_fields', 'A list, one block per item with {fields}. Bind it to a whole list — one value and nothing else around it.', { fields: names.join(', ') })");
        expect(WEB).toContain("t('builder_polish.fill_list_hint', 'A list. Bind it to a whole list — one value and nothing else around it.')");
        expect(WEB).toContain("if (isConditionParameter(p)) return t('builder_polish.fill_condition_hint', 'Decides whether its block is printed at all.');");
        expect(placeholderHint(param({ summary: 'S', instructions: 'I' }))).toBe('S');
        expect(placeholderHint(param({ instructions: 'I' }))).toBe('I');
        expect(placeholderHint(param({ kind: 'list', fields: ['qty', 'price'] }))).toEqual([
            'builder_polish.fill_list_hint_fields',
            'A list, one block per item with {fields}. Bind it to a whole list — one value and nothing else around it.',
            { fields: 'qty, price' },
        ]);
        expect(placeholderHint(param({ type: 'list' }))?.[0]).toBe('builder_polish.fill_list_hint');
        expect(placeholderHint(param({ kind: 'condition' }))?.[0]).toBe('builder_polish.fill_condition_hint');
        expect(placeholderHint(param({ type: 'boolean', conditionForSections: ['terms'] }))?.[0]).toBe('builder_polish.fill_condition_hint');
        expect(placeholderHint(param({ type: 'boolean' }))).toBeNull();
        expect(placeholderHint(param({}))).toBeNull();
    });

    it('prints an example as the web does', () => {
        expect(WEB).toContain("{t('builder_polish.fill_example', 'Example:')} {typeof p.example==='object'?JSON.stringify(p.example):String(p.example)}");
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
        const web = [...WEB.matchAll(/<option value="(automatic|include|exclude)">\{t\('([a-z0-9_.]+)', '([^']+)'\)\}<\/option>/g)].map((m) => [m[1], m[2], m[3]]);
        expect(web.length).toBe(3);
        expect(SECTION_CHOICES.map((c) => [c.value, c.label[0], c.label[1]])).toEqual(web);
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
