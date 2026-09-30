import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { createCursorPublisher, readPeers, setLocalUser } from './awareness';
import { PEER_COLORS, peerClass, peerColor, peerColorIndex, peerHighlightName } from './colors';

describe('presence state', () => {
    let docs: Y.Doc[] = [];
    const aw = () => { const d = new Y.Doc(); docs.push(d); return new Awareness(d); };
    afterEach(() => { docs.forEach((d) => d.destroy()); docs = []; });

    it('reads other clients only, validated, and never trusts shapes from elsewhere', () => {
        const mine = aw();
        setLocalUser(mine, 'me');
        const states = mine.getStates();
        states.set(101, { user: { id: 'u2' }, cursor: { anchor: 'AA==', head: 'AQ==' }, editing: true });
        states.set(102, { user: { id: 42 } });
        states.set(103, { user: { id: 'u3' }, cursor: { anchor: 'x'.repeat(600), head: 'y' }, editing: 'yes' });
        states.set(104, { cursor: { anchor: 'a', head: 'b' } });
        const peers = readPeers(mine);
        expect(peers).toEqual([
            { clientId: 101, userId: 'u2', cursor: { anchor: 'AA==', head: 'AQ==' }, editing: true },
            { clientId: 103, userId: 'u3', cursor: null, editing: false },
        ]);
    });

    it('carries a user id only — no name, no document text', () => {
        const mine = aw();
        setLocalUser(mine, 'u1');
        expect(mine.getLocalState()).toEqual({ user: { id: 'u1' } });
    });
});

describe('cursor publisher', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('sends the first change at once and then at most one trailing change per window, with the latest value', () => {
        const a = new Awareness(new Y.Doc());
        const updates = vi.fn();
        a.on('change', updates);
        const pub = createCursorPublisher(a, { throttleMs: 100 });
        pub.publish({ anchor: 'a1', head: 'a1' }, true);
        expect(updates).toHaveBeenCalledTimes(1);
        pub.publish({ anchor: 'a2', head: 'a2' }, true);
        pub.publish({ anchor: 'a3', head: 'a3' }, true);
        expect(updates).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(100);
        expect(updates).toHaveBeenCalledTimes(2);
        expect(a.getLocalState()).toMatchObject({ cursor: { anchor: 'a3', head: 'a3' }, editing: true });
        a.destroy();
    });

    it('does not resend an unchanged caret, and flush sends immediately', () => {
        const a = new Awareness(new Y.Doc());
        const updates = vi.fn();
        a.on('change', updates);
        const pub = createCursorPublisher(a, { throttleMs: 100 });
        pub.publish(null, false);
        vi.advanceTimersByTime(200);
        pub.publish(null, false);
        vi.advanceTimersByTime(200);
        expect(updates).toHaveBeenCalledTimes(1);
        pub.publish({ anchor: 'b', head: 'b' }, true);
        pub.publish({ anchor: 'c', head: 'c' }, true);
        pub.flush();
        expect(a.getLocalState()).toMatchObject({ cursor: { anchor: 'c', head: 'c' } });
        pub.cancel();
        a.destroy();
    });
});

describe('peer colours', () => {
    it('are stable per person and come from the palette', () => {
        expect(peerColorIndex('anna')).toBe(peerColorIndex('anna'));
        expect(PEER_COLORS).toContain(peerColor('anna'));
        expect(peerClass('anna')).toBe(`bf-peer-${peerColorIndex('anna')}`);
        expect(peerColorIndex(null)).toBe(0);
    });

    it('spread different people over the palette', () => {
        const used = new Set(Array.from({ length: 40 }, (_, i) => peerColorIndex(`user-${i}`)));
        expect(used.size).toBeGreaterThan(4);
    });

    it('name a highlight per palette slot, wrapping out-of-range indexes', () => {
        expect(peerHighlightName(2)).toBe('bf-peer-sel-2');
        expect(peerHighlightName(PEER_COLORS.length + 1)).toBe('bf-peer-sel-1');
        expect(peerHighlightName(-1)).toBe(`bf-peer-sel-${PEER_COLORS.length - 1}`);
    });

    it('contain no purple, violet or indigo', () => {
        const hue = (hex: string) => {
            const n = parseInt(hex.slice(1), 16);
            const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
            const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
            if (!d) return 0;
            const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            return (h * 60 + 360) % 360;
        };
        // Indigo through purple is roughly 230°–300°.
        for (const hex of PEER_COLORS) expect(hue(hex) >= 230 && hue(hex) <= 300).toBe(false);
    });
});
