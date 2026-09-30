/**
 * rebaseDoc.ts — carry a whole-document rewrite onto a document that others
 * have changed since the rewrite was made.
 *
 * An AI fill (or any rewrite of the whole document) starts from a snapshot,
 * `base`, and takes a while; meanwhile co-editors keep typing, so the editor
 * now holds `current`. Writing the rewrite, `next`, as it is would delete
 * everything they did since. Instead both changes are replayed from the
 * snapshot as two concurrent edits of one shared document (two Yjs replicas
 * of `base`: one edited to `current`, one to `next`) and merged the way
 * co-editing merges typing. The rewrite lands, and the paragraphs and words
 * the others added stay.
 *
 * When nothing changed since the snapshot the rewrite is returned as it is.
 */
import * as Y from 'yjs';
import { astToFragment, fragmentToAst, sameInY } from './yConvert';
import { syncDocToFragment } from './ySync';
import { FRAGMENT_NAME, type AstNode } from './ySchema';

function replica(state: Uint8Array): Y.Doc {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
}

/** `next` (made from `base`) with the changes `current` has over `base` kept. */
export function rebaseDoc(base: AstNode, current: AstNode, next: AstNode): AstNode {
    if (sameInY(base, current, 0)) return next;
    const origin = new Y.Doc();
    astToFragment(base, origin.getXmlFragment(FRAGMENT_NAME));
    const start = Y.encodeStateAsUpdate(origin);
    const theirs = replica(start);
    const mine = replica(start);
    try {
        syncDocToFragment(theirs.getXmlFragment(FRAGMENT_NAME), current);
        syncDocToFragment(mine.getXmlFragment(FRAGMENT_NAME), next);
        Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs, Y.encodeStateVector(mine)));
        return fragmentToAst(mine.getXmlFragment(FRAGMENT_NAME));
    } finally {
        origin.destroy();
        theirs.destroy();
        mine.destroy();
    }
}
