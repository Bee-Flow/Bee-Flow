/**
 * The preload bridge.
 *
 * This file is the entire surface between the pages this app shows and the
 * process that can touch the machine. It runs with `contextIsolation` on and
 * `sandbox` on, which means it has `ipcRenderer` and essentially nothing else —
 * and that is the point: the object handed to the page is built here, by hand,
 * from a fixed list of channels, so a page can only ask for things this file
 * names.
 *
 * Two consequences worth stating, because they are what make the design work:
 *
 *   1. **The SPA is unchanged in a browser.** `window.beeflow` is simply
 *      absent there, so every call site is `window.beeflow?.…` and the web app
 *      keeps behaving exactly as it does today. Nothing in agent-hub has to
 *      know this client exists.
 *   2. **Nothing dynamic crosses.** No `invoke(channel, …)` passthrough, no
 *      `require`, no path or filesystem helper. A channel that is not below
 *      cannot be reached from a page, whatever the page's origin.
 *
 * Built by scripts/build-preload.mjs, not tsc. Under `sandbox: true` this file
 * may require `electron` and nothing else, so the shared channel list below is
 * bundled in; the build fails if any other require appears.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { EVENT, INVOKE, VERSION_ARGUMENT, type BeeflowBridge, type Unsubscribe } from '../shared/ipc.ts';

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(args[0] as T);
    ipcRenderer.on(channel, wrapped);
    return () => {
        ipcRenderer.removeListener(channel, wrapped);
    };
}

const bridge: BeeflowBridge = {
    client: 'desktop',
    platform: process.platform,
    version: process.argv.find((argument) => argument.startsWith(VERSION_ARGUMENT))?.slice(VERSION_ARGUMENT.length) ?? '',

    diagnostics: () => ipcRenderer.invoke(INVOKE.diagnostics),
    openExternal: (url) => ipcRenderer.invoke(INVOKE.openExternal, url),
    openSettings: () => ipcRenderer.invoke(INVOKE.openSettings),
    showItemInFolder: (filePath) => ipcRenderer.invoke(INVOKE.showItemInFolder, filePath),
    relaunch: () => ipcRenderer.invoke(INVOKE.relaunch),

    settings: {
        get: () => ipcRenderer.invoke(INVOKE.settingsGet),
        patch: (patch) => ipcRenderer.invoke(INVOKE.settingsPatch, patch),
        onChanged: (listener) => subscribe(EVENT.settingsChanged, listener),
    },

    server: {
        get: () => ipcRenderer.invoke(INVOKE.serverGet),
        probe: (url) => ipcRenderer.invoke(INVOKE.serverProbe, url),
        set: (url) => ipcRenderer.invoke(INVOKE.serverSet, url),
        forget: (url) => ipcRenderer.invoke(INVOKE.serverForget, url),
        choose: () => ipcRenderer.invoke(INVOKE.serverChoose),
        onChanged: (listener) => subscribe(EVENT.serverChanged, listener),
    },

    updates: {
        check: () => ipcRenderer.invoke(INVOKE.updateCheck),
        install: () => ipcRenderer.invoke(INVOKE.updateInstall),
        onState: (listener) => subscribe(EVENT.updateState, listener),
    },

    nextcloud: {
        status: () => ipcRenderer.invoke(INVOKE.ncStatus),
        refresh: () => ipcRenderer.invoke(INVOKE.ncRefresh),
        resolve: (paths) => ipcRenderer.invoke(INVOKE.ncResolve, paths),
        pickFiles: (options) => ipcRenderer.invoke(INVOKE.ncPickFiles, options),
        share: (localPath) => ipcRenderer.invoke(INVOKE.ncShare, localPath),
        reveal: (localPath) => ipcRenderer.invoke(INVOKE.ncReveal, localPath),
        openInNextcloud: (localPath) => ipcRenderer.invoke(INVOKE.ncOpenInNextcloud, localPath),
        save: (input) => ipcRenderer.invoke(INVOKE.ncSave, input),
        login: (server) => ipcRenderer.invoke(INVOKE.ncLoginStart, server),
        cancelLogin: () => ipcRenderer.invoke(INVOKE.ncLoginCancel),
        watched: {
            list: () => ipcRenderer.invoke(INVOKE.ncWatchList),
            add: (input) => ipcRenderer.invoke(INVOKE.ncWatchAdd, input),
            update: (id, patch) => ipcRenderer.invoke(INVOKE.ncWatchUpdate, id, patch),
            remove: (id) => ipcRenderer.invoke(INVOKE.ncWatchRemove, id),
            onFile: (listener) => subscribe(EVENT.watchedFile, listener),
        },
        onStatusChanged: (listener) => subscribe(EVENT.ncStatusChanged, listener),
    },

    filePathsOf: (files) => {
        const paths: string[] = [];
        for (let index = 0; index < files.length; index += 1) {
            const file = files[index];
            if (!file) continue;
            // Returns '' for anything that did not come from the filesystem —
            // a blob built in the page, for instance — and those are dropped
            // rather than passed on as an empty path.
            const filePath = webUtils.getPathForFile(file);
            if (filePath) paths.push(filePath);
        }
        return paths;
    },

    notify: (input) => ipcRenderer.invoke(INVOKE.notify, input),
    setBadge: (count) => ipcRenderer.invoke(INVOKE.setBadge, count),

    onCommand: (listener) => subscribe(EVENT.command, listener),
    onDeepLink: (listener) => subscribe(EVENT.deepLink, listener),
};

contextBridge.exposeInMainWorld('beeflow', bridge);

/**
 * The quick-ask window's private channel.
 *
 * Exposed separately, and only used by a page this app ships: the main window
 * has no business submitting on its behalf.
 */
contextBridge.exposeInMainWorld('beeflowQuickAsk', {
    submit: (text: string) => ipcRenderer.send('quick-ask:submit', text),
    onPrefill: (listener: (text: string) => void) => subscribe('quick-ask:prefill', listener),
});
