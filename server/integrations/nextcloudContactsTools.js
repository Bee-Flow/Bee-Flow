// @typecheck strict
/**
 * Nextcloud Contacts Tools — CardDAV CRUD over /remote.php/dav/addressbooks/users/<uid>/.
 *
 * Auth + base-URL handled by ./nextcloudClient (Bearer when the user logged in
 * via Nextcloud OAuth, app-password Basic otherwise).
 *
 * vCard handling delegates to the `vcf` library (RFC 6350 line folding,
 * escaping, parameter parsing); WebDAV multistatus parsing uses fast-xml-parser.
 */

const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const ncClient = require('./nextcloudClient');
const { buildVCard, parseVCard } = require('./nextcloudVcard');
const { NEXTCLOUD_CONTACTS_TOOLS } = require('./nextcloudContactsToolDefs.mts');

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
    // address-data carries &#13; for CR; left literal it breaks the vCard parse.
    htmlEntities: true,
});

const PROPFIND_ADDRESSBOOKS = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <card:supported-address-data/>
    <cs:getctag/>
  </d:prop>
</d:propfind>`;

const ADDRESSBOOK_QUERY = `<?xml version="1.0" encoding="utf-8" ?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag/>
    <card:address-data/>
  </d:prop>
</card:addressbook-query>`;


// ─── DAV helpers ──────────────────────────────────────────────────

/**
 * @param {string} baseUrl
 * @param {string | undefined} uid
 */
function addressbooksRoot(baseUrl, uid) {
    return `${baseUrl}/remote.php/dav/addressbooks/users/${encodeURIComponent(String(uid))}`;
}

/**
 * @param {string} baseUrl
 * @param {string | undefined} uid
 * @param {string | number | boolean} book
 * @param {string} contactUid
 */
function contactHref(baseUrl, uid, book, contactUid) {
    return `${addressbooksRoot(baseUrl, uid)}/${encodeURIComponent(book)}/${encodeURIComponent(contactUid)}.vcf`;
}

/**
 * @param {string | Uint8Array<ArrayBufferLike>} xml
 * @returns {Array<{ href: string, props: import('./nextcloudFiles/webdav').DavProps }>}
 */
function parseMultistatusResponses(xml) {
    const parsed = xmlParser.parse(xml);
    const ms = parsed?.multistatus;
    if (!ms) return [];
    const list = Array.isArray(ms.response) ? ms.response : (ms.response ? [ms.response] : []);
    return list.map((/** @type {{ href?: string, propstat?: unknown }} */ r) => {
        const propstats = Array.isArray(r.propstat) ? r.propstat : (r.propstat ? [r.propstat] : []);
        /** @type {import('./nextcloudFiles/webdav').DavProps} */
        const props = {};
        for (const ps of propstats) {
            const status = ps.status || '';
            if (status && !/\b2\d\d\b/.test(status)) continue;
            Object.assign(props, ps.prop || {});
        }
        return { href: r.href || '', props };
    });
}

/** @param {import('./nextcloudFiles/webdav').DavProps} props */
function isAddressbook(props) {
    const rt = props.resourcetype;
    if (!rt) return false;
    return rt.addressbook !== undefined;
}

/**
 * @param {string | Uint8Array<ArrayBufferLike>} xml
 * @param {string | undefined} uid
 */
function parsePropfindAddressbooks(xml, uid) {
    const root = `/remote.php/dav/addressbooks/users/${decodeURIComponent(String(uid))}`;
    const books = [];
    for (const { href, props } of parseMultistatusResponses(xml)) {
        if (!href || !isAddressbook(props)) continue;
        const decoded = decodeURIComponent(href);
        if (decoded.replace(/\/+$/, '') === root) continue;
        const slug = /** @type {string} */ (decoded.replace(/\/+$/, '').split('/').pop()); // split yields one part at least
        books.push({ slug, displayName: props.displayname || slug, href });
    }
    return books;
}

/**
 * @param {string | Uint8Array<ArrayBufferLike>} xml
 */
function parseAddressbookMultiStatus(xml) {
    return parseMultistatusResponses(xml)
        .filter(({ href, props }) => href && props['address-data'] && !href.endsWith('/'))
        .map(({ href, props }) => ({
            href: decodeURIComponent(href),
            etag: props.getetag || null,
            cardData: props['address-data'] || '',
        }));
}

// ─── Tool execution ──────────────────────────────────────────────

/**
 * @typedef {{ addressbook?: string, uid?: string, query?: string, limit?: number, fullName?: string, firstName?: string, lastName?: string, emails?: string[], phones?: string[], organization?: string, title?: string, notes?: string }} ContactsArgs
 * @typedef {Awaited<ReturnType<typeof ncClient.resolveAuth>> & { root: string }} ContactsCtx
 * @typedef {(args: ContactsArgs, c: ContactsCtx) => Promise<Record<string, any>>} ContactsHandler
 */

/** @param {ContactsCtx} c */
function propfindBooks(c) {
    return c.fetch(`${c.root}/`, {
        method: 'PROPFIND',
        headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_ADDRESSBOOKS,
    });
}

/** @param {ContactsCtx} c @param {string} book */
function reportBook(c, book) {
    return c.fetch(`${c.root}/${encodeURIComponent(book)}/`, {
        method: 'REPORT',
        headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: ADDRESSBOOK_QUERY,
    });
}

/** @type {ContactsHandler} */
async function listAddressbooks(_args, c) {
    const res = await propfindBooks(c);
    if (res.status === 401) return { error: c.authError };
    if (!res.ok) return { error: `Address book list failed (${res.status})` };
    const xml = await res.text();
    const addressbooks = parsePropfindAddressbooks(xml, c.uid);
    return { count: addressbooks.length, addressbooks };
}

/** @type {ContactsHandler} */
async function listContacts(args, c) {
    const book = args.addressbook || 'contacts';
    const limit = Math.min(Math.max(args.limit || 200, 1), 1000);
    const res = await reportBook(c, book);
    if (res.status === 401) return { error: c.authError };
    if (res.status === 404) return { error: `Address book not found: ${book}` };
    if (!res.ok) return { error: `Contacts list failed (${res.status})` };
    const xml = await res.text();
    const items = parseAddressbookMultiStatus(xml);
    const contacts = items.slice(0, limit).map(it => ({ ...parseVCard(it.cardData), etag: it.etag, href: it.href, addressbook: book }));
    return { addressbook: book, count: contacts.length, contacts };
}

/** @param {ReturnType<typeof parseVCard>} c */
function contactHaystack(c) {
    return [
        c.fullName, c.firstName, c.lastName, c.organization, c.title, c.notes,
        ...(c.emails || []), ...(c.phones || [])
    ].join(' ').toLowerCase();
}

/**
 * The address books a search covers: the one asked for, or every book.
 * @param {ContactsArgs} args @param {ContactsCtx} c
 * @returns {Promise<{ books: string[] } | { error: string }>}
 */
async function searchBooks(args, c) {
    if (args.addressbook) return { books: [args.addressbook] };
    const listRes = await propfindBooks(c);
    if (listRes.status === 401) return { error: c.authError };
    if (!listRes.ok) return { error: `Failed to enumerate address books (${listRes.status})` };
    return { books: parsePropfindAddressbooks(await listRes.text(), c.uid).map(b => b.slug) };
}

/** @type {ContactsHandler} */
async function searchContacts(args, c) {
    const q = String(args.query || '').toLowerCase().trim();
    if (!q) return { error: 'query is required' };
    const limit = Math.min(Math.max(args.limit || 50, 1), 200);
    const target = await searchBooks(args, c);
    if ('error' in target) return target;

    /** @type {Record<string, any>[]} */
    const matches = [];
    for (const book of target.books) {
        const res = await reportBook(c, book);
        if (!res.ok) continue;
        const items = parseAddressbookMultiStatus(await res.text());
        for (const it of items) {
            const contact = parseVCard(it.cardData);
            if (!contactHaystack(contact).includes(q)) continue;
            matches.push({ ...contact, etag: it.etag, href: it.href, addressbook: book });
            if (matches.length >= limit) break;
        }
        if (matches.length >= limit) break;
    }
    return { query: args.query, count: matches.length, contacts: matches };
}

/** @type {ContactsHandler} */
async function getContact(args, { baseUrl, uid, fetch: ncFetch, authError }) {
    if (!args.addressbook || !args.uid) return { error: 'addressbook and uid are required' };
    const res = await ncFetch(contactHref(baseUrl, uid, args.addressbook, args.uid), {});
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Contact not found: ${args.uid}` };
    if (!res.ok) return { error: `Contact fetch failed (${res.status})` };
    const text = await res.text();
    const contact = parseVCard(text);
    return { ...contact, etag: res.headers.get('etag'), addressbook: args.addressbook };
}

