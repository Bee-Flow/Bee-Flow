/** @typedef {import('express-serve-static-core').NextFunction} NextFunction */
// @typecheck noImplicitAny
/**
 * Test kit for the co-editing tests: a whole co-editing server over PGlite
 * and in-memory stand-ins, with no module mocking.
 *
 *   const w = await collabWorld();
 *   w.collab       a makeCollab() instance over the real store, crypto and hub
 *   w.resources    notebooks/pages by id ({projectId, html, supported, …})
 *   w.mirrors      what was written into resources; w.versions, w.events, …
 *
 * The converter here is a deliberately small stand-in for the editor bundle
 * (paragraphs of plain text, one `textblock` + `XmlText` per paragraph, a
 * minimal text diff on write), so these tests do not depend on the bundle
 * being built. The bundle itself is tested in agent-hub; convergence.test
 * also runs against it when it is present.
 *
 * Not a test file: required by *.test.js next to it.
 */

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const Y = require('yjs');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeCollabDocStore, DDL } = require('../../stores/collabDocStore');
const { makeCollab } = require('./index');
const { makeConverter } = require('./convert');

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

// ── A paragraph-only stand-in for the editor bundle ────────────────────────

/**
 * @param {string} text
 */
const paragraph = (text) => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });
const textOfBlock = /** @param {{ content?: Array<{ text?: string }> }} b */ (b) => (b.content || []).map((c) => c.text || '').join('');
const escapeHtml = /** @param {string} s */ (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** @param {import('yjs').XmlText} t */
function ytextString(t) {
    return t.toDelta().map(/** @param {{ insert?: unknown }} d */ (d) => (typeof d.insert === 'string' ? d.insert : '')).join('');
}

/**
 * @param {string} text
 */
function newBlock(text) {
    const el = new Y.XmlElement('textblock');
    el.setAttribute('type', 'paragraph');
    const t = new Y.XmlText();
    if (text) t.insert(0, text);
    el.insert(0, [t]);
    return el;
}

/**
 * The smallest text edit turning `t` into `next`.
 * @param {import('yjs').XmlText} t
 * @param {string} next
 */
function syncText(t, next) {
    const cur = ytextString(t);
    if (cur === next) return;
    let a = 0;
    while (a < cur.length && a < next.length && cur[a] === next[a]) a += 1;
    let b = 0;
    while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b += 1;
    if (cur.length - a - b > 0) t.delete(a, cur.length - a - b);
    if (next.length - a - b > 0) t.insert(a, next.slice(a, next.length - b));
}

const simpleBundle = {
    markdownToAst: /** @param {string} md */ (md) => ({ type: 'doc', content: String(md).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).map(paragraph) }),
    htmlToAst: /** @param {string} html */ (html) => ({
        type: 'doc',
        content: [...String(html).matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => paragraph(m[1].replace(/<[^>]*>/g, ''))),
    }),
    astToMarkdown: /** @param {import('./convert').AstNode} ast */ (ast) => (ast.content || []).map(textOfBlock).join('\n\n'),
    astToHtml: /** @param {import('./convert').AstNode} ast */ (ast) => (ast.content || []).map((b) => `<p>${escapeHtml(textOfBlock(b))}</p>`).join(''),
    /**
     * @param {import('./convert').AstNode} ast
     * @param {import('yjs').XmlFragment} fragment
     */
    astToFragment(ast, fragment) {
        if (fragment.length) fragment.delete(0, fragment.length);
        const els = (ast.content || []).map((b) => newBlock(textOfBlock(b)));
        if (els.length) fragment.insert(0, els);
    },
    /** @param {import('yjs').XmlFragment} fragment */
    fragmentToAst(fragment) {
        return {
            type: 'doc',
            content: fragment.toArray()
                .filter(/** @param {import('yjs').XmlElement | import('yjs').XmlText} el @returns {el is import('yjs').XmlElement} */ (el) => el instanceof Y.XmlElement && el.nodeName === 'textblock')
                .map((el) => paragraph(ytextString(/** @type {import('yjs').XmlText} */ (el.get(0))))),
        };
    },
    /**
     * @param {import('yjs').XmlFragment} fragment
     * @param {import('./convert').AstNode} doc
     */
    syncDocToFragment(fragment, doc) {
        const want = (doc.content || []).map(textOfBlock);
        const have = fragment.toArray();
        for (let i = 0; i < want.length; i += 1) {
            if (i < have.length) syncText(/** @type {import('yjs').XmlText} */ (/** @type {import('yjs').XmlElement} */ (have[i]).get(0)), want[i]);
            else fragment.insert(fragment.length, [newBlock(want[i])]);
        }
        if (have.length > want.length) fragment.delete(want.length, have.length - want.length);
    },
    /**
     * @param {import('./convert').AstNode} a
     * @param {import('./convert').AstNode} b
     */
    diffDocs(a, b) {
        const words = /** @param {import('./convert').AstNode} d */ (d) => (d.content || []).map(textOfBlock).join(' ').split(/\s+/).filter(Boolean);
        const wa = words(a);
        const wb = words(b);
        const common = wb.filter((w) => wa.includes(w)).length;
        const blocks = Math.abs((a.content || []).length - (b.content || []).length)
            + (a.content || []).filter((x, i) => textOfBlock(x) !== textOfBlock((b.content || [])[i] || {})).length;
        return { blocks: /** @type {unknown[]} */ ([]), stats: { wordsAdded: wb.length - common, wordsRemoved: Math.max(0, wa.length - common), blocksChanged: blocks } };
    },
};

