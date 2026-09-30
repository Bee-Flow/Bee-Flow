import { translate } from '@/core/i18n';

import {
    applyEveryone,
    applyGroup,
    ceilingByKind,
    everyoneState,
    groupState,
    holdersSummary,
    isCapabilityKind,
    kindLabel,
    sectionsByKind,
    withGrant,
} from './access';
import type { Capability, GroupAccess } from './types';

const cap = (id: string, kind: string, extra: Partial<Capability> = {}): Capability => ({ id, kind, name: id, ...extra });

const access: GroupAccess = {
    orgId: 'o1',
    mode: 'cloud',
    capabilities: [
        cap('notes', 'core', { category: 'b' }),
        cap('apps', 'core', { category: 'a' }),
        cap('labs', 'beta'),
        cap('slack', 'integration'),
        cap('jira', 'integration'),
    ],
    ceiling: ['notes', 'apps', 'labs', 'slack'],
    everyone: ['notes', 'slack'],
    groups: [
        { id: 'g1', name: 'Sales', granted: ['apps'] },
        { id: 'g2', name: 'Ops', granted: ['apps', 'jira'] },
    ],
    betaGoverned: true,
};

const byId = (id: string) => access.capabilities.find((c) => c.id === id) as Capability;

describe('sections', () => {
    it('groups by kind in kind order, category then name, empty kinds dropped', () => {
        const sections = sectionsByKind(access.capabilities, ['integration', 'core']);
        expect(sections.map((s) => s.kind)).toEqual(['integration', 'core']);
        expect(sections[1]?.data.map((c) => c.id)).toEqual(['apps', 'notes']);
        expect(sectionsByKind([cap('x', 'core')], ['beta'])).toEqual([]);
    });

    it('lists the ceiling per kind, keeping empty kinds', () => {
        const sections = ceilingByKind({ ...access, ceiling: ['notes'] });
        expect(sections.map((s) => [s.kind, s.data.length])).toEqual([['core', 1], ['beta', 0], ['integration', 0]]);
    });

    it('recognises a kind and names it', () => {
        expect(isCapabilityKind('integration')).toBe(true);
        expect(isCapabilityKind('nope')).toBe(false);
        expect(kindLabel('beta', translate)).toBe('Beta features');
    });
});

describe('scope state', () => {
    it('everyone: granted, governed beta on and fixed, outside the ceiling locked', () => {
        expect(everyoneState(access, byId('notes'))).toEqual({ checked: true, readOnly: false, inherited: false });
        expect(everyoneState(access, byId('labs'))).toMatchObject({ checked: true, readOnly: true });
        expect(everyoneState(access, byId('jira'))).toMatchObject({ checked: false, readOnly: true });
    });

    it('a group inherits what everyone has, holds its own, and is locked outside the ceiling', () => {
        expect(groupState(access, byId('notes'), 'g1')).toEqual({ checked: true, readOnly: true, inherited: true });
        expect(groupState(access, byId('apps'), 'g1')).toEqual({ checked: true, readOnly: false, inherited: false });
        expect(groupState(access, byId('apps'), 'nope')).toMatchObject({ checked: false });
        expect(groupState(access, byId('jira'), 'g2')).toMatchObject({ checked: true, readOnly: true });
    });
});

describe('writes', () => {
    it('sends the whole list with the one change', () => {
        expect(withGrant(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c']);
        expect(withGrant(['a', 'b'], 'a', false)).toEqual(['b']);
        expect(withGrant(['a'], 'a', true)).toEqual(['a']);
    });

    it('applies a write optimistically', () => {
        expect(applyEveryone(access, []).everyone).toEqual([]);
        expect(applyGroup(access, 'g1', ['x']).groups.map((g) => g.granted)).toEqual([['x'], ['apps', 'jira']]);
    });

    it('says who holds a capability', () => {
        expect(holdersSummary(access, byId('notes'), translate)).toBe('All members');
        expect(holdersSummary(access, byId('apps'), translate)).toBe('2 groups');
        expect(holdersSummary({ ...access, groups: [access.groups[0]!] }, byId('apps'), translate)).toBe('1 group');
        expect(holdersSummary({ ...access, betaGoverned: false }, byId('labs'), translate)).toBe('Not granted');
        expect(holdersSummary(access, byId('jira'), translate)).toBe('Outside your organisation’s access');
    });
});
