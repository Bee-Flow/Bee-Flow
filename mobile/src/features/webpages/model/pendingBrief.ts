/**
 * The description typed when a page was created, waiting for its builder
 * chat. The web opens a new page's editor and sends that description as the
 * first message; the phone does the same, across a navigation, so the brief
 * is parked here by page id and taken — once — by the Build tab.
 *
 * Device memory on purpose: a brief that was never sent is lost with the
 * process, and the page still has it as its instructions on the server.
 */

const briefs = new Map<string, string>();

export function parkBrief(pageId: string, brief: string): void {
    const text = brief.trim();
    if (text) briefs.set(pageId, text);
}

/** The parked brief, removed as it is returned so it is only ever sent once. */
export function takeBrief(pageId: string): string | null {
    const text = briefs.get(pageId) ?? null;
    briefs.delete(pageId);
    return text;
}