/**
 * The text of a Y.Doc's paragraphs, as the stand-in reads them.
 * @param {import('yjs').Doc} ydoc
 */
function docText(ydoc) {
    return simpleBundle.astToMarkdown(simpleBundle.fragmentToAst(ydoc.getXmlFragment('content')));
}

/**
 * Type into a paragraph of a client's Y.Doc (creating it when missing).
 * @param {import('yjs').Doc} ydoc
 * @param {number} index
 * @param {number} at
 * @param {string} text
 */
function typeInto(ydoc, index, at, text) {
    const fragment = ydoc.getXmlFragment('content');
    ydoc.transact(() => {
        while (fragment.length <= index) fragment.insert(fragment.length, [newBlock('')]);
        const t = /** @type {import('yjs').XmlText} */ (/** @type {import('yjs').XmlElement} */ (fragment.get(index)).get(0));
        t.insert(Math.min(at, t.length), text);
    });
}

// ── The world ──────────────────────────────────────────────────────────────

/**
 * `contentCaps` gives a kind an owner's cap on the rendered body (like
 * documentStore's for pages): past it the owner refuses the mirror and the
 * version, and co-editing learns the cap through `maxContentBytes`. `refuse`
 * (a Set of resource ids) makes an owner refuse whatever it is given.
 * @param {{ limits?: object, enabled?: boolean, converter?: any, contentCaps?: Record<string, number> }} [opts]
 */
