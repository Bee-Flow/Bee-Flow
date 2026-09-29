/**
 * The page shown when the workspace will not load.
 *
 * Chromium has its own version of this page, and it is useless here: it says
 * ERR_CONNECTION_REFUSED under a picture of a dinosaur, which tells a person
 * running their own server nothing about which of the five plausible causes
 * they have. The main process probes the server before showing this page, so
 * what lands here is a specific reason and — this is the part that makes the
 * page worth having — the specific next step for that reason.
 */

import type { ServerProbeResult } from '../shared/types.ts';
import { bridge, byId, queryParam, setStatus } from './bridge.ts';

const api = bridge();

const server = queryParam('server');
const reason = queryParam('reason');
const code = queryParam('code');

byId('server').textContent = server || 'not set';
byId('reason').textContent = reason || 'The connection failed.';

/** What to try next, per failure. Written as instructions, not diagnoses. */
const ADVICE: Record<string, string[]> = {
    dns: [
        'Check the address for a typo.',
        'If the server is only reachable inside your organisation, connect to the VPN first.',
    ],
    refused: [
        'The address is right but nothing answered on that port — the Bee Flow server may be stopped.',
        'On the server: `docker compose ps` should show the server container up, and `docker compose logs server` will say why if it is not.',
    ],
    timeout: [
        'The server did not answer in time. It may still be starting, or a firewall may be dropping the connection.',
        'Try again in a minute.',
    ],
    tls: [
        'The certificate could not be verified, and Bee Flow will not skip that check.',
        'If you issued the certificate yourself, install your certificate authority on this computer — then this page will go away on its own.',
    ],
    'http-error': ['Something is in front of the server and answered instead of it.'],
    'not-bee-flow': [
        'Something answered at that address, but it was not a Bee Flow server.',
        'If your server lives under a path, include it — for example https://cloud.example.com/beeflow.',
    ],
    offline: ['This computer has no network connection right now.'],
    redirected: [
        'Your server now sends people to a different address, and Bee Flow does not follow that kind of move by itself.',
        'If the new address is your server, use it below. If you did not expect this, check with whoever runs the server first.',
    ],
    'origin-refused': ['On the server, add this address to CLIENT_PUBLIC_HOST (or CORS_ORIGIN) and restart it.'],
    'api-port': ['Use the address you open Bee Flow at in a browser — on a standard install, port 5176.'],
    proxy: ["Check this computer's proxy settings, or ask whoever manages them."],
};

const advice = ADVICE[code] ?? ['Check that the address is right and that the server is running.'];
const list = document.createElement('ul');
list.className = 'muted';
for (const line of advice) {
    const item = document.createElement('li');
    item.textContent = line;
    list.append(item);
}
byId('advice').append(list);

const status = byId<HTMLElement>('status');
const retry = byId<HTMLButtonElement>('retry');
const useTarget = byId<HTMLButtonElement>('use-target');

/**
 * The server answered, now what. Three outcomes:
 *
 * - it is at the saved address: go back to the workspace;
 * - it answered from a new address the probe was willing to follow by itself
 *   (http became https, another port on the same machine): save that address
 *   through the main process, which checks it again, and let it load there;
 * - it sends people somewhere the app will not follow by itself (code
 *   'redirected'): say where, and let the person choose it.
 *
 * Navigating this page to a new origin directly does not work: the navigation
 * policy treats any origin but the saved server's as a link, and used to open
 * a browser tab for it on every retry.
 */
async function answered(probe: ServerProbeResult): Promise<boolean> {
    if (probe.ok && originOf(probe.url) === originOf(server)) {
        stopRetrying();
        setStatus(status, 'The server answered. Loading your workspace…', 'ok');
        window.location.replace(probe.url);
        return true;
    }
    if (probe.ok) {
        stopRetrying();
        setStatus(status, `The server now answers at ${probe.url}. Switching to it…`, 'ok');
        const result = await api.server.set(probe.url);
        if (!result.ok) setStatus(status, result.error ?? 'That address could not be used.', 'error');
        return true;
    }
    if (probe.code === 'redirected' && probe.redirectTarget) {
        stopRetrying();
        offerTarget(probe.redirectTarget);
        setStatus(status, probe.error ?? '', 'error');
        return true;
    }
    return false;
}

function offerTarget(target: string): void {
    useTarget.textContent = `Use ${target}`;
    useTarget.hidden = false;
    useTarget.onclick = async () => {
        useTarget.disabled = true;
        setStatus(status, `Connecting to ${target}…`);
        const result = await api.server.set(target);
        if (!result.ok) {
            useTarget.disabled = false;
            setStatus(status, result.error ?? 'That address could not be used.', 'error');
        }
    };
}

const target = queryParam('target');
if (code === 'redirected' && target) offerTarget(target);

retry.addEventListener('click', async () => {
    retry.disabled = true;
    setStatus(status, 'Trying again…');
    const probe = await api.server.probe(server);
    if (await answered(probe)) return;
    retry.disabled = false;
    setStatus(status, probe.error ?? 'Still no answer.', 'error');
});

byId('change').addEventListener('click', () => {
    window.location.replace('welcome.html?change=1');
});

byId('settings').addEventListener('click', () => {
    // A separate window, opened by the main process — this one is still the
    // workspace window and should stay where the retry button is.
    void api.openSettings();
});

/**
 * Retry by itself, quietly.
 *
 * A server that was restarting comes back within a minute or two, and having
 * the workspace reappear without a click is the difference between "it was
 * briefly down" and "the app broke". The interval is deliberately unhurried:
 * a client hammering a server that is trying to start is not help.
 */
const AUTO_RETRY_MS = 15_000;
const autoRetry = setInterval(async () => {
    if (retry.disabled || !server) return;
    await answered(await api.server.probe(server));
}, AUTO_RETRY_MS);

function stopRetrying(): void {
    clearInterval(autoRetry);
}

function originOf(url: string): string {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}
