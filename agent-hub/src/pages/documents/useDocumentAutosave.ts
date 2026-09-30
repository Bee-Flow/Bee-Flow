// Saving a designed document while it is typed in: the one property the
// editor must never fail at is not losing what somebody wrote.
//
// THE BASE REVISION. Every save says which revision the text in the frame
// grew from (`expectedVersionId`) and asks the server to MERGE when that is no
// longer the newest (`merge: true`): somebody else, or the assistant, saved in
// between. The server merges section by section; what it cannot merge comes
// back as a conflict whose parts the person compares and chooses from. The
// base only moves forward once the frame shows what the server holds (after a
// plain save, or after the other side's sections were put into the frame);
// until then the next save is merged again, so a change by somebody else can
// never be saved over by a frame that has not seen it. A body the frame
// reported while a merged save was out was read BEFORE the others' sections
// went in, so it is never saved on the new base: the frame is asked for its
// body again first (`reread`), and when it cannot answer the base stays. That
// is what fixes the old dead end where, after one conflict, every retry and
// every later autosave failed again with the same stale revision.
//
// A DRAFT of what is not yet saved is kept in sessionStorage with its base, so
// a closed tab or a failed save can be restored into this document (and merged
// like any late save), compared, or discarded.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, updateDocument } from './documentsApi';
import type { StudioDocument } from './documentQueries';
import { resolveParts, type MergePart } from './canvasBridge';

export const AUTOSAVE_MS = 1500;

export type SaveState = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error' | 'conflict';

export interface Conflict {
    parts: MergePart[];
    currentVersionId: string;
    mine: string;
}

export interface Draft { html: string; base: string | null; at: number }

export interface AutosaveOptions {
    documentId: string;
    /** The document as the server last answered it. */
    docRef: React.MutableRefObject<StudioDocument | null>;
    /** A save landed: the new server state. */
    onSaved: (doc: StudioDocument) => void;
    /** A late save was merged with others' changes: resolve true once the frame shows them. */
    onMerged: (doc: StudioDocument) => Promise<boolean>;
    /** The server says this reader may no longer change the document. */
    onReadOnly: () => void;
    /**
     * A page went live (co-edited) while this save was out, and the server
     * refused it (`document_live`, with the id of the version that keeps the
     * text as `conflictVersionId`). Answer true when the text is safe and the
     * page joins the live session: nothing is left to save here then.
     */
    onLive?: (err: Error & { conflictVersionId?: string | null }) => boolean;
    /** Ask the frame for its body again; it answers through markDirty. */
    reread?: () => Promise<void>;
}

interface Ctx {
    documentId: string;
    docRef: React.MutableRefObject<StudioDocument | null>;
    pending: { current: string | null };
    /** How many bodies the frame has reported: tells a fresh body from the one before. */
    reported: { current: number };
    base: { current: string | null };
    inFlight: { current: Promise<void> | null };
    queue: { current: Promise<unknown> };
    cb: { current: Pick<AutosaveOptions, 'onSaved' | 'onMerged' | 'onReadOnly' | 'reread' | 'onLive'> };
    set: { state: (s: SaveState | ((prev: SaveState) => SaveState)) => void; error: (e: Error | null) => void; conflict: (c: Conflict | null) => void; savedAt: (d: Date) => void };
}

const draftKey = (id: string) => `document-draft:${id}`;

export function readDraft(documentId: string): Draft | null {
    try {
        const raw = sessionStorage.getItem(draftKey(documentId));
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.html === 'string') return { html: parsed.html, base: parsed.base || null, at: Number(parsed.at) || 0 };
        } catch { /* an older, plain-text draft */ }
        return { html: raw, base: null, at: 0 };
    } catch {
        return null;
    }
}

function writeDraft(documentId: string, draft: Draft | null) {
    try {
        if (draft) sessionStorage.setItem(draftKey(documentId), JSON.stringify(draft));
        else sessionStorage.removeItem(draftKey(documentId));
    } catch { /* storage unavailable: the pending copy in memory remains */ }
}

/** The revision the frame's text grew from. */
const baseOf = (ctx: Ctx) => ctx.base.current || ctx.docRef.current?.versionId || null;

/** Every write, one after another: a save never overtakes the one before it. */
function enqueue<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
    const next = ctx.queue.current.catch(() => undefined).then(fn);
    ctx.queue.current = next;
    return next;
}

function adopt(ctx: Ctx, saved: StudioDocument) {
    ctx.docRef.current = { ...ctx.docRef.current, ...saved };
    ctx.cb.current.onSaved(ctx.docRef.current);
}

