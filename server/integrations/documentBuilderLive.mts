/**
 * The live layer of the document tools: a page that people are editing live
 * is read and written through the co-editing facade (core/collab), so every
 * open editor shows an AI change at once. The tools are documentBuilderTools.js.
 *
 * A page edited live has no stored revision that says what the model read: the live state
 * moves with every keystroke. document_read hands out a versionId that also names the live
 * update it read (`<versionId>@live:<seq>`); a full write is applied only while that is newest.
 */

/** The live co-editing facade (core/collab) as the document tools use it; every method may be missing. */
export type LiveCollab = {
    read?: (type: string, id: string) => Promise<{ html?: string, seq?: number } | null>,
    readHtml?: (type: string, id: string) => Promise<string | null>,
    withFragment?: <R>(type: string, id: string, fn: (state: { html: unknown, fragment: unknown }) => R) => Promise<R | null>,
    applyServerEdit?: (type: string, id: string, actor: { origin: string, actorId: string },
        edit: { replaceWith: { html: string }, expectSeq?: number }) => Promise<{ stale?: boolean, applied?: boolean, seq?: number } | null>,
};

type LiveDoc = { id: string, name: string, versionId?: string | null };
type EditResult = { error?: string, content?: string, message?: string };

const LIVE_MARK = '@live:';
const APP_PATH = 'app/studio/documents';

export function documentUrl(id: string): string {
    return `/${APP_PATH}/${id}`;
}

export const liveToken = (versionId: string | null | undefined, seq: number): string => `${versionId || ''}${LIVE_MARK}${seq}`;

export function parseExpected(value: unknown): { versionId: string | null, seq: number | null } {
    const text = typeof value === 'string' ? value : '';
    const at = text.lastIndexOf(LIVE_MARK);
    if (at < 0) return { versionId: text || null, seq: null };
    const seq = Number(text.slice(at + LIVE_MARK.length));
    return { versionId: text.slice(0, at) || null, seq: Number.isInteger(seq) && seq >= 0 ? seq : null };
}

/** The live state of a page and the update it is at (seq null when the facade cannot say). */
export async function readLive(live: LiveCollab, id: string): Promise<{ html: string | null, seq: number | null }> {
    if (typeof live.read === 'function') {
        const state = await live.read('document', id);
        if (state) return { html: state.html ?? '', seq: Number.isInteger(state.seq) ? state.seq ?? null : null };
    }
    return { html: typeof live.readHtml === 'function' ? await live.readHtml('document', id) : null, seq: null };
}

/**
 * Run `fn({ html, fragment })` on what people see now: the live state of a
 * co-edited page, opened once so anchors get relative positions into the very
 * fragment the editors hold, or the stored body (fragment null).
 */
export async function withCurrentBody<R>(live: LiveCollab | null, id: string, storedHtml: string | undefined,
    fn: (body: { html: string, fragment: unknown }) => R): Promise<R> {
    const stored: { html: string, fragment: unknown } = { html: storedHtml || '', fragment: null };
    if (!live) return fn(stored);
    if (typeof live.withFragment === 'function') {
        const out = await live.withFragment('document', id, ({ html, fragment }) => fn({ html: typeof html === 'string' ? html : stored.html, fragment }));
        return out === null ? fn(stored) : out;
    }
    const current = (await readLive(live, id)).html;
    return fn({ html: typeof current === 'string' ? current : stored.html, fragment: null });
}

const LIVE_STALE = 'Somebody changed this page since you read it. Call document_read again and make your change with document_edit, so what they typed stays.';
// A find/replace re-reads the live state, so a keystroke landing between that
// read and the write is simply read again; after this many, it gives up.
const LIVE_EDIT_ATTEMPTS = 3;

/**
 * Write a page's body through the live layer when the page is being edited
 * live: the change reaches every open editor, and the live layer's checkpoint
 * records it as the AI's. `expectSeq` is the live update the body was made
 * from: when anybody typed since, nothing is written and the answer says so
 * (`{ error }`), because the body would undo what they typed. Null when the
 * page is not live (the caller then saves the stored body with its revision
 * check).
 */
export async function writeLive(doc: LiveDoc, userId: string, html: string, live: LiveCollab | null, expectSeq: number | undefined) {
    if (!live || typeof live.applyServerEdit !== 'function') return null;
    const out = await live.applyServerEdit('document', doc.id, { origin: 'ai', actorId: userId }, { replaceWith: { html }, expectSeq });
    if (out?.stale) return { error: LIVE_STALE };
    if (!out?.applied) return null;
    return {
        documentId: doc.id,
        url: documentUrl(doc.id),
        name: doc.name,
        versionId: Number.isInteger(out.seq) ? liveToken(doc.versionId, out.seq as number) : doc.versionId,
        wrote: ['bodyHtml'],
        message: `Updated the page "${doc.name}" for everyone who has it open. Reply with a clickable link of the form "[${doc.name}](${documentUrl(doc.id)})".`,
    };
}

/**
 * A find/replace on a page edited live: applied to the live state and written
 * only from the update it was computed on. Null when the page turns out not to
 * be live (the caller edits the stored body).
 */
export async function editLive(doc: LiveDoc, userId: string, live: LiveCollab, edit: (text: string) => EditResult) {
    for (let attempt = 0; attempt < LIVE_EDIT_ATTEMPTS; attempt += 1) {
        const state = await readLive(live, doc.id);
        if (typeof state.html !== 'string') return null;
        const out = edit(state.html);
        if (out.error) return { error: out.error };
        const written = await writeLive(doc, userId, out.content as string, live, state.seq ?? undefined);
        if (!written) return null;
        if (!written.error) return { ...written, message: out.message };
    }
    return { error: LIVE_STALE };
}
