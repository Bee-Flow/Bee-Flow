'use strict';

/**
 * The welcome email's Learning Center link (BFSF-279 / BFSF-230).
 *
 * The confirmation email promises a Learning Center; its link used to be the
 * app root, which lands a new user on the dashboard. It must point at the
 * in-app Learning Center, in both the text and the HTML part.
 *
 * Static and DB-free: renders the shipped default template, no module mocks.
 *
 * Run: cd server && node --test utils/emailService.test.js
 */

// Keeps configStore (loaded through emailService) from opening its LISTEN socket.
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { welcomeLearnUrl, renderEmailFromTemplate } = require('./emailService');
const { getDefaultEmailTemplate } = require('../i18n/defaults/emailTemplates');

function withClientHost(host, fn) {
    const saved = { protocol: process.env.CLIENT_PROTOCOL, host: process.env.CLIENT_PUBLIC_HOST };
    process.env.CLIENT_PROTOCOL = 'https';
    process.env.CLIENT_PUBLIC_HOST = host;
    try {
        return fn();
    } finally {
        for (const [key, value] of [['CLIENT_PROTOCOL', saved.protocol], ['CLIENT_PUBLIC_HOST', saved.host]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test('the Learning Center link is the in-app Learning Center, not the app root', () => {
    withClientHost('workspace.example.test', () => {
        assert.equal(welcomeLearnUrl(), 'https://workspace.example.test/app/settings/learning');
    });
});

test('the rendered welcome email carries the Learning Center link in text and html', () => {
    withClientHost('workspace.example.test', () => {
        const learnUrl = welcomeLearnUrl();
        const { text, html } = renderEmailFromTemplate(getDefaultEmailTemplate('welcome'), {
            name: 'Test User',
            loginUrl: 'https://workspace.example.test/login',
            learnUrl,
            orgName: 'Example Org',
        });
        assert.ok(text.includes('https://workspace.example.test/app/settings/learning'), text);
        assert.ok(html.includes('https://workspace.example.test/app/settings/learning'), 'html part carries the link');
    });
});

// ── sendProjectCollabEmail ──────────────────────────────────────────────
const { sendProjectCollabEmail } = require('./emailService');

function collabDeps(extra = {}) {
    const sentMails = [];
    return {
        sentMails,
        deps: {
            getServiceEmailConfig: async () => ({ configured: true }),
            getUser: async () => ({ id: 'bob', email: 'bob@example.test', preferredLocale: 'nl' }),
            translate: async (_l, key) => (key.endsWith('.event') ? 'Genoemd in een teamchat' : key),
            renderTemplate: async (id, locale, vars) => renderEmailFromTemplate(getDefaultEmailTemplate(id, locale), vars),
            sendServiceEmail: async (m) => { sentMails.push(m); return { success: true }; },
            ...extra,
        },
    };
}

test('the collaboration mail is rendered in the recipient\'s locale and carries the link', async () => {
    const { sentMails, deps } = collabDeps();
    const res = await sendProjectCollabEmail({
        userId: 'bob', locale: 'nl', event: 'chat_mention',
        vars: { project: 'Launch', actor: 'Ann', intro: 'Ann heeft je genoemd in "Launch"', detail: 'Je bent genoemd.' }, ctaUrl: 'https://app.example.test/app/projects/p1',
    }, deps);
    assert.deepEqual(res, { sent: true });
    assert.equal(sentMails[0].to, 'bob@example.test');
    assert.equal(sentMails[0].subject, 'Genoemd in een teamchat · Launch');
    assert.ok(sentMails[0].text.includes('Ann heeft je genoemd in "Launch"'), sentMails[0].text);
    assert.ok(sentMails[0].text.includes('Openen in Bee Flow: https://app.example.test/app/projects/p1'), sentMails[0].text);
    assert.ok(sentMails[0].html.includes('Je krijgt deze e-mail door je meldingsinstellingen'), 'footer in html');
});

test('without a service mailbox, or when the send fails, the collaboration mail is {sent:false} and throws nothing', async () => {
    const a = collabDeps({ getServiceEmailConfig: async () => ({ configured: false }) });
    assert.deepEqual(await sendProjectCollabEmail({ userId: 'bob', event: 'added', vars: {} }, a.deps), { sent: false });
    assert.equal(a.sentMails.length, 0);
    const b = collabDeps({ sendServiceEmail: async () => { throw new Error('boom'); } });
    assert.deepEqual(await sendProjectCollabEmail({ userId: 'bob', event: 'added', vars: {} }, b.deps), { sent: false });
    const c = collabDeps({ sendServiceEmail: async () => ({ success: false, error: 'x' }) });
    assert.deepEqual(await sendProjectCollabEmail({ userId: 'bob', event: 'added', vars: {} }, c.deps), { sent: false });
});
