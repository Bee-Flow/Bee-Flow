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
