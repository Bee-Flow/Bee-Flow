// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
    attachedNames,
    directChatKbList,
    resolveKbClaim,
    toggledIds,
    usableInChat,
} from './knowledgeBaseClaim';

/**
 * The KB pill answers "where will this answer come from?" — a question the
 * reader cannot check. So the tests below are mostly about the two ways of
 * getting that wrong, and both are silences rather than errors:
 *
 *   claiming NOTHING when the list never loaded, and
 *   counting an id the server did not hand back.
 */

const kb = (id, extra = {}) => ({ id, name: id.toUpperCase(), ...extra });

describe('usableInChat', () => {
    it('offers a base whose contexts include direct chat', () => {
        expect(usableInChat({ usage_contexts: ['direct_chat', 'agent'] })).toBe(true);
        expect(usableInChat({ usage_contexts: '["direct_chat"]' })).toBe(true);
        expect(usableInChat({ usageContexts: ['direct_chat'] })).toBe(true);
    });

    it('withholds one its owner kept out of chat', () => {
        expect(usableInChat({ usage_contexts: ['agent'] })).toBe(false);
        expect(usableInChat({ usage_contexts: '["webpage"]' })).toBe(false);
        expect(usableInChat({ usage_contexts: [] })).toBe(false);
    });

    it('reads an unexpressed value as everywhere, never as nowhere', () => {
        // An install predating the column has NULL on every row. Reading that
        // as "nowhere" empties the picker for everyone who upgraded.
        expect(usableInChat({})).toBe(true);
        expect(usableInChat({ usage_contexts: null })).toBe(true);
        expect(usableInChat({ usage_contexts: 'not json' })).toBe(true);
        expect(usableInChat({ usage_contexts: 7 })).toBe(true);
    });
});

describe('resolveKbClaim — when there is nothing to say', () => {
    it('says nothing at all while the list is unknown', () => {
        // null is not empty: /api/kb is lazy and it can fail. "No knowledge
        // bases" and "we could not ask" read identically and mean opposite
        // things about where the next answer comes from.
        expect(resolveKbClaim({ availableKBs: null, selectedKBIds: [] })).toBeNull();
        expect(resolveKbClaim({ availableKBs: undefined, selectedKBIds: [] })).toBeNull();
        expect(resolveKbClaim({})).toBeNull();
        expect(resolveKbClaim()).toBeNull();
    });

    it('stays silent even when this chat is holding ids', () => {
        // The tempting shortcut — "we know two are attached, show 2" — names a
        // count the server has not re-authorised on this read.
        expect(resolveKbClaim({ availableKBs: null, selectedKBIds: ['a', 'b'] })).toBeNull();
    });

    it('distinguishes an answered-and-empty list from an unanswered one', () => {
        const claim = resolveKbClaim({ availableKBs: [], selectedKBIds: [] });
        expect(claim).not.toBeNull();
        expect(claim.options).toEqual([]);
        expect(claim.attached).toEqual([]);
    });
});

describe('resolveKbClaim — the server filters, this subtracts', () => {
    it('counts only what came back in the list', () => {
        // 'ghost' is a base that was deleted, unshared, or taken out of chat.
        // It survives in the stored column and in whatever the client held.
        const claim = resolveKbClaim({
            availableKBs: [kb('kb1'), kb('kb2')],
            selectedKBIds: ['kb1', 'ghost'],
        });
        expect(claim.attachedIds).toEqual(['kb1']);
        expect(claim.attached).toHaveLength(1);
    });

    it('never offers or counts a base kept out of chat', () => {
        const claim = resolveKbClaim({
            availableKBs: [kb('kb1'), kb('kb2', { usage_contexts: ['agent'] })],
            selectedKBIds: ['kb1', 'kb2'],
        });
        expect(claim.options.map(k => k.id)).toEqual(['kb1']);
        expect(claim.attachedIds).toEqual(['kb1']);
    });

    it('keeps the list order rather than the selection order', () => {
        const claim = resolveKbClaim({
            availableKBs: [kb('a'), kb('b'), kb('c')],
            selectedKBIds: ['c', 'a'],
        });
        expect(claim.attachedIds).toEqual(['a', 'c']);
    });

    it('ignores rows with no usable id, and a selection that is not a list', () => {
        const claim = resolveKbClaim({
            availableKBs: [kb('a'), { name: 'no id' }, null, { id: '' }],
            selectedKBIds: 'kb1',
        });
        expect(claim.options.map(k => k.id)).toEqual(['a']);
        expect(claim.attachedIds).toEqual([]);
    });
});

describe('attachedNames', () => {
    it('names only what it can name', () => {
        const claim = resolveKbClaim({
            availableKBs: [kb('a', { name: 'Handbook' }), kb('b', { name: '   ' }), kb('c', { name: null })],
            selectedKBIds: ['a', 'b', 'c'],
        });
        // A base with no name is left out entirely rather than shown as its
        // id — a uuid reads like a name to anyone who has not seen one.
        expect(attachedNames(claim)).toEqual(['Handbook']);
    });

    it('has nothing to say without a claim', () => {
        expect(attachedNames(null)).toEqual([]);
    });
});

describe('toggledIds', () => {
    const claim = resolveKbClaim({
        availableKBs: [kb('a'), kb('b')],
        selectedKBIds: ['a', 'ghost'],
    });

    it('adds and removes against the confirmed subset', () => {
        expect(toggledIds(claim, 'b')).toEqual(['a', 'b']);
        expect(toggledIds(claim, 'a')).toEqual([]);
    });

    it('drops a dead id instead of resending it forever', () => {
        // Resending 'ghost' makes the server refuse the whole PATCH (400,
        // nothing stored) on EVERY later change — the picker would look
        // broken rather than stale.
        expect(toggledIds(claim, 'b')).not.toContain('ghost');
    });

    it('starts from nothing when there is no claim', () => {
        expect(toggledIds(null, 'a')).toEqual(['a']);
    });
});

describe('directChatKbList — what the call site may hand the picker', () => {
    it('hands over nothing at all until GET /api/kb has answered', () => {
        // The hub holds `[]` before the first fetch AND after a 401 or a 500.
        // Passing that array on is how a chat grounded on three bases ends up
        // under a confident "no knowledge bases".
        expect(directChatKbList([], false)).toBeNull();
        expect(directChatKbList([kb('a')], false)).toBeNull();
        expect(directChatKbList(null, false)).toBeNull();
    });

    it('hands over the chat-usable rows once it has', () => {
        const list = directChatKbList([kb('a'), kb('b', { usage_contexts: ['agent'] })], true);
        expect(list.map(k => k.id)).toEqual(['a']);
    });

    it('hands over an empty list when the answer really was empty', () => {
        expect(directChatKbList([], true)).toEqual([]);
        expect(directChatKbList(undefined, true)).toEqual([]);
    });
});
