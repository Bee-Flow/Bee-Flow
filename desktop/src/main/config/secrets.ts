/**
 * Credentials the desktop client holds: the Bee Flow session token and, when
 * the user pairs one, a Nextcloud app password.
 *
 * The rule this module exists to enforce: **a credential is either sealed by
 * the OS keyring or it is not written down at all.** Electron's `safeStorage`
 * is keychain-backed on macOS, DPAPI-backed on Windows and libsecret- or
 * KWallet-backed on Linux. On a Linux desktop Electron does not recognise — i3,
 * sway, a bare X session, most tiling window managers — it picks `basic_text`,
 * which "encrypts" with a key hardcoded in Chromium. Whether
 * `isEncryptionAvailable()` then says false depends on the Electron version
 * and the session (Electron 44 with no desktop at all says false; with a
 * desktop it has not identified, it has said true), and writing an app
 * password to `~/.config` in what amounts to plaintext is not a risk worth
 * resting on that answer. So the backend is checked by name, and `basic_text`
 * counts as no keyring: the
 * value stays in memory for the session, the user is told once, and the next
 * launch asks again. An hour of inconvenience beats a credential on disk.
 *
 * What is written is written atomically and readable by this user only.
 */

import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';

/** The slice of Electron's `safeStorage` used here. */
export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
    /** Linux only: which store backs it. */
    getSelectedStorageBackend?(): string;
}

/**
 * The Linux backends that are not a keyring. `basic_text` is Chromium's
 * hardcoded-key fallback; `unknown` means it has not even decided.
 */
const NOT_A_KEYRING = new Set(['basic_text', 'unknown']);

export interface SecretsIo {
    readFile(file: string, encoding: 'utf8'): Promise<string>;
    writeFile(file: string, data: string, options: { encoding: 'utf8'; mode: number }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    mkdir(dir: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
    rm(file: string, options: { force: true }): Promise<void>;
}

const realIo: SecretsIo = {
    readFile: (file, encoding) => fsPromises.readFile(file, encoding),
    writeFile: (file, data, options) => fsPromises.writeFile(file, data, options),
    rename: (from, to) => fsPromises.rename(from, to),
    mkdir: (dir, options) => fsPromises.mkdir(dir, options),
    rm: (file, options) => fsPromises.rm(file, options),
};

export interface SecretsOptions {
    /** Absolute path to the sealed-credential file. */
    file: string;
    safeStorage: SafeStorageLike;
    io?: SecretsIo;
    onWarning?: (message: string) => void;
    /** Injected for tests; defaults to process.platform. */
    platform?: NodeJS.Platform;
}

/** The keys this store holds. A closed set, so a typo cannot invent a slot. */
export type SecretKey = 'beeflow.sessionToken' | 'nextcloud.appPassword';

interface SealedFile {
    version: 1;
    /** key → base64 of the safeStorage ciphertext. */
    values: Record<string, string>;
}

export class SecretStore {
    private readonly file: string;
    private readonly safeStorage: SafeStorageLike;
    private readonly io: SecretsIo;
    private readonly warn: (message: string) => void;
    private readonly platform: NodeJS.Platform;
    private warnedAboutBackend = false;

    /** The session's view. Always populated; the disk copy may be a subset. */
    private readonly memory = new Map<SecretKey, string>();
    private loaded = false;

    constructor(options: SecretsOptions) {
        this.file = options.file;
        this.safeStorage = options.safeStorage;
        this.io = options.io ?? realIo;
        this.warn = options.onWarning ?? ((message) => console.warn(`[Secrets] ${message}`));
        this.platform = options.platform ?? process.platform;
    }

    /**
     * Can this machine seal a credential? The settings UI reads this to explain
     * why a pairing did not stick, instead of leaving the user to find out by
     * being logged out tomorrow.
     */
    get available(): boolean {
        try {
            if (!this.safeStorage.isEncryptionAvailable()) return false;
            if (this.platform !== 'linux') return true;
            const backend = this.safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
            if (!NOT_A_KEYRING.has(backend)) return true;
            if (!this.warnedAboutBackend) {
                this.warnedAboutBackend = true;
                this.warn(
                    `the only credential store on this desktop is "${backend}", which is not a keyring, so nothing is written to disk. ` +
                        'Run gnome-keyring or KWallet (or start Bee Flow with --password-store=gnome-libsecret) to keep sign-ins between launches.',
                );
            }
            return false;
        } catch (error) {
            this.warn(`keyring check failed: ${describe(error)}`);
            return false;
        }
    }

    async load(): Promise<void> {
        this.loaded = true;
        if (!this.available) return;

        let parsed: SealedFile | null = null;
        try {
            parsed = JSON.parse(await this.io.readFile(this.file, 'utf8')) as SealedFile;
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                this.warn(`could not read sealed credentials: ${describe(error)}`);
            }
            return;
        }

        for (const [key, sealed] of Object.entries(parsed?.values ?? {})) {
            try {
                this.memory.set(key as SecretKey, this.safeStorage.decryptString(Buffer.from(sealed, 'base64')));
            } catch (error) {
                // A keyring that was reset, or a file copied from another
                // machine. Neither is recoverable and neither is fatal: drop
                // the value and let the user sign in again.
                this.warn(`could not unseal "${key}" (${describe(error)}); it will be asked for again`);
            }
        }
    }

    get(key: SecretKey): string | null {
        if (!this.loaded) this.warn('read before load(); returning nothing');
        return this.memory.get(key) ?? null;
    }

    /**
     * Store a credential. Returns whether it was PERSISTED — false means it is
     * held for this session only, which callers surface rather than swallow.
     */
    async set(key: SecretKey, value: string): Promise<boolean> {
        this.memory.set(key, value);
        if (!this.available) {
            this.warn(
                `no OS keyring available, so "${key}" is kept in memory for this session only. ` +
                    'On Linux, install and run a Secret Service provider (gnome-keyring or kwallet) to keep it.',
            );
            return false;
        }
        return this.persist();
    }

    async delete(key: SecretKey): Promise<void> {
        this.memory.delete(key);
        if (this.memory.size === 0) {
            await this.io.rm(this.file, { force: true }).catch(() => undefined);
            return;
        }
        await this.persist();
    }

    /** Forget everything, on disk and in memory. Used when signing out. */
    async clear(): Promise<void> {
        this.memory.clear();
        await this.io.rm(this.file, { force: true }).catch(() => undefined);
    }

    private async persist(): Promise<boolean> {
        const values: Record<string, string> = {};
        for (const [key, value] of this.memory) {
            try {
                values[key] = this.safeStorage.encryptString(value).toString('base64');
            } catch (error) {
                this.warn(`could not seal "${key}": ${describe(error)}`);
                return false;
            }
        }
        // A temporary file, then a rename: a crash mid-write leaves the old file
        // or the new one, never half of one. 0600 on the file and 0700 on a
        // directory created here, because other accounts on the machine have
        // no business with even the sealed bytes.
        const temporary = `${this.file}.tmp`;
        try {
            await this.io.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
            await this.io.writeFile(temporary, `${JSON.stringify({ version: 1, values } satisfies SealedFile, null, 4)}\n`, { encoding: 'utf8', mode: 0o600 });
            await this.io.rename(temporary, this.file);
            return true;
        } catch (error) {
            this.warn(`could not write sealed credentials: ${describe(error)}`);
            return false;
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
