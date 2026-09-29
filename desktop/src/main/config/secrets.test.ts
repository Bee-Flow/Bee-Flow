import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { SecretStore, type SafeStorageLike, type SecretsIo } from './secrets.ts';

/** A keyring stand-in. "Encryption" is a reversible marker — enough to prove
 *  the bytes on disk are not the plaintext, which is what the test is about. */
class FakeKeyring implements SafeStorageLike {
    private readonly ok: boolean;
    private readonly backend: string;
    constructor(ok = true, backend = 'gnome_libsecret') {
        this.ok = ok;
        this.backend = backend;
    }
    getSelectedStorageBackend(): string {
        return this.backend;
    }
    isEncryptionAvailable(): boolean {
        return this.ok;
    }
    encryptString(plain: string): Buffer {
        if (!this.ok) throw new Error('no keyring');
        return Buffer.from(`sealed:${plain}`, 'utf8');
    }
    decryptString(encrypted: Buffer): string {
        const text = encrypted.toString('utf8');
        if (!text.startsWith('sealed:')) throw new Error('not ours');
        return text.slice('sealed:'.length);
    }
}

class FakeFs implements SecretsIo {
    files = new Map<string, string>();
    modes = new Map<string, number>();
    async readFile(file: string): Promise<string> {
        const value = this.files.get(file);
        if (value === undefined) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
        }
        return value;
    }
    async writeFile(file: string, data: string, options: { mode: number }): Promise<void> {
        this.files.set(file, data);
        this.modes.set(file, options.mode);
    }
    async rename(from: string, to: string): Promise<void> {
        const data = this.files.get(from);
        if (data === undefined) throw new Error('ENOENT');
        this.files.set(to, data);
        this.modes.set(to, this.modes.get(from) ?? 0o644);
        this.files.delete(from);
        this.modes.delete(from);
    }
    async mkdir(): Promise<string | undefined> {
        return undefined;
    }
    async rm(file: string): Promise<void> {
        this.files.delete(file);
    }
}

const FILE = '/home/tom/.config/Bee Flow/credentials.json';

let io: FakeFs;
let warnings: string[];

beforeEach(() => {
    io = new FakeFs();
    warnings = [];
});

function store(keyring: SafeStorageLike, platform: NodeJS.Platform = 'linux'): SecretStore {
    return new SecretStore({ file: FILE, safeStorage: keyring, io, platform, onWarning: (m) => warnings.push(m) });
}

describe('SecretStore with a working keyring', () => {
    it('round-trips a credential without writing the plaintext', async () => {
        const first = store(new FakeKeyring());
        await first.load();
        assert.equal(await first.set('nextcloud.appPassword', 'hunter2-not-real'), true);

        const onDisk = String(io.files.get(FILE));
        assert.doesNotMatch(onDisk, /hunter2-not-real/, 'the password must not appear in the file');

        const second = store(new FakeKeyring());
        await second.load();
        assert.equal(second.get('nextcloud.appPassword'), 'hunter2-not-real');
    });

    it('removes the file once the last credential is deleted', async () => {
        const s = store(new FakeKeyring());
        await s.load();
        await s.set('beeflow.sessionToken', 'token');
        await s.delete('beeflow.sessionToken');
        assert.equal(io.files.has(FILE), false);
    });

    it('drops a value it cannot unseal instead of failing to start', async () => {
        io.files.set(FILE, JSON.stringify({ version: 1, values: { 'beeflow.sessionToken': Buffer.from('from-another-machine').toString('base64') } }));
        const s = store(new FakeKeyring());
        await s.load();
        assert.equal(s.get('beeflow.sessionToken'), null);
        assert.match(warnings.join(' '), /asked for again/);
    });
});

describe('SecretStore without a keyring', () => {
    it('keeps the value for the session but refuses to write it down', async () => {
        const s = store(new FakeKeyring(false));
        await s.load();

        const persisted = await s.set('nextcloud.appPassword', 'hunter2-not-real');

        assert.equal(persisted, false, 'the caller is told it did not stick');
        assert.equal(s.get('nextcloud.appPassword'), 'hunter2-not-real', 'but this session still works');
        assert.equal(io.files.size, 0, 'nothing reached the disk');
        assert.match(warnings.join(' '), /gnome-keyring|kwallet/, 'and the user is told how to fix it');
    });

    it('reports its own unavailability rather than guessing', () => {
        assert.equal(store(new FakeKeyring(false)).available, false);
        assert.equal(store(new FakeKeyring(true)).available, true);
    });

    it('treats a throwing keyring as unavailable', () => {
        const explodes: SafeStorageLike = {
            isEncryptionAvailable() {
                throw new Error('dbus is not running');
            },
            encryptString: () => Buffer.alloc(0),
            decryptString: () => '',
        };
        assert.equal(store(explodes).available, false);
        assert.match(warnings.join(' '), /dbus/);
    });
});

describe('SecretStore — Linux without a real keyring', () => {
    it('treats basic_text as no keyring, even when Electron says encryption is available', async () => {
        // Chromium's basic_text backend "encrypts" with a key hardcoded in
        // Chromium itself, and isEncryptionAvailable() has answered true for it.
        const secrets = store(new FakeKeyring(true, 'basic_text'));
        assert.equal(secrets.available, false);
        await secrets.load();
        assert.equal(await secrets.set('nextcloud.appPassword', 'app-password-value'), false);
        assert.equal(io.files.size, 0, 'nothing written to disk');
        assert.equal(secrets.get('nextcloud.appPassword'), 'app-password-value', 'still usable this session');
        assert.equal(warnings.filter((w) => w.includes('basic_text')).length, 1, 'said once, not on every call');
    });

    it('treats an undecided backend the same way', () => {
        assert.equal(store(new FakeKeyring(true, 'unknown')).available, false);
    });

    it('accepts the real keyrings', () => {
        for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
            assert.equal(store(new FakeKeyring(true, backend)).available, true, backend);
        }
    });

    it('does not ask the backend question off Linux', () => {
        assert.equal(store(new FakeKeyring(true, 'basic_text'), 'darwin').available, true);
        assert.equal(store(new FakeKeyring(true, 'basic_text'), 'win32').available, true);
    });
});

describe('SecretStore — the file on disk', () => {
    it('is written through a temporary file and readable by this user only', async () => {
        const secrets = store(new FakeKeyring());
        await secrets.load();
        await secrets.set('beeflow.sessionToken', 'token');
        assert.equal(io.files.has(`${FILE}.tmp`), false, 'renamed into place');
        assert.equal(io.modes.get(FILE), 0o600);
    });
});
