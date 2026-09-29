/**
 * What must never leave the device.
 *
 * These are pinned rather than spot-checked because the scrubber is the only
 * thing standing between a stack trace and a customer's content. Each case
 * below is a shape that actually occurs in this app's errors, not a
 * hypothetical.
 */

import { scrubMessage, scrubStack, truncate } from './scrub';

describe('scrubMessage', () => {
    it('removes an email address', () => {
        expect(scrubMessage('No account for tom@beeflow.nl')).toBe('No account for <email>');
    });

    it('removes a session bridge token', () => {
        // A live credential until it expires. This is the single worst thing
        // that could ride along in an error message.
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_123';
        expect(scrubMessage(`401 for ${jwt}`)).toBe('401 for <token>');
    });

    it('removes conversation and document ids', () => {
        expect(scrubMessage('GET /ai/direct/conversations/3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed')).toContain('<id>');
        expect(scrubMessage('GET /x/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).not.toMatch(/3f2504e0/);
    });

    it('removes the server URL, which on a self-host is the customer name', () => {
        expect(scrubMessage('connect ECONNREFUSED https://ai.acme-notaris.nl/api/health')).toBe(
            'connect ECONNREFUSED <url>',
        );
    });

    it('removes quoted content but keeps a quoted property name', () => {
        // The property name is the most useful word in a TypeError and is code,
        // not content. A document title is content.
        expect(scrubMessage("Cannot read property 'id' of undefined")).toBe(
            "Cannot read property 'id' of undefined",
        );
        expect(scrubMessage('Could not open "Q3 leveranciersovereenkomst.pdf"')).toBe(
            'Could not open "<quoted>"',
        );
    });

    it('removes long digit runs, which are never diagnostic and often personal', () => {
        expect(scrubMessage('BSN 123456789 rejected')).toBe('BSN <number> rejected');
        // An HTTP status or a short count survives — those are the numbers you
        // actually read a crash report for.
        expect(scrubMessage('HTTP 404 after 3 retries')).toBe('HTTP 404 after 3 retries');
    });

    it('truncates', () => {
        expect(scrubMessage('x'.repeat(900))).toHaveLength(600 + '…[truncated]'.length);
    });

    it('survives a non-string', () => {
        expect(scrubMessage(undefined)).toBe('');
        expect(scrubMessage(null)).toBe('');
        expect(scrubMessage(42)).toBe('42');
    });
});

describe('scrubStack', () => {
    const stack = [
        'TypeError: undefined is not a function',
        '    at ChatScreen (/data/app/index.android.bundle:14203:31)',
        '    at renderWithHooks (/data/app/index.android.bundle:9021:17)',
    ].join('\n');

    it('keeps the frames, which are the only reason to send a stack at all', () => {
        const out = scrubStack(stack);
        expect(out).toContain('index.android.bundle:14203:31');
        expect(out).toContain('renderWithHooks');
    });

    it('still removes credentials and ids from a frame', () => {
        const withSecret = `${stack}\n    at fetch (https://x/api?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef)`;
        expect(scrubStack(withSecret)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
        expect(scrubStack('at load (3f2504e0-4f89-11d3-9a0c-0305e82c3301)')).toContain('<id>');
    });
});

describe('truncate', () => {
    it('leaves short text alone', () => {
        expect(truncate('short', 10)).toBe('short');
    });
    it('marks what it cut', () => {
        expect(truncate('abcdef', 3)).toBe('abc…[truncated]');
    });
});
