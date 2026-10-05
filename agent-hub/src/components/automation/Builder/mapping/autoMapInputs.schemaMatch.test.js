import { describe, expect, it } from 'vitest';
import { autoMapInputs } from './autoMapInputs';

const group = (label, base, sample) => ({
    id: label, label, kind: 'integration_action', basePath: base, sample,
    fields: Object.entries(sample).map(([k, v]) => ({ key: k, path: `${base}.${k}`, sample: v })),
});

describe('autoMapInputs: schema matching after the name tiers', () => {
    it('fills what names alone did not: accountId from Mail accounts, title from subject', () => {
        const groups = [
            group('Mail accounts', 'steps.acc.output', { id: 1, email: 'admin@example.com' }),
            group('Test data', 'steps.code.output.result', { subject: 'Order 1042', body: 'Hi' }),
        ];
        const schema = {
            properties: { accountId: { type: 'number' }, title: { type: 'string' }, content: { type: 'string' } },
            required: ['accountId', 'title'],
        };
        expect(autoMapInputs(schema, {}, groups)).toEqual({
            accountId: { kind: 'ref', path: 'steps.acc.output.id' },
            title: { kind: 'ref', path: 'steps.code.output.result.subject' },
            content: { kind: 'ref', path: 'steps.code.output.result.body' },
        });
    });

    it('an exact name still wins, and a filled field is never touched', () => {
        const groups = [group('Test data', 'steps.code.output.result', { title: 'T', subject: 'S' })];
        const schema = { properties: { title: { type: 'string' }, content: { type: 'string' } } };
        expect(autoMapInputs(schema, { content: { kind: 'literal', value: 'mine' } }, groups)).toEqual({
            title: { kind: 'ref', path: 'steps.code.output.result.title' },
        });
    });
});
