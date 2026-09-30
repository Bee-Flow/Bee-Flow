/**
 * A new chat's name arrives after its first answer. The server names the
 * chat in the background once `done` has gone out, and sends the name as a
 * `title` frame on the same socket, which it holds open up to 15 s for that
 * (routes/ai/directChat/streamTurn.js, TITLE_HOLD_MS). The phone stops
 * reading at `done`: the runner is shared by every chat surface, and reading
 * on would keep Stop up for those seconds. So the name is looked up instead —
 * the conversation and the list are read again a few seconds after such a
 * turn, and once more later only while the name has still not landed.
 */

/** When to look, after the turn. The second look covers a slow naming model; past 15 s the server has stopped waiting too. */
export const TITLE_CHECKS_MS: readonly number[] = [4_000, 12_000];

/** Whether a chat is still waiting for its name: the server's own test (finalizeTurn.js `_titleIsPlaceholder`). */
export function awaitsTitle(title: string | null | undefined): boolean {
    const trimmed = (title ?? '').trim();
    return !trimmed || /^new chat$/i.test(trimmed);
}
