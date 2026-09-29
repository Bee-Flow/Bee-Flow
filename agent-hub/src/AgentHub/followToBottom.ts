/**
 * Put a chat scroller at its latest message, and keep it there while the
 * messages finish laying out (BFSF-453).
 *
 * One scroll right after the commit is not enough for a conversation that was
 * just loaded: images, code blocks and other late content grow AFTER that
 * commit and push the latest message back down, so a single scroll lands short
 * of it. For a short while every growth of the content re-pins the bottom.
 *
 * It lets go early the moment the reader scrolls up. That is read off the
 * scroll position, not the distance to the bottom: growing content moves the
 * bottom away without moving `scrollTop`, and only a reader (or a shrink the
 * browser clamps) moves `scrollTop` back up.
 *
 * `scrollTop` on the scroller, not scrollIntoView on a sentinel, so no
 * scrollable ancestor (the page) moves with it; always instant, so our own
 * scroll never reads as the reader's. Returns a function that stops following.
 */
export default function followToBottom(
    container: HTMLElement,
    { durationMs = 2500 }: { durationMs?: number } = {},
): () => void {
    let stopped = false;
    let pinnedTop = 0;

    const pin = () => {
        container.scrollTop = container.scrollHeight;
        pinnedTop = container.scrollTop;
    };

    const onScroll = () => {
        if (container.scrollTop < pinnedTop - 1) stop();
    };

    const observer = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => { if (!stopped) pin(); })
        : null;

    const timer = setTimeout(() => stop(), durationMs);

    function stop() {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        observer?.disconnect();
        container.removeEventListener('scroll', onScroll);
    }

    pin();
    container.addEventListener('scroll', onScroll, { passive: true });
    const content = container.firstElementChild;
    if (observer && content) observer.observe(content);
    return stop;
}
