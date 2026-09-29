/**
 * `beeflow://` links.
 *
 * The scheme is registered with the OS, which means ANY web page can send this
 * app a link — a Nextcloud notification email, a Talk message, or a page
 * nobody in this company wrote. So a deep link is treated as untrusted input
 * throughout: it can say which screen to show, and it can PROPOSE a change of
 * server or a Nextcloud pairing, but proposing is as far as it goes. Anything
 * that would repoint this client at another server, or start handing
 * credentials somewhere, comes back as an action flagged
 * `needsConfirmation`, and the window asks.
 *
 * The alternative — honouring `beeflow://server/set?url=…` directly — is a
 * one-click account takeover dressed as a convenience feature.
 */

export type DeepLinkAction =
    /** Show a path inside the SPA, e.g. /app/chat/123. */
    | { kind: 'navigate'; path: string; needsConfirmation: false }
    /** Open the quick-ask window with text already in it. */
    | { kind: 'quick-ask'; text: string; needsConfirmation: false }
    /** Point this client at a different Bee Flow server. Always asks first. */
    | { kind: 'set-server'; url: string; needsConfirmation: true }
    /** Start a Nextcloud Login Flow against this server. Always asks first. */
    | { kind: 'pair-nextcloud'; server: string; needsConfirmation: true }
    /** Reveal a local file in its folder — sync folders and Downloads only. Always asks first. */
    | { kind: 'open-path'; path: string; needsConfirmation: true }
    | { kind: 'unknown'; reason: string; needsConfirmation: false };

export const DEEP_LINK_SCHEME = 'beeflow';

/**
 * Pull the deep link out of a process argv.
 *
 * On Windows and Linux a second launch delivers the URL as a command-line
 * argument; macOS uses the `open-url` event instead. Both paths end up here so
 * the parsing has one home. Only the LAST matching argument is taken — argv can
 * carry Chromium's own switches, and a URL somewhere in the middle is more
 * likely to be a file than an intent.
 */
export function extractDeepLink(argv: readonly string[]): string | null {
    for (let i = argv.length - 1; i >= 0; i -= 1) {
        const candidate = argv[i];
        if (typeof candidate === 'string' && candidate.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) {
            return candidate;
        }
    }
    return null;
}

export function parseDeepLink(raw: string): DeepLinkAction {
    let url: URL;
    try {
        url = new URL(String(raw ?? '').trim());
    } catch {
        return { kind: 'unknown', reason: 'That is not a link this app understands.', needsConfirmation: false };
    }

    if (url.protocol !== `${DEEP_LINK_SCHEME}:`) {
        return { kind: 'unknown', reason: `Not a ${DEEP_LINK_SCHEME}:// link.`, needsConfirmation: false };
    }

    // beeflow://host/path — the host is the verb. URL lowercases it for us.
    const verb = url.hostname;
    const rest = decodeSafely(url.pathname).replace(/^\/+/, '');
    const params = url.searchParams;

    switch (verb) {
        case 'chat':
        case 'chats':
            return navigateTo(rest ? `/app/chat/${rest}` : '/app/chat');
        case 'automation':
        case 'automations':
            return navigateTo(rest ? `/app/automations/${rest}` : '/app/automations');
        case 'knowledge':
            return navigateTo(rest ? `/app/knowledge/${rest}` : '/app/knowledge');
        case 'document':
        case 'documents':
            return navigateTo(rest ? `/app/documents/${rest}` : '/app/documents');
        case 'task':
        case 'tasks':
            return navigateTo(rest ? `/app/tasks/${rest}` : '/app/tasks');
        case 'go': {
            // The general escape hatch: beeflow://go/app/whatever
            return navigateTo(`/${rest}`);
        }
        case 'ask': {
            const text = params.get('text') ?? decodeSafely(rest);
            if (!text.trim()) return { kind: 'unknown', reason: 'That link asked nothing.', needsConfirmation: false };
            return { kind: 'quick-ask', text: text.slice(0, 4000), needsConfirmation: false };
        }
        case 'server': {
            const target = params.get('url') ?? rest;
            if (!target) return { kind: 'unknown', reason: 'That link named no server.', needsConfirmation: false };
            return { kind: 'set-server', url: target, needsConfirmation: true };
        }
        case 'nextcloud': {
            const server = params.get('server') ?? rest;
            if (!server) return { kind: 'unknown', reason: 'That link named no Nextcloud.', needsConfirmation: false };
            return { kind: 'pair-nextcloud', server, needsConfirmation: true };
        }
        case 'open': {
            const target = params.get('path') ?? decodeSafely(rest);
            if (!target) return { kind: 'unknown', reason: 'That link named no file.', needsConfirmation: false };
            return { kind: 'open-path', path: target, needsConfirmation: true };
        }
        default:
            return { kind: 'unknown', reason: `Nothing in Bee Flow answers to "${verb}".`, needsConfirmation: false };
    }
}

/**
 * Turn a fragment of a deep link into an in-app path, or refuse.
 *
 * The refusals matter more than the acceptances. `//evil.example/x` is a
 * protocol-relative URL that a naive `serverUrl + path` join turns into a
 * different origin; `\\evil.example\x` is the same trick with the separator
 * Windows also accepts; a path with `..` in it walks back out of the SPA.
 */
function navigateTo(path: string): DeepLinkAction {
    const cleaned = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (!cleaned.startsWith('/')) {
        return { kind: 'unknown', reason: 'That link points outside the app.', needsConfirmation: false };
    }
    if (cleaned.includes('..') || /^\/+(https?:)?\/\//i.test(path)) {
        return { kind: 'unknown', reason: 'That link points outside the app.', needsConfirmation: false };
    }
    // A deep link arrives from outside the app, and a NUL or an escape in a
    // path is never an accident.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(cleaned)) {
        return { kind: 'unknown', reason: 'That link contains characters a path cannot have.', needsConfirmation: false };
    }
    return { kind: 'navigate', path: cleaned, needsConfirmation: false };
}

function decodeSafely(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * The sentence shown on the confirmation dialog.
 *
 * Written here rather than in the window code so the wording is covered by the
 * same tests as the parsing: a confirmation that does not say what is about to
 * happen is a confirmation in name only.
 */
export function confirmationPrompt(action: DeepLinkAction): { title: string; detail: string } | null {
    switch (action.kind) {
        case 'set-server':
            return {
                title: 'Connect to a different Bee Flow server?',
                detail:
                    `A link is asking this app to connect to ${action.url}.\n\n` +
                    'Only continue if you recognise that address. Connecting sends your sign-in to it.',
            };
        case 'pair-nextcloud':
            return {
                title: 'Link a Nextcloud account?',
                detail:
                    `A link is asking to sign in to ${action.server} and store an app password for it.\n\n` +
                    'Only continue if this is your own Nextcloud.',
            };
        case 'open-path':
            return {
                title: 'Show this file?',
                detail: `A link is asking to show ${action.path} in its folder. Bee Flow only does that for files in your Nextcloud folders or Downloads, and never opens or runs them.`,
            };
        default:
            return null;
    }
}
