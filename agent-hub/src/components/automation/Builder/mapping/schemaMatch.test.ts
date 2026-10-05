import { describe, expect, it } from 'vitest';
import { matchSchema, tokens, valueKind } from './schemaMatch';

const c = (key: string, path: string, sample: unknown, groupLabel = 'Step', groupIndex = 1) => ({ key, path, sample, groupLabel, groupIndex });
const map = (params: Parameters<typeof matchSchema>[0], cands: Parameters<typeof matchSchema>[1]) =>
    Object.fromEntries(matchSchema(params, cands).map(r => [r.key, r.path]));

describe('tokens', () => {
    it('splits names into canonical, singular words', () => {
        expect(tokens('recipientEmailAddress')).toEqual(['to', 'email', 'address']);
        expect(tokens('message_ids')).toEqual(['message', 'id']);
        expect(tokens('emailAddress')).toEqual(['email']);
        expect(tokens('Mail accounts')).toEqual(['mail', 'account']);
    });
});

describe('valueKind', () => {
    it('reads what a sample is', () => {
        expect(valueKind('jan@example.com')).toBe('email');
        expect(valueKind('MoveMove <no-reply@movemove.com>')).toBe('email');
        expect(valueKind('https://x.nl/a')).toBe('url');
        expect(valueKind('2026-10-31')).toBe('date');
        expect(valueKind('Tue, 29 Sep 2026 03:13:26 +0000 (UTC)')).toBe('date');
        expect(valueKind('Factuur 1042')).toBe('text');
    });
});

describe('matchSchema: what a person would call obviously that one', () => {
    it('a generic id borrows its step\'s entity: accountId ← Mail accounts ▸ id', () => {
        expect(map([{ key: 'accountId', type: 'number' }], [
            c('id', 'steps.a.output.id', 1, 'Mail accounts'),
            c('count', 'steps.a.output.count', 1, 'Mail accounts'),
        ])).toEqual({ accountId: 'steps.a.output.id' });
    });

    it('synonyms: title ← subject, recipient ← to, content ← body', () => {
        expect(map(
            [{ key: 'title', type: 'string' }, { key: 'recipient', type: 'string' }, { key: 'content', type: 'string' }],
            [c('subject', 's.subject', 'Order'), c('to', 's.to', 'a@b.nl'), c('body', 's.body', 'Hi')],
        )).toEqual({ title: 's.subject', recipient: 's.to', content: 's.body' });
    });

    it('a parameter that names a kind takes the one value of that kind nearby', () => {
        expect(map([{ key: 'emailTo', type: 'string' }], [
            c('sender', 's.sender', 'MoveMove <no-reply@movemove.com>', 'gmail read', 2),
            c('subject', 's.subject', 'Factuur', 'gmail read', 2),
        ])).toEqual({ emailTo: 's.sender' });
    });

    it('an allowed value is evidence: status ← state when its value is one of the options', () => {
        expect(map([{ key: 'status', type: 'string', enum: ['open', 'closed'] }], [
            c('state', 's.state', 'open'),
        ])).toEqual({});
        expect(map([{ key: 'priorityLevel', type: 'string', enum: ['low', 'high'] }], [
            c('priority', 's.priority', 'high'),
        ])).toEqual({ priorityLevel: 's.priority' });
    });

    it('one field per parameter and one parameter per field, best pair first', () => {
        const out = map([{ key: 'title' }, { key: 'subject' }], [c('subject', 's.subject', 'x')]);
        expect(Object.values(out)).toEqual(['s.subject']);
    });
});

describe('matchSchema: what it must NOT guess', () => {
    it('one shared word in a longer name is not enough', () => {
        expect(map([{ key: 'name', type: 'string' }], [c('filename', 's.filename', 'a.pdf'), c('billingAddressLine', 's.b', 'x')])).toEqual({});
        expect(map([{ key: 'query', type: 'string' }], [c('subject', 's.subject', 'x')])).toEqual({});
    });

    it('a value of the wrong kind never fills a typed parameter', () => {
        expect(map([{ key: 'count', type: 'number' }], [c('count', 's.count', '12')])).toEqual({});
        expect(map([{ key: 'email', type: 'string' }], [c('email', 's.email', 'not an address')])).toEqual({});
    });

    it('two e-mail addresses nearby: no guess on kind alone', () => {
        expect(map([{ key: 'emailTo' }], [c('from', 's.from', 'a@b.nl'), c('cc', 's.cc', 'c@d.nl')])).toEqual({});
    });
});
