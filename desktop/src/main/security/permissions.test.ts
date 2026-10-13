import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPermissionHandlers, permissionPrompt, promptNeeded, type PermissionPrompt } from './permissions.ts';

const PLAIN = 'http://192.168.1.40:5176';
const SECURE = 'https://bee.example.com';

function setup(options: { allowed?: boolean } = {}) {
    const refused: string[] = [];
    const handlers = createPermissionHandlers({
        allowed: () => options.allowed ?? true,
        isUnencrypted: (url) => url.startsWith(PLAIN),
        onRefused: (permission, url) => refused.push(`${permission} ${url}`),
    });
    return { handlers, refused };
}

function request(handlers: ReturnType<typeof setup>['handlers'], permission: string, url: string, answer?: number) {
    const prompts: PermissionPrompt[] = [];
    let granted: boolean | undefined;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
        settle = resolve;
    });
    handlers.request(
        permission,
        url,
        async (prompt) => {
            prompts.push(prompt);
            return answer ?? 0;
        },
        (value) => {
            granted = value;
            settle();
        },
    );
    return { prompts, done, granted: () => granted };
}

describe('promptNeeded', () => {
    it('asks only about capture on an unencrypted server', () => {
        for (const permission of ['media', 'audioCapture', 'videoCapture', 'display-capture']) {
            assert.equal(promptNeeded(permission, true), true, permission);
            assert.equal(promptNeeded(permission, false), false, permission);
        }
        assert.equal(promptNeeded('notifications', true), false);
        assert.equal(promptNeeded('clipboard-sanitized-write', true), false);
    });
});

describe('permissionPrompt', () => {
    it('names the origin and what it wants, with Block as the default', () => {
        const prompt = permissionPrompt(`${PLAIN}/chat`, 'media');
        assert.equal(prompt.message, `${PLAIN} wants to use your microphone or camera.`);
        assert.deepEqual(prompt.buttons, ['Block', 'Allow']);
        assert.equal(prompt.defaultId, 0);
        assert.equal(prompt.cancelId, 0);
        assert.equal(permissionPrompt(PLAIN, 'display-capture').message, `${PLAIN} wants to use your screen.`);
    });
});

describe('createPermissionHandlers', () => {
    it('refuses what the policy refuses, without asking, and reports it', () => {
        const { handlers, refused } = setup({ allowed: false });
        const result = request(handlers, 'media', PLAIN);
        assert.equal(result.granted(), false);
        assert.equal(result.prompts.length, 0);
        assert.deepEqual(refused, [`media ${PLAIN}`]);
        assert.equal(handlers.check('media', PLAIN), false);
    });

    it('grants on an encrypted server, and non-capture permissions anywhere, synchronously', () => {
        const { handlers } = setup();
        assert.equal(request(handlers, 'media', SECURE).granted(), true);
        assert.equal(request(handlers, 'notifications', PLAIN).granted(), true);
        assert.equal(handlers.check('media', SECURE), true);
        assert.equal(handlers.check('notifications', PLAIN), true);
    });

    it('asks once per origin and permission on a plain-http server and remembers the answer', async () => {
        const { handlers } = setup();
        assert.equal(handlers.check('media', PLAIN), false, 'nothing asked yet');

        const first = request(handlers, 'media', `${PLAIN}/chat`, 1);
        assert.equal(first.granted(), undefined, 'waits for the answer');
        await first.done;
        assert.equal(first.granted(), true);
        assert.equal(first.prompts.length, 1);
        assert.equal(handlers.check('media', PLAIN), true);

        const again = request(handlers, 'media', `${PLAIN}/other`);
        assert.equal(again.granted(), true, 'answered from memory, synchronously');
        assert.equal(again.prompts.length, 0);

        const screen = request(handlers, 'display-capture', PLAIN, 0);
        await screen.done;
        assert.equal(screen.granted(), false, 'another permission is asked separately');
        assert.equal(handlers.check('display-capture', PLAIN), false);
        assert.equal(request(handlers, 'display-capture', PLAIN).granted(), false, 'and a Block is remembered too');
    });
});
