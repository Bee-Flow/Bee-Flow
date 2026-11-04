/**
 * describeStepError: every failure gets its real reason, a code and whether a
 * retry can help. Never "Step failed"; never driver or provider text.
 *
 * Run: cd server && node --test appStudio/actionExecutor/stepErrors.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { describeStepError } = require('./stepErrors.mts');

const logged = [];
const deps = { log: { error: (msg, meta) => logged.push({ msg, meta }) }, ref: () => 'abcd1234', isRowsLocked: (e) => e && e.name === 'RowsLockedError' };
const err = (message, extra = {}) => Object.assign(new Error(message), extra);
const d = (e, kind = 'create_record') => describeStepError(e, { kind }, deps);

test.beforeEach(() => { logged.length = 0; });

test('the mapping rows, in order', () => {
    const cases = [
        [err('App is full', { status: 409, code: 'quota_exceeded', limit: 10, used: 10 }), { error: 'App is full', code: 'quota_exceeded', retryable: false, limit: 10, used: 10 }],
        [err('The AI did not answer within 120 seconds', { code: 'ai_timeout', safe: true }), { error: 'The AI did not answer within 120 seconds', code: 'ai_timeout', retryable: true }],
        [err('These rows belong to a release', { name: 'RowsLockedError', status: 409 }), { error: 'These rows belong to a release', code: 'managed_part', retryable: false }],
        [err('You may not write here', { status: 403 }), { error: 'You may not write here', code: 'forbidden', retryable: false }],
        [err('The prompt is empty', { status: 400 }), { error: 'The prompt is empty', code: 'bad_input', retryable: false }],
        [Object.assign(err('Unknown field "x"', { status: 422 }), { name: 'CompileError' }), { error: 'Unknown field "x"', code: 'invalid_field', retryable: false }],
        [err('The AI returned no records', { status: 422, code: 'ai_no_output' }), { error: 'The AI returned no records', code: 'ai_no_output', retryable: true }],
        [err('A value does not fit', { status: 422 }), { error: 'A value does not fit', code: 'unprocessable', retryable: false }],
        [err('A record with this value already exists — "sku" must be unique', { status: 409, code: 'unique_violation' }), { error: 'A record with this value already exists — "sku" must be unique', code: 'unique_violation', retryable: false }],
        [err('The linked table could not be read', { status: 503, safe: true }), { error: 'The linked table could not be read', code: 'datatable_source', retryable: true }],
        [err('Not possible here yet', { status: 501, safe: true }), { error: 'Not possible here yet', code: 'datatable_source', retryable: false }],
        [err('canceling statement due to statement timeout', { code: 'statement_timeout' }), { error: 'The database took too long to answer.', code: 'db_timeout', retryable: true }],
        [err('duplicate key value violates unique constraint "uq_x" Key (sku)=(S-1)', { code: '23505' }), { error: 'A record with this value already exists.', code: 'unique_violation', retryable: false }],
        [err('null value in column "x"', { code: '23502' }), { error: 'A required value is missing.', code: 'required_value', retryable: false }],
        [err('new row violates check constraint', { code: '23514' }), { error: 'A value is not allowed by the table\'s rules.', code: 'check_violation', retryable: false }],
        [err('could not serialize access', { code: '40001' }), { error: 'The database was busy with another change. Try again.', code: 'db_busy', retryable: true }],
        [err('deadlock detected', { code: '40P01' }), { error: 'The database was busy with another change. Try again.', code: 'db_busy', retryable: true }],
        [err('database is locked', { code: 'SQLITE_BUSY' }), { error: 'The database was busy with another change. Try again.', code: 'db_busy', retryable: true }],
        [err('datatype mismatch', { code: 'SQLITE_MISMATCH' }), { error: 'A value does not fit its column type.', code: 'invalid_value', retryable: false }],
    ];
    for (const [e, want] of cases) assert.deepEqual(d(e), { ok: false, ...want }, e.message);
    assert.equal(logged.length, 0, 'known failures are not logged as internal');
});

test('provider and network failures: fixed sentences, AI wording for AI kinds', () => {
    assert.deepEqual(d(err('Rate limit: you sent "secret prompt"', { status: 429 }), 'ai_generate'),
        { ok: false, error: 'The AI provider is receiving too many requests. Try again in a moment.', code: 'provider_rate_limit', retryable: true });
    assert.deepEqual(d(err('invalid x-api-key', { status: 401 }), 'ai_extract'),
        { ok: false, error: 'The AI provider refused the credentials. An administrator needs to check the connection.', code: 'provider_credentials', retryable: false });
    assert.deepEqual(d(err('overloaded', { status: 529 }), 'ai_generate'),
        { ok: false, error: 'The AI provider had a temporary problem. Try again.', code: 'provider_unavailable', retryable: true });
    assert.deepEqual(d(err('connect ECONNREFUSED 10.0.0.1:443', { code: 'ECONNREFUSED' }), 'kb_query'),
        { ok: false, error: 'The AI provider could not be reached. Try again.', code: 'provider_unreachable', retryable: true });
    assert.deepEqual(d(err('socket hang', { code: 'UND_ERR_SOCKET' }), 'generate_file'),
        { ok: false, error: 'The service this step calls could not be reached. Try again.', code: 'provider_unreachable', retryable: true });
});

test('an unknown error: a reference, retryable, and a log line without its message', () => {
    const out = d(err('TypeError: cannot read "Jan Jansen" of undefined'), 'generate_file');
    assert.deepEqual(out, {
        ok: false, error: 'The generate file step could not finish because of an internal error (reference abcd1234).',
        code: 'internal', retryable: true, ref: 'abcd1234',
    });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].msg, '[ActionExecutor] step failed');
    assert.deepEqual(logged[0].meta, { kind: 'generate_file', ref: 'abcd1234', code: null, status: null, name: 'Error' });
    assert.doesNotMatch(JSON.stringify(logged[0]), /Jan Jansen|cannot read/);
});

test('AI kinds say "The AI step"; a thrown non-error still gets a reference', () => {
    assert.match(d('boom', 'ai_generate').error, /^The AI step could not finish because of an internal error \(reference abcd1234\)\.$/);
    assert.equal(d(null, 'ai_generate').code, 'internal');
    assert.notEqual(d(err('x'), 'create_record').error, 'Step failed');
});

test('the default reference is 8 hex characters', () => {
    const out = describeStepError(new Error('x'), { kind: 'create_record' }, { log: { error() {} } });
    assert.match(out.ref, /^[0-9a-f]{8}$/);
    assert.match(out.error, new RegExp(`reference ${out.ref}`));
});
