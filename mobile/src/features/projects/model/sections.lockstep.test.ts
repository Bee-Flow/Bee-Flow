/**
 * What a Solution can hold, held to its two sources (textual lockstep): the
 * server's membership registry (projects/membership.js — which sections
 * exist, which kind each files as, which are movable) and the web's
 * ProjectResourcesTab SECTIONS (their order, whose item is it) and
 * SolutionContentTable BANDS (who touches what). Then the rules that read it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { BANDS, bandOf, filedKeys, itemLabel, mayRemove, MOVABLE_SECTIONS, SECTIONS } from './sections';
import type { ProjectResources } from './types';

const REPO = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const MEMBERSHIP = read('server/projects/membership.js');
const WEB_SECTIONS = read('agent-hub/src/components/projects/ProjectResourcesTab.jsx');
const WEB_BANDS = read('agent-hub/src/components/projects/SolutionContentTable.jsx');

describe('the sections match the server registry', () => {
    const kinds = [...MEMBERSHIP.matchAll(/kind: '([a-z_]+)',\s*\n\s*section: '([a-zA-Z]+)'/g)].map((m) => [m[1], m[2]]);

    // The ORDER is the web's (its project page lists apps before routines);
    // the set, and the kind each section files as, is the server's.
    it('section for section, each filed as its kind', () => {
        expect(kinds.length).toBeGreaterThan(5);
        const byKey = (a: (string | undefined)[], b: (string | undefined)[]) => String(a[1]).localeCompare(String(b[1]));
        expect(SECTIONS.map((s) => [s.kind, s.key]).sort(byKey)).toEqual([...kinds].sort(byKey));
    });

    it('with approvals as the one kind that cannot be moved', () => {
        const approval = MEMBERSHIP.slice(MEMBERSHIP.indexOf("kind: 'approval'"));
        expect(approval.slice(0, approval.indexOf('},\n];'))).not.toContain('setProject');
        expect(SECTIONS.filter((s) => !s.movable).map((s) => s.kind)).toEqual(['approval']);
        expect(MOVABLE_SECTIONS).toHaveLength(SECTIONS.length - 1);
    });
});

describe('the sections match the web', () => {
    const web = [...WEB_SECTIONS.matchAll(/\{ key: '(\w+)'.*kind: '(\w+)', movable: (true|false), ownerFields: (null|\[[^\]]*\])/g)].map(
        (m) => ({
            key: m[1],
            kind: m[2],
            movable: m[3] === 'true',
            ownerFields: m[4] === 'null' ? null : [...(m[4] as string).matchAll(/'(\w+)'/g)].map((f) => f[1]),
        }),
    );

    it('with the same owner fields per kind', () => {
        expect(web).toHaveLength(SECTIONS.length);
        expect(SECTIONS.map((s) => ({ key: s.key, kind: s.kind, movable: s.movable, ownerFields: s.ownerFields }))).toEqual(web);
    });

    it('in the same three bands', () => {
        const bands = [...WEB_BANDS.matchAll(/\{ key: '(\w+)', labelKey: '[^']+', fallback: '[^']+', sections: \[([^\]]*)\] \}/g)].map((m) => ({
            key: m[1],
            sections: [...(m[2] as string).matchAll(/'(\w+)'/g)].map((s) => s[1]),
        }));
        expect(BANDS.map((b) => ({ key: b.key, sections: [...b.sections] }))).toEqual(bands);
    });
});

describe('the rules', () => {
    const apps = SECTIONS.find((s) => s.key === 'apps')!;
    const kbs = SECTIONS.find((s) => s.key === 'knowledgeBases')!;
    const approvals = SECTIONS.find((s) => s.key === 'approvals')!;

    it('offers "take it out" only to an editor who owns the item, or for a link on the project', () => {
        expect(mayRemove(apps, { id: 'a', userId: 'me' }, 'me', true)).toBe(true);
        expect(mayRemove(apps, { id: 'a', userId: 'you' }, 'me', true)).toBe(false);
        expect(mayRemove(apps, { id: 'a' }, 'me', true)).toBe(false);
        expect(mayRemove(apps, { id: 'a', userId: 'me' }, undefined, true)).toBe(false);
        expect(mayRemove(apps, { id: 'a', userId: 'me' }, 'me', false)).toBe(false);
        expect(mayRemove(kbs, { id: 'k' }, undefined, true)).toBe(true);
        expect(mayRemove(approvals, { id: 'x' }, 'me', true)).toBe(false);
    });

    it('labels an item by its name, title or question', () => {
        expect(itemLabel({ id: '1', name: 'A', title: 'B' })).toBe('A');
        expect(itemLabel({ id: '1', title: 'B' })).toBe('B');
        expect(itemLabel({ id: '1', prompt: 'Approve?' })).toBe('Approve?');
        expect(itemLabel({ id: '1' })).toBeNull();
    });

    it('puts a kind without a band in the last one, and knows what is already filed', () => {
        expect(bandOf('apps')).toBe('people');
        expect(bandOf('mystery' as never)).toBe('knowledge');
        const resources = { role: 'owner', apps: [{ id: 'a1' }], knowledgeBases: null } as unknown as ProjectResources;
        expect([...filedKeys(resources)]).toEqual(['app:a1']);
        expect(filedKeys(null).size).toBe(0);
    });
});
