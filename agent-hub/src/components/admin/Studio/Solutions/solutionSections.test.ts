import { describe, expect, it } from 'vitest';
import { SECTIONS, itemLabel, mayRemove } from './solutionSections';

const section = (key: string) => {
    const found = SECTIONS.find(s => s.key === key);
    if (!found) throw new Error(`no section ${key}`);
    return found;
};

describe('the sections a Solution holds', () => {
    it('lists the same eight kinds, in order', () => {
        expect(SECTIONS.map(s => s.key)).toEqual([
            'notebooks', 'apps', 'automations', 'webpages',
            'datatables', 'agents', 'knowledgeBases', 'approvals',
        ]);
    });

    it('names a distinct server kind per section', () => {
        const kinds = SECTIONS.map(s => s.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
        for (const s of SECTIONS) expect(s.labelKey).toMatch(/^[a-z_]+\./);
    });

    it('does not offer the workspace-only kinds', () => {
        const kinds = SECTIONS.map(s => s.kind);
        expect(kinds).not.toContain('document');
        expect(kinds).not.toContain('meeting');
    });
});

describe('itemLabel', () => {
    it('reads name, then title, then the question an approval asks', () => {
        expect(itemLabel({ name: 'By name', title: 'no' })).toBe('By name');
        expect(itemLabel({ title: 'By title' })).toBe('By title');
        expect(itemLabel({ prompt: 'Ship it?' })).toBe('Ship it?');
    });

    it('falls back when the item carries none of them', () => {
        expect(itemLabel({})).toBe('Untitled');
        expect(itemLabel({ name: '' })).toBe('Untitled');
    });
});

describe('mayRemove', () => {
    it('lets the owner of an item take it out when they may edit', () => {
        expect(mayRemove(section('apps'), { userId: 'me' }, 'me', true)).toBe(true);
        expect(mayRemove(section('apps'), { ownerId: 'me' }, 'me', true)).toBe(true);
    });

    it('refuses anyone who may not edit', () => {
        expect(mayRemove(section('apps'), { userId: 'me' }, 'me', false)).toBe(false);
    });

    it('refuses a colleague\'s item, even to the Solution owner', () => {
        expect(mayRemove(section('apps'), { userId: 'anna' }, 'me', true)).toBe(false);
    });

    it('only reads the owner fields of that kind', () => {
        expect(mayRemove(section('apps'), { ownerUserId: 'me' }, 'me', true)).toBe(false);
        expect(mayRemove(section('datatables'), { ownerUserId: 'me' }, 'me', true)).toBe(true);
        expect(mayRemove(section('agents'), { ownerId: 'me' }, 'me', true)).toBe(true);
    });

    it('treats a knowledge base link as the Solution\'s, not the item owner\'s', () => {
        expect(mayRemove(section('knowledgeBases'), {}, 'me', true)).toBe(true);
        expect(mayRemove(section('knowledgeBases'), {}, 'me', false)).toBe(false);
    });

    it('never offers to remove an approval', () => {
        expect(mayRemove(section('approvals'), { userId: 'me' }, 'me', true)).toBe(false);
    });

    it('withholds the answer when nobody is signed in', () => {
        expect(mayRemove(section('datatables'), { ownerUserId: undefined }, undefined, true)).toBe(false);
        expect(mayRemove(section('apps'), { userId: null }, null, true)).toBe(false);
    });
});
