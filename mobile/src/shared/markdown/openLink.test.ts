/**
 * What a tap on a link in an answer does. The "doesn't open on the phone"
 * notice is for an app page the phone cannot show; a link that is no usable
 * address anywhere (`www.acme.nl` without a scheme, `docs/setup`) stays a
 * silent no-op, because sending the person to a computer would not help.
 */

import * as WebBrowser from 'expo-web-browser';

import { translateWebLink } from '@/features/notifications/model/route';

import { openLink, type LinkOpeners } from './openLink';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
jest.mock('@/core/api/server', () => ({ getServerUrl: () => 'https://ai.acme.example' }));

function openers(): LinkOpeners & { [K in 'push' | 'anchor' | 'unavailable']: jest.Mock } {
    return { push: jest.fn(), anchor: jest.fn(), unavailable: jest.fn(), translate: translateWebLink };
}

beforeEach(() => jest.clearAllMocks());

describe('openLink', () => {
    it('says so for an app page neither the phone nor its browser can show', async () => {
        const o = openers();
        await openLink('/app/billing', o);
        await openLink('https://ai.acme.example/app/settings/learning', o);
        expect(o.unavailable).toHaveBeenCalledTimes(2);
        expect(o.push).not.toHaveBeenCalled();
        expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    });

    it('does nothing, and says nothing, for a link that is no address at all', async () => {
        const o = openers();
        for (const href of ['www.acme.nl', 'docs/setup', 'javascript:alert(1)', '']) await openLink(href, o);
        expect(o.unavailable).not.toHaveBeenCalled();
        expect(o.push).not.toHaveBeenCalled();
        expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    });

    it('opens a native screen, a web page and an anchor as before', async () => {
        const o = openers();
        await openLink('/app/cowork/c1', o);
        await openLink('https://example.com/a', o);
        await openLink('#top', o);
        expect(o.push).toHaveBeenCalledWith('/cowork/c1');
        expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://example.com/a', { createTask: false });
        expect(o.anchor).toHaveBeenCalledWith('#top');
        expect(o.unavailable).not.toHaveBeenCalled();
    });
});
