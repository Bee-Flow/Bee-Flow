// @typecheck
'use strict';

/**
 * Characterisation (golden) test for processTurnAttachments: for each
 * scenario what it returns (and whether that is the object it was handed) or
 * throws, every event it sends to the chat, and every call on its
 * collaborators in order: the log line, the provider classification, the
 * attachment processor with the exact options (model, shield, conversation,
 * provider verdict), the block audit, the guardrail ledger writes and the
 * conversation token map. The clock stands still.
 *
 * Scenarios reach each branch: one named file, several files, a nameless
 * file; no summaries; a block for each reason (found, held, decided by the
 * person) with and without categories and context; another failure; scan
 * summaries that were tokenised, allowed, incomplete or timed out; an
 * existing tokenisation record to merge into; the live badge; the raw
 * payload (text parts, a plain string, nothing to show, a token map, a
 * failing lookup); ledger writes that fail; and a turn without an event sink.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/agentRuntime/attachmentIntake.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-01T10:00:00.000Z') });

const { processTurnAttachments, INTAKE_DEPS } = require('./attachmentIntake');

const GOLDEN = path.join(__dirname, 'attachmentIntake.characterisation.golden.json');

const PDF = { name: 'report.pdf', type: 'application/pdf', content: 'data:application/pdf;base64,AAAA' };
const PNG = { name: 'scan.png', type: 'image/png', content: 'data:image/png;base64,BBBB' };
const AGENT = { organization_id: 'org-1', name: 'Helper' };
const SHIELD = { dlpEnabled: true, dlpAllowlistedHosts: ['models.corp.local'] };
const RAW = { ...SHIELD, showRawPayload: true };
/** @param {Record<string, unknown>} [over] */
const blocked = (over = {}) => Object.assign(new Error('This attachment holds personal data and was not sent.'), {
    code: 'ATTACHMENT_PII_BLOCKED', filename: 'report.pdf', reason: 'pii', summary: { byCategory: { person: 2, iban: 1 } }, ...over,
});
/** @param {Record<string, unknown>} [over] */
const summary = (over = {}) => ({ filename: 'report.pdf', action: 'tokenize', count: 3, byCategory: { person: 2, email: 1 }, ...over });
const TEXT_PARTS = [{ type: 'text', text: 'Summarise [person_1]' }, { type: 'image', data: 'x' }, { type: 'note', text: 'not a text part' }, null, { type: 'text', text: 7 }, { type: 'text', text: 'from the file' }];

/**
 * name → { input (overrides of the call), env (what the collaborators answer) }.
 * @type {Record<string, { input?: Record<string, any>, env?: Record<string, any> }>}
 */
