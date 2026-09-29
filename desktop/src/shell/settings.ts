/**
 * The settings window.
 *
 * Plain DOM, no framework: this page has about thirty controls and a list, and
 * a React build for it would be a second toolchain shipping in the installer
 * to save a hundred lines. Every control writes through
 * `window.beeflow.settings.patch`, which normalises and persists — so there is
 * no local state to keep in step and no Save button to forget to press.
 */

import type { DesktopSettings, NextcloudStatus, WatchedFolder } from '../shared/types.ts';
import type { UpdateState } from '../shared/ipc.ts';
import { bridge, byId, hostOf, setStatus } from './bridge.ts';

const api = bridge();

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = ['general', 'nextcloud', 'updates', 'about'] as const;
type Tab = (typeof TABS)[number];

function showTab(active: Tab): void {
    for (const tab of TABS) {
        byId(`tab-${tab}`).setAttribute('aria-selected', String(tab === active));
        byId(`panel-${tab}`).hidden = tab !== active;
    }
}

for (const tab of TABS) {
    byId(`tab-${tab}`).addEventListener('click', () => showTab(tab));
}

// ── Binding helpers ──────────────────────────────────────────────────────────

/** A checkbox that writes one boolean through to settings on change. */
function bindCheckbox(id: string, read: (settings: DesktopSettings) => boolean, write: (value: boolean) => unknown): void {
    const element = byId<HTMLInputElement>(id);
    element.addEventListener('change', () => void write(element.checked));
    readers.push((settings) => {
        element.checked = read(settings);
    });
}

function bindSelect(id: string, read: (settings: DesktopSettings) => string, write: (value: string) => unknown): void {
    const element = byId<HTMLSelectElement>(id);
    element.addEventListener('change', () => void write(element.value));
    readers.push((settings) => {
        element.value = read(settings);
    });
}

/**
 * A text field that writes on blur rather than on every keystroke.
 *
 * Writing per keystroke would persist "https://bee.exam" on the way to
 * "https://bee.example.com" and, for the Nextcloud paths, would set off a
 * re-scan for every character typed.
 */
function bindText(id: string, read: (settings: DesktopSettings) => string, write: (value: string) => unknown): void {
    const element = byId<HTMLInputElement>(id);
    const commit = () => void write(element.value.trim());
    element.addEventListener('blur', commit);
    element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit();
    });
    readers.push((settings) => {
        if (document.activeElement !== element) element.value = read(settings);
    });
}

const readers: Array<(settings: DesktopSettings) => void> = [];

// ── General ──────────────────────────────────────────────────────────────────

bindCheckbox('open-at-login', (s) => s.launch.openAtLogin, (v) => api.settings.patch({ launch: { openAtLogin: v } }));
bindCheckbox('start-minimised', (s) => s.launch.startMinimised, (v) => api.settings.patch({ launch: { startMinimised: v } }));
bindCheckbox('close-to-tray', (s) => s.launch.closeToTray, (v) => api.settings.patch({ launch: { closeToTray: v } }));
bindText('quick-ask', (s) => s.shortcuts.quickAsk, (v) => api.settings.patch({ shortcuts: { quickAsk: v } }));
bindCheckbox('notifications-enabled', (s) => s.notifications.enabled, (v) => api.settings.patch({ notifications: { enabled: v } }));
bindCheckbox('notifications-unfocused', (s) => s.notifications.onlyWhenUnfocused, (v) => api.settings.patch({ notifications: { onlyWhenUnfocused: v } }));
bindSelect('theme', (s) => s.appearance.theme, (v) => api.settings.patch({ appearance: { theme: v as DesktopSettings['appearance']['theme'] } }));
bindCheckbox('auto-hide-menu', (s) => s.appearance.autoHideMenuBar, (v) => api.settings.patch({ appearance: { autoHideMenuBar: v } }));

byId('change-server').addEventListener('click', async () => {
    // The picker replaces the workspace window's contents, because that is the
    // window the new server has to load into. This window has nothing left to
    // show once it has handed over.
    await api.server.choose();
    window.close();
});

// ── Nextcloud ────────────────────────────────────────────────────────────────

bindCheckbox('nc-enabled', (s) => s.nextcloud.enabled, async (value) => {
    await api.settings.patch({ nextcloud: { enabled: value } });
    renderNextcloud(await api.nextcloud.refresh());
});
bindText('nc-config', (s) => s.nextcloud.configPath, async (value) => {
    await api.settings.patch({ nextcloud: { configPath: value } });
    renderNextcloud(await api.nextcloud.refresh());
});
bindText('nc-socket', (s) => s.nextcloud.socketPath, async (value) => {
    await api.settings.patch({ nextcloud: { socketPath: value } });
    renderNextcloud(await api.nextcloud.refresh());
});
// No refresh: this one changes where files are written, not where Nextcloud is.
bindText('nc-save-folder', (s) => s.nextcloud.saveFolder, (value) => api.settings.patch({ nextcloud: { saveFolder: value } }));

