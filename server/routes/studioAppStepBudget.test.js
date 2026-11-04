'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { limitersForStep, limitersForStepDef } = require('./studioAppStepBudget.mts');

const fake = (name) => ({ limiterName: name, check: async () => true, take: async () => ({ ok: true }) });
const LIMITERS = Object.fromEntries(['aiStepLimiter', 'actionRunLimiter', 'sendEmailLimiter', 'sendEmailDailyLimiter', 'fileIntakeLimiter', 'datasetQueryLimiter'].map((n) => [n, fake(n)]));
const names = (budgets) => budgets.map((b) => b.name);

test('a one-row write costs no run; a filter-mode write and a replaceWhere cost one (the /step route and a job alike)', () => {
    assert.deepEqual(names(limitersForStepDef({ kind: 'update_record', recordId: 'r1' }, LIMITERS)), []);
    assert.deepEqual(names(limitersForStepDef({ kind: 'delete_record', filter: [{ field: 'status', op: 'eq', value: 'done' }] }, LIMITERS)), ['STUDIO_APP_ACTION_RUN_RPM']);
    assert.deepEqual(names(limitersForStepDef({ kind: 'dataset_query', writeTo: { tableId: 't', replaceWhere: [] } }, LIMITERS)), ['STUDIO_APP_ACTION_RUN_RPM', 'STUDIO_APP_DATASET_QUERY_RPM']);
});

test('a bulk model call stays on the model bucket only', () => {
    assert.deepEqual(names(limitersForStepDef({ kind: 'ai_extract', writeTo: { tableId: 't', replaceWhere: [] } }, LIMITERS)), ['STUDIO_APP_AI_STEP_RPM']);
    assert.deepEqual(names(limitersForStep('send_email', LIMITERS)), ['STUDIO_APP_ACTION_RUN_RPM', 'STUDIO_APP_SEND_EMAIL_RPM', 'STUDIO_APP_SEND_EMAIL_DAILY']);
});
