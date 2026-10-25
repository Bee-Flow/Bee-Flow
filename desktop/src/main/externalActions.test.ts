import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { openExternally, type OpenExternallyHost, revealPath, type RevealHost } from './externalActions.ts';

function openHost(fail = false) {
    const log: string[] = [];
    const messages: { detail: string }[] = [];
    const host: OpenExternallyHost = {
        info: (_t, m) => void log.push(`info ${m}`),
        warn: (_t, m) => void log.push(`warn ${m}`),
        openExternal: async (url) => {
            if (fail) throw new Error('no browser');
            log.push(`open ${url}`);
        },
        showMessage: (message) => void messages.push(message),
    };
    return { host, log, messages };
}

test('openExternally opens the address and says so', async () => {
    const { host, log, messages } = openHost();
    assert.equal(await openExternally('https://example.org/x', host), true);
    assert.deepEqual(log, ['info opening in the browser: https://example.org/x', 'open https://example.org/x']);
    assert.equal(messages.length, 0);
});

test('openExternally shows the address when no browser opens', async () => {
    const { host, log, messages } = openHost(true);
    assert.equal(await openExternally('https://example.org/x', host), false);
    assert.match(log.at(-1) ?? '', /^warn could not open https:\/\/example\.org\/x: Error: no browser/);
    assert.match(messages[0]?.detail ?? '', /https:\/\/example\.org\/x/);
});

function revealHost() {
    const shown: string[] = [];
    const warnings: string[] = [];
    const downloads = path.resolve('/home/u/Downloads');
    const host: RevealHost = {
        warn: (_t, m) => void warnings.push(m),
        ownFiles: [path.resolve('/home/u/.config/app/log.txt')],
        isInsideSyncFolder: (resolved) => resolved.startsWith(path.resolve('/home/u/Nextcloud')),
        downloads: () => downloads,
        showItemInFolder: (p) => void shown.push(p),
    };
    return { host, shown, warnings, downloads };
}

test('revealPath shows a file in Downloads or a sync folder', () => {
    const { host, shown, downloads } = revealHost();
    assert.equal(revealPath(path.join(downloads, 'a.pdf'), {}, host), true);
    assert.equal(revealPath(path.resolve('/home/u/Nextcloud/b.txt'), {}, host), true);
    assert.equal(shown.length, 2);
});

test('revealPath refuses anywhere else, and logs what it refused', () => {
    const { host, shown, warnings } = revealHost();
    assert.equal(revealPath(path.resolve('/etc/passwd'), {}, host), false);
    assert.equal(revealPath(42, {}, host), false);
    assert.deepEqual(shown, []);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? '', /^refused to reveal /);
});

test('the app\'s own files are revealable only when asked for', () => {
    const { host, shown } = revealHost();
    const own = path.resolve('/home/u/.config/app/log.txt');
    assert.equal(revealPath(own, {}, host), false);
    assert.equal(revealPath(own, { ownFiles: true }, host), true);
    assert.deepEqual(shown, [own]);
});
