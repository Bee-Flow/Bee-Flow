/**
 * The notes autosave as a plain object, so its bookkeeping (the version it
 * last knew, whether an edit landed during a save, the debounce timer) is
 * ordinary fields rather than refs threaded through hooks. It never talks
 * HTTP itself: hooks/useNoteDraft.ts hands it the calls.
 *
 * The rules are the web's useDocumentAutosave:
 * - a pause in typing saves, single-flight: an edit made while a save is in
 *   the air is saved right after it;
 * - every save asserts the version it last knew, and a 409 loads the
 *   server's copy instead of overwriting it;
 * - a newer server copy replaces the draft only while nothing here is unsaved;
 * - an edit still waiting when the screen closes is saved without a version,
 *   so a final edit is never stranded behind a conflict.
 */

/** How long typing has to pause before a save goes out. */
export const AUTOSAVE_MS = 1500;

export type NoteStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface NoteView {
    text: string;
    status: NoteStatus;
    error: string | null;
}

export interface NoteSaverDeps {
    /** PUT the body; answers the new version, or null when the server did not say. */
    save: (text: string, expectedVersion: number | null) => Promise<{ version: number | null }>;
    /** Re-read the server's copy after a conflict. */
    reload: () => Promise<{ text: string; version: number } | null>;
    /** A save was accepted: update caches. */
    onSaved: (text: string, version: number | null) => void;
    /** Words for a failed save. */
    describe: (err: unknown) => string;
    isConflict: (err: unknown) => boolean;
}

export const EMPTY_NOTE: NoteView = { text: '', status: 'idle', error: null };

export class NoteSaver {
    private deps: NoteSaverDeps;
    private readonly publish: (view: NoteView) => void;
    private view: NoteView = EMPTY_NOTE;
    private version: number | null = null;
    private again = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(deps: NoteSaverDeps, publish: (view: NoteView) => void) {
        this.deps = deps;
        this.publish = publish;
    }

    configure(deps: NoteSaverDeps): void {
        this.deps = deps;
    }

    get text(): string {
        return this.view.text;
    }

    private set(change: Partial<NoteView>): void {
        this.view = { ...this.view, ...change };
        this.publish(this.view);
    }

    private get unsaved(): boolean {
        return this.view.status === 'dirty' || this.view.status === 'saving' || this.view.status === 'error';
    }

    /** The server's copy, taken only when newer and nothing here is unsaved. */
    adopt(version: number, text: string): void {
        if (this.version !== null && version <= this.version) return;
        if (this.unsaved) return;
        this.version = version;
        this.set({ text });
    }

    edit(text: string): void {
        if (this.view.status === 'saving') {
            this.again = true;
            this.set({ text });
        } else {
            this.set({ text, status: 'dirty' });
        }
        this.clearTimer();
        this.timer = setTimeout(() => void this.save(), AUTOSAVE_MS);
    }

    async save(): Promise<void> {
        this.clearTimer();
        if (this.view.status === 'saving') {
            this.again = true;
            return;
        }
        const body = this.view.text;
        this.set({ status: 'saving' });
        try {
            const { version } = await this.deps.save(body, this.version);
            if (version !== null) this.version = version;
            this.deps.onSaved(body, version);
            const changed = this.again || this.view.text !== body;
            this.again = false;
            this.set({ status: changed ? 'dirty' : 'saved', error: null });
            if (changed) await this.save();
        } catch (err) {
            this.again = false;
            if (this.deps.isConflict(err)) await this.reload();
            else this.set({ status: 'error', error: this.deps.describe(err) });
        }
    }

    private async reload(): Promise<void> {
        try {
            const fresh = await this.deps.reload();
            if (!fresh) throw new Error('gone');
            this.version = fresh.version;
            this.set({ text: fresh.text, status: 'idle', error: null });
        } catch (err) {
            this.set({ status: 'error', error: this.deps.describe(err) });
        }
    }

    /** The screen is closing: an edit still waiting is saved, unversioned. */
    leave(): Promise<unknown> | null {
        this.clearTimer();
        if (this.view.status !== 'dirty') return null;
        return this.deps.save(this.view.text, null).catch(() => undefined);
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
}
