import { describe, expect, it } from 'vitest';
import type { ProjectMembers } from '@/api/queries/projects';
import type { ValueRequest } from '@/api/templateFillTeamApi';
import { colleaguesOf, fieldNotes, nameFor } from './projectFillModel';

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
        const requests: ValueRequest[] = [
            { id: 'r1', fields: ['iban', 'kvk'], assigneeId: 'bob', requestedBy: 'alice', message: '', createdAt: 'x' },
            { id: 'r2', fields: ['vat'], assigneeId: 'carol', requestedBy: 'alice', message: '', createdAt: 'x', cancelledAt: 'y' },
        ];
        const name = (id: string) => nameFor(members, 'alice', id, t);
        const notes = fieldNotes(requests, { iban: { userId: 'bob', at: 'z' } }, name, t);
        expect(notes).toEqual({ iban: 'Filled in by Bob', kvk: 'Asked of Bob' });
    });
});
