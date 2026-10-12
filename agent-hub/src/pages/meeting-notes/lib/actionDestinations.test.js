// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
    ACTION_FIELD_IDS,
    actionFieldValue,
    applyDestination,
    buildAutomationPayload,
    buildKbSource,
    buildRowValues,
    defaultRowMapping,
    destinationRecord,
    writableColumns,
} from './actionDestinations';

const meeting = { id: 'm-1', title: 'Weekly sync', createdAt: '2026-07-27T09:30:00.000Z' };

/**
 * An action item as it exists AFTER M3: the four fields a destination may
 * carry, plus the bookkeeping that must never leave the note — and one field
 * that does not exist yet, standing in for whatever M4 or a later stage adds.
 */
const item = {
    id: 'u-42',
    text: 'Testlink versturen',
    assignee: 'Tom',
    due: '2026-07-28',
    timestamp: '38:20',
    done: false,
    source: 'user',
    segmentIndex: 12,
    destination: { kind: 'kb', ref: 'kb-9', label: 'Offertevoorwaarden', at: '2026-07-27T10:00:00.000Z' },
    // The field of the future. Nothing here may carry it anywhere.
    privateNote: 'belde eerder over een klacht',
};

const fields = [
    { key: 'title', type: 'text', label: 'Title' },
    { key: 'owner', type: 'text', label: 'Owner' },
    { key: 'deadline', type: 'date', label: 'Deadline' },
    { key: 'amount', type: 'number', label: 'Amount' },
    { key: 'is_open', type: 'bool', label: 'Open' },
    { key: 'age_days', type: 'computed', label: 'Age' },
    { key: 'created_at', type: 'datetime', label: 'Created' },
];

describe('actionDestinations — the allow-list', () => {
    /**
     * THE BITE. Every payload is built field by field from ACTION_FIELD_IDS.
     * Rewrite any of the three builders as `{ ...item }` — one character
     * shorter, and the obvious thing to reach for — and a field nobody
     * reviewed rides into an automation's payload, a shared table and a knowledge
     * base an agent answers from. This is the assertion that stops it.
     */
    it('never lets a field outside the list reach ANY destination', () => {
        const automation = JSON.stringify(buildAutomationPayload(item, meeting));
        const row = JSON.stringify(buildRowValues(item, meeting, { title: 'text', owner: 'assignee' }, fields));
        const kb = JSON.stringify(buildKbSource(item, meeting));
        for (const payload of [automation, row, kb]) {
            expect(payload).not.toMatch(/privateNote|belde eerder/);
            // The bookkeeping is not the action either.
            expect(payload).not.toMatch(/segmentIndex/);
            expect(payload).not.toMatch(/"done"/);
            expect(payload).not.toMatch(/u-42/);
        }
    });

    it('answers nothing for a field id that is not on the list', () => {
        expect(actionFieldValue('privateNote', item, meeting)).toBe('');
        expect(actionFieldValue('id', item, meeting)).toBe('');
        expect(actionFieldValue('done', item, meeting)).toBe('');
        expect(ACTION_FIELD_IDS).not.toContain('id');
    });

    it('reads the six fields it does know', () => {
        expect(actionFieldValue('text', item, meeting)).toBe('Testlink versturen');
        expect(actionFieldValue('assignee', item, meeting)).toBe('Tom');
        expect(actionFieldValue('due', item, meeting)).toBe('2026-07-28');
        expect(actionFieldValue('timestamp', item, meeting)).toBe('38:20');
        expect(actionFieldValue('meeting_title', item, meeting)).toBe('Weekly sync');
        expect(actionFieldValue('meeting_date', item, meeting)).toBe('2026-07-27');
    });

    it('survives an item and a meeting that are not there', () => {
        expect(actionFieldValue('text', null, null)).toBe('');
        expect(actionFieldValue('meeting_date', item, { createdAt: 'someday' })).toBe('');
    });
});

describe('actionDestinations — automation payload', () => {
    it('always carries every key, so a binding never resolves to undefined', () => {
        const payload = buildAutomationPayload({ text: 'Bellen' }, meeting);
        expect(payload.action).toEqual({ text: 'Bellen', assignee: '', due: '', timestamp: '' });
        expect(payload.meeting).toEqual({ id: 'm-1', title: 'Weekly sync', date: '2026-07-27' });
        expect(payload.source).toBe('meeting_notes');
    });
});

