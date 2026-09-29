import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    classifyNavigation,
    classifyWindowOpen,
    isPackagedShellUrl,
    isServerUrl,
    permissionDecision,
    senderTrust,
    type PolicyContext,
} from './policy.ts';

const context: PolicyContext = {
    serverUrl: 'https://bee.example.com',
    nextcloudOrigins: ['https://cloud.example.com'],
};

const unconfigured: PolicyContext = { serverUrl: '' };

describe('classifyNavigation', () => {
    it('lets the server navigate itself', () => {
        assert.equal(classifyNavigation('https://bee.example.com/app/chat', context), 'allow');
        assert.equal(classifyNavigation('https://bee.example.com/auth/login?x=1', context), 'allow');
    });

    it('sends a link to somewhere else to the system browser', () => {
        assert.equal(classifyNavigation('https://news.example.com/article', context), 'external');
        assert.equal(classifyNavigation('http://blog.example.org', context), 'external');
    });

    it('hands mail and phone links to the OS', () => {
        assert.equal(classifyNavigation('mailto:support@beeflow.nl', context), 'external');
        assert.equal(classifyNavigation('tel:+31201234567', context), 'external');
    });

    it('blocks the schemes that only ever come from an attack', () => {
        for (const url of [
            'javascript:alert(document.cookie)',
            'data:text/html,<script>fetch("https://evil.example")</script>',
            'vbscript:msgbox(1)',
            'blob:https://bee.example.com/2c4f',
            'about:blank',
        ]) {
            assert.equal(classifyNavigation(url, context), 'block', url);
        }
    });

    it('blocks file:// unless it is a page this app shipped', () => {
        assert.equal(classifyNavigation('file:///etc/shadow', context), 'block');
        assert.equal(classifyNavigation('file:///home/tom/.ssh/id_ed25519', context), 'block');
        assert.equal(classifyNavigation('file:///opt/Bee%20Flow/resources/app.asar/dist/ui/shell/settings.html', context), 'allow');
    });

    it('does not let a traversal dress itself up as a shell page', () => {
        assert.equal(
            classifyNavigation('file:///opt/app/dist/ui/shell/../../../../../../etc/passwd', context),
            'block',
        );
        assert.equal(
            classifyNavigation('file:///opt/app/dist/ui/shell/%2e%2e%2f%2e%2e%2fetc/passwd', context),
            'block',
        );
    });

    it('allows the identity providers a sign-in redirects through', () => {
        assert.equal(classifyNavigation('https://accounts.google.com/o/oauth2/v2/auth?x=1', context, 'redirect'), 'allow');
        assert.equal(classifyNavigation('https://login.microsoftonline.com/common/oauth2/authorize', context, 'redirect'), 'allow');
        assert.equal(classifyNavigation('https://cloud.example.com/index.php/login/flow', context, 'redirect'), 'allow', "the user's own Nextcloud");
    });

    it('sends a page that navigates to an identity provider itself to the browser', () => {
        // A link in a chat to github.com is a link, not a sign-in. Allowing it
        // top-level would put GitHub — and wherever GitHub's OAuth redirects
        // on to — in the workspace window.
        assert.equal(classifyNavigation('https://github.com/login/oauth/authorize?client_id=x', context), 'external');
        assert.equal(classifyNavigation('https://accounts.google.com/o/oauth2/v2/auth?x=1', context), 'external');
    });

    it('lets a sign-in in progress do what sign-in pages do', () => {
        const signingIn = { url: 'https://login.microsoftonline.com/common/oauth2/authorize?x=1', signingIn: true };
        // The provider's own password POST and its next steps.
        assert.equal(classifyNavigation('https://login.microsoftonline.com/common/login', context, 'navigate', signingIn), 'allow');
        assert.equal(classifyNavigation('https://github.com/session', context, 'navigate', { url: 'https://github.com/login', signingIn: true }), 'allow');
        assert.equal(classifyNavigation('https://cloud.example.com/login', context, 'navigate', { url: 'https://cloud.example.com/login', signingIn: true }), 'allow');
        // A company's own federated login, reached by redirect, and its form.
        assert.equal(classifyNavigation('https://adfs.corp.example/adfs/ls/', context, 'redirect', signingIn), 'allow');
        assert.equal(classifyNavigation('https://adfs.corp.example/adfs/ls/?submit=1', context, 'navigate', { url: 'https://adfs.corp.example/adfs/ls/', signingIn: true }), 'allow');
    });

    it('keeps a link on a sign-in page a link', () => {
        const signingIn = { url: 'https://accounts.google.com/signin', signingIn: true };
        assert.equal(classifyNavigation('https://policies.example.org/privacy', context, 'navigate', signingIn), 'external');
        assert.equal(classifyNavigation('http://accounts.google.com/x', context, 'redirect', signingIn), 'external', 'never plain http');
    });

    it('does not treat the workspace as mid-sign-in', () => {
        // The same form POST from the workspace itself is a link to a provider.
        assert.equal(classifyNavigation('https://login.microsoftonline.com/common/login', context, 'navigate', { url: 'https://bee.example.com/app', signingIn: false }), 'external');
    });

    it('does not fall for a look-alike identity provider host', () => {
        for (const url of [
            'https://accounts.google.com.evil.example/o/oauth2',
            'https://evil.example/accounts.google.com',
            'http://accounts.google.com/o/oauth2',
        ]) {
            assert.equal(classifyNavigation(url, context, 'redirect'), 'external', url);
        }
    });

    it("keeps the server's single sign-on origin in the window, and nothing more", () => {
        const withApi: PolicyContext = { ...context, apiOrigin: 'https://api.bee.example.com' };
        assert.equal(classifyNavigation('https://api.bee.example.com/auth/login/google', withApi), 'allow');
        assert.equal(classifyWindowOpen('https://api.bee.example.com/auth/login/google?popup=1', withApi), 'popup');
        // Navigable is all it is: it is not the server for anything that grants.
        assert.equal(isServerUrl('https://api.bee.example.com/', withApi), false);
        assert.equal(permissionDecision('media', 'https://api.bee.example.com/', withApi), false);
        assert.equal(classifyNavigation('https://api.bee.example.com.evil.example/', withApi), 'external');
    });

    it('treats its own deep-link scheme as something to route, not navigate', () => {
        assert.equal(classifyNavigation('beeflow://chat/123', context), 'block');
    });

    it('blocks everything remote before a server is configured', () => {
        assert.equal(classifyNavigation('https://bee.example.com', unconfigured), 'external');
        assert.equal(classifyNavigation('https://anything.example', unconfigured), 'external');
    });

    it('blocks garbage', () => {
        for (const url of ['', '   ', 'not a url', '//bee.example.com']) {
            assert.equal(classifyNavigation(url, context), 'block', JSON.stringify(url));
        }
    });
});