const ncStatusLine = byId<HTMLElement>('nc-status');

byId('nc-refresh').addEventListener('click', async () => {
    setStatus(ncStatusLine, 'Looking for the Nextcloud desktop client…');
    const status = await api.nextcloud.refresh();
    renderNextcloud(status);
    setStatus(ncStatusLine, status.installed ? 'Found it.' : 'Still nothing.', status.installed ? 'ok' : 'warn');
});

byId('nc-pair').addEventListener('click', async () => {
    setStatus(ncStatusLine, 'Your browser will open for the Nextcloud sign-in. Approve it there, then come back.');
    const result = await api.nextcloud.login();
    if (!result.ok) {
        setStatus(ncStatusLine, result.error, 'error');
        return;
    }
    setStatus(
        ncStatusLine,
        result.storedOnServer
            ? `Linked ${result.loginName} at ${hostOf(result.server)}. Your Bee Flow server can now read those files.`
            : `Linked ${result.loginName} at ${hostOf(result.server)}, but the app password could not be stored on your Bee Flow server — sign in there and try again.`,
        result.storedOnServer ? 'ok' : 'warn',
    );
});

function renderNextcloud(status: NextcloudStatus): void {
    const pill = byId('nc-pill');
    pill.textContent = status.running ? 'connected' : status.installed ? 'client not running' : 'not found';
    pill.className = `pill ${status.running ? 'ok' : status.installed ? 'warn' : 'off'}`;

    byId('nc-summary').textContent =
        status.error ??
        (status.configPath ? `Configuration read from ${status.configPath}` : 'No Nextcloud desktop client found on this computer.');

    const folders = byId('nc-folders');
    const rows = status.accounts.flatMap((account) =>
        account.folders.map((folder) => {
            const row = document.createElement('div');
            row.className = 'row';

            const text = document.createElement('div');
            text.className = 'row-text';
            const title = document.createElement('div');
            title.className = 'row-title';
            title.textContent = folder.localPath;
            const hint = document.createElement('div');
            hint.className = 'row-hint';
            hint.textContent = `${hostOf(account.url)} · ${folder.targetPath}${folder.virtualFiles ? ' · online-only files' : ''}`;
            text.append(title, hint);

            const open = document.createElement('button');
            open.textContent = 'Open';
            open.addEventListener('click', () => void api.showItemInFolder(folder.localPath));

            row.append(text, open);
            return row;
        }),
    );

    if (rows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = status.installed
            ? 'The Nextcloud client is installed but not syncing any folders yet.'
            : 'Install the Nextcloud desktop app and sign in, and its folders will appear here.';
        folders.replaceChildren(empty);
    } else {
        folders.replaceChildren(...rows);
    }
}

// ── Watched folders ──────────────────────────────────────────────────────────

const watchStatus = byId<HTMLElement>('watch-status');

function renderWatched(folders: readonly WatchedFolder[]): void {
    const list = byId('watched-list');
    if (folders.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'No folders are being watched.';
        list.replaceChildren(empty);
        return;
    }

    list.replaceChildren(
        ...folders.map((folder) => {
            const row = document.createElement('div');
            row.className = 'row';

            const text = document.createElement('div');
            text.className = 'row-text';
            const title = document.createElement('div');
            title.className = 'row-title';
            title.textContent = folder.label;
            const hint = document.createElement('div');
            hint.className = 'row-hint';
            hint.textContent = `${folder.path} → knowledge base ${folder.knowledgeBaseId}${folder.recursive ? '' : ' (this folder only)'}`;
            text.append(title, hint);

            const enabled = document.createElement('input');
            enabled.type = 'checkbox';
            enabled.checked = folder.enabled;
            enabled.title = 'Watch this folder';
            enabled.addEventListener('change', async () => {
                await api.nextcloud.watched.update(folder.id, { enabled: enabled.checked });
                renderWatched(await api.nextcloud.watched.list());
            });

            const remove = document.createElement('button');
            remove.className = 'link';
            remove.textContent = 'Remove';
            remove.addEventListener('click', async () => {
                await api.nextcloud.watched.remove(folder.id);
                renderWatched(await api.nextcloud.watched.list());
            });

            const controls = document.createElement('div');
            controls.className = 'controls';
            controls.append(enabled, remove);

            row.append(text, controls);
            return row;
        }),
    );
}

byId('watch-add').addEventListener('click', async () => {
    const knowledgeBaseId = byId<HTMLInputElement>('watch-kb').value.trim();
    if (!knowledgeBaseId) {
        setStatus(watchStatus, 'Give the knowledge base these documents should go into first.', 'error');
        return;
    }
    try {
        const added = await api.nextcloud.watched.add({ knowledgeBaseId });
        if (!added) {
            setStatus(watchStatus, '');
            return;
        }
        byId<HTMLInputElement>('watch-kb').value = '';
        renderWatched(await api.nextcloud.watched.list());
        setStatus(watchStatus, `Watching ${added.path}.`, 'ok');
    } catch (error) {
        setStatus(watchStatus, error instanceof Error ? error.message : String(error), 'error');
    }
});