/** @type {ContactsHandler} */
async function createContact(args, { baseUrl, uid, fetch: ncFetch, authError }) {
    if (!args.addressbook || !args.fullName) return { error: 'addressbook and fullName are required' };
    const contactUid = `${crypto.randomUUID()}@${new URL(baseUrl).hostname}`;
    const vcard = buildVCard({ uid: contactUid, ...args });
    const res = await ncFetch(contactHref(baseUrl, uid, args.addressbook, contactUid), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/vcard; charset=utf-8', 'If-None-Match': '*' },
        body: vcard,
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Address book not found: ${args.addressbook}` };
    if (!res.ok && res.status !== 201 && res.status !== 204) {
        const body = await res.text().catch(() => '');
        return { error: `Contact create failed (${res.status}): ${body.slice(0, 200)}` };
    }
    return { success: true, addressbook: args.addressbook, uid: contactUid, etag: res.headers.get('etag') };
}

/**
 * The stored contact with every field the call names replaced.
 * @param {ContactsArgs & { uid: string }} args @param {ReturnType<typeof parseVCard>} current
 */
function mergeContact(args, current) {
    return {
        uid: args.uid,
        fullName: args.fullName !== undefined ? args.fullName : current.fullName,
        firstName: args.firstName !== undefined ? args.firstName : current.firstName,
        lastName: args.lastName !== undefined ? args.lastName : current.lastName,
        emails: args.emails !== undefined ? args.emails : current.emails,
        phones: args.phones !== undefined ? args.phones : current.phones,
        organization: args.organization !== undefined ? args.organization : current.organization,
        title: args.title !== undefined ? args.title : current.title,
        notes: args.notes !== undefined ? args.notes : current.notes,
    };
}

/** @type {ContactsHandler} */
async function updateContact(args, { baseUrl, uid, fetch: ncFetch, authError }) {
    if (!args.addressbook || !args.uid) return { error: 'addressbook and uid are required' };
    const getRes = await ncFetch(contactHref(baseUrl, uid, args.addressbook, args.uid), {});
    if (getRes.status === 401) return { error: authError };
    if (getRes.status === 404) return { error: `Contact not found: ${args.uid}` };
    if (!getRes.ok) return { error: `Could not load contact for update (${getRes.status})` };
    const currentEtag = getRes.headers.get('etag');
    const current = parseVCard(await getRes.text());

    const vcard = buildVCard(mergeContact({ ...args, uid: args.uid }, current));
    const putRes = await ncFetch(contactHref(baseUrl, uid, args.addressbook, args.uid), {
        method: 'PUT',
        headers: {
            'Content-Type': 'text/vcard; charset=utf-8',
            ...(currentEtag ? { 'If-Match': currentEtag } : {}),
        },
        body: vcard,
    });
    if (putRes.status === 401) return { error: authError };
    if (putRes.status === 412) return { error: 'Contact was modified by another client; refetch and retry.' };
    if (!putRes.ok && putRes.status !== 204) {
        const body = await putRes.text().catch(() => '');
        return { error: `Contact update failed (${putRes.status}): ${body.slice(0, 200)}` };
    }
    return { success: true, addressbook: args.addressbook, uid: args.uid, etag: putRes.headers.get('etag') };
}

/** @type {ContactsHandler} */
async function deleteContact(args, { baseUrl, uid, fetch: ncFetch, authError }) {
    if (!args.addressbook || !args.uid) return { error: 'addressbook and uid are required' };
    const res = await ncFetch(contactHref(baseUrl, uid, args.addressbook, args.uid), { method: 'DELETE' });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Contact not found: ${args.uid}` };
    if (!res.ok && res.status !== 204) return { error: `Contact delete failed (${res.status})` };
    return { success: true, addressbook: args.addressbook, uid: args.uid };
}

/** @type {Record<string, ContactsHandler>} */
const HANDLERS = {
    nextcloud_contacts_list_addressbooks: listAddressbooks,
    nextcloud_contacts_list: listContacts,
    nextcloud_contacts_search: searchContacts,
    nextcloud_contacts_get: getContact,
    nextcloud_contacts_create: createContact,
    nextcloud_contacts_update: updateContact,
    nextcloud_contacts_delete: deleteContact,
};

/**
 * @param {string} toolName
 * @param {ContactsArgs} args
 * @param {string} userId
 * @param {Partial<Express.Session>} session
 */
async function executeNextcloudContactsTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const handler = Object.hasOwn(HANDLERS, toolName) ? HANDLERS[toolName] : null;
    if (!handler) return { error: `Unknown Nextcloud contacts tool: ${toolName}` };
    return handler(args, { ...ctx, root: addressbooksRoot(ctx.baseUrl, ctx.uid) });
}

/** @param {unknown} toolName */
function isNextcloudContactsTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_contacts_');
}

module.exports = {
    NEXTCLOUD_CONTACTS_TOOLS,
    executeNextcloudContactsTool,
    isNextcloudContactsTool,
};