async function saveOnce(ctx: Ctx, html: string) {
    // Pinned before the answer moves the document on: until the frame shows
    // the server's state, this is the revision its text grew from.
    const from = baseOf(ctx);
    ctx.base.current = from;
    const saved = await enqueue(ctx, () => updateDocument(ctx.documentId, { bodyHtml: html, expectedVersionId: from, merge: true }) as Promise<StudioDocument>);
    adopt(ctx, saved);
    if (!saved.merge?.merged) { ctx.base.current = saved.versionId; return; }
    if (!await ctx.cb.current.onMerged(ctx.docRef.current!)) return;
    // The frame shows the others' sections now, but a body it reported while
    // this save was out does not: saved on the new base it would put their
    // old text back, with nothing left to merge. Read the frame again.
    if (ctx.pending.current != null && !await rereadFrame(ctx)) return;
    ctx.base.current = saved.versionId;
}

/** A fresh body from the frame in place of the pending one; false when it did not answer. */
async function rereadFrame(ctx: Ctx): Promise<boolean> {
    const reread = ctx.cb.current.reread;
    if (!reread) return false;
    const before = ctx.reported.current;
    try { await reread(); } catch { return false; }
    return ctx.reported.current !== before;
}

async function openConflict(ctx: Ctx, err: any, html: string) {
    if (err?.conflict?.parts && err.conflict.currentVersionId) {
        ctx.set.conflict({ parts: err.conflict.parts, currentVersionId: err.conflict.currentVersionId, mine: html });
    } else {
        // No parts (the revision it started from is gone): the whole document
        // is the one thing to choose about.
        const latest = await getDocument(ctx.documentId) as StudioDocument;
        ctx.set.conflict({
            currentVersionId: latest.versionId, mine: html,
            parts: [{ kind: 'conflict', key: 'all', label: latest.name, base: '', mine: html, theirs: latest.bodyHtml }],
        });
    }
    ctx.set.state('conflict');
}

async function failed(ctx: Ctx, e: any, html: string) {
    if (e?.status === 409 && e?.code === 'document_live' && ctx.pending.current == null && ctx.cb.current.onLive?.(e)) {
        // The server kept this text as a version and the page joins the
        // live session: saving it again here would only be refused again.
        writeDraft(ctx.documentId, null);
        ctx.set.error(null);
        ctx.set.state('idle');
        return;
    }
    // A newer keystroke always wins over the failed request's body.
    if (ctx.pending.current == null) ctx.pending.current = html;
    writeDraft(ctx.documentId, { html: ctx.pending.current, base: baseOf(ctx), at: Date.now() });
    if (e?.status === 409 && e?.code === 'document_conflict') {
        await openConflict(ctx, e, ctx.pending.current).catch(() => { ctx.set.state('error'); ctx.set.error(e); });
        return;
    }
    if (e?.code === 'document_read_only') ctx.cb.current.onReadOnly();
    ctx.set.error(e);
    ctx.set.state('error');
}

async function drainPending(ctx: Ctx) {
    while (ctx.pending.current != null) {
        const html = ctx.pending.current;
        ctx.pending.current = null;
        if (html === ctx.docRef.current?.bodyHtml && baseOf(ctx) === ctx.docRef.current?.versionId) continue;
        ctx.set.state('saving');
        try {
            await saveOnce(ctx, html);
        } catch (e) {
            await failed(ctx, e, html);
            throw e;
        }
        if (ctx.pending.current == null) writeDraft(ctx.documentId, null);
        ctx.set.error(null);
        ctx.set.savedAt(new Date());
        ctx.set.state(ctx.pending.current == null ? 'saved' : 'unsaved');
    }
}

async function flushNow(ctx: Ctx) {
    if (ctx.inFlight.current) await ctx.inFlight.current.catch(() => undefined);
    if (ctx.pending.current == null) return;
    ctx.inFlight.current = drainPending(ctx);
    try { await ctx.inFlight.current; } finally { ctx.inFlight.current = null; }
}

async function resolveWith(ctx: Ctx, conflict: Conflict, choices: Record<string, 'mine' | 'theirs'>) {
    const body = resolveParts(conflict.parts, choices);
    ctx.base.current = conflict.currentVersionId;
    ctx.pending.current = null;
    try {
        const saved = await enqueue(ctx, () => updateDocument(ctx.documentId, { bodyHtml: body, expectedVersionId: conflict.currentVersionId, merge: true }) as Promise<StudioDocument>);
        ctx.base.current = saved.versionId;
        writeDraft(ctx.documentId, null);
        ctx.set.conflict(null);
        ctx.set.error(null);
        ctx.set.savedAt(new Date());
        ctx.set.state('saved');
        adopt(ctx, saved);
        return ctx.docRef.current;
    } catch (e: any) {
        if (e?.status === 409 && e?.code === 'document_conflict') await openConflict(ctx, e, body);
        else { ctx.set.error(e); ctx.set.state('error'); }
        return null;
    }
}

