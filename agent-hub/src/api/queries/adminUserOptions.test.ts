import { describe, expect, it } from 'vitest';
import { toUserOptions } from './adminUserOptions';

describe('toUserOptions', () => {
    it('names an account by display name, then first and last name, then e-mail, sorted', () => {
        expect(toUserOptions([
            { id: 'u2', displayName: 'Zoë', email: 'z@example.com' },
            { id: 'u1', firstName: 'Ann', lastName: 'Lee', email: 'a@example.com' },
            { id: 'u3', email: 'only@example.com' },
        ])).toEqual([
            { id: 'u1', name: 'Ann Lee', email: 'a@example.com' },
            { id: 'u3', name: 'only@example.com', email: 'only@example.com' },
            { id: 'u2', name: 'Zoë', email: 'z@example.com' },
        ]);
    });

    it('leaves out the server\'s own system row, which no Microsoft identity can belong to', () => {
        // GET /auth/users without an organisation puts the built-in administrator first.
        const options = toUserOptions([
            { id: 'admin', displayName: 'Administrator (System)', role: 'admin', isSystem: true },
            { id: 'u1', displayName: 'Ann', email: 'a@example.com' },
        ]);
        expect(options.map(o => o.id)).toEqual(['u1']);
    });

    it('reads anything but a list as no accounts, and drops a row without an id', () => {
        expect(toUserOptions(null)).toEqual([]);
        expect(toUserOptions({ users: [] })).toEqual([]);
        expect(toUserOptions([{ displayName: 'No id' }, null])).toEqual([]);
    });
});
