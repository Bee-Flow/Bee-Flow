import { describe, expect, it } from 'vitest';
import type { ProjectMembers } from '../../../../api/queries/projects';
import { AI_TONE, aiToneFor, hueOf } from '../projectVisuals';
import { buildChatPeople } from './chatPeople';

const MEMBERS: ProjectMembers = {
    ownerId: 'u-owner',
    members: [{ id: 's1', sharedWithType: 'user', sharedWithId: 'u-jan', permission: 'editor' }],
    people: {
        'u-owner': { name: 'Olivia', avatar: '🦊', avatarType: 'emoji' },
        'u-jan': { name: 'Jan Test', avatar: '/api/projects/p1/avatars/u-jan?v=abc', avatarType: 'image' },
    },
    groups: {},
};

describe('avatars in the chat', () => {
    it('gives every member their own avatar from the member list', () => {
        const people = buildChatPeople(MEMBERS, { id: 'u-viewer', name: 'Vera' });
        expect(people.avatarOf('u-owner')).toEqual({ type: 'emoji', value: '🦊' });
        expect(people.avatarOf('u-jan')).toEqual({ type: 'image', value: '/api/projects/p1/avatars/u-jan?v=abc' });
        expect(people.avatarOf('u-unknown')).toBeUndefined();
        expect(people.avatarOf(null)).toBeUndefined();
    });

    it('shows the reader the avatar the app shows them, also when it only lives in their session', () => {
        const me = { id: 'u-jan', name: 'Jan Test', avatar: 'https://nc.example.test/avatar/jan/64', avatarType: 'url' };
        expect(buildChatPeople(MEMBERS, me).avatarOf('u-jan')).toEqual({ type: 'url', value: 'https://nc.example.test/avatar/jan/64' });
        // Somebody else's avatar is never taken from the reader.
        expect(buildChatPeople(MEMBERS, me).avatarOf('u-owner')).toEqual({ type: 'emoji', value: '🦊' });
        // A type the app does not know is not shown.
        expect(buildChatPeople(MEMBERS, { ...me, avatarType: 'weird' }).avatarOf('u-jan')).toEqual({ type: 'image', value: '/api/projects/p1/avatars/u-jan?v=abc' });
        // No avatar of their own: the member list has it, or there is none.
        expect(buildChatPeople(undefined, { id: 'u-x', name: 'X' }).avatarOf('u-x')).toBeUndefined();
    });
});

describe('a colour per person', () => {
    it('is stable, within the colour wheel, and differs between names', () => {
        expect(hueOf('Jan Test')).toBe(hueOf('Jan Test'));
        for (const n of ['Jan Test', 'Olivia', 'A', '', null, undefined]) {
            expect(hueOf(n)).toBeGreaterThanOrEqual(0);
            expect(hueOf(n)).toBeLessThan(360);
        }
        expect(hueOf('Jan Test')).not.toBe(hueOf('Olivia'));
    });
});

describe('the AI\'s colours follow the project', () => {
    it('mixes a little of the project colour into the card, the label and the edge', () => {
        const green = aiToneFor('#22c55e');
        for (const value of Object.values(green)) expect(value).toContain('#22c55e');
        expect(green.card).toMatch(/^color-mix\(in srgb, #22c55e 4\.5%, transparent\)$/);
        expect(green.ink).toContain('var(--text-primary)');
        expect(aiToneFor('#3b82f6').card).not.toBe(green.card);
    });

    it('falls back to the quiet default for no colour, or one that is not a colour', () => {
        expect(aiToneFor(null)).toEqual(AI_TONE);
        expect(aiToneFor(undefined)).toEqual(AI_TONE);
        expect(aiToneFor('red; background:url(x)')).toEqual(AI_TONE);
        expect(aiToneFor('')).toEqual(AI_TONE);
    });
});
