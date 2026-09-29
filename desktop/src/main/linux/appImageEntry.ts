/**
 * `beeflow://` links for an AppImage, which has no installer to register them.
 *
 * On Linux, `app.setAsDefaultProtocolClient` runs `xdg-settings` with the
 * desktop file named in package.json (`beeflow.desktop`). The .deb, .rpm and
 * pacman packages install that file; an AppImage does not, so the call
 * succeeds and points the scheme at a file that does not exist, and
 * `xdg-open beeflow://…` opens nothing.
 *
 * So an AppImage writes one for itself, in the user's own applications
 * directory, pointing at the AppImage file. `NoDisplay=true`: it is a link
 * handler, not a second menu entry next to the one AppImageLauncher or Gear
 * Lever may already have made. And never when a package install already
 * provides beeflow.desktop — a per-user file shadows the system one, and when
 * the AppImage is later deleted, links would stop working for the installed
 * app too.
 */

import * as path from 'node:path';

export interface AppImageEntryInput {
    /** $APPIMAGE: the AppImage file itself, set by its runtime. */
    appImage: string | undefined;
    /** $APPDIR: where the runtime mounted or extracted it. */
    appDir: string | undefined;
    /** process.execPath: must be inside APPDIR for this to be the AppImage. */
    execPath: string;
    home: string;
    /** $XDG_DATA_HOME, when set. */
    xdgDataHome: string | undefined;
    /** Does a system-wide beeflow.desktop exist (from a package install)? */
    systemEntryExists: boolean;
    /** The current per-user beeflow.desktop, or null when there is none. */
    existing: string | null;
}

export type AppImageEntryPlan = { action: 'write'; file: string; content: string } | { action: 'remove'; file: string } | null;

export const DESKTOP_FILE_NAME = 'beeflow.desktop';

/** Marks a desktop file this module wrote, so it is the only one ever removed. */
export const MARKER = 'X-Beeflow-AppImage=true';

/** Where a package install puts its desktop file; checked before writing ours. */
export const SYSTEM_ENTRY_PATHS = ['/usr/share/applications/beeflow.desktop', '/usr/local/share/applications/beeflow.desktop'];

/**
 * What to do about ~/.local/share/applications/beeflow.desktop.
 *
 * Written only when this process really is an AppImage — $APPIMAGE alone is
 * not enough, because a terminal or editor that is itself an AppImage passes
 * it on to everything it starts, and the entry would point links at that other
 * application. Removed (only if we wrote it) once a package install provides
 * beeflow.desktop, or when this copy is not an AppImage: a stale per-user file
 * would shadow the package's, hide it from the menu (it is NoDisplay) and send
 * links to an AppImage that may be long deleted.
 */
export function planAppImageEntry(input: AppImageEntryInput): AppImageEntryPlan {
    const dataHome = input.xdgDataHome && path.isAbsolute(input.xdgDataHome) ? input.xdgDataHome : path.join(input.home, '.local', 'share');
    const file = path.join(dataHome, 'applications', DESKTOP_FILE_NAME);
    const ours = input.existing?.split('\n').some((line) => line.trim() === MARKER) ?? false;

    const appImage = input.appImage?.trim();
    const appDir = input.appDir?.trim();
    const isAppImage =
        Boolean(appImage && path.isAbsolute(appImage) && appDir && path.isAbsolute(appDir)) &&
        (input.execPath === appDir || input.execPath.startsWith(`${appDir!.replace(/\/+$/, '')}/`));

    if (!isAppImage || input.systemEntryExists) return ours ? { action: 'remove', file } : null;
    if (input.existing !== null && !ours) return null; // someone else's file; leave it alone

    const content = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Bee Flow',
        `Exec=${execArgument(appImage!)} %U`,
        'Icon=beeflow',
        'Terminal=false',
        'NoDisplay=true',
        'MimeType=x-scheme-handler/beeflow;',
        'StartupWMClass=beeflow',
        MARKER,
        '',
    ].join('\n');
    return input.existing === content ? null : { action: 'write', file, content };
}

/**
 * The AppImage path as one `Exec=` argument, per the Desktop Entry spec: in
 * double quotes, with `"`, `` ` ``, `$` and `\` backslash-escaped; then, because
 * the whole value is itself an escaped string, every backslash doubled; and a
 * literal `%` written `%%` so it is not read as a field code. Someone's
 * `~/Apps/$weird "name".AppImage` must still launch, and must not run anything
 * but the AppImage.
 */
export function execArgument(file: string): string {
    const quoted = `"${file.replace(/["`$\\]/g, (char) => `\\${char}`)}"`;
    return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}