describe('classifyWindowOpen', () => {
    it('keeps the sign-in popup inside the app', () => {
        assert.equal(classifyWindowOpen('https://bee.example.com/auth/google?popup=1', context), 'popup');
        assert.equal(classifyWindowOpen('https://accounts.google.com/o/oauth2/v2/auth', context), 'popup');
        assert.equal(classifyWindowOpen('https://cloud.example.com/index.php/login/v2/flow', context), 'popup');
    });

    it('sends anything else to the system browser', () => {
        assert.equal(classifyWindowOpen('https://news.example.com', context), 'external');
    });

    it('never opens a local file in a new window', () => {
        assert.equal(classifyWindowOpen('file:///opt/app/dist/ui/shell/settings.html', context), 'block');
    });

    it('blocks the dangerous schemes here too', () => {
        assert.equal(classifyWindowOpen('javascript:alert(1)', context), 'block');
        assert.equal(classifyWindowOpen('data:text/html,<h1>x', context), 'block');
    });
});

describe('permissionDecision', () => {
    it('grants the server what the product actually uses', () => {
        for (const permission of ['media', 'audioCapture', 'videoCapture', 'notifications', 'display-capture', 'fullscreen']) {
            assert.equal(permissionDecision(permission, 'https://bee.example.com/app', context), true, permission);
        }
        // Screenshot paste on Wayland reads the clipboard itself.
        assert.equal(permissionDecision('clipboard-read', 'https://bee.example.com/app', context), true);
        for (const permission of ['clipboard-read']) {
            assert.equal(permissionDecision(permission, 'https://evil.example/', context), false, permission);
        }
    });

    it('refuses the hardware Chromium can ask for and this app has no use for', () => {
        for (const permission of ['geolocation', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'bluetooth', 'idle-detection', 'openExternal', 'pointerLock']) {
            assert.equal(permissionDecision(permission, 'https://bee.example.com/app', context), false, permission);
        }
    });

    it('refuses everything from any other origin, including the microphone', () => {
        assert.equal(permissionDecision('media', 'https://evil.example', context), false);
        assert.equal(permissionDecision('notifications', 'https://accounts.google.com', context), false);
    });
});

