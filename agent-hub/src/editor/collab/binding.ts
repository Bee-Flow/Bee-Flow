/**
 * binding.ts — ties one EditorView to one shared Y.XmlFragment.
 *
 *   local edit  → view.dispatch → docChanged hook → syncDocToFragment inside
 *                 ydoc.transact(…, this.origin)  (minimal diff, W2-B's ySync)
 *   remote edit → fragment.observeDeep → fragmentToAst (cached, sanitised)
 *                 → view.applyExternal with the selection mapped through
 *                 relative positions
 *
 * Batching: remote updates arrive through the provider's inbound queue, which
 * applies a whole animation frame's worth in ONE Yjs transaction — so the
 * editor re-renders once per frame however fast others type. The binding
 * itself applies synchronously, which keeps the editor and the shared
 * document identical between events: a local edit is always diffed against
 * the state it was made on, and a caret mapped through relative positions
 * computed on that same state.
 *
 * The one exception is IME composition: while the browser owns the DOM,
 * remote changes are held and land at compositionend (before the committed
 * text is applied, and with the composition's start position mapped).
 *
 * Undo is per user: a Y.UndoManager that only tracks this binding's origin,
 * with the engine's grouping (a run of typing is one step, anything else its
 * own), and the caret restored from the selection saved with each step.
 */
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { createYCache, fragmentToAst, type YCache } from './yConvert';
import { syncDocToFragment } from './ySync';
import { relativeFromPos, posFromRelative, encodeRelpos, decodeRelpos } from './relpos';
import { createCursorPublisher, type CursorPublisher, type CursorState } from './awareness';
import { textSelection, nodeSelection, cellSelection, pos, isText, isNode, isCell } from '../engine/selection.js';

type EditorViewLike = any;
type Selection = any;

export interface ModelPos { path: number[]; offset: number }

/** A selection in positions that survive concurrent edits. */
type RelSel =
    | { type: 'text'; anchor: Y.RelativePosition; head: Y.RelativePosition }
    | { type: 'node'; at: Y.RelativePosition }
    | { type: 'cell'; anchor: Y.RelativePosition; head: Y.RelativePosition };

export interface CollabBindingOptions {
    ydoc: Y.Doc;
    fragment: Y.XmlFragment;
    awareness?: Awareness | null;
    /** Reported when a local change could not be written (the view is then reloaded from the shared state). */
    onError?: (error: unknown) => void;
}

const CAPTURE_TIMEOUT_MS = 400;
const SELECTION_META = 'bf-selection';

export class CollabBinding {
    readonly view: EditorViewLike;
    readonly ydoc: Y.Doc;
    readonly fragment: Y.XmlFragment;
    /** Transaction origin of this binding's own writes (tracked by the undo manager). */
    readonly origin: { readonly binding: CollabBinding };
    readonly undoManager: Y.UndoManager;
    private readonly cache: YCache;
    private readonly opts: CollabBindingOptions;
    private readonly publisher: CursorPublisher | null;
    private removePlugin: (() => void) | null = null;
    private pending = false;
    private snapshot: Map<Selection, RelSel | null> | null = null;
    private localBefore: RelSel | null = null;
    private externalBefore: RelSel | null = null;
    private destroyed = false;
    private cursorTimer: ReturnType<typeof setTimeout> | null = null;
    private onFocusChange: (() => void) | null = null;