// ── Updates ──────────────────────────────────────────────────────────────────

bindCheckbox('updates-enabled', (s) => s.updates.enabled, (v) => api.settings.patch({ updates: { enabled: v } }));
bindCheckbox('updates-automatic', (s) => s.updates.automatic, (v) => api.settings.patch({ updates: { automatic: v } }));
bindSelect('updates-channel', (s) => s.updates.channel, (v) => api.settings.patch({ updates: { channel: v as 'stable' | 'beta' } }));

function renderUpdate(state: UpdateState): void {
    const line = byId('update-state');
    const install = byId<HTMLButtonElement>('update-install');
    install.hidden = state.status !== 'ready';

    switch (state.status) {
        case 'idle':
            line.textContent = 'Up to date.';
            break;
        case 'checking':
            line.textContent = 'Checking…';
            break;
        case 'available':
            line.textContent = `Version ${state.version} is available.`;
            break;
        case 'downloading':
            line.textContent = `Downloading… ${state.percent}%`;
            break;
        case 'ready':
            line.textContent = `Version ${state.version} is ready to install.`;
            break;
        case 'unsupported':
            line.textContent = state.reason;
            break;
        case 'error':
            line.textContent = `The update check failed: ${state.message}`;
            break;
        default:
            line.textContent = '';
    }
}

byId('update-check').addEventListener('click', async () => renderUpdate(await api.updates.check()));
byId('update-install').addEventListener('click', () => void api.updates.install());
api.updates.onState(renderUpdate);

// ── About ────────────────────────────────────────────────────────────────────

async function renderAbout(): Promise<void> {
    const diagnostics = await api.diagnostics();
    const rows: Array<[string, string]> = [
        ['Bee Flow', diagnostics.appVersion],
        ['Installed as', diagnostics.packaging],
        ['Electron', diagnostics.electronVersion],
        ['Chromium', diagnostics.chromeVersion],
        ['Node', diagnostics.nodeVersion],
        ['Platform', `${diagnostics.platform} ${diagnostics.arch}`],
        ['Settings file', diagnostics.settingsPath],
        ['Log file', diagnostics.logPath],
    ];

    byId('about').replaceChildren(
        ...rows.map(([label, value]) => {
            const row = document.createElement('div');
            row.className = 'row';
            const title = document.createElement('div');
            title.className = 'row-title';
            title.textContent = label;
            const hint = document.createElement('div');
            hint.className = 'row-hint';
            hint.textContent = value;
            row.append(title, hint);
            return row;
        }),
    );

    const pill = byId('secrets-pill');
    pill.textContent = diagnostics.secretsAvailable ? 'sealed by the OS' : 'unavailable';
    pill.className = `pill ${diagnostics.secretsAvailable ? 'ok' : 'warn'}`;
    // Interface text about the keyring, not a secret.
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
    byId('secrets-state').textContent = diagnostics.secretsAvailable
        ? 'Credentials are encrypted with your operating system keyring.'
        : 'No keyring is available. Bee Flow keeps its own credentials in memory only and will ask again next time, and the sign-in cookie for your server is stored without keyring protection. On Linux, run gnome-keyring or KWallet.';

    const sandboxPill = byId('sandbox-pill');
    sandboxPill.textContent = diagnostics.sandboxed ? 'on' : 'off';
    sandboxPill.className = `pill ${diagnostics.sandboxed ? 'ok' : 'warn'}`;
    byId('sandbox-state').textContent = diagnostics.sandboxed
        ? "Pages run in Chromium's sandbox, so a compromised page cannot reach the rest of this computer."
        : "Chromium's sandbox is off for this run, because this system restricts user namespaces and this copy could not set the sandbox up (an AppImage or the tar.gz). Installing the .deb, .rpm or pacman package turns it on.";

    byId('show-logs').addEventListener('click', () => void api.showItemInFolder(diagnostics.logPath));
}

// ── Load ─────────────────────────────────────────────────────────────────────

function applySettings(settings: DesktopSettings): void {
    for (const reader of readers) reader(settings);
    byId('server-url').textContent = settings.server.url || 'Not set';
    byId('server-state').textContent = settings.server.url
        ? 'The workspace loads from this server.'
        : 'Bee Flow has nowhere to connect to yet.';
}

async function load(): Promise<void> {
    applySettings(await api.settings.get());
    renderNextcloud(await api.nextcloud.status());
    renderWatched(await api.nextcloud.watched.list());
    renderUpdate(await api.updates.check());
    await renderAbout();
}

api.settings.onChanged(applySettings);
api.nextcloud.onStatusChanged(renderNextcloud);

void load();
