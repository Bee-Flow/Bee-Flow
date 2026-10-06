import { describe, it, expect } from 'vitest';
import { walkPath, resolveBinding } from './resolveBinding';

// An automation result as Graph, an HTTP API or Jira hand it back. The app's
// result paths use the one path grammar the automation runtime and the server
// validator use (shared/expr/path.mjs), so what the preview shows is what
// saves and what runs.
const RESULT = {
    body: { value: [{ subject: 'Invoice 1' }, { subject: 'Invoice 2' }], '@odata.nextLink': 'next' },
    fields: { 'Story Points': 5 },
    headers: { 'Content-Type': 'json', list: [{ name: 'Date', value: 'Mon' }, { name: 'Subject', value: 'Hi' }] },
    raw: '{"order":{"id":"#1001"}}',
    'Full name': 'Ann',
};

describe('walkPath — the shared path grammar', () => {
    it('reads quoted keys, unicode/hyphen names, negative indexes and match segments', () => {
        expect(walkPath(RESULT, 'body["@odata.nextLink"]')).toBe('next');
        expect(walkPath(RESULT, 'fields["Story Points"]')).toBe(5);
        expect(walkPath(RESULT, 'headers.Content-Type')).toBe('json');
        expect(walkPath(RESULT, 'body.value[-1].subject')).toBe('Invoice 2');
        expect(walkPath(RESULT, 'headers.list[name="Subject"].value')).toBe('Hi');
    });

    it('maps a list with [*] and reads JSON text as the object it encodes', () => {
        expect(walkPath(RESULT, 'body.value[*].subject')).toEqual(['Invoice 1', 'Invoice 2']);
        expect(walkPath(RESULT, 'raw.order.id')).toBe('#1001');
    });

    it('still reads a column whose whole name is not a path', () => {
        // Component props name columns (labelKey, sideField…); a column called
        // "Full name" is one key, not a broken path.
        expect(walkPath(RESULT, 'Full name')).toBe('Ann');
        expect(walkPath(RESULT, 'fields.Story Points')).toBeUndefined();
    });

    it('never walks the prototype chain', () => {
        expect(walkPath(RESULT, 'body.constructor')).toBeUndefined();
        expect(walkPath(RESULT, '__proto__')).toBeUndefined();
    });

    it('an actionResult binding resolves the same paths', () => {
        const actionState = { act1: { status: 'success', result: RESULT } };
        expect(resolveBinding({ kind: 'actionResult', actionId: 'act1', path: 'body.value[0].subject' }, { actionState }).value).toBe('Invoice 1');
        expect(resolveBinding({ kind: 'actionResult', actionId: 'act1', path: 'headers.list[name="Date"].value' }, { actionState }).value).toBe('Mon');
    });
});
