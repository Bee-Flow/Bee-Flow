/**
 * Chat notifications: what they carry, and when they stay quiet.
 *
 * Same stance as the YouTrack egress tests — the thread is populated with
 * something identifying in every field, and the assertion is that none of it
 * reaches the payload for any provider. Google Chat is a third-party
 * destination with its own retention, so it gets the same treatment YouTrack
 * does.
 */

const test = require('node:test');
const assert = require('assert');
const Module = require('module');

let settings = {};
let includeSubject = false;
const posted = [];
let postFails = null;
const audits = [];
const screened = [];
// What issueEgress.screenText answers; a function throws or inspects.
let screenResult = { ok: true, scanned: true, findings: [] };

// The real getConfig JSON-parses the stored text, so the 'true' the route saves
// comes back as true and a saved list as an array. A stub that returned the raw
// string hid a reader that compared against 'true' and could never turn on.
function asStored(v) {
    if (v == null) return null;
    try { return JSON.parse(v); } catch (_) { return v; }
}

const stubConfig = {
    getSecret: async (k) => settings[k] ?? null,
    getConfig: async (k) => asStored(settings[k]),
    setConfig: async () => true,
    setSecret: async () => true,
};
const stubStore = { recordAuditEvent: async (e) => { audits.push(e); return {}; } };
const stubApi = {
    jsonApiRequest: async (url, opts) => {
        if (postFails) throw new Error(postFails);
        posted.push({ url, body: opts.body });
        return {};
    },
};

const origLoad = Module._load;
Module._load = function (request) {
    if (request.endsWith('stores/configStore')) return stubConfig;
    if (request.endsWith('stores/supportStore')) return stubStore;
    if (request.endsWith('integrations/shared/apiClient')) return stubApi;
    if (request.endsWith('support/issueEgress')) {
        return {
            includeSubjectEnabled: async () => includeSubject,
            screenText: async (text, opts) => {
                screened.push({ text, thread: opts?.thread });
                return typeof screenResult === 'function' ? screenResult(text) : screenResult;
            },
        };
    }
    return origLoad.apply(this, arguments);
};
const chat = require('./outboundChatNotifier');
Module._load = origLoad;

const HOT_THREAD = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ticket_ref: 'BF-2451',
    source: 'email',
    priority: 'high',
    subject: 'Invoice for Jan de Vries at Acme Holding is wrong',
    requester_email: 'jan.devries@acme-holding.nl',
    requester_name: 'Jan de Vries',
    requester_org_name: 'Acme Holding',
    requester_ip: '203.0.113.44',
    organization_id: 'org_1',
};

const SECRETS = ['jan.devries@acme-holding.nl', 'Jan de Vries', 'Acme Holding', '203.0.113.44'];

function configure(over = {}) {
    settings = {
        support_chat_webhook_url: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=K&token=T',
        support_chat_enabled: 'true',
        support_chat_provider: 'google_chat',
        support_chat_events: JSON.stringify(['ticket_created', 'customer_message']),
        ...over,
    };
    includeSubject = false;
    posted.length = 0;
    postFails = null;
    audits.length = 0;
    screened.length = 0;
    screenResult = { ok: true, scanned: true, findings: [] };
    chat._lastSent.clear();
}

test('no provider\'s card carries anything that identifies the customer', async () => {
    for (const provider of chat.PROVIDERS) {
        configure({ support_chat_provider: provider });
        const r = await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' });
        assert.strictEqual(r.sent, true, `${provider} should have sent`);

        const body = JSON.stringify(posted[0].body);
        for (const secret of SECRETS) {
            assert.ok(!body.includes(secret), `${provider} leaked ${JSON.stringify(secret)}`);
        }
        assert.ok(body.includes('BF-2451'), `${provider} must carry the reference`);
        assert.ok(body.includes('/app/admin/support/'), `${provider} must carry the staff link`);
    }
});

test('the subject travels only when an admin turned it on', async () => {
    configure();
    await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' });
    assert.ok(!JSON.stringify(posted[0].body).includes('Invoice for'));

    configure();
    includeSubject = true;
    await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' });
    assert.ok(JSON.stringify(posted[0].body).includes('Invoice for'));
});

// BFSF-448: "when the setting is on, the subject is PII-scanned before send".
// The screen is issueEgress.screenText, the one the YouTrack path uses, and it
// gets the thread so the customer's own name and address count as findings.

test('with the setting on, the subject is screened with the thread before it goes', async () => {
    configure();
    includeSubject = true;
    await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' });
    assert.strictEqual(screened.length, 1);
    assert.strictEqual(screened[0].text, HOT_THREAD.subject);
    assert.strictEqual(screened[0].thread, HOT_THREAD);
});

test('a subject the screen flags is left off, and the notification still goes', async () => {
    configure();
    includeSubject = true;
    screenResult = { ok: false, scanned: true, findings: [{ category: 'KnownIdentifier', label: 'customer name', count: 1 }] };

    const r = await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' });
    assert.strictEqual(r.sent, true);
    const body = JSON.stringify(posted[0].body);
    assert.ok(!body.includes('Invoice for'));
    assert.ok(!body.includes('Subject:'));
    assert.ok(body.includes('BF-2451'));

    const withheld = audits.find(a => a.action === 'chat_subject_withheld');
    assert.ok(withheld, 'withholding the subject is on the record');
    assert.deepStrictEqual(withheld.payload.findings, ['KnownIdentifier']);
    assert.ok(!JSON.stringify(withheld).includes('Invoice for'), 'the audit names categories, not the text');
});