describe('isServerUrl / isPackagedShellUrl', () => {
    it('compares origins, not string prefixes', () => {
        assert.equal(isServerUrl('https://bee.example.com/anything', context), true);
        assert.equal(isServerUrl('https://bee.example.com.evil.example/', context), false);
        assert.equal(isServerUrl('https://bee.example.com:8443/', context), false, 'a different port is a different origin');
    });

    it('recognises only the shipped pages', () => {
        assert.equal(isPackagedShellUrl('file:///opt/app/dist/ui/shell/index.html'), true);
        assert.equal(isPackagedShellUrl('file:///opt/app/dist/ui/shell/nested/deep.html'), false);
        assert.equal(isPackagedShellUrl('file:///opt/app/dist/ui/shell/index.html.exe'), false);
        assert.equal(isPackagedShellUrl('https://bee.example.com/dist/ui/shell/index.html'), false);
    });
});

describe('isPackagedShellUrl — against the real shell directory', () => {
    const root = '/opt/Bee Flow/resources/app.asar/dist/ui/shell';

    it('accepts a page directly in it, spaces and query string included', () => {
        assert.equal(isPackagedShellUrl('file:///opt/Bee%20Flow/resources/app.asar/dist/ui/shell/welcome.html?change=1', root), true);
    });

    it('refuses the same file name planted anywhere else', () => {
        // The path shape alone would accept these: a synced folder can hold a
        // dist/ui/shell/ of its own.
        assert.equal(isPackagedShellUrl('file:///home/tom/Nextcloud/dist/ui/shell/settings.html', root), false);
        assert.equal(isPackagedShellUrl('file:///tmp/.mount_BeeXYZ/resources/app.asar/dist/ui/shell/settings.html', root), false);
    });

    it('refuses a file URL with a host (a network share)', () => {
        assert.equal(isPackagedShellUrl('file://attacker.example/opt/Bee%20Flow/resources/app.asar/dist/ui/shell/settings.html', root), false);
    });

    it('uses the root for navigation too', () => {
        const context: PolicyContext = { serverUrl: 'https://bee.example.com', shellRoot: root };
        assert.equal(classifyNavigation('file:///opt/Bee%20Flow/resources/app.asar/dist/ui/shell/settings.html', context), 'allow');
        assert.equal(classifyNavigation('file:///home/tom/Nextcloud/dist/ui/shell/settings.html', context), 'block');
    });
});

describe('isPackagedShellUrl — Windows paths', () => {
    it('ignores drive-letter case, as Windows does', () => {
        // Chromium upper-cases the drive letter; Node keeps the case the app
        // was started with. Compared as text, the app stopped trusting its own
        // pages and Connect was dead again.
        const url = 'file:///C:/Users/tom/AppData/Local/Programs/Bee%20Flow/resources/app.asar/dist/ui/shell/welcome.html';
        assert.equal(isPackagedShellUrl(url, 'c:\\Users\\tom\\AppData\\Local\\Programs\\Bee Flow\\resources\\app.asar\\dist\\ui\\shell', 'win32'), true);
        assert.equal(isPackagedShellUrl(url, 'C:\\Users\\tom\\AppData\\Local\\Programs\\Bee Flow\\resources\\app.asar\\dist\\ui\\shell', 'win32'), true);
        assert.equal(isPackagedShellUrl(url, 'D:\\Users\\tom\\AppData\\Local\\Programs\\Bee Flow\\resources\\app.asar\\dist\\ui\\shell', 'win32'), false, 'another drive');
    });

    it('accepts an app run from a network share, on Windows only', () => {
        const url = 'file://fileserver/apps/Bee%20Flow/resources/app.asar/dist/ui/shell/settings.html';
        assert.equal(isPackagedShellUrl(url, '\\\\fileserver\\apps\\Bee Flow\\resources\\app.asar\\dist\\ui\\shell', 'win32'), true);
        assert.equal(isPackagedShellUrl(url, '\\\\otherserver\\apps\\Bee Flow\\resources\\app.asar\\dist\\ui\\shell', 'win32'), false);
        assert.equal(isPackagedShellUrl(url, '/opt/Bee Flow/resources/app.asar/dist/ui/shell', 'linux'), false);
    });
});

describe('senderTrust', () => {
    const context: PolicyContext = {
        serverUrl: 'https://bee.example.com',
        apiOrigin: 'https://api.bee.example.com',
        shellRoot: '/opt/app/dist/ui/shell',
    };

    it('tells our own pages, the workspace and everything else apart', () => {
        assert.equal(senderTrust('file:///opt/app/dist/ui/shell/settings.html', context), 'shell');
        assert.equal(senderTrust('https://bee.example.com/app/chat/1', context), 'server');
        // The sign-on origin is navigable, not trusted.
        assert.equal(senderTrust('https://api.bee.example.com/auth/login/google', context), 'other');
        assert.equal(senderTrust('https://accounts.google.com/o/oauth2', context), 'other');
        assert.equal(senderTrust('https://github.com/x', context), 'other');
        assert.equal(senderTrust('', context), 'other');
    });
});
