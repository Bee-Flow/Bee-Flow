/**
 * The application menu.
 *
 * A desktop app without one is a web page in a frame. The menu is where
 * copy/paste, find, zoom and the window commands live — the things people
 * reach for by muscle memory and are quietly annoyed to find missing — plus the
 * handful of commands that only exist here: the Nextcloud bridge, the server
 * picker, the quick-ask window.
 *
 * On macOS the first submenu must be the app's own; on Windows and Linux there
 * is no such menu and its items belong under File and Help instead. That is the
 * whole reason this file branches on platform.
 */

import { Menu, app, shell, type MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
    newChat: () => void;
    quickAsk: () => void;
    focusSearch: () => void;
    openSettings: () => void;
    chooseServer: () => void;
    reload: () => void;
    checkForUpdates: () => void;
    openNextcloudFolder: () => void;
    pairNextcloud: () => void;
    refreshNextcloud: () => void;
    attachFromNextcloud: () => void;
    showLogs: () => void;
    about: () => void;
}

export function buildMenu(actions: MenuActions): Menu {
    const isMac = process.platform === 'darwin';

    const appMenu: MenuItemConstructorOptions[] = isMac
        ? [
              {
                  label: app.name,
                  submenu: [
                      { label: 'About Bee Flow', click: actions.about },
                      { label: 'Check for Updates…', click: actions.checkForUpdates },
                      { type: 'separator' },
                      { label: 'Settings…', accelerator: 'Command+,', click: actions.openSettings },
                      { label: 'Change Server…', click: actions.chooseServer },
                      { type: 'separator' },
                      { role: 'services' },
                      { type: 'separator' },
                      { role: 'hide' },
                      { role: 'hideOthers' },
                      { role: 'unhide' },
                      { type: 'separator' },
                      { role: 'quit' },
                  ],
              },
          ]
        : [];

    const fileMenu: MenuItemConstructorOptions = {
        label: '&File',
        submenu: [
            { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: actions.newChat },
            { label: 'Quick Ask…', accelerator: 'CmdOrCtrl+Shift+Space', click: actions.quickAsk },
            { type: 'separator' },
            { label: 'Attach from Nextcloud…', click: actions.attachFromNextcloud },
            { type: 'separator' },
            ...(isMac
                ? ([{ role: 'close' }] as MenuItemConstructorOptions[])
                : ([
                      { label: 'Settings…', accelerator: 'Ctrl+,', click: actions.openSettings },
                      { label: 'Change Server…', click: actions.chooseServer },
                      { type: 'separator' },
                      { role: 'quit' },
                  ] as MenuItemConstructorOptions[])),
        ],
    };

    const editMenu: MenuItemConstructorOptions = {
        label: '&Edit',
        submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            ...(isMac ? ([{ role: 'pasteAndMatchStyle' }] as MenuItemConstructorOptions[]) : []),
            { role: 'delete' },
            { role: 'selectAll' },
            { type: 'separator' },
            { label: 'Find in Workspace', accelerator: 'CmdOrCtrl+F', click: actions.focusSearch },
        ],
    };

    const viewMenu: MenuItemConstructorOptions = {
        label: '&View',
        submenu: [
            { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: actions.reload },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            // Ctrl+= is what an unshifted "+" actually sends; without it, zoom
            // in only works from the numpad on most keyboards.
            { role: 'zoomIn', accelerator: 'CmdOrCtrl+=', visible: false },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
            { role: 'toggleDevTools', visible: !app.isPackaged },
        ],
    };

    const nextcloudMenu: MenuItemConstructorOptions = {
        label: '&Nextcloud',
        submenu: [
            { label: 'Open Sync Folder', click: actions.openNextcloudFolder },
            { label: 'Attach Files from Nextcloud…', click: actions.attachFromNextcloud },
            { label: 'Link a Nextcloud Account…', click: actions.pairNextcloud },
            { type: 'separator' },
            { label: 'Look for Nextcloud Again', click: actions.refreshNextcloud },
        ],
    };

    const windowMenu: MenuItemConstructorOptions = {
        label: '&Window',
        submenu: isMac
            ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
            : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    };

    const helpMenu: MenuItemConstructorOptions = {
        role: 'help',
        submenu: [
            { label: 'Documentation', click: () => void shell.openExternal('https://bee-flow.github.io/docs/') },
            { label: 'Report an Issue', click: () => void shell.openExternal('https://github.com/Bee-Flow/Bee-Flow/issues') },
            { type: 'separator' },
            { label: 'Show Logs', click: actions.showLogs },
            ...(isMac
                ? []
                : ([
                      { type: 'separator' },
                      { label: 'Check for Updates…', click: actions.checkForUpdates },
                      { label: 'About Bee Flow', click: actions.about },
                  ] as MenuItemConstructorOptions[])),
        ],
    };

    return Menu.buildFromTemplate([...appMenu, fileMenu, editMenu, viewMenu, nextcloudMenu, windowMenu, helpMenu]);
}
