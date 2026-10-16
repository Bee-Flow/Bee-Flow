/** Teams: delete is only reported as done when the team is really gone. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { json, installFakeNc, resetFakeNc } = require('./nextcloudToolFakes');
const { executeNextcloudTeamsTool } = require('./nextcloudTeamsTools');

test.afterEach(resetFakeNc);

const OK = () => json(200, { ocs: { meta: { statuscode: 200 }, data: [] } });
const NOT_FOUND = () => json(404, { ocs: { meta: { statuscode: 404, message: 'Circle not found' } } });
const TEAM = () => json(200, { ocs: { meta: { statuscode: 200 }, data: { id: 'c1', name: 'T', population: 1 } } });
const del = () => executeNextcloudTeamsTool('nextcloud_teams_delete', { teamId: 'c1' }, 'u', {});

/** A Nextcloud whose DELETE answers `answer`; the team is gone afterwards only if `gone`. */
function install(answer, gone) {
    let exists = true;
    return installFakeNc((req) => {
        if (req.method === 'DELETE') { if (gone) exists = false; return answer(); }
        return exists ? TEAM() : NOT_FOUND();
    });
}

test('delete that really removes the team is a success', async () => {
    const calls = install(OK, true);
    assert.deepEqual(await del(), { success: true, teamId: 'c1' });
    assert.deepEqual(calls.map(c => c.method), ['DELETE', 'GET'], 'the result is read back');
});

test('a 200 that did not delete the team is reported as a failure', async () => {
    install(OK, false);
    const out = await del();
    assert.equal(out.success, undefined);
    assert.match(out.error, /still exists/i);
});

test('an OCS failure inside an HTTP 200 is reported with its message', async () => {
    const calls = install(() => json(200, { ocs: { meta: { statuscode: 403, message: 'Only the owner can delete' }, data: [] } }), false);
    assert.match((await del()).error, /Only the owner can delete/);
    assert.deepEqual(calls.map(c => c.method), ['DELETE'], 'no read-back needed once the answer itself says no');
});

test('the OCS message is cleaned and capped before it is shown', async () => {
    install(() => json(200, { ocs: { meta: { statuscode: 403, message: `bad\u0000\n${'x'.repeat(500)}` }, data: [] } }), false);
    const { error } = await del();
    assert.doesNotMatch(error, /[\u0000\n]/);
    assert.ok(error.length < 300);
});

test('deleting a team that does not exist is an error, not a second success', async () => {
    install(NOT_FOUND, true);
    const out = await del();
    assert.ok(out.error);
    assert.equal(out.success, undefined);
});

test('when the read-back fails the delete is not claimed as done', async () => {
    installFakeNc((req) => (req.method === 'DELETE' ? OK() : json(403, { ocs: { meta: { message: 'no' } } })));
    assert.match((await del()).error, /could not be confirmed/i);
});

test('a 401 on the read-back is the auth error', async () => {
    installFakeNc((req) => (req.method === 'DELETE' ? OK() : json(401, {})));
    assert.equal((await del()).error, 'auth');
});
