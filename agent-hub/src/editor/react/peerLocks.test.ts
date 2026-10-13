import { describe, it, expect } from 'vitest';
import type { CollabPeer } from '../collab/useCollab';
import { peerInBlocks } from './peerLocks';

const binding = { relToPos: (b64: string) => (b64 === 'gone' ? null : { path: [Number(b64), 0], offset: 0 }) };
const peer = (head: string | null) => ({ cursor: head == null ? null : { anchor: head, head } }) as unknown as CollabPeer;

describe('peerInBlocks', () => {
    it('is true when a co-editor\'s caret sits inside the moved blocks', () => {
        expect(peerInBlocks(binding, [peer('2')], 1, 2)).toBe(true);
        expect(peerInBlocks(binding, [peer('1')], 1, 1)).toBe(true);
    });

    it('is false for a caret outside the range, without a caret, or at a position that no longer exists', () => {
        expect(peerInBlocks(binding, [peer('3')], 1, 2)).toBe(false);
        expect(peerInBlocks(binding, [peer('0')], 1, 2)).toBe(false);
        expect(peerInBlocks(binding, [peer(null)], 0, 5)).toBe(false);
        expect(peerInBlocks(binding, [peer('gone')], 0, 5)).toBe(false);
    });

    it('is false without a binding or peers', () => {
        expect(peerInBlocks(null, [peer('1')], 0, 5)).toBe(false);
        expect(peerInBlocks(binding, [], 0, 5)).toBe(false);
        expect(peerInBlocks(binding, undefined, 0, 5)).toBe(false);
    });
});