async function discard(ctx: Ctx) {
    ctx.pending.current = null;
    writeDraft(ctx.documentId, null);
    const latest = await getDocument(ctx.documentId) as StudioDocument;
    ctx.base.current = latest.versionId;
    ctx.set.conflict(null);
    ctx.set.error(null);
    ctx.set.state('idle');
    adopt(ctx, latest);
    return ctx.docRef.current;
}

function useCtx(options: AutosaveOptions) {
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const [error, setError] = useState<Error | null>(null);
    const [conflict, setConflict] = useState<Conflict | null>(null);
    const ctx = useRef<Ctx>(null as unknown as Ctx);
    if (!ctx.current) {
        ctx.current = {
            documentId: options.documentId, docRef: options.docRef,
            pending: { current: null }, reported: { current: 0 }, base: { current: null }, inFlight: { current: null }, queue: { current: Promise.resolve() },
            cb: { current: options },
            set: { state: setSaveState, error: setError, conflict: setConflict, savedAt: setLastSavedAt },
        };
    }
    useEffect(() => { ctx.current.cb.current = options; ctx.current.documentId = options.documentId; });
    return { ctx: ctx.current, saveState, lastSavedAt, error, conflict, setSaveState, setError };
}

export default function useDocumentAutosave(options: AutosaveOptions) {
    const { ctx, saveState, lastSavedAt, error, conflict, setSaveState, setError } = useCtx(options);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stopTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
    const flush = useCallback(async () => { stopTimer(); await flushNow(ctx); }, [ctx]);

    const markDirty = useCallback((html: string) => {
        if (ctx.docRef.current?.editable === false) return;
        ctx.reported.current += 1;
        if (html === ctx.docRef.current?.bodyHtml && ctx.pending.current == null) return;
        ctx.pending.current = html;
        writeDraft(ctx.documentId, { html, base: baseOf(ctx), at: Date.now() });
        // "Unsaved changes" until the save starts: never "Saving…" per keystroke.
        setSaveState((s) => (s === 'conflict' ? s : 'unsaved'));
        stopTimer();
        timer.current = setTimeout(() => { flush().catch(() => undefined); }, AUTOSAVE_MS);
    }, [ctx, flush, setSaveState]);

    // Leaving the editor saves what is pending (the common way out is Back,
    // well inside the autosave window); a failure keeps the draft.
    useEffect(() => () => { stopTimer(); if (ctx.pending.current != null) flushNow(ctx).catch(() => undefined); }, [ctx]);
    useEffect(() => {
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (ctx.pending.current == null && !ctx.inFlight.current) return;
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [ctx]);

    return {
        saveState, lastSavedAt, error, conflict, markDirty, flush,
        enqueue: <T,>(fn: () => Promise<T>) => enqueue(ctx, fn),
        /** The frame now shows exactly this revision. */
        syncedTo: (doc: StudioDocument) => { ctx.base.current = doc.versionId; },
        resolveConflict: (choices: Record<string, 'mine' | 'theirs'>) => (conflict ? resolveWith(ctx, conflict, choices) : Promise.resolve(null)),
        discardMine: () => { stopTimer(); return discard(ctx); },
        /**
         * The server state changed under the editor for a reason the editor
         * chose (a restore): what was typed before it is dropped, and the
         * editor continues from `doc`.
         */
        replaceWith: (doc: StudioDocument) => {
            stopTimer();
            ctx.pending.current = null;
            ctx.base.current = doc.versionId;
            writeDraft(ctx.documentId, null);
            ctx.set.conflict(null);
            ctx.set.error(null);
            ctx.set.state('idle');
            adopt(ctx, doc);
        },
        /** Forget the kept draft (the person discarded it). */
        dropDraft: () => writeDraft(ctx.documentId, null),
        /** Put a recovered draft back: saved like a late save, merged against its base. */
        restoreDraft: (draft: Draft) => { ctx.base.current = draft.base || ctx.docRef.current?.versionId || null; ctx.pending.current = draft.html; return flush(); },
        hasPending: () => ctx.pending.current != null || !!ctx.inFlight.current,
        clearError: () => setError(null),
    };
}
