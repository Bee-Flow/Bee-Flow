/**
 * The transcript's INVERTED list, scrolled: in-answer `#anchor` links, and
 * the way back to the newest message.
 *
 * shared/markdown's scrollViewHost measures against a plain ScrollView's
 * content; an inverted FlatList has no such frame to measure in — its
 * content is flipped — so this host measures on the screen instead: where
 * the heading is, where the list's top edge is, and moves the list by the
 * difference. In an inverted list a larger offset moves the content DOWN,
 * hence the sign — and offset 0 is the newest message.
 *
 * `away` says the newest message is out of view (the "Jump to latest"
 * button). It changes only when the offset crosses a threshold, with a gap
 * between showing and hiding, so scrolling does not re-render the list on
 * every event or flicker the button at the edge.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent, View } from 'react-native';

import type { MarkdownScrollHost } from '@/shared/markdown';

import type { ChatMessage } from '../model/types';

/** Room left above a heading scrolled to, so it does not sit under the edge. */
const HEADROOM = 12;

/** Scrolled this far up, the newest message is out of view: the jump button shows… */
const SHOW_JUMP_AT = 400;
/** …and it goes again once back within this much of it. */
const HIDE_JUMP_AT = 150;

/** The offset that puts a heading at `targetY` just under the list's top edge at `listTop`. */
export function invertedOffsetFor(offset: number, listTop: number, targetY: number): number {
    return Math.max(0, offset + (listTop + HEADROOM - targetY));
}

/** Whether "Jump to latest" shows at `offset`, given whether it shows now. */
export function awayFromLatest(showing: boolean, offset: number): boolean {
    return showing ? offset > HIDE_JUMP_AT : offset > SHOW_JUMP_AT;
}

export function useListScrollHost() {
    const list = useRef<FlatList<ChatMessage>>(null);
    const frame = useRef<View>(null);
    const offset = useRef(0);
    const awayNow = useRef(false);
    const [away, setAway] = useState(false);

    const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        offset.current = event.nativeEvent.contentOffset.y;
        const next = awayFromLatest(awayNow.current, offset.current);
        if (next === awayNow.current) return;
        awayNow.current = next;
        setAway(next);
    }, []);

    /** Back to the newest message: animated from the button, at once for a turn just sent. */
    const toLatest = useCallback((animated: boolean) => {
        list.current?.scrollToOffset({ offset: 0, animated });
    }, []);

    const host = useMemo<MarkdownScrollHost>(
        () => ({
            scrollTo(target) {
                const edge = frame.current;
                if (!edge || !list.current) return;
                edge.measureInWindow((_x, listTop) => {
                    target.measureInWindow((_tx, targetY) => {
                        list.current?.scrollToOffset({ offset: invertedOffsetFor(offset.current, listTop, targetY), animated: true });
                    });
                });
            },
        }),
        [],
    );

    return { list, frame, onScroll, host, away, toLatest };
}
