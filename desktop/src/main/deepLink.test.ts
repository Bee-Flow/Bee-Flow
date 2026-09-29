import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { confirmationPrompt, extractDeepLink, parseDeepLink } from './deepLink.ts';

describe('extractDeepLink', () => {
    it('finds the link among Chromium switches', () => {
        assert.equal(
            extractDeepLink(['/opt/Bee Flow/beeflow', '--no-sandbox', 'beeflow://chat/42']),
            'beeflow://chat/42',
        );
    });

    it('takes the last one, not a path that happens to look like a URL', () => {
        assert.equal(
            extractDeepLink(['app', 'beeflow://chat/1', '--flag', 'beeflow://chat/2']),
            'beeflow://chat/2',
        );
    });

    it('returns null when there is none', () => {
        assert.equal(extractDeepLink(['app', '--enable-logging']), null);
        assert.equal(extractDeepLink([]), null);
    });
});

describe('parseDeepLink — navigation', () => {
    it('maps the product nouns onto SPA paths', () => {
        assert.deepEqual(parseDeepLink('beeflow://chat/abc-123'), { kind: 'navigate', path: '/app/chat/abc-123', needsConfirmation: false });
        assert.deepEqual(parseDeepLink('beeflow://automations'), { kind: 'navigate', path: '/app/automations', needsConfirmation: false });
        assert.deepEqual(parseDeepLink('beeflow://go/app/admin/usage'), { kind: 'navigate', path: '/app/admin/usage', needsConfirmation: false });
    });

    it('never produces a path that resolves to another origin', () => {
        // The property that matters is not which verdict comes back but where
        // the SPA ends up: the main window resolves the path against the
        // configured server, exactly as `new URL(path, server)` does here. A
        // protocol-relative path, a backslash separator and an encoded
        // separator are all ways of making that resolution land somewhere else.
        const server = 'https://bee.example.com';
        for (const link of [
            'beeflow://go//evil.example/steal',
            'beeflow://go/%2f%2fevil.example/steal',
            'beeflow://go/%5c%5cevil.example%5csteal',
            'beeflow://chat/..%2f..%2fadmin',
            'beeflow://go/\\\\evil.example\\steal',
            'beeflow://go/https://evil.example',
        ]) {
            const action = parseDeepLink(link);
            if (action.kind === 'unknown') continue;
            assert.equal(action.kind, 'navigate', link);
            assert.equal(new URL(action.path, server).origin, server, link);
        }
    });

    it('refuses a traversal that survived URL parsing', () => {
        // A literal `..` is collapsed by the URL constructor before this code
        // sees it, which is why the encoded form is the one worth testing: it
        // arrives intact and has to be rejected here.
        assert.equal(parseDeepLink('beeflow://chat/..%2f..%2fadmin').kind, 'unknown');
        assert.equal(parseDeepLink('beeflow://go/app%2f..%2f..%2fadmin').kind, 'unknown');
    });

    it('refuses control characters in a path', () => {
        assert.equal(parseDeepLink('beeflow://go/app/%00admin').kind, 'unknown');
    });
});

describe('parseDeepLink — actions with consequences', () => {
    it('asks before repointing the client at another server', () => {
        const action = parseDeepLink('beeflow://server?url=https://evil.example');
        assert.equal(action.kind, 'set-server');
        assert.equal(action.needsConfirmation, true);
        const prompt = confirmationPrompt(action);
        assert.match(String(prompt?.detail), /evil\.example/, 'the dialog names the server');
        assert.match(String(prompt?.detail), /sends your sign-in/, 'and says what it costs');
    });

    it('asks before pairing a Nextcloud account', () => {
        const action = parseDeepLink('beeflow://nextcloud?server=https://cloud.evil.example');
        assert.equal(action.kind, 'pair-nextcloud');
        assert.equal(action.needsConfirmation, true);
        assert.match(String(confirmationPrompt(action)?.detail), /your own Nextcloud/);
    });

    it('asks before opening a local file', () => {
        const action = parseDeepLink('beeflow://open?path=/home/tom/Nextcloud/report.pdf');
        assert.equal(action.kind, 'open-path');
        assert.equal(action.needsConfirmation, true);
    });

    it('lets a quick ask through without a dialog, but caps its length', () => {
        const action = parseDeepLink(`beeflow://ask?text=${encodeURIComponent('summarise this week')}`);
        assert.deepEqual(action, { kind: 'quick-ask', text: 'summarise this week', needsConfirmation: false });

        const long = parseDeepLink(`beeflow://ask?text=${'x'.repeat(9000)}`);
        assert.equal(long.kind === 'quick-ask' && long.text.length, 4000);
    });
});

describe('parseDeepLink — refusals', () => {
    it('rejects another scheme', () => {
        assert.equal(parseDeepLink('https://bee.example.com/app').kind, 'unknown');
        assert.equal(parseDeepLink('file:///etc/passwd').kind, 'unknown');
    });

    it('rejects nonsense without throwing', () => {
        for (const link of ['', '   ', 'beeflow:/', 'beeflow://', 'beeflow://nope/what']) {
            assert.equal(parseDeepLink(link).kind, 'unknown', JSON.stringify(link));
        }
    });

    it('has no confirmation prompt for the harmless kinds', () => {
        assert.equal(confirmationPrompt(parseDeepLink('beeflow://chat/1')), null);
        assert.equal(confirmationPrompt(parseDeepLink('beeflow://ask?text=hi')), null);
    });
});
