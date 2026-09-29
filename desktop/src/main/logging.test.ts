import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redact } from './logging.ts';

describe('redact', () => {
    it('removes a Nextcloud app password from a JSON payload', () => {
        const line = redact('login ok {"server":"https://cloud.example.com","loginName":"tom","appPassword":"aBcDe-FgHiJ-KlMnO-PqRsT-UvWxY"}');
        assert.doesNotMatch(line, /aBcDe/);
        assert.match(line, /loginName":"tom"/, 'the useful part survives');
    });

    it('removes a token from a URL', () => {
        assert.equal(
            redact('GET https://bee.example.com/auth/login-pickup?pickup=abc123def456&x=1'),
            'GET https://bee.example.com/auth/login-pickup?pickup=***&x=1',
        );
    });

    it('removes an Authorization header', () => {
        assert.equal(redact('headers: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'), 'headers: Bearer ***');
        assert.equal(redact('headers: Basic dG9tOnBhc3N3b3Jk'), 'headers: Basic ***');
    });

    it('removes a password from a form body', () => {
        assert.match(redact('body: token=poll-token-here&x=1'), /token=\*\*\*/);
        assert.match(redact('password: hunter2seriously'), /password: \*\*\*/);
    });

    it('catches a bare app password even without a label', () => {
        assert.equal(redact('the value is aBcDe-FgHiJ-KlMnO-PqRsT-UvWxY'), 'the value is ***');
    });

    it('leaves an ordinary message alone', () => {
        const line = 'could not read /home/tom/.config/Nextcloud/nextcloud.cfg: ENOENT';
        assert.equal(redact(line), line);
    });
});
