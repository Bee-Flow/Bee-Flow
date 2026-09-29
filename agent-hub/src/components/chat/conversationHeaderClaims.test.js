import { describe, it, expect } from 'vitest';

import { headerKbState, headerShieldState } from './conversationHeaderClaims';

/**
 * The two statements the conversation header may make (C1).
 *
 * Both are believed on sight — a header is read the way a letterhead is read —
 * so what is pinned here is not the wording but the DISTINCTION underneath it:
 * a runtime claim and a configuration claim must not collapse into each other,
 * and an unknown status must not collapse into a negative one.
 */

const STATUS = (over = {}) => ({
    enabled: true,
    source: 'org',
    action: 'redact',
    failMode: 'fail_closed',
    guardReachable: true,
    euMode: false,
    coworkEnabled: false,
    ...over,
});

describe('headerShieldState — "switched on" is not "being shielded"', () => {
    it('claims the runtime state only when the detector can actually scan', () => {
        expect(headerShieldState(STATUS())).toBe('active');
    });

    it('drops to the configuration claim when the guard is unreachable', () => {
        // The single most important line here: on + nothing scanning is NOT
        // active. It gets its own, weaker word, never the runtime one.
        expect(headerShieldState(STATUS({ guardReachable: false }))).toBe('unverified');
    });

    it('says nothing when the shield is off, however healthy the guard is', () => {
        expect(headerShieldState(STATUS({ enabled: false }))).toBeNull();
        expect(headerShieldState(STATUS({ enabled: false, guardReachable: false }))).toBeNull();
    });

    it('says nothing when the status is unknown', () => {
        // Offline, 401, an unreadable body: all arrive as null, and none of
        // them is evidence that the shield is off.
        expect(headerShieldState(null)).toBeNull();
        expect(headerShieldState(undefined)).toBeNull();
    });

    it('does not read a truthy non-boolean as switched on', () => {
        expect(headerShieldState({ enabled: 'yes', guardReachable: true })).toBeNull();
    });

    it('holds every action, because none of them is what the pill claims', () => {
        // The header says the shield is working, not what it does with a hit —
        // block and ask are as active as redact.
        expect(headerShieldState(STATUS({ action: 'block' }))).toBe('active');
        expect(headerShieldState(STATUS({ action: 'ask' }))).toBe('active');
        expect(headerShieldState(STATUS({ action: null }))).toBe('active');
    });
});

const KB = (id, name) => ({ id, name, usage_contexts: ['direct_chat'] });

describe('headerKbState — the server filters, the header subtracts', () => {
    it('says nothing while the list of knowledge bases is unknown', () => {
        // Not the same as "none attached": /api/kb is lazy and can fail, and
        // an authoritative-looking silence is a claim of its own.
        expect(headerKbState({ availableKBs: null, selectedKBIds: ['a'] })).toBeNull();
        expect(headerKbState({ availableKBs: undefined, selectedKBIds: ['a'] })).toBeNull();
        expect(headerKbState({})).toBeNull();
        expect(headerKbState()).toBeNull();
    });

    it('says nothing when this chat is grounded on nothing', () => {
        expect(headerKbState({ availableKBs: [KB('a', 'Sales manual')], selectedKBIds: [] })).toBeNull();
    });

    it('names the single attached base outright', () => {
        const state = headerKbState({
            availableKBs: [KB('a', 'Sales manual'), KB('b', 'HR')],
            selectedKBIds: ['a'],
        });
        expect(state).toEqual({ count: 1, names: ['Sales manual'], name: 'Sales manual' });
    });

    it('never counts an id the server did not hand back', () => {
        // A base that was deleted, unshared, or taken out of chat stays in the
        // stored selection; counting it would tell the reader their answer is
        // grounded on something nothing will search.
        const state = headerKbState({
            availableKBs: [KB('a', 'Sales manual')],
            selectedKBIds: ['a', 'deleted-one', 'unshared-one'],
        });
        expect(state.count).toBe(1);
        expect(state.names).toEqual(['Sales manual']);
    });

    it('does not count a base this organisation took out of chat', () => {
        const state = headerKbState({
            availableKBs: [{ id: 'a', name: 'Runbook', usage_contexts: ['agent'] }],
            selectedKBIds: ['a'],
        });
        expect(state).toBeNull();
    });

    it('falls back to the count rather than showing an id as a name', () => {
        const state = headerKbState({
            availableKBs: [{ id: '9f3c-uuid', usage_contexts: ['direct_chat'] }],
            selectedKBIds: ['9f3c-uuid'],
        });
        expect(state.count).toBe(1);
        expect(state.name).toBeNull();
        expect(state.names).toEqual([]);
    });

    it('counts several, and keeps their names for the tooltip', () => {
        const state = headerKbState({
            availableKBs: [KB('a', 'Sales manual'), KB('b', 'HR'), KB('c', 'Legal')],
            selectedKBIds: ['a', 'c'],
        });
        expect(state.count).toBe(2);
        expect(state.name).toBeNull();
        expect(state.names).toEqual(['Sales manual', 'Legal']);
    });
});
