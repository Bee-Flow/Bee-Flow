/**
 * Outbox — the queue of updates the server has not confirmed: batches leave
 * the queue while in flight, come back in front when they fail, are bounded
 * by bytes and split on request, and a sync's catch-up never turns separate
 * updates into one the server cannot take.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Outbox, chunkByBytes, mergeAll } from './outbox';

/** A document and the updates of each of its edits. */
function edits(texts: string[]) {
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    for (const t of texts) doc.getText('t').insert(doc.getText('t').length, t);
    return { doc, updates };
}
const textOf = (list: Uint8Array[]) => {
    const d = new Y.Doc();
    Y.applyUpdate(d, mergeAll(list));
    return d.getText('t').toString();
};

describe('Outbox', () => {
    it('takes a batch out while it is in flight; a failed one goes back in front of what queued meanwhile', () => {
        const { updates: [a, b, c] } = edits(['a', 'b', 'c']);
        const box = new Outbox();
        box.push(a); box.push(b);
        const batch = box.take();
        expect(batch).toEqual([a, b]);
        expect(box.size).toBe(0);
        box.push(c);
        box.settle(false);
        expect(box.all()).toEqual([a, b, c]);
        expect(box.pending).toBe(true);
        box.take();
        box.settle(true);
        expect(box.pending).toBe(false);
    });

    it('keeps what queued behind a batch in flight when a sync replaces the queue', () => {
        const { doc, updates: [a, b] } = edits(['a', 'b']);
        const box = new Outbox();
        box.push(a);
        box.take();
        box.push(b);
        box.catchUp(Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc));
        box.settle(true);
        expect(textOf(box.all())).toBe('ab');
    });

    it('bounds a batch by bytes and splits one the server found too large', () => {
        const { updates } = edits(['x'.repeat(100), 'y'.repeat(100), 'z'.repeat(100)]);
        const box = new Outbox(1000);
        updates.forEach((u) => box.push(u));
        const batch = box.take();
        expect(batch).toHaveLength(3);
        box.settle(false);
        expect(box.split(batch)).toBe(true);
        expect(box.take().length).toBeLessThan(3);
        expect(box.split([updates[0]])).toBe(false);
        expect(chunkByBytes(updates, 150).map((r) => r.length)).toEqual([1, 1, 1]);
    });

    it('keeps separate updates for a large catch-up they cover, and sends one they do not cover as it is', () => {
        const { doc, updates } = edits(['x'.repeat(400), 'y'.repeat(400)]);
        const covered = new Outbox(500);
        updates.forEach((u) => covered.push(u));
        covered.catchUp(Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc));
        expect(covered.all().slice(0, 2)).toEqual(updates);
        expect(covered.all()[2].length).toBeLessThan(100);
        expect(textOf(covered.all())).toBe('x'.repeat(400) + 'y'.repeat(400));

        const lost = new Outbox(500);
        lost.push(updates[1]);
        const missing = Y.encodeStateAsUpdate(doc);
        lost.catchUp(missing, Y.encodeStateVector(doc));
        expect(lost.all()).toContain(missing);
        expect(textOf(lost.all())).toBe('x'.repeat(400) + 'y'.repeat(400));
    });
});