test('a subject that could not be screened is left off (fails closed)', async () => {
    configure();
    includeSubject = true;
    screenResult = { ok: true, scanned: false, findings: [] };
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' })).sent, true);
    assert.ok(!JSON.stringify(posted[0].body).includes('Invoice for'));
    assert.strictEqual(audits.find(a => a.action === 'chat_subject_withheld').payload.scanned, false);

    configure();
    includeSubject = true;
    screenResult = () => { throw new Error('guard exploded'); };
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' })).sent, true);
    assert.ok(!JSON.stringify(posted[0].body).includes('Invoice for'));
});

test('with the setting off, nothing is screened because nothing travels', async () => {
    configure();
    await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' });
    assert.strictEqual(screened.length, 0);
});

// ── The opt-in events have senders now; the throttle must not eat them ────

test('an escalation right after a customer reply still reaches the channel', async () => {
    configure({ support_chat_events: JSON.stringify(['customer_message', 'escalation', 'sla_breach']) });
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'customer_message' })).sent, true);
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'escalation' })).sent, true);
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'sla_breach' })).sent, true);
    // Each keeps its own window.
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'escalation' })).reason, 'throttled');
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'customer_message' })).reason, 'throttled');
});

test('arrivals still share one window: a reply right after the ticket is not a second ping', async () => {
    configure();
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' })).sent, true);
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'customer_message' })).reason, 'throttled');
});

test('a ticket from a customer organisation\'s own inbox never reaches the team channel', async () => {
    configure({ support_chat_events: JSON.stringify(chat.EVENTS) });
    const r = await chat.notify({ thread: { ...HOT_THREAD, inbox_id: 'inbox-1' }, event: 'sla_breach' });
    assert.strictEqual(r.sent, false);
    assert.strictEqual(posted.length, 0);
});

test('the opt-in events get their own titles and carry only the detail they were given', async () => {
    for (const [event, title] of [
        ['sla_breach', 'BF-2451 — SLA breached'],
        ['escalation', 'BF-2451 — escalated to engineering'],
        ['issue_resolved', 'BF-2451 — a linked issue was resolved'],
    ]) {
        const card = chat.buildCard({ thread: HOT_THREAD, event, detail: 'Linked issue: BFSF-1' });
        assert.strictEqual(card.title, title);
        assert.ok(card.lines.includes('Linked issue: BFSF-1'));
        for (const secret of SECRETS) assert.ok(!JSON.stringify(card).includes(secret));
    }
});

test('a busy thread is throttled to one message per window', async () => {
    configure();
    const a = await chat.notify({ thread: HOT_THREAD, event: 'customer_message' });
    const b = await chat.notify({ thread: HOT_THREAD, event: 'customer_message' });
    const c = await chat.notify({ thread: HOT_THREAD, event: 'customer_message' });
    assert.strictEqual(a.sent, true);
    assert.strictEqual(b.sent, false);
    assert.strictEqual(b.reason, 'throttled');
    assert.strictEqual(c.sent, false);
    assert.strictEqual(posted.length, 1, 'a ten-message thread must not produce ten pings');

    // A different ticket is unaffected — the throttle is per thread, not global.
    const other = await chat.notify({ thread: { ...HOT_THREAD, id: 'other-id' }, event: 'customer_message' });
    assert.strictEqual(other.sent, true);
});

test('events the admin did not select stay quiet', async () => {
    configure();
    const r = await chat.notify({ thread: HOT_THREAD, event: 'sla_breach' });
    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.reason, 'event not selected');
    assert.strictEqual(posted.length, 0);
});

test('nothing is sent while the channel is off or unconfigured', async () => {
    configure({ support_chat_enabled: 'false' });
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' })).sent, false);

    configure({ support_chat_webhook_url: null });
    assert.strictEqual((await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' })).sent, false);
    assert.strictEqual(posted.length, 0);
});

test('a failed delivery is reported, not swallowed', async () => {
    configure();
    postFails = 'Chat webhook: request timed out after 10000ms';
    const r = await chat.notify({ thread: HOT_THREAD, event: 'ticket_created' });
    assert.strictEqual(r.sent, false);
    assert.match(r.reason, /timed out/);
    // And it must not throw: a chat outage cannot fail a ticket submission.
});

test('the public settings never include the webhook URL', async () => {
    configure();
    const pub = await chat.getPublicSettings();
    assert.strictEqual(pub.configured, true);
    assert.strictEqual(pub.host, 'chat.googleapis.com');
    assert.strictEqual(pub.url, undefined);
    // The URL carries key and token in its query string — it IS the credential.
    assert.ok(!JSON.stringify(pub).includes('token=T'));
    assert.ok(!JSON.stringify(pub).includes('key=K'));
});

test('the switch and the event choice read back as the route saved them', async () => {
    configure({ support_chat_events: JSON.stringify(['sla_breach']) });
    const s = await chat.getSettings();
    assert.strictEqual(s.enabled, true);
    assert.deepStrictEqual(s.events, ['sla_breach']);

    // Every event unticked is a choice, not a corrupted setting.
    configure({ support_chat_events: JSON.stringify([]) });
    assert.deepStrictEqual((await chat.getSettings()).events, []);
});

test('a corrupted events setting falls back to the defaults rather than silence', async () => {
    configure({ support_chat_events: 'not json{' });
    const s = await chat.getSettings();
    assert.deepStrictEqual(s.events, chat.DEFAULT_EVENTS);
});
