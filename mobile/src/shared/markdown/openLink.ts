/**
 * Open a link from an answer.
 *
 * `#fragment` scrolls to a heading in the same answer. App screens are pushed
 * onto the router. A web page opens in a Custom Tab, which keeps the app in
 * the back stack, so returning lands on the same message rather than a cold
 * start; mailto:, tel: and the like go to the system handler. An app page
 * neither this app nor a phone's browser can show (links.ts) calls
 * `unavailable`, so the screen says so rather than letting the tap look
 * broken. A link that is no usable address at all (`docs/setup`, a scheme we
 * do not trust) does nothing: it is just as broken on a computer.
 */

import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';

import { getServerUrl } from '@/core/api/server';

import { isAppLink, linkTarget, type AppLinkTranslator } from './links';

export interface LinkOpeners {
    push: (route: string) => void;
    translate: AppLinkTranslator;
    anchor: (fragment: string) => void;
    /** The link is an app page that opens nowhere on a phone. */
    unavailable?: () => void;
}

export async function openLink(href: string, { push, translate, anchor, unavailable }: LinkOpeners): Promise<void> {
    const raw = href.trim();
    if (raw.startsWith('#')) {
        anchor(raw);
        return;
    }
    const serverUrl = getServerUrl();
    const target = linkTarget(raw, serverUrl, translate);
    if (!target) {
        // Only an app page earns the "open it on a computer" notice.
        if (isAppLink(raw, serverUrl)) unavailable?.();
        return;
    }
    try {
        if (target.kind === 'route') push(target.href);
        else if (target.kind === 'browser') await WebBrowser.openBrowserAsync(target.url, { createTask: false });
        else await Linking.openURL(target.url);
    } catch {
        // A malformed href in a model answer is not worth an error dialog.
    }
}