const CASES = {
    // what is processed
    oneNamedFile: {},
    oneNamelessFile: { input: { messageMetadata: { attachments: [{ type: 'image/png', content: 'x' }] } } },
    severalFiles: { input: { messageMetadata: { attachments: [PDF, PNG] } } },
    noShieldNoConversationNoConfig: { input: { dlpShield: null, conversation: null, config: null } },
    providerFromConfig: { input: { config: { providerType: 'ollama', url: 'http://models.corp.local:11434', providerName: 'Local' } } },
    providerPrivateHost: { input: { config: { providerType: 'custom', url: 'https://models.corp.local/v1' } } },
    providerAllowlistedHost: { input: { dlpShield: { dlpAllowlistedHosts: ['llm.example.com'] }, config: { providerType: 'custom', url: 'https://llm.example.com/v1' } } },
    providerSameHostNotAllowlisted: { input: { dlpShield: {}, config: { providerType: 'custom', url: 'https://llm.example.com/v1' } } },
    answerWithoutSummaries: { env: { result: {} } },
    answerEmptySummaries: { env: { result: { attachmentScanSummaries: [] } } },
    keepsTheRecordItWasHanded: { input: { _assistantTokenisationInfo: { source: 'privacy_shield', action: 'redact', count: 2, categories: ['person'] } }, env: { result: {} } },
    // blocked
    blockedFound: { env: { throws: blocked() } },
    blockedNoCategories: { env: { throws: blocked({ summary: undefined }) } },
    blockedNoReason: { env: { throws: blocked({ reason: undefined }) } },
    blockedOverflow: { env: { throws: blocked({ reason: 'overflow' }) } },
    blockedTimeout: { env: { throws: blocked({ reason: 'timeout' }) } },
    blockedDegraded: { env: { throws: blocked({ reason: 'degraded', summary: { byCategory: {} } }) } },
    blockedByThePerson: { env: { throws: blocked({ reason: 'user_blocked' }) } },
    blockedAskTimeout: { env: { throws: blocked({ reason: 'ask_timeout' }) } },
    blockedBareContext: { input: { agent: {}, agentId: undefined, userId: undefined, conversation: null, config: null }, env: { throws: blocked() } },
    blockedProviderType: { input: { config: { providerType: 'openai' } }, env: { throws: blocked() } },
    blockedLedgerFails: { env: { throws: blocked(), ledgerThrows: true } },
    blockedNoEventSink: { input: { onEvent: undefined }, env: { throws: blocked() } },
    otherFailure: { env: { throws: new Error('extraction crashed') } },
    otherFailureWithCode: { env: { throws: Object.assign(new Error('too large'), { code: 'ATTACHMENT_TOO_LARGE' }) } },
    failureIsNothing: { env: { throws: null } },
    // scan summaries
    tokenised: { env: { result: { attachmentScanSummaries: [summary()] } } },
    tokenisedSeveral: { input: { messageMetadata: { attachments: [PDF, PNG] } }, env: { result: { attachmentScanSummaries: [summary(), summary({ filename: 'scan.png', count: 1, byCategory: { person: 1, phone: 1 } }), summary({ filename: 'c.txt', count: undefined, byCategory: undefined })] } } },
    allowed: { env: { result: { attachmentScanSummaries: [summary({ action: 'allowed' })] } } },
    cleanFile: { env: { result: { attachmentScanSummaries: [summary({ action: 'none', count: 0, byCategory: {} })] } } },
    incompleteTokenised: { env: { result: { attachmentScanSummaries: [summary({ reason: 'overflow', scannedPages: 40, totalPages: 90 })] } } },
    incompletePassedThrough: { env: { result: { attachmentScanSummaries: [summary({ action: 'none', count: 0, byCategory: {}, reason: 'timeout', scannedPages: 3, totalPages: 9 })] } } },
    timedOutNoFindings: { env: { result: { attachmentScanSummaries: [summary({ action: 'none', count: 0, byCategory: {}, timeout: true })] } } },
    mergesIntoExistingRecord: { input: { _assistantTokenisationInfo: { source: 'privacy_shield', action: 'redact', count: 2, categories: ['person', 'iban'], provider: 'x' } }, env: { result: { attachmentScanSummaries: [summary()] } } },
    mergesIntoBareRecord: { input: { _assistantTokenisationInfo: { source: 'privacy_shield', action: 'redact' } }, env: { result: { attachmentScanSummaries: [summary()] } } },
    summariesBareContext: { input: { agent: {}, agentId: undefined, userId: undefined, conversation: null, config: { providerType: 'azure' }, dlpShield: null }, env: { result: { attachmentScanSummaries: [summary(), summary({ action: 'allowed', reason: 'degraded' })] } } },
    summariesLedgerFails: { env: { result: { attachmentScanSummaries: [summary({ reason: 'overflow' }), summary({ action: 'allowed' })] }, ledgerThrows: true } },
    summariesNoEventSink: { input: { onEvent: undefined, dlpShield: RAW, lastMsg: { role: 'user', content: 'Summarise [person_1]' } }, env: { result: { attachmentScanSummaries: [summary()] }, tokenMap: { '[person_1]': 'Ada' } } },
    // raw payload
    rawPayloadTextParts: { input: { dlpShield: RAW, lastMsg: { role: 'user', content: TEXT_PARTS } }, env: { result: { attachmentScanSummaries: [summary()] }, tokenMap: { '[person_1]': 'Ada' } } },
    rawPayloadString: { input: { dlpShield: RAW, lastMsg: { role: 'user', content: 'Summarise [person_1]' } }, env: { result: { attachmentScanSummaries: [summary()] } } },
    rawPayloadNothingToShow: { input: { dlpShield: RAW, lastMsg: { role: 'user', content: [] } }, env: { result: { attachmentScanSummaries: [summary()] }, tokenMap: { '[person_1]': 'Ada' } } },
    rawPayloadNoMessage: { input: { dlpShield: RAW, lastMsg: null }, env: { result: { attachmentScanSummaries: [summary()] }, tokenMap: null } },
    rawPayloadOtherContent: { input: { dlpShield: RAW, lastMsg: { role: 'user', content: 5 } }, env: { result: { attachmentScanSummaries: [summary()] } } },
    rawPayloadOnlyWithFindings: { input: { dlpShield: RAW, lastMsg: { role: 'user', content: 'plain' } }, env: { result: { attachmentScanSummaries: [summary({ action: 'none', count: 0, byCategory: {}, timeout: true })] } } },
    rawPayloadOff: { input: { lastMsg: { role: 'user', content: 'Summarise [person_1]' } }, env: { result: { attachmentScanSummaries: [summary()] }, tokenMap: { '[person_1]': 'Ada' } } },
    rawPayloadTokenMapFails: { input: { dlpShield: RAW, lastMsg: { role: 'user', content: 'Summarise [person_1]' } }, env: { result: { attachmentScanSummaries: [summary()] }, tokenMapThrows: true } },
    rawPayloadNoConversation: { input: { dlpShield: RAW, conversation: null, lastMsg: { role: 'user', content: 'Summarise [person_1]' } }, env: { result: { attachmentScanSummaries: [summary()] }, tokenMap: { '[person_1]': 'Ada' } } },
};

