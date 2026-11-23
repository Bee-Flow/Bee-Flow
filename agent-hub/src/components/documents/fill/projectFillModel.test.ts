import { describe, expect, it } from 'vitest';
import type { ProjectMembers } from '@/api/queries/projects';
import { NO_TEAM, type FillTeam, type ValueRequest } from '@/api/templateFillTeamApi';
import { askedOfMe, colleaguesOf, fieldHints, guideStep, nameFor, type GuideInput } from './projectFillModel';

const t = (_key: string, fallback: string, vars: Record<string, unknown> = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));

const members: ProjectMembers = {
    ownerId: 'alice',
    members: [
        { id: 's1', sharedWithType: 'user', sharedWithId: 'bob', permission: 'editor' },
        { id: 's2', sharedWithType: 'user', sharedWithId: 'carol', permission: 'viewer' },
        { id: 's3', sharedWithType: 'group', sharedWithId: 'g1', permission: 'editor' },
    ],
    people: { alice: { name: 'Alice' }, bob: { name: 'Bob' }, carol: { name: 'Carol' } },
    groups: {},
};

const request = (over: Partial<ValueRequest>): ValueRequest => ({ id: 'r1', fields: ['iban'], assigneeId: 'bob', requestedBy: 'alice', message: '', createdAt: 'x', ...over });

describe('projectFillModel', () => {
    it('offers the owner and the editors, never a viewer, a group or the reader', () => {
        expect(colleaguesOf(members, 'bob')).toEqual([{ id: 'alice', name: 'Alice' }]);
        expect(colleaguesOf(members, 'carol').map((c) => c.name)).toEqual(['Alice', 'Bob']);
        expect(colleaguesOf(undefined, 'bob')).toEqual([]);
    });

    it('names the reader "you" and an unknown person "a colleague"', () => {
        expect(nameFor(members, 'bob', 'bob', t)).toBe('you');
        expect(nameFor(members, 'bob', 'alice', t)).toBe('Alice');
        expect(nameFor(members, 'bob', 'zed', t)).toBe('a colleague');
    });

    it('says who a field was asked of while open, and who filled it in once it is', () => {
        const requests = [request({ fields: ['iban', 'kvk'] }), request({ id: 'r2', fields: ['vat'], assigneeId: 'carol', cancelledAt: 'y' })];
        const name = (id: string) => nameFor(members, 'alice', id, t);
        const filledBy = { iban: { userId: 'bob', at: 'z' }, price: { userId: 'alice', at: 'z', via: 'ai' as const } };
        expect(fieldHints({ requests, filledBy }, name, t)).toEqual({
            iban: { text: 'Filled in by Bob', asked: false }, kvk: { text: 'Asked of Bob', asked: true },
            price: { text: 'Filled in by you, with the assistant', asked: false },
        });
        // Bob reads the same document: at the field asked of him it says who is waiting, not "asked of you".
        const asBob = (id: string) => nameFor(members, 'bob', id, t);
        expect(fieldHints({ requests, filledBy: {}, meId: 'bob' }, asBob, t).kvk).toEqual({ text: 'Alice is waiting for this', asked: true });
    });

    it('lists what colleagues still wait for from the reader: open requests, empty fields, each once', () => {
        const requests = [
            request({ fields: ['iban', 'kvk'] }), request({ id: 'r2', fields: ['kvk', 'vat'] }),
            request({ id: 'r3', fields: ['done'], doneAt: 'y' }), request({ id: 'r4', fields: ['other'], assigneeId: 'carol' }),
        ];
        expect(askedOfMe(requests, 'bob', { iban: 'NL91' })).toEqual(['kvk', 'vat']);
        expect(askedOfMe(requests, null, {})).toEqual([]);
    });
});

describe('guideStep: the one thing to do next', () => {
    const team = (over: Partial<FillTeam> = {}): FillTeam => ({ ...NO_TEAM, ...over });
    const step = (over: Partial<GuideInput> = {}) => guideStep({
        editable: true, finished: false, missing: [], team: NO_TEAM, meId: 'bob', values: {}, checkAhead: true, ...over,
    });
    const remark = { key: 'scope', kind: 'doubt' as const, reason: 'Looks off.' };

    it('a reader who cannot change it is told so, and a finished document is finished, before anything else', () => {
        expect(step({ editable: false, finished: true, missing: ['a'] })).toEqual({ kind: 'readOnly' });
        expect(step({ finished: true, missing: ['a'] })).toEqual({ kind: 'done' });
    });

    it('what colleagues asked of the reader comes first, then what is still needed (and how much of it others were asked for)', () => {
        const requests = [request({ fields: ['iban'] }), request({ id: 'r2', fields: ['price'], assigneeId: 'alice' })];
        expect(step({ missing: ['iban', 'price', 'scope'], team: team({ requests }) })).toEqual({ kind: 'asked', count: 1 });
        expect(step({ missing: ['price', 'scope'], team: team({ requests }), values: { iban: 'NL91' } })).toEqual({ kind: 'missing', count: 2, waiting: 1 });
    });

    it('once everything needed is in: the remarks of the check, else the check, else finishing', () => {
        const review = { at: 'now', checked: 3, findings: [remark] };
        expect(step({ team: team({ review }), checkAhead: false })).toEqual({ kind: 'remarks', count: 1 });
        expect(step()).toEqual({ kind: 'check' });
        expect(step({ team: team({ review: { ...review, findings: [] } }), checkAhead: false })).toEqual({ kind: 'finish', checked: true });
        // The check could not run: finishing is still the next step, without claiming it was checked.
        expect(step({ checkAhead: false })).toEqual({ kind: 'finish', checked: false });
    });
});
