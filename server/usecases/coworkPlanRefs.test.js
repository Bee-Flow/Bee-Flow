/**
 * A list a plan step works through that the earlier step's described output does not have (./coworkPlanRefs.mts): a finding
 * with a plain sentence, before the plan is approved. An output nobody described is never a finding.
 *
 * Run: cd server && node --test usecases/coworkPlanRefs.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { refFindings } = require('./coworkPlanRefs.mts');
const { fakeLookups } = require('../core/cowork/plan/plan.testkit');

const lookups = fakeLookups();
const plan = (overRef, tool = 'fireflies_list_transcripts') => ({
    schemaVersion: 1,
    trigger: { id: 'trg', type: 'trigger', kind: 'schedule' },
    steps: [
        { id: 'list', type: 'integration_action', label: 'List meetings', tool, inputs: {} },
        { id: 'sums', type: 'integration_action', label: 'Get summaries', tool: 'fireflies_get_summary', forEach: { overRef, itemVar: 't' }, inputs: {} },
    ],
    edges: [],
});

test('a key the tool does not return is a finding that names the step, the field and what it does return', () => {
    const [finding, ...more] = refFindings(plan('steps.list.output.transcripts'), lookups);
    assert.deepStrictEqual(more, []);
    assert.deepStrictEqual([finding.code, finding.stepId], ['ref.missing', 'sums']);
    assert.match(finding.message, /^Step 'Get summaries' reads `transcripts` from 'List meetings', which returns no such field\. It returns: results, count/);
});

test('the list the tool does return is no finding', () => {
    assert.deepStrictEqual(refFindings(plan('steps.list.output.results'), lookups), []);
});

test('the output itself is no list: a finding that says what it holds', () => {
    const [finding] = refFindings(plan('steps.list.output'), lookups);
    assert.match(finding.message, /as a list, but it is no list\. It returns: results/);
});

test('a tool nobody described is never a reason for a finding', () => {
    assert.deepStrictEqual(refFindings(plan('steps.list.output.whatever', 'someone_custom_tool'), lookups), []);
});
