/**
 * Contract readers for /api/webpages (server/stores/webpage/shared.js
 * mapWebpageRow, and webpagePublicShareStore.js mapRow for the links).
 */

import { field, pick, shapeListOf, shapeOf, type FieldReader } from '@/core/api/contract';

import type { CreatedWebpageShare, Webpage, WebpageDetail, WebpageExtraFile, WebpageShare } from '../model/types';

const readRow = shapeOf({
    id: field.str(''),
    userId: field.str(''),
    name: field.str(''),
    description: field.str(''),
    tagline: field.str(''),
    icon: field.str(''),
    accentColor: field.str(''),
    isPublished: field.bool(false),
    sharedGroups: field.strArray,
    organizationId: field.strOrNull,
    projectId: field.strOrNull,
    htmlSize: field.num(0),
    cssSize: field.num(0),
    jsSize: field.num(0),
    sourceCount: field.num(0),
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
    instructions: field.str(''),
    knowledgeBaseIds: field.strArray,
    slug: field.strOrNull,
    publicShareId: field.strOrNull,
    publicShareCount: field.numOrNull,
});

const readFramework = field.oneOf(['vanilla', 'react-mui'] as const, 'vanilla');
const readRuntime = field.oneOf(['light', 'full'] as const, 'light');

/**
 * The row, plus the two words of `settings` the phone acts on. Anything else
 * in that open block is left to the web. The fallbacks are the server's own
 * read-time defaults (integrations/webpageFramework.js resolveFramework).
 */
export function readWebpage(raw: unknown): Webpage {
    const settings = pick(raw, 'settings');
    return {
        ...readRow(raw),
        framework: readFramework(pick(settings, 'framework')),
        runtime: readRuntime(pick(settings, 'runtime')),
    };
}

export function readWebpages(raw: unknown): Webpage[] {
    return field.list(readWebpage)(pick(raw, 'webpages'));
}

const readExtraFiles = shapeListOf({
    path: field.str(''),
    mimeType: field.str('application/octet-stream'),
    isText: field.bool(false),
    size: field.num(0),
});

/** The stored chat rows, kept as the web wrote them so a save can hand them back intact. */
function readChatRows(raw: unknown): Record<string, unknown>[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object');
}

/**
 * The detail response also carries the whole project — sources, the three
 * file bodies, chat — because the desktop IDE opens from this one call. The
 * bodies can run to megabytes and are dropped here: the Code tab asks for them
 * itself (readWebpageFiles) when it is opened. `readOnly` counts only when it
 * is exactly true.
 */
export function readWebpageDetail(raw: unknown): WebpageDetail | null {
    const webpage = pick(raw, 'webpage');
    if (webpage === null || typeof webpage !== 'object') return null;
    const extraFiles: WebpageExtraFile[] = readExtraFiles(pick(raw, 'extraFiles')).filter((f) => f.path !== '');
    return {
        webpage: readWebpage(webpage),
        readOnly: pick(raw, 'readOnly') === true,
        extraFiles,
        chatMessages: readChatRows(pick(raw, 'chatMessages')),
    };
}

/** POST / and POST /:id/clone both answer `{ webpage }`; null without an id. */
export function readCreatedWebpage(raw: unknown): Webpage | null {
    const webpage = pick(raw, 'webpage');
    if (webpage === null || typeof webpage !== 'object') return null;
    const read = readWebpage(webpage);
    return read.id ? read : null;
}

/** Stripped for anyone but the share's creator: absent, as opposed to null. */
const allowedEmails: FieldReader<string[] | null | undefined> = (value) =>
    value === null ? null : field.optStrArray(value);

const shareSpec = {
    id: field.str(''),
    webpageId: field.str(''),
    createdBy: field.str(''),
    accessMode: field.oneOf(['unlisted', 'password', 'email'] as const, 'unlisted'),
    hasPassword: field.bool(false),
    allowedEmails,
    expiresAt: field.strOrNull,
    revokedAt: field.strOrNull,
    title: field.str(''),
    viewCount: field.num(0),
    lastViewedAt: field.strOrNull,
    createdAt: field.strOrNull,
    url: field.strOrNull,
};

const readShare: (raw: unknown) => WebpageShare = shapeOf(shareSpec);

export function readWebpageShares(raw: unknown): WebpageShare[] {
    return shapeListOf(shareSpec)(pick(raw, 'shares'));
}

/** The one response where the link's URL is guaranteed; null without both halves. */
export function readCreatedShare(raw: unknown): CreatedWebpageShare | null {
    const share = pick(raw, 'share');
    const url = field.strOrNull(pick(raw, 'url'));
    if (share === null || typeof share !== 'object' || !url) return null;
    return { share: readShare(share), url };
}

/** PATCH …/publish answers the state it settled on; fall back to what was asked. */
export function readPublished(raw: unknown, asked: boolean): boolean {
    return field.optBool(pick(raw, 'isPublished')) ?? asked;
}
