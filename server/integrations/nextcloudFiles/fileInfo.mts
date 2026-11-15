/**
 * nextcloud_file_info: one file or folder by its numeric file id or by its
 * path, as the user sees it in their own Files tree.
 *
 *   { fileId, path, name, mimeType, size, owner, modifiedAt, isFolder }
 *
 * By path: a Depth 0 PROPFIND on that path. By file id: a WebDAV SEARCH on
 * `oc:fileid` over the user's Files tree (`/files/<uid>`, depth infinity), so a
 * file id from a trigger, a Forms upload or another tool turns into a path.
 * Nextcloud answers only what the user may see: an id outside their tree is
 * "not found", never someone else's path.
 *
 * Exactly one of the two. With both, the scope guard would judge the path
 * while the lookup used the id; the call is refused instead.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type DavProps = Record<string, unknown>;
type DavEntry = { href: string; props: DavProps; status: string };
type NcResponse = { ok: boolean; status: number; text: () => Promise<string> };
type NcFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<NcResponse>;

const webdav = nodeRequire('./webdav') as {
    PROPFIND_BODY: string;
    joinDavPath: (root: string, path?: string) => string;
    parseMultistatus: (xml: string) => DavEntry[];
    isCollectionProp: (props: DavProps) => boolean;
    relativeFromRoot: (href: string, baseUrl: string, uid: string) => string;
};

export interface FileInfoCtx { baseUrl: string; ncFetch: NcFetch; authError: string; uid: string; root: string }
export interface FileInfoArgs { fileId?: unknown; path?: unknown }
export interface FileInfo {
    fileId: number | null;
    path: string;
    name: string;
    mimeType: string | null;
    size: number | null;
    owner: string | null;
    modifiedAt: string | null;
    isFolder: boolean;
}

/** The props a lookup asks for: those of PROPFIND_BODY (owner id and oc:size included). */
const SELECT_PROPS = `<d:displayname/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:resourcetype/>
      <oc:fileid/><oc:size/><oc:owner-id/>`;

function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** WebDAV SEARCH body: the node with this file id anywhere in the user's Files tree, with its props. */
export function fileIdSearchBody(uid: string, fileId: number): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop>${SELECT_PROPS}</d:prop></d:select>
    <d:from><d:scope><d:href>/files/${xmlEscape(uid)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:eq><d:prop><oc:fileid/></d:prop><d:literal>${fileId}</d:literal></d:eq></d:where>
    <d:limit><d:nresults>1</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
}

/** A positive integer file id from a number or a string of digits, or null. */
export function parseFileId(value: unknown): number | null {
    const text = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : '');
    if (!text || text.length > 15) return null;
    for (const ch of text) if (ch < '0' || ch > '9') return null;
    const n = Number(text);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function textProp(props: DavProps, key: string): string | null {
    const v = props[key];
    return typeof v === 'string' && v !== '' ? v : null;
}

function intProp(props: DavProps, key: string): number | null {
    const v = textProp(props, key);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function isoDate(httpDate: string | null): string | null {
    if (!httpDate) return null;
    const t = Date.parse(httpDate);
    return Number.isFinite(t) ? new Date(t).toISOString() : httpDate;
}

/** The FileInfo of one multistatus entry, the path relative to the user's Files root. */
export function toFileInfo(entry: DavEntry, baseUrl: string, uid: string): FileInfo {
    const { props } = entry;
    const isFolder = webdav.isCollectionProp(props);
    const rel = webdav.relativeFromRoot(entry.href, baseUrl, uid);
    const path = rel.length > 1 && rel.endsWith('/') ? rel.slice(0, -1) : rel;
    const name = path === '/' ? '/' : (path.split('/').pop() || path);
    return {
        fileId: parseFileId(textProp(props, 'fileid')),
        path,
        name,
        mimeType: isFolder ? null : textProp(props, 'getcontenttype'),
        // A folder has no getcontentlength; oc:size is the size of what is in it.
        size: isFolder ? intProp(props, 'size') : (intProp(props, 'getcontentlength') ?? intProp(props, 'size')),
        owner: textProp(props, 'owner-id'),
        modifiedAt: isoDate(textProp(props, 'getlastmodified')),
        isFolder,
    };
}

function lookupFailure(status: number, authError: string, what: string): { error: string } {
    if (status === 401) return { error: authError };
    if (status === 404) return { error: `File not found: ${what}` };
    if (status === 403) return { error: `Nextcloud does not let this account see ${what} (403).` };
    return { error: `Nextcloud file lookup failed for ${what} (${status})` };
}

async function byPath(path: string, ctx: FileInfoCtx): Promise<FileInfo | { error: string }> {
    const res = await ctx.ncFetch(webdav.joinDavPath(ctx.root, path), {
        method: 'PROPFIND',
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: webdav.PROPFIND_BODY,
    });
    if (!res.ok && res.status !== 207) return lookupFailure(res.status, ctx.authError, path);
    const entry = webdav.parseMultistatus(await res.text())[0];
    if (!entry || !entry.href) return { error: `File not found: ${path}` };
    return toFileInfo(entry, ctx.baseUrl, ctx.uid);
}

async function byFileId(fileId: number, ctx: FileInfoCtx): Promise<FileInfo | { error: string }> {
    const what = `file id ${fileId}`;
    const res = await ctx.ncFetch(`${ctx.baseUrl}/remote.php/dav/`, {
        method: 'SEARCH',
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        body: fileIdSearchBody(ctx.uid, fileId),
    });
    if (!res.ok && res.status !== 207) return lookupFailure(res.status, ctx.authError, what);
    const prefix = `/remote.php/dav/files/${ctx.uid}`;
    const entry = webdav.parseMultistatus(await res.text()).find((e) => {
        let href = e.href;
        try { href = decodeURIComponent(href); } catch { return false; }
        return href.includes(prefix);
    });
    if (!entry) return { error: `File not found: ${what}` };
    return toFileInfo(entry, ctx.baseUrl, ctx.uid);
}

/** The nextcloud_file_info handler. */
export async function nextcloudFileInfo(args: FileInfoArgs, ctx: FileInfoCtx): Promise<FileInfo | { error: string }> {
    const hasId = args.fileId !== undefined && args.fileId !== null && args.fileId !== '';
    const hasPath = typeof args.path === 'string' && args.path.trim() !== '';
    if (hasId && hasPath) return { error: 'Pass fileId or path, not both.' };
    if (hasPath) return byPath(String(args.path), ctx);
    if (!hasId) return { error: 'fileId or path is required' };
    const fileId = parseFileId(args.fileId);
    if (fileId === null) return { error: `fileId must be a positive whole number (got ${JSON.stringify(args.fileId)}).` };
    return byFileId(fileId, ctx);
}
