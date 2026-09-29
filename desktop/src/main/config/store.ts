/**
 * Where settings live on disk, and how they get there without being lost.
 *
 * Deliberately not `electron-store`: this file is ~150 lines, it is the only
 * thing in the app that can lose a user's server URL, and the interesting parts
 * (what happens to a half-written file, what happens when two windows save at
 * once) are exactly the parts a dependency would hide. Writing it here means
 * they are testable in plain Node, with no Electron and no filesystem.
 */

import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';

import type { DesktopSettings } from '../../shared/types.ts';
import { defaultSettings, mergeSettings, normaliseSettings } from './schema.ts';

/** The slice of `fs/promises` this module uses, so tests can supply their own. */
export interface StoreIo {
    readFile(file: string, encoding: 'utf8'): Promise<string>;
    writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
    unlink(file: string): Promise<void>;
    copyFile(from: string, to: string): Promise<void>;
}

const realIo: StoreIo = {
    readFile: (file, encoding) => fsPromises.readFile(file, encoding),
    writeFile: (file, data, encoding) => fsPromises.writeFile(file, data, encoding),
    rename: (from, to) => fsPromises.rename(from, to),
    mkdir: (dir, options) => fsPromises.mkdir(dir, options),
    unlink: (file) => fsPromises.unlink(file),
    copyFile: (from, to) => fsPromises.copyFile(from, to),
};

export interface SettingsStoreOptions {
    /** Absolute path to settings.json. */
    file: string;
    io?: StoreIo;
    platform?: NodeJS.Platform;
    /** Where to report a recoverable problem. Defaults to console.warn. */
    onWarning?: (message: string) => void;
}

type Listener = (settings: DesktopSettings) => void;

export class SettingsStore {
    readonly file: string;

    private readonly io: StoreIo;
    private readonly platform: NodeJS.Platform;
    private readonly warn: (message: string) => void;
    private readonly listeners = new Set<Listener>();

    private current: DesktopSettings;
    /** Serialises writes: every save queues behind the one in flight. */
    private writeChain: Promise<void> = Promise.resolve();

    constructor(options: SettingsStoreOptions) {
        this.file = options.file;
        this.io = options.io ?? realIo;
        this.platform = options.platform ?? process.platform;
        this.warn = options.onWarning ?? ((message) => console.warn(`[Settings] ${message}`));
        this.current = defaultSettings(this.platform);
    }

    /** The settings as last loaded or saved. Always valid, never null. */
    get(): DesktopSettings {
        return this.current;
    }

    /**
     * Read settings off disk.
     *
     * Three outcomes, none of which is a crash: the file parses (use it), the
     * file is missing (first run — use defaults), or the file is there and
     * unreadable. The third is the one worth handling properly: rather than
     * silently starting fresh, the damaged file is kept as `.corrupt` so the
     * person who has to explain where their server URL went has something to
     * look at, and the `.bak` written before the last save is tried first.
     */
    async load(): Promise<DesktopSettings> {
        const primary = await this.tryRead(this.file);
        if (primary.ok) {
            this.current = normaliseSettings(primary.value, this.platform);
            return this.current;
        }

        if (primary.missing) {
            this.current = defaultSettings(this.platform);
            return this.current;
        }

        this.warn(`${this.file} could not be read (${primary.error}); trying the backup`);
        const backup = await this.tryRead(this.backupFile);
        if (backup.ok) {
            this.current = normaliseSettings(backup.value, this.platform);
            // Put the good copy back where the app looks for it, and keep the
            // damaged one under a name that says what it is.
            await this.quietly(() => this.io.copyFile(this.file, `${this.file}.corrupt`));
            await this.save(this.current);
            return this.current;
        }

        await this.quietly(() => this.io.copyFile(this.file, `${this.file}.corrupt`));
        this.current = defaultSettings(this.platform);
        return this.current;
    }

    /** Apply a partial patch, persist it, and tell anyone listening. */
    async patch(patch: unknown): Promise<DesktopSettings> {
        const next = mergeSettings(this.current, patch, this.platform);
        return this.save(next);
    }

    /** Replace the whole object (after normalisation) and persist it. */
    async save(next: DesktopSettings): Promise<DesktopSettings> {
        this.current = normaliseSettings(next, this.platform);
        const snapshot = this.current;
        this.writeChain = this.writeChain.then(() => this.writeAtomically(snapshot)).catch((error: unknown) => {
            this.warn(`could not write ${this.file}: ${describe(error)}`);
        });
        await this.writeChain;
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch (error) {
                this.warn(`a settings listener threw: ${describe(error)}`);
            }
        }
        return snapshot;
    }

    onChange(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Waits for any queued write, so a quit can be sure the file is on disk. */
    async flush(): Promise<void> {
        await this.writeChain;
    }

    private get backupFile(): string {
        return `${this.file}.bak`;
    }

    private async tryRead(file: string): Promise<{ ok: true; value: unknown } | { ok: false; missing: boolean; error: string }> {
        try {
            const raw = await this.io.readFile(file, 'utf8');
            return { ok: true, value: JSON.parse(raw) };
        } catch (error) {
            const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
            return { ok: false, missing, error: describe(error) };
        }
    }

    /**
     * Write through a temporary file and rename over the target.
     *
     * `rename` within a directory is atomic on every filesystem this app runs
     * on, so a reader either sees the old file or the new one — never the
     * half-written middle, which is what a plain `writeFile` gives you if the
     * machine loses power mid-save.
     */
    private async writeAtomically(settings: DesktopSettings): Promise<void> {
        const dir = path.dirname(this.file);
        await this.io.mkdir(dir, { recursive: true });

        // Keep the previous good file as the backup before overwriting it.
        await this.quietly(() => this.io.copyFile(this.file, this.backupFile));

        const temporary = `${this.file}.${process.pid}.tmp`;
        await this.io.writeFile(temporary, `${JSON.stringify(settings, null, 4)}\n`, 'utf8');
        try {
            await this.io.rename(temporary, this.file);
        } catch (error) {
            await this.quietly(() => this.io.unlink(temporary));
            throw error;
        }
    }

    /** Run something whose failure is not worth reporting (a missing backup). */
    private async quietly(operation: () => Promise<unknown>): Promise<void> {
        try {
            await operation();
        } catch {
            /* expected on first run, and never fatal */
        }
    }
}

function describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}