async function collabWorld(opts = {}) {
    const { pg, db } = pgliteDb();
    await pg.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, organization_id TEXT DEFAULT '')");
    await pg.exec(DDL);
    const store = makeCollabDocStore(db);

    const projects = new Map();
    const resources = new Map();
    /** @type {Array<{ kind: string, id: string, html: string, markdown?: string | null, text?: string, wordCount?: number }>} */
    const mirrors = [];
    /** @type {Array<{ kind: string, id: string, versionId: string, html?: string, [k: string]: unknown }>} */
    const versions = [];
    /** @type {{ projectId: string; }[]} */
    const events = [];
    /** @type {{ projectId: string; }[]} */
    const transients = [];
    /** @type {Array<Record<string, unknown>>} */
    const feed = [];
    /** @type {Array<Record<string, unknown>>} */
    const scans = [];
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    const settings = { enabled: opts.enabled !== false, isCollabEnabled: async () => settings.enabled };
    const keys = new Map();
    let keyFails = false;
    const contentCaps = opts.contentCaps || {};
    const refuse = new Set();
    /**
     * @param {string} kind
     * @param {string} id
     * @param {string | ArrayBufferLike | NodeJS.ArrayBufferView<ArrayBufferLike>} html
     */
    const overCap = (kind, id, html) => refuse.has(id) || (contentCaps[kind] > 0 && Buffer.byteLength(html || '', 'utf8') > contentCaps[kind]);

    /**
     * @param {string} id
     * @param {Record<string, unknown>} [extra]
     */
    async function addProject(id, extra = {}) {
        const project = { id, kind: 'workspace', organizationId: 'org1', ...extra };
        await pg.query('INSERT INTO projects (id, name, owner_id, organization_id) VALUES ($1, $1, $2, $3)', [id, 'owner', project.organizationId || '']);
        projects.set(id, project);
    }

    /**
     * @param {string} kind
     * @param {string} id
     * @param {Record<string, unknown>} [extra]
     */
    function addResource(kind, id, extra = {}) {
        const r = { id, kind, projectId: 'p1', ownerId: 'ann', orgId: 'org1', html: '', markdown: /** @type {string | null} */ (null), supported: true, ...extra };
        resources.set(`${kind}:${id}`, r);
        return r;
    }

    const resourceApi = {
        /** @param {string} kind @param {string} id */
        async load(kind, id) {
            const r = resources.get(`${kind}:${id}`);
            return r ? { ...r } : null;
        },
        maxContentBytes: /** @param {string} kind */ (kind) => contentCaps[kind] || null,
        /**
         * @param {string} kind
         * @param {string} id
         * @param {{ html: string, markdown?: string | null, text?: string, wordCount?: number }} content
         */
        async writeMirror(kind, id, content) {
            if (overCap(kind, id, content.html)) return { written: false, refused: true, reason: 'document_too_large' };
            mirrors.push({ kind, id, ...content });
            const r = resources.get(`${kind}:${id}`);
            if (r) { r.html = content.html; r.markdown = content.markdown ?? r.markdown; }
            return { written: true };
        },
        /**
         * @param {string} kind
         * @param {string} id
         * @param {{ html?: string, [k: string]: unknown }} v
         */
        async recordVersion(kind, id, v) {
            if (overCap(kind, id, v.html)) throw Object.assign(new Error('too large'), { errorClass: 'document_too_large', status: 413 });
            const versionId = `v${versions.length + 1}`;
            versions.push({ kind, id, versionId, ...v });
            return versionId;
        },
    };

    const collab = makeCollab({
        store,
        converter: opts.converter || makeConverter({ bundle: simpleBundle }),
        resources: resourceApi,
        settings,
        getProject: async (id) => projects.get(id) || null,
        getProjectKey: async (projectId) => {
            if (keyFails) throw new Error('vault unavailable');
            if (!keys.has(projectId)) keys.set(projectId, crypto.randomBytes(32));
            return keys.get(projectId);
        },
        publishTransient: async (projectId, ev) => {
            transients.push({ projectId, ...ev });
            bus.emit(projectId, { ...ev, transient: true });
        },
        emitProjectEvent: async (projectId, ev) => { events.push({ projectId, ...ev }); },
        changeFeed: () => ({ recordContentChange: async (/** @type {Record<string, unknown>} */ x) => { feed.push(x); } }),
        contentSignals: () => ({ queueContentScan: async (/** @type {{ loadText: () => Promise<string>, [k: string]: unknown }} */ x) => { scans.push({ ...x, text: await x.loadText() }); } }),
        subscribeProject: (/** @type {string} */ projectId, /** @type {(ev: unknown) => void} */ handler) => { bus.on(projectId, handler); return () => bus.off(projectId, handler); },
        isDistributed: () => true,
        limits: opts.limits,
        log: quietLog,
    });

    await addProject('p1');
    await addProject('p2');

    return {
        pg, db, store, collab, bus, settings, projects, resources, mirrors, versions, events, transients, feed, scans, refuse,
        addProject, addResource,
        failKeys: (on = true) => { keyFails = on; },
        close: async () => { collab.hub._reset(); await pg.close(); },
    };
}

/**
 * The role gate as auth/projectAccess answers it: 401 without a session,
 * 404 for a non-member, 403 for a role too low.
 * @param {Record<string, Record<string, string>>} roles projectId → userId → role
 */
function fakeRoleGate(roles) {
    /** @type {Record<string, number>} */
    const ORDER = { viewer: 0, editor: 1, owner: 2 };
    return (/** @type {string} */ minRole) => /**
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     * @param {NextFunction} next
     */ function requireProjectRoleMw(req, res, next) {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const role = roles[req.params.id]?.[userId];
        if (!role) return res.status(404).json({ error: 'Not found' });
        if (ORDER[role] < ORDER[minRole]) return res.status(403).json({ error: 'Insufficient permissions' });
        req.projectRole = role;
        return next();
    };
}

/**
 * @param {import('express').Request} _req
 * @param {import('express').Response} _res
 * @param {NextFunction} next
 */
const passThrough = (_req, _res, next) => next();

/**
 * Wait until `fn()` holds.
 * @param {() => unknown} fn
 * @param {number} [ms]
 */
async function until(fn, ms = 5000) {
    const start = Date.now();
    while (!fn()) {
        if (Date.now() - start > ms) throw new Error('timed out waiting');
        await new Promise((r) => setTimeout(r, 5));
    }
}

const b64 = /** @param {string | Uint8Array} u */ (u) => Buffer.from(u).toString('base64');

module.exports = { collabWorld, fakeRoleGate, passThrough, until, simpleBundle, docText, typeInto, newBlock, ytextString, b64, quietLog };