    constructor(view: EditorViewLike, opts: CollabBindingOptions) {
        this.view = view;
        this.opts = opts;
        this.ydoc = opts.ydoc;
        this.fragment = opts.fragment;
        this.origin = Object.freeze({ binding: this });
        this.cache = createYCache();

        // First content: what the shared document holds, with a fresh history.
        view.applyExternal(fragmentToAst(this.fragment, this.cache), { origin: 'load' });

        this.undoManager = new Y.UndoManager(this.fragment, {
            trackedOrigins: new Set([this.origin]),
            captureTimeout: CAPTURE_TIMEOUT_MS,
        });
        this.undoManager.on('stack-item-added', this.onStackItemAdded);
        this.undoManager.on('stack-item-popped', this.onStackItemPopped);

        view.setCollaborative(true);
        view.setUndoProvider({
            undo: () => { this.undoManager.undo(); },
            redo: () => { this.undoManager.redo(); },
            canUndo: () => this.undoManager.canUndo(),
            canRedo: () => this.undoManager.canRedo(),
            stopCapturing: () => this.undoManager.stopCapturing(),
        });
        this.removePlugin = view.addPlugin({
            beforeChange: () => { if (this.pending) this.applyFromY('remote'); },
            docChanged: (prev: any, next: any) => this.writeLocal(prev, next),
            selectionChanged: () => this.scheduleCursor(),
            compositionEnd: () => { if (this.pending) this.applyFromY('remote'); },
            viewDestroyed: () => this.destroy(),
        });

        this.ydoc.on('beforeTransaction', this.onBeforeTransaction);
        this.fragment.observeDeep(this.onFragmentChange);

        this.publisher = opts.awareness ? createCursorPublisher(opts.awareness) : null;
        if (this.publisher) {
            this.onFocusChange = () => this.scheduleCursor();
            view.host.addEventListener('focus', this.onFocusChange);
            view.host.addEventListener('blur', this.onFocusChange);
            this.scheduleCursor();
        }
    }

    /* ── positions ─────────────────────────────────────────── */

    /** Encoded relative position for a model position (null when it has none). */
    posToRel(p: ModelPos, assoc = 0): string | null {
        const rel = this.relOf(p, assoc);
        return rel ? encodeRelpos(rel) : null;
    }

    /** Model position for an encoded relative position, in the CURRENT shared state. */
    relToPos(b64: string): ModelPos | null {
        const rel = decodeRelpos(b64);
        return rel ? this.posOf(rel) : null;
    }

    private relOf(p: ModelPos | null | undefined, assoc = 0): Y.RelativePosition | null {
        if (!p || !Array.isArray(p.path)) return null;
        try { return relativeFromPos(this.fragment, p.path, p.offset, assoc) || null; } catch { return null; }
    }

    private posOf(rel: Y.RelativePosition): ModelPos | null {
        try {
            const r = posFromRelative(this.fragment, this.ydoc, rel) as ModelPos | null;
            return r && Array.isArray(r.path) ? { path: r.path, offset: r.offset } : null;
        } catch { return null; }
    }

    /** Relative form of a selection (text, a selected block, or a cell rectangle). */
    private relSel(sel: Selection): RelSel | null {
        if (isText(sel)) {
            const anchor = this.relOf(sel.anchor);
            const head = this.relOf(sel.head);
            return anchor && head ? { type: 'text', anchor, head } : null;
        }
        if (isNode(sel)) {
            const at = this.relOf({ path: sel.path, offset: 0 });
            return at ? { type: 'node', at } : null;
        }
        if (isCell(sel)) {
            const anchor = this.relOf({ path: sel.anchorCell, offset: 0 });
            const head = this.relOf({ path: sel.headCell, offset: 0 });
            return anchor && head ? { type: 'cell', anchor, head } : null;
        }
        return null;
    }

    private absSel(rel: RelSel | null | undefined): Selection | null {
        if (!rel) return null;
        if (rel.type === 'node') {
            const at = this.posOf(rel.at);
            return at ? nodeSelection(at.path) : null;
        }
        const a = this.posOf(rel.anchor);
        const h = this.posOf(rel.head);
        if (!a || !h) return null;
        return rel.type === 'cell' ? cellSelection(a.path, h.path) : textSelection(pos(a.path, a.offset), pos(h.path, h.offset));
    }

    /* ── local → shared ────────────────────────────────────── */

    private writeLocal(prev: any, next: any) {
        if (this.destroyed) return;
        // The shared state still equals `prev` here: this is the caret the
        // undo step will restore.
        this.localBefore = this.relSel(prev.selection);
        try {
            this.ydoc.transact(() => { syncDocToFragment(this.fragment, next.doc, this.cache); }, this.origin);
        } catch (e) {
            // Never let the editor and the shared document drift apart: show
            // what is shared (the keystroke is lost, the document is not).
            try { this.opts.onError?.(e); } catch { /* noop */ }
            this.applyFromY('remote');
        }
    }

    /* ── shared → local ────────────────────────────────────── */

