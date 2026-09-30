/**
 * In-answer `#anchor` links, the phone's half of the web's heading ids.
 *
 * The web gives every heading an id and scrolls the message's container to
 * it. A phone has no ids and no document to query, so each rendered heading
 * registers itself (slug, text, view) with its answer's AnchorRegistry, and a
 * tapped `#fragment` is resolved there with the web's own matching rules
 * (parse/slug.ts).
 *
 * Scrolling needs the screen's scroll view, which a Markdown block cannot
 * reach: a screen that wants anchors to move wraps its content in
 * <MarkdownScrollHostProvider host={scrollViewHost(ref)}>. Without a host the
 * link is inert, as it was before — nothing opens a browser on `#x`.
 */

import React, { createContext, useContext, type ReactNode, type RefObject } from 'react';
import type { ScrollView, View } from 'react-native';

import { findAnchor, type AnchorHeading } from '../parse/slug';

export interface AnchorEntry extends AnchorHeading {
    /** Document order: block index, then position within the block. */
    order: number;
    view: View | null;
}

export class AnchorRegistry {
    private entries = new Map<string, AnchorEntry>();

    set(key: string, entry: AnchorEntry): void {
        this.entries.set(key, entry);
    }

    delete(key: string): void {
        this.entries.delete(key);
    }

    /** The heading `#fragment` names, in document order for the fuzzy pass. */
    find(fragment: string): AnchorEntry | undefined {
        const ordered = [...this.entries.values()].sort((a, b) => a.order - b.order);
        return findAnchor(fragment, ordered);
    }
}

/** What a screen offers its answers: bring this view into sight. */
export interface MarkdownScrollHost {
    scrollTo: (target: View) => void;
}

const ScrollHostContext = createContext<MarkdownScrollHost | null>(null);

export function MarkdownScrollHostProvider({ host, children }: { host: MarkdownScrollHost; children: ReactNode }) {
    return <ScrollHostContext.Provider value={host}>{children}</ScrollHostContext.Provider>;
}

export function useMarkdownScrollHost(): MarkdownScrollHost | null {
    return useContext(ScrollHostContext);
}

/** Room left above a heading scrolled to, so it does not sit under the edge. */
const HEADROOM = 12;

/** A host for a plain (non-inverted) ScrollView: measure against its content, scroll there. */
export function scrollViewHost(ref: RefObject<ScrollView | null>): MarkdownScrollHost {
    return {
        scrollTo(target) {
            const scroll = ref.current;
            const content = scroll?.getInnerViewNode();
            if (!scroll || !content) return;
            target.measureLayout(
                content,
                (_x, y) => scroll.scrollTo({ y: Math.max(0, y - HEADROOM), animated: true }),
                () => undefined,
            );
        },
    };
}
