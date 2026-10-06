// @vitest-environment node
/**
 * A table or a group reached THROUGH `[*]` (Graph's `value[*].from`, one
 * record per message) gets its columns and fields by plain key, because `[*]`
 * maps the rest of the path over every message. Every choice the builder
 * writes resolves at run time to what its label promises.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '@shared/expr/engine.mjs';
import { getPath, replaceTemplate } from '@shared/expr/path.mjs';
import { templateText } from '@shared/expr/templateText.mjs';
import * as mismatch from './mismatch';
import { templateRemediesFor } from './templateRemedies';

const ROOT = {
    steps: {
        src: {
            output: {
                value: [
                    { from: { emailAddress: { address: 'ada@x.nl', name: 'Ada' } }, toRecipients: [{ emailAddress: { address: 'c@x.nl' } }, { emailAddress: { address: 'd@x.nl' } }] },
                    { from: { emailAddress: { address: 'bob@x.nl', name: 'Bob' } }, toRecipients: [] },
                ],
                body: { 'content-type': 'json', 'a]b': 1, 'say "hi"': 2, plain: 3 },
                lines: [{ sku: 'A', 'unit price': 1 }, { sku: 'B', 'unit price': 2 }],
            },
        },
    },
};

type Fn = (...args: unknown[]) => unknown;
const { columnPath, remediesFor } = mismatch;
const columnForSlot = mismatch.columnForSlot as unknown as Fn;
const fieldForSlot = mismatch.fieldForSlot as unknown as Fn;

const run = (tpl: string) => replaceTemplate(tpl, (inner: string) => templateText(getPath(ROOT, inner)));

describe('columnPath', () => {
    it.each([
        ['steps.src.output.value[*].from', 'emailAddress', 'steps.src.output.value[*].from.emailAddress'],
        ['steps.src.output.value[*].toRecipients', 'emailAddress', 'steps.src.output.value[*].toRecipients[*].emailAddress'],
        ['steps.src.output.lines', 'unit price', 'steps.src.output.lines[*]["unit price"]'],
    ])('%s ▸ %s', (path, key, want) => {
        expect(columnPath(path, key, ROOT)).toBe(want);
        expect((getPath(ROOT, want) as unknown[]).length).toBeGreaterThan(0);
    });
});

describe('ValueBuilder auto-pick (columnForSlot / fieldForSlot)', () => {
    it('a column of a table reached through [*] resolves at run time', () => {
        const col = columnForSlot('steps.src.output.value[*].from.emailAddress', ROOT, { slot: 'Recipient address', expectedKind: 'email' });
        expect(col).toBe('steps.src.output.value[*].from.emailAddress.address');
        expect(evaluate(`join(${col}, ", ")`, ROOT)).toBe('ada@x.nl, bob@x.nl');
    });

    it('a field of a group is written in the canonical spelling', () => {
        expect(fieldForSlot('steps.src.output.body', ROOT, { slot: 'content type', expectedKind: 'text' }))
            .toBe('steps.src.output.body["content-type"]');
    });
});

describe('group remedies offer every key, quoted so the run resolves it', () => {
    it('keys holding ] and quotes are offered and resolve', () => {
        const r = remediesFor('steps.src.output.body', ROOT, { actualKind: 'group' });
        const fields = [...r.primary, ...r.more].filter(x => x.id.startsWith('field:'));
        expect(fields.map(f => f.id)).toEqual(['field:content-type', 'field:a]b', 'field:say "hi"', 'field:plain']);
        for (const f of fields) {
            const key = f.id.slice('field:'.length) as keyof typeof ROOT.steps.src.output.body;
            expect(getPath(ROOT, (f.binding as { path: string }).path)).toBe(ROOT.steps.src.output.body[key]);
        }
    });
});

describe('TemplateField "More" choices for a table reached through [*]', () => {
    it('columns read the column; no per-row count is offered', () => {
        const r = templateRemediesFor('steps.src.output.value[*].from', ROOT);
        expect(r?.shape).toBe('table');
        const ids = r!.choices.map(c => c.id);
        expect(ids).not.toContain('count');
        const col = r!.choices.find(c => c.id === 'column:emailAddress')!;
        expect(col.token).toBe('{{steps.src.output.value[*].from.emailAddress}}');
        expect(run('{{steps.src.output.value[*].from.emailAddress}}')).not.toBe('');
    });

    it('a table of lists per row reads its column through [*]', () => {
        const r = templateRemediesFor('steps.src.output.value[*].toRecipients', ROOT);
        const col = r!.choices.find(c => c.id === 'column:emailAddress')!;
        expect(col.token).toBe('{{steps.src.output.value[*].toRecipients[*].emailAddress}}');
        expect(r!.choices.map(c => c.id)).not.toContain('count');
    });

    it('a plain table still counts its rows, and its columns quote odd keys', () => {
        const r = templateRemediesFor('steps.src.output.lines', ROOT);
        const count = r!.choices.find(c => c.id === 'count')!;
        expect(run(count.token)).toBe('2');
        const price = r!.choices.find(c => c.id === 'column:unit price')!;
        expect(price.token).toBe('{{steps.src.output.lines[*]["unit price"]}}');
        expect(run(price.token)).toBe('1, 2');
    });
});
