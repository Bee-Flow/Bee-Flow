/**
 * Which Nextcloud app a `nextcloud_request` call reaches, read from its path.
 *
 * nextcloud_request (integrations/nextcloudRequestTool.mts) is one tool for
 * every OCS and WebDAV path, so its name says nothing about the app it talks
 * to. The scope guard (ncScopeGuard.checkToolCall) and the automation
 * runner's app-switch check (automationRunner/integrationActionGates.js)
 * judge it by the families this module names instead:
 *
 *   /remote.php/dav/files|uploads|trashbin|versions|comments|systemtags…  Files
 *   /remote.php/dav/calendars        Calendar and Tasks (CalDAV holds both)
 *   /remote.php/dav/addressbooks     Contacts
 *   /ocs/v*.php/apps/<app>/, /index.php/apps/<app>/   the family of <app>
 *
 * Anything else (core OCS endpoints, an app without a Bee Flow family) maps
 * to no family: null, and the callers then allow it only when no family is
 * narrowed at all. A path that cannot be read (bad percent-encoding, a "." or
 * ".." segment) is null as well; the handler refuses it anyway.
 *
 * The path is compared decoded and lower-cased, segment by segment, the way
 * the handler's normalisePath reads it. Plain string operations only.
 */

/** Every Nextcloud family a scope or an app switch can narrow. */
export const NC_FAMILY_IDS: readonly string[] = [
    'nextcloud', 'nextcloud-calendar', 'nextcloud-contacts', 'nextcloud-deck', 'nextcloud-notifications',
    'nextcloud-talk', 'nextcloud-tasks', 'nextcloud-notes', 'nextcloud-mail', 'nextcloud-activity',
    'nextcloud-teams', 'nextcloud-tables', 'nextcloud-forms', 'nextcloud-status',
];

const LABELS: Readonly<Record<string, string>> = {
    nextcloud: 'Nextcloud Files', 'nextcloud-calendar': 'Nextcloud Calendar', 'nextcloud-contacts': 'Nextcloud Contacts',
    'nextcloud-deck': 'Nextcloud Deck', 'nextcloud-notifications': 'Nextcloud Notifications', 'nextcloud-talk': 'Nextcloud Talk',
    'nextcloud-tasks': 'Nextcloud Tasks', 'nextcloud-notes': 'Nextcloud Notes', 'nextcloud-mail': 'Nextcloud Mail',
    'nextcloud-activity': 'Nextcloud Activity', 'nextcloud-teams': 'Nextcloud Teams', 'nextcloud-tables': 'Nextcloud Tables',
    'nextcloud-forms': 'Nextcloud Forms', 'nextcloud-status': 'Nextcloud Status',
};

/** The name of a family for a sentence ("Nextcloud Mail"). */
export function familyLabel(id: string): string {
    return Object.prototype.hasOwnProperty.call(LABELS, id) ? LABELS[id] : id;
}

/** The Nextcloud app id in an apps/<app>/ path, and the families it belongs to. */
const APP_FAMILIES: Readonly<Record<string, readonly string[]>> = {
    mail: ['nextcloud-mail'],
    spreed: ['nextcloud-talk'],
    deck: ['nextcloud-deck'],
    tables: ['nextcloud-tables'],
    forms: ['nextcloud-forms'],
    notes: ['nextcloud-notes'],
    user_status: ['nextcloud-status'],
    files: ['nextcloud'],
    files_sharing: ['nextcloud'],
    calendar: ['nextcloud-calendar', 'nextcloud-tasks'],
    tasks: ['nextcloud-tasks'],
    contacts: ['nextcloud-contacts'],
    activity: ['nextcloud-activity'],
    notifications: ['nextcloud-notifications'],
    circles: ['nextcloud-teams'],
};

/** The first segment under /remote.php/dav/, and the families it belongs to. */
const DAV_FAMILIES: Readonly<Record<string, readonly string[]>> = {
    files: ['nextcloud'],
    uploads: ['nextcloud'],
    trashbin: ['nextcloud'],
    versions: ['nextcloud'],
    comments: ['nextcloud'],
    systemtags: ['nextcloud'],
    'systemtags-relations': ['nextcloud'],
    calendars: ['nextcloud-calendar', 'nextcloud-tasks'],
    addressbooks: ['nextcloud-contacts'],
};

/** The decoded, lower-cased segments of a path, or null when it cannot be read. */
function segmentsOf(raw: unknown): string[] | null {
    if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
    const out: string[] = [];
    for (const seg of raw.slice(1).split('/')) {
        let plain: string;
        try { plain = decodeURIComponent(seg); } catch { return null; }
        if (plain === '.' || plain === '..' || plain.includes('/') || plain.includes('\\')) return null;
        out.push(plain.toLowerCase());
    }
    return out;
}

/** The families of an apps/<app>/... path that starts at `at`, or null. */
function appFamilies(segs: string[], at: number): readonly string[] | null {
    if (segs[at] !== 'apps' || !segs[at + 1]) return null;
    return Object.prototype.hasOwnProperty.call(APP_FAMILIES, segs[at + 1]) ? APP_FAMILIES[segs[at + 1]] : null;
}

/**
 * The families a nextcloud_request path reaches, or null for a path of no
 * known family (or one that cannot be read).
 */
export function requestFamilies(rawPath: unknown): string[] | null {
    const segs = segmentsOf(rawPath);
    if (!segs || segs.length < 2) return null;
    let found: readonly string[] | null = null;
    if (segs[0] === 'ocs' && (segs[1] === 'v1.php' || segs[1] === 'v2.php')) found = appFamilies(segs, 2);
    else if (segs[0] === 'index.php') found = appFamilies(segs, 1);
    else if (segs[0] === 'remote.php' && segs[1] === 'dav' && segs[2]) {
        found = Object.prototype.hasOwnProperty.call(DAV_FAMILIES, segs[2]) ? DAV_FAMILIES[segs[2]] : null;
    }
    return found ? [...found] : null;
}
