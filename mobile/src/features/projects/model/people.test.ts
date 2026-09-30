/**
 * A project's people in words: names when the directory gives them, roles
 * when it does not, and the caller's own share (the one they can leave).
 */

import { translate } from '@/core/i18n';

import { memberTitle, nameResolver, ownShare, roleLabel } from './people';
import type { ProjectShare } from './types';

function share(over: Partial<ProjectShare>): ProjectShare {
    return {
        id: 's1',
        projectId: 'p1',
        sharedWithType: 'user',
        sharedWithId: 'u2',
        permission: 'editor',
        createdAt: null,
        ...over,
    };
}

describe('nameResolver', () => {
    const nameFor = nameResolver({
        users: [{ id: 'u1', displayName: 'Ada' }, { id: 'u2', username: 'grace' }, { id: 'u3' }],
        groups: [{ id: 'g1', name: 'Finance' }, { id: 'g2' }],
    });

    it('prefers a display name, then a username, then the id', () => {
        expect(nameFor({ sharedWithType: 'user', sharedWithId: 'u1' })).toBe('Ada');
        expect(nameFor({ sharedWithType: 'user', sharedWithId: 'u2' })).toBe('grace');
        expect(nameFor({ sharedWithType: 'user', sharedWithId: 'u3' })).toBe('u3');
    });

    it('looks groups up among groups, and answers null for a stranger', () => {
        expect(nameFor({ sharedWithType: 'group', sharedWithId: 'g1' })).toBe('Finance');
        expect(nameFor({ sharedWithType: 'group', sharedWithId: 'g2' })).toBe('g2');
        expect(nameFor({ sharedWithType: 'group', sharedWithId: 'u1' })).toBeNull();
        expect(nameFor({ sharedWithType: 'user', sharedWithId: 'nobody' })).toBeNull();
    });

    it('resolves nothing without a directory', () => {
        expect(nameResolver(undefined)({ sharedWithType: 'user', sharedWithId: 'u1' })).toBeNull();
    });
});

describe('memberTitle', () => {
    const nameFor = nameResolver({ users: [{ id: 'u2', displayName: 'Grace' }], groups: [] });

    it('says You for the caller, a name when known, and the kind of member otherwise', () => {
        expect(memberTitle(share({ sharedWithId: 'me' }), 'me', nameFor, translate)).toBe('You');
        expect(memberTitle(share({}), 'me', nameFor, translate)).toBe('Grace');
        expect(memberTitle(share({ sharedWithId: 'x' }), 'me', nameFor, translate)).toBe('A colleague');
        expect(memberTitle(share({ sharedWithType: 'group', sharedWithId: 'g' }), 'me', nameFor, translate)).toBe('A group');
    });
});

describe('roleLabel and ownShare', () => {
    it('names each role in the web words', () => {
        expect(['owner', 'editor', 'viewer'].map((r) => roleLabel(r as ProjectShare['permission'], translate))).toEqual([
            'owner',
            'editor',
            'viewer',
        ]);
    });

    it('finds only a PERSON share of the caller — a group cannot be left', () => {
        const members = [share({ id: 'g', sharedWithType: 'group', sharedWithId: 'me' }), share({ id: 'mine', sharedWithId: 'me' })];
        expect(ownShare(members, 'me')?.id).toBe('mine');
        expect(ownShare(members, undefined)).toBeNull();
        expect(ownShare([share({})], 'me')).toBeNull();
    });
});
