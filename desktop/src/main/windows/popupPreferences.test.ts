import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withoutBridge } from './popupPreferences.ts';

describe('withoutBridge', () => {
    const window = {
        preload: '/opt/app/dist/preload/index.js',
        additionalArguments: ['--beeflow-version=1.2.3'],
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: true,
    };

    it('gives a popup no preload', () => {
        const popup = withoutBridge(window);
        assert.equal('preload' in popup, false);
        assert.equal('additionalArguments' in popup, false);
    });

    it('keeps every isolation setting of the window', () => {
        const popup = withoutBridge(window);
        assert.equal(popup.nodeIntegration, false);
        assert.equal(popup.contextIsolation, true);
        assert.equal(popup.sandbox, true);
        assert.equal(popup.webviewTag, false);
        assert.equal(popup.webSecurity, true);
        assert.equal(popup.allowRunningInsecureContent, false);
    });

    it('does not change the window it was given', () => {
        withoutBridge(window);
        assert.equal(window.preload, '/opt/app/dist/preload/index.js');
    });
});