describe('actionDestinations — datatable columns', () => {
    it('offers only columns that can hold one of our strings', () => {
        expect(writableColumns(fields).map((f) => f.key)).toEqual(['title', 'owner', 'deadline']);
    });

    it('drops computed, system and non-string columns rather than 500 on them', () => {
        const keys = writableColumns(fields).map((f) => f.key);
        expect(keys).not.toContain('age_days');
        expect(keys).not.toContain('created_at');
        expect(keys).not.toContain('amount');
        expect(keys).not.toContain('is_open');
    });

    it('starts a fresh table with the action text in the first sentence column, and nothing else', () => {
        expect(defaultRowMapping(fields)).toEqual({ title: 'text' });
        expect(defaultRowMapping([{ key: 'n', type: 'number' }])).toEqual({});
        expect(defaultRowMapping(null)).toEqual({});
    });

    it('builds the row from the mapping', () => {
        expect(buildRowValues(item, meeting, { title: 'text', owner: 'assignee', deadline: 'due' }, fields))
            .toEqual({ title: 'Testlink versturen', owner: 'Tom', deadline: '2026-07-28' });
    });

    it('skips a column the schema no longer has instead of losing the whole row', () => {
        // `unknown field: …` is refused for the WHOLE insert, so one stale
        // mapping entry must not take the other columns down with it.
        const values = buildRowValues(item, meeting, { title: 'text', gone: 'assignee' }, fields);
        expect(values).toEqual({ title: 'Testlink versturen' });
    });

    it('skips a column whose type cannot hold a string', () => {
        expect(buildRowValues(item, meeting, { amount: 'text', is_open: 'text' }, fields)).toEqual({});
    });

    it('leaves an empty value out rather than writing "" into a date column', () => {
        const noDue = { text: 'Bellen' };
        expect(buildRowValues(noDue, meeting, { title: 'text', deadline: 'due' }, fields))
            .toEqual({ title: 'Bellen' });
    });

    it('ignores a mapping onto a field id outside the allow-list', () => {
        expect(buildRowValues(item, meeting, { title: 'privateNote' }, fields)).toEqual({});
    });
});

describe('actionDestinations — knowledge snippet', () => {
    it('writes the action first and labels the rest with the caller’s words', () => {
        const body = buildKbSource(item, meeting, {
            labels: { assignee: 'Owner', due: 'Due', timestamp: 'At', meeting_title: 'From', meeting_date: 'Date' },
        });
        expect(body.kind).toBe('text');
        expect(body.config.text.split('\n')[0]).toBe('Testlink versturen');
        expect(body.config.text).toContain('Owner: Tom');
        expect(body.config.text).toContain('From: Weekly sync');
        expect(body.name).toBe('Weekly sync');
    });

    it('falls back to the bare field id — a machine value, not untranslated prose', () => {
        expect(buildKbSource(item, meeting).config.text).toContain('assignee: Tom');
    });

    it('refuses to build a body the server would reject as too short', () => {
        expect(buildKbSource({ text: 'ok' }, meeting)).toBeNull();
        expect(buildKbSource({}, meeting)).toBeNull();
    });
});

describe('actionDestinations — the destination record', () => {
    it('is the shape the server validates', () => {
        const record = destinationRecord('automation', { ref: 'auto-1', label: 'Testlink versturen', itemRef: 'run-9' });
        expect(record.kind).toBe('automation');
        expect(record.ref).toBe('auto-1');
        expect(record.label).toBe('Testlink versturen');
        expect(record.itemRef).toBe('run-9');
        expect(Number.isNaN(Date.parse(record.at))).toBe(false);
    });

    it('records the destination WITHOUT an itemRef when the run had no id yet', () => {
        // 202 {pending:true}: the run started, there is simply nothing to
        // link to. "Sent to this automation" is true; a made-up run id is not.
        const record = destinationRecord('automation', { ref: 'auto-1', label: 'Nightly digest' });
        expect(record).not.toHaveProperty('itemRef');
        expect(record.ref).toBe('auto-1');
    });

    it('refuses an unknown kind and a missing ref — no chip beats an unresolvable chip', () => {
        expect(destinationRecord('cowork_task', { ref: 'x' })).toBeNull();
        expect(destinationRecord('automation', { ref: '' })).toBeNull();
        expect(destinationRecord('automation', {})).toBeNull();
    });
});

describe('actionDestinations — applyDestination', () => {
    const list = [
        { id: 'ai-0', text: 'Van de AI', source: 'ai' },
        { id: 'u-42', text: 'Van mij', source: 'user' },
    ];

    /**
     * THE BITE. `PATCH actionItems` REPLACES the column. A handler that sent
     * only the item it changed would delete every other action on the note —
     * the AI's and, worse, the ones a person typed themselves, which is the
     * exact loss M3 exists to prevent.
     */
    it('answers the WHOLE list, because the PATCH replaces the column', () => {
        const next = applyDestination(list, 'u-42', { kind: 'kb', ref: 'kb-1', label: 'Sales', at: 'now' });
        expect(next).toHaveLength(2);
        expect(next[0]).toEqual(list[0]);
        expect(next[1].destination.ref).toBe('kb-1');
    });

    it('keeps the whole list even when the id is not in it', () => {
        expect(applyDestination(list, 'gone', { kind: 'kb', ref: 'kb-1' })).toEqual(list);
    });

    it('clears a destination by dropping the key, not by storing null', () => {
        const withDest = [{ id: 'u-42', text: 'Van mij', destination: { kind: 'kb', ref: 'kb-1' } }];
        const [cleared] = applyDestination(withDest, 'u-42', null);
        expect(cleared).not.toHaveProperty('destination');
        expect(cleared.text).toBe('Van mij');
    });

    it('never mutates the list it was given', () => {
        applyDestination(list, 'u-42', { kind: 'kb', ref: 'kb-1' });
        expect(list[1]).not.toHaveProperty('destination');
    });

    it('answers a list for junk input', () => {
        expect(applyDestination(null, 'u-42', null)).toEqual([]);
    });
});