/** @param {string} name */
async function runCase(name) {
    const c = CASES[name];
    const env = c.env || {};
    /** @type {unknown[][]} */
    const calls = [];
    const persistedByLive = new Map();
    const onEvent = (/** @type {string} */ type, /** @type {unknown} */ data) => { record('event', type, data); };
    const brief = (/** @type {unknown} */ value) => JSON.parse(JSON.stringify(value === undefined ? '<undefined>' : value, (_k, v) => {
        if (v === undefined) return '<undefined>';
        if (v === persistedByLive) return '<persistedByLive>';
        if (v === onEvent) return '<onEvent>';
        if (typeof v === 'function') return '<function>';
        return v;
    }));
    function record(/** @type {string} */ what, /** @type {unknown[]} */ ...args) { calls.push([what, ...brief([null, ...args]).slice(1)]); }
    const ledger = (/** @type {string} */ method) => async (/** @type {unknown} */ row) => {
        record(`ledger.${method}`, row);
        if (env.ledgerThrows) throw new Error('ledger down');
    };
    const real = { classification: INTAKE_DEPS.classification(), blockAudit: INTAKE_DEPS.blockAudit() };
    const deps = {
        ...INTAKE_DEPS,
        log: { ...INTAKE_DEPS.log, info: (/** @type {unknown[]} */ ...a) => record('log.info', ...a) },
        classification: () => { record('classification'); return real.classification; },
        blockAudit: () => { record('blockAudit'); return real.blockAudit; },
        processAttachments: async (/** @type {unknown[]} */ attachments, /** @type {unknown} */ lastMsg, /** @type {unknown} */ userId, /** @type {unknown} */ opts) => {
            record('processAttachments', attachments.length, lastMsg, userId, opts);
            if ('throws' in env) throw env.throws;
            return 'result' in env ? env.result : undefined;
        },
        guardrailEvents: () => {
            record('guardrailEvents');
            return { logGuardrailEvent: ledger('logGuardrailEvent'), logAttachmentPiiFindings: ledger('logAttachmentPiiFindings'), logAttachmentScanIncomplete: ledger('logAttachmentScanIncomplete') };
        },
        dlpRunner: () => ({
            getConversationTokenMap: (/** @type {unknown} */ id) => {
                record('getConversationTokenMap', id);
                if (env.tokenMapThrows) throw new Error('map unreadable');
                return 'tokenMap' in env ? env.tokenMap : {};
            },
        }),
    };
    const input = {
        messageMetadata: { attachments: [PDF] }, lastMsg: { role: 'user', content: 'Summarise this' }, userId: 'user-1', modelToUse: 'model-x',
        persistedByLive, dlpShield: SHIELD, conversation: { id: 'conv-1' }, onEvent, agent: AGENT, agentId: 'agent-1',
        config: { providerType: 'anthropic', providerName: 'Claude' }, _assistantTokenisationInfo: undefined,
        ...(c.input || {}),
    };
    /** @type {Record<string, unknown>} */
    let outcome;
    try {
        const returned = await processTurnAttachments(/** @type {any} */ (input), /** @type {any} */ (deps));
        outcome = { returned: brief(returned), sameRecord: returned !== undefined && returned === input._assistantTokenisationInfo };
    } catch (err) {
        const e = /** @type {any} */ (err);
        outcome = { threw: e instanceof Error ? { message: e.message, ...(e.code ? { code: e.code } : {}), sameError: e === env.throws } : { value: brief(e) } };
    }
    // The ledger writes are not awaited: let their rejections settle before the next scenario.
    await new Promise((resolve) => setImmediate(resolve));
    return { ...outcome, calls };
}

test('processTurnAttachments: outcome, chat events and collaborator calls per scenario match the golden file', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const name of Object.keys(CASES)) actual[name] = await runCase(name);
    const text = `${JSON.stringify(actual, null, 1)}\n`;
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, text);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const name of Object.keys(CASES)) {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(actual[name])), golden[name], `scenario ${name}`);
    }
    assert.deepStrictEqual(Object.keys(golden), Object.keys(CASES));
});