    private onBeforeTransaction = (tr: Y.Transaction) => {
        if (tr.origin === this.origin || this.pending || this.destroyed) return;
        // The editor and the shared state are identical right now: remember
        // where the carets are, in positions that survive the change.
        const map = new Map<Selection, RelSel | null>();
        const { selection } = this.view.state;
        map.set(selection, this.relSel(selection));
        if (this.view.compStartSel) map.set(this.view.compStartSel, this.relSel(this.view.compStartSel));
        this.snapshot = map;
    };

    private onFragmentChange = (_events: Array<Y.YEvent<any>>, tr: Y.Transaction) => {
        if (tr.origin === this.origin || this.destroyed) return;
        if (this.view.composing) { this.pending = true; return; }
        this.applyFromY(tr.origin === this.undoManager ? 'undo' : 'remote');
    };

    private applyFromY(origin: 'remote' | 'undo') {
        if (this.destroyed) return;
        const snapshot = this.snapshot;
        this.snapshot = null;
        this.pending = false;
        // Kept for the redo step an undo creates (added after this runs).
        this.externalBefore = snapshot?.get(this.view.state.selection) ?? null;
        const doc = fragmentToAst(this.fragment, this.cache);
        this.view.applyExternal(doc, {
            origin,
            mapSelection: (sel: Selection) => (snapshot && snapshot.has(sel) ? this.absSel(snapshot.get(sel)) : null),
        });
    }

    /* ── undo steps carry the caret ────────────────────────── */

    private onStackItemAdded = (ev: { stackItem: { meta: Map<string, unknown> }; origin: unknown; type: 'undo' | 'redo' }) => {
        const sel = ev.origin === this.origin ? this.localBefore : this.externalBefore;
        if (sel) ev.stackItem.meta.set(SELECTION_META, sel);
    };

    private onStackItemPopped = (ev: { stackItem: { meta: Map<string, unknown> } }) => {
        const sel = this.absSel(ev.stackItem.meta.get(SELECTION_META) as RelSel | undefined);
        if (!sel || this.destroyed) return;
        this.view.setSelection(sel);
        this.view.writeSelection();
        try { this.view.onSelectionChange(this.view.state); } catch { /* noop */ }
    };

    /* ── presence ──────────────────────────────────────────── */

    private scheduleCursor() {
        if (!this.publisher || this.cursorTimer || this.destroyed) return;
        this.cursorTimer = setTimeout(() => { this.cursorTimer = null; this.publishCursor(); }, 60);
    }

    private publishCursor() {
        if (!this.publisher || this.destroyed) return;
        if (this.pending) { this.scheduleCursor(); return; }
        const focused = this.view.hasFocus();
        const sel = this.view.state.selection;
        let cursor: CursorState | null = null;
        if (this.view.editable && isText(sel)) {
            const anchor = this.posToRel(sel.anchor);
            const head = this.posToRel(sel.head);
            if (anchor && head) cursor = { anchor, head };
        }
        this.publisher.publish(cursor, focused);
    }

    /* ── teardown ──────────────────────────────────────────── */

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this.cursorTimer) { clearTimeout(this.cursorTimer); this.cursorTimer = null; }
        if (this.onFocusChange) {
            this.view.host.removeEventListener('focus', this.onFocusChange);
            this.view.host.removeEventListener('blur', this.onFocusChange);
        }
        if (this.publisher) {
            this.publisher.cancel();
            // Withdraw the caret, unless the session (and its presence) already ended.
            if (this.opts.awareness?.getLocalState() != null) { this.publisher.publish(null, false); this.publisher.flush(); }
        }
        this.fragment.unobserveDeep(this.onFragmentChange);
        this.ydoc.off('beforeTransaction', this.onBeforeTransaction);
        this.undoManager.off('stack-item-added', this.onStackItemAdded);
        this.undoManager.off('stack-item-popped', this.onStackItemPopped);
        this.undoManager.destroy();
        if (this.removePlugin) { this.removePlugin(); this.removePlugin = null; }
        // Back to the plain editor: its own snapshot history, starting empty.
        this.view.setUndoProvider(null);
        this.view.setCollaborative(false);
        this.cache.destroy();
    }
}

export function bindEditor(view: EditorViewLike, opts: CollabBindingOptions): CollabBinding {
    return new CollabBinding(view, opts);
}
