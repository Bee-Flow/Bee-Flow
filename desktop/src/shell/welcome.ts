/**
 * The first-run server picker, and the "change server" screen.
 *
 * This is the only screen in the app that exists before there is a server, so
 * it carries the burden of explaining what kind of product this is: you bring
 * your own server. The probe runs before anything is saved, because the failure
 * modes ("that certificate expired", "nothing is listening on that port",
 * "something answered but it is not Bee Flow") are what people actually need
 * told, and they are far more useful before a commitment than after one.
 */

import { bridge, byId, queryParam, setStatus } from './bridge.ts';

const api = bridge();

const input = byId<HTMLInputElement>('server');
const connect = byId<HTMLButtonElement>('connect');
const cancel = byId<HTMLButtonElement>('cancel');
const status = byId<HTMLElement>('status');
const recentSection = byId<HTMLElement>('recent-section');
const recentList = byId<HTMLUListElement>('recent');

const isChanging = queryParam('change') === '1';

async function render(): Promise<void> {
    const server = await api.server.get();

    if (isChanging) {
        byId('heading').textContent = 'Connect to a different server';
        byId('intro').textContent =
            'Bee Flow will sign out of the current server and connect to the one you enter. Your data stays on the server it is already on.';
        input.value = server.url;
        cancel.hidden = false;
    }

    if (server.recent.length === 0) {
        recentSection.hidden = true;
        return;
    }

    recentSection.hidden = false;
    recentList.replaceChildren(
        ...server.recent.map((url) => {
            const item = document.createElement('li');

            const label = document.createElement('span');
            label.className = 'row-hint';
            label.textContent = url;

            const use = document.createElement('button');
            use.textContent = 'Use';
            use.addEventListener('click', () => void submit(url));

            const forget = document.createElement('button');
            forget.className = 'link';
            forget.textContent = 'Forget';
            forget.addEventListener('click', async () => {
                await api.server.forget(url);
                await render();
            });

            const buttons = document.createElement('span');
            buttons.append(use, forget);
            item.append(label, buttons);
            return item;
        }),
    );
}

let connecting = false;

/** Everything that can start a connect, disabled together while one runs. */
function setBusy(busy: boolean): void {
    connecting = busy;
    connect.disabled = busy;
    input.disabled = busy;
    for (const button of recentList.querySelectorAll('button')) button.disabled = busy;
}

async function submit(value?: string): Promise<void> {
    // Enter, the button and a recent server's "Use" can all fire while a
    // check is running; one connect at a time.
    if (connecting) return;
    const candidate = (value ?? input.value).trim();
    if (!candidate) {
        setStatus(status, 'Enter the address of your Bee Flow server.', 'error');
        input.focus();
        return;
    }

    setBusy(true);
    setStatus(status, `Looking for Bee Flow at ${candidate}…`);

    // One call: the main process probes the address itself before saving it
    // — it does not take a renderer's word that a server was checked — and
    // navigates this window to the workspace when it succeeds.
    try {
        const result = await api.server.set(candidate);
        if (!result.ok) {
            setStatus(status, result.error ?? 'That server could not be reached.', 'error');
            if (result.code === 'redirected' && result.redirectTarget) input.value = result.redirectTarget;
            setBusy(false);
            return;
        }
        // Stays busy: the window is on its way to the workspace.
        setStatus(status, result.insecure ? `Found Bee Flow at ${result.url}. The connection is not encrypted. Connecting…` : `Found Bee Flow at ${result.url}. Connecting…`, 'ok');
    } catch (error) {
        // The page must never be left saying "Looking for…" forever.
        setStatus(status, `Something went wrong while connecting: ${error instanceof Error ? error.message : String(error)}`, 'error');
        setBusy(false);
    }
}

connect.addEventListener('click', () => void submit());
cancel.addEventListener('click', () => window.history.back());
input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
});

void render();
