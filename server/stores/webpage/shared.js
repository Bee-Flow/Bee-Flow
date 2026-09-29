// @typecheck
// Shared webpage-store internals: the slot vocabulary + content types, the
// RustFS key builder, and the `webpages` row mapper every aggregate reads
// through. Leaf module — requires nothing else from webpage/.

const crypto = require('crypto');
const storageStore = require('../storageStore');
const { parseJSONObject: parseJSON } = require('../lib/json');

const SLOTS = ['html', 'css', 'js'];
// Versioned slots include the SQLite database — `data.db` is snapshotted
// alongside the text files but isn't part of the text-write code paths.
const VERSIONED_SLOTS = [...SLOTS, 'db'];
const CONTENT_TYPES = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    db: 'application/vnd.sqlite3',
};

// ── RustFS helpers ─────────────────────────────────────────────────

function sha256(s) {
    return crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');
}

function keyFor(userId, webpageId, slot, versionId = null) {
    return storageStore.buildWebpageKey(userId, webpageId, slot, versionId);
}

// ── Row Mappers ─────────────────────────────────────────────────────


function mapWebpageRow(r) {
    return {
        id: r.id,
        userId: r.user_id,
        name: r.name,
        description: r.description || '',
        instructions: r.instructions || '',
        knowledgeBaseIds: parseJSON(r.knowledge_base_ids, []),
        settings: parseJSON(r.settings, {}),
        htmlSha: r.html_sha256 || '',
        cssSha: r.css_sha256 || '',
        jsSha: r.js_sha256 || '',
        dbSha: r.db_sha256 || '',
        htmlSize: parseInt(r.html_size) || 0,
        cssSize: parseInt(r.css_size) || 0,
        jsSize: parseInt(r.js_size) || 0,
        dbSize: parseInt(r.db_size) || 0,
        isPublished: r.is_published === true || r.is_published === 't',
        // W2 publish lifecycle: WHICH snapshot the audience reads. NULL means
        // nothing is pinned — see webpage/access.resolveReadVersion, which is
        // the ONE place that turns this into a read decision.
        publishedVersionId: r.published_version_id || null,
        sharedGroups: parseJSON(r.shared_groups, []),
        organizationId: r.organization_id || null,
        projectId: r.project_id || null,
        // W3 stap 4 — het adres. `slug` is /w/<slug>; `publicShareId` zegt
        // WELKE share dat adres bedient ("één share is het adres"). Allebei
        // null tot de pagina openbaar wordt gezet, en null blijft null: een
        // lege string zou "adres bestaat, maar is leeg" beweren.
        slug: r.slug || null,
        publicShareId: r.public_share_id || null,
        icon: r.icon || '',
        accentColor: r.accent_color || '',
        tagline: r.tagline || '',
        thumbnailSha: r.thumbnail_sha256 || '',
        thumbnailSize: parseInt(r.thumbnail_size) || 0,
        sourceCount: parseInt(r.source_count) || 0,
        // Live public share links (webpageVisibility.isPubliclyShared reads it).
        // NULL/absent stays NULL, never 0: a query that did not ask for the
        // count must report "unknown", because "0 shares" is a claim about
        // reach that a header would paint as "Personal".
        publicShareCount: (r.public_share_count === undefined || r.public_share_count === null)
            ? null
            : (parseInt(r.public_share_count) || 0),
        // Spiegel van DEFAULT_BRIDGE_GRANTS (webpage/bridgeGrants.js), hier als
        // literal omdat shared.js een leaf-module is: importeren zou een cyclus
        // maken (bridgeGrants.js leest parseJSON hiervandaan). Dit is puur de
        // TERUGVAL voor een rij zonder kolom — het gezaghebbende versmallen
        // gebeurt in normalizeBridgeGrants, waar elke lees- en schrijfbeurt
        // langsgaat. Groeit die vorm, dan groeit deze regel mee.
        bridgeGrants: parseJSON(r.bridge_grants, {
            ai: { enabled: true, groundOnPage: true },
            automations: [], integrations: [], tables: [], agent: null,
        }),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

module.exports = {
    SLOTS,
    VERSIONED_SLOTS,
    CONTENT_TYPES,
    sha256,
    keyFor,
    parseJSON,
    mapWebpageRow,
};
