'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { buildEnvelope, openEnvelope, isEnvelope } = require('./fieldEnvelope');
const { HttpError } = require('../../shared/httpErrors');

const sessions = new AsyncLocalStorage();
function withDocumentEncryptionSession(req, _res, next) { sessions.run(req, next); }

const keySources = {
    policy: async (orgId) => {
        if (!orgId) return { enabled: false, tier: 'none' };
        const db = require('../../db');
        const schema = await db.getOne("SELECT to_regclass('public.organizations') AS present");
        if (!schema?.present) return { enabled: false, tier: 'none' };
        const row = await db.getOne('SELECT to_jsonb(o) AS policy FROM organizations o WHERE id = $1', [orgId]);
        return require('../encryptionPolicy').policyFromRow(row?.policy);
    },
    userKey: (userId, orgId) => require('../../auth/orgEscrow').getOrCreateUserDek(userId, orgId),
    orgKey: (orgId) => require('../../auth/transcriptEscrow').getTranscriptDek(orgId),
};

function metadata(resource) {
    return { type: resource.type, id: resource.id, userId: resource.userId, orgId: resource.organizationId || null,
        shared: resource.cryptoContext?.scope === 'organisation' || !!resource.projectId || resource.visibility === 'team' || ['organisation', 'restricted'].includes(resource.sharingAudience) };
}

async function writeContext(resource, forceShared) {
    const meta = metadata(resource);
    const policy = await keySources.policy(meta.orgId);
    if (!policy.enabled) return resource.cryptoContext ? { ...resource.cryptoContext, scope: (forceShared ?? meta.shared) ? 'organisation' : 'user' } : null;
    return { scope: (forceShared ?? meta.shared) ? 'organisation' : 'user', tier: policy.tier,
        orgId: meta.orgId, userId: meta.userId };
}

async function keyFor(context, type, id) {
    let root;
    try {
        if (context.scope === 'organisation') root = await keySources.orgKey(context.orgId);
        else if (context.tier === 'managed') root = await keySources.userKey(context.userId, context.orgId);
        else {
            const session = sessions.getStore()?.session;
            if (session?.user?.id === context.userId && session.encryptionKey) root = Buffer.from(session.encryptionKey, 'base64');
        }
        if (!Buffer.isBuffer(root) || root.length !== 32) throw new Error('Missing key');
        return Buffer.from(crypto.hkdfSync('sha256', root, Buffer.from('beeflow:document:v1'),
            JSON.stringify([context.scope, context.orgId || '', context.userId || '', type, id]), 32));
    } catch (e) {
        // The user sees "not unlocked"; the log says why (a broken org escrow key looks the same to them).
        require('../../telemetry/log').warn(`[DocumentCrypto] no ${context.scope}/${context.tier} key for org ${context.orgId || '-'}: ${e.message}`);
        throw new HttpError(423, 'document_encryption_key_unavailable', 'Your encryption key is not loaded in this session. Sign in again (or enter your encryption PIN) to unlock it, then try again.');
    }
}

function aad(type, id, field, context) {
    return JSON.stringify(['bfdoc:v1', type, id, field, context.scope, context.tier, context.orgId, context.userId]);
}

function envelopeOf(value) {
    if (!isEnvelope(value)) return null;
    return typeof value === 'string' ? JSON.parse(value) : value;
}

async function open(value, type, id, field, json = false, resolvedKey = null) {
    const envelope = envelopeOf(value);
    if (!envelope) return value;
    if (!envelope.documentContext) throw new HttpError(423, 'document_encryption_invalid', 'This document has an unsupported encryption envelope.');
    const context = envelope.documentContext;
    try {
        const key = resolvedKey || await keyFor(context, type, id);
        const plain = openEnvelope(envelope, key, aad(type, id, field, context));
        return json ? JSON.parse(plain) : plain;
    } catch (e) {
        if (e.status) throw e;
        throw new HttpError(423, 'document_decryption_failed', 'The encrypted document could not be opened.');
    }
}

async function seal(value, resource, field, { json = false, context, key: resolvedKey = null } = {}) {
    if (value === undefined || value === null) return value;
    const ctx = context === undefined ? await writeContext(resource) : context;
    // Existing encrypted data never becomes plaintext just because the policy was disabled.
    if (!ctx) return value;
    const plain = await open(value, resource.type, resource.id, field, json);
    const key = resolvedKey || await keyFor(ctx, resource.type, resource.id);
    const envelope = { ...buildEnvelope(json ? JSON.stringify(plain) : String(plain), key,
        aad(resource.type, resource.id, field, ctx)), documentContext: ctx,
        documentResource: { type: resource.type, id: resource.id, field, json } };
    return json ? envelope : JSON.stringify(envelope);
}

function resourceOf(row, type = 'document') {
    return { type, id: row.id, userId: row.user_id, organizationId: row.organization_id,
        projectId: row.project_id, visibility: row.visibility, sharingAudience: row.sharing_audience,
        cryptoContext: row._contentCryptoContext || Object.values(row).map(envelopeOf).find((value) => value?.documentContext)?.documentContext };
}

function resourceOfDocument(doc) {
    return { ...doc, type: 'document', sharingAudience: doc.sharing?.audience };
}

// Read only field envelopes; SQL filtering, counts and permission metadata stay in SQL.
async function openRow(row) {
    if (!row) return row;
    const out = { ...row };
    for (const [field, value] of Object.entries(row)) {
        const envelope = envelopeOf(value);
        if (!envelope?.documentResource) continue;
        const resource = envelope.documentResource;
        if (resource.field !== field || (row.id && row.id !== resource.id)) {
            throw new HttpError(423, 'document_encryption_invalid', 'The encrypted content does not belong to this document.');
        }
        out[field] = await open(value, resource.type, resource.id, field, resource.json);
        out._contentCryptoContext = envelope.documentContext;
    }
    return out;
}

function readingClient(client) {
    return { ...client, query: async (...args) => {
        const result = await client.query(...args);
        return { ...result, rows: await Promise.all((result.rows || []).map(openRow)) };
    } };
}

function readingDb(db) {
    return { ...db,
        getOne: async (...args) => openRow(await db.getOne(...args)),
        getAll: async (...args) => Promise.all((await db.getAll(...args)).map(openRow)),
        withTransaction: (fn) => db.withTransaction((client) => fn(readingClient(client))),
    };
}

const DOCUMENT_FIELDS = { body_html: false, css: false, settings: true };
const NOTEBOOK_FIELDS = { document_content: false, document_md: false, instructions: false, settings: true, preview: false };
async function openFields(row, type, fields) {
    if (!row) return row;
    const out = { ...row };
    for (const [field, json] of Object.entries(fields)) if (out[field] !== undefined) out[field] = await open(out[field], type, row.id, field, json);
    return out;
}
async function sealFields(row, resource, fields, context) {
    const out = { ...row };
    const ctx = context === undefined ? await writeContext(resource) : context;
    const key = ctx ? await keyFor(ctx, resource.type, resource.id) : null;
    for (const [field, json] of Object.entries(fields)) if (out[field] !== undefined) out[field] = await seal(out[field], resource, field, { json, context: ctx, key });
    return out;
}

module.exports = { keySources, sessions, withDocumentEncryptionSession, writeContext, resourceOf,
    resourceOfDocument, readingDb, readingClient, keyFor, openRow, open, seal, openFields, sealFields, DOCUMENT_FIELDS, NOTEBOOK_FIELDS, envelopeOf };
