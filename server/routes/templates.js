// @typecheck
/**
 * Template Routes — CRUD + file upload/download for Word templates.
 *
 * Upload .docx files, extract {{parameter}} placeholders, store in RustFS,
 * and fill templates using docxtemplater.
 *
 * ── What a caller may send ───────────────────────────────────────────
 * Every body is closed (validate() + schemaParts), so a misspelled key is a
 * 400 naming it instead of a 200 that changed nothing. `knowledgeBaseIds` is
 * a READ GRANT: template chat searches whatever the template lists, and the
 * ingest layer does no tenant filtering of its own. It is checked here with
 * the retrieval rule (`usableKbIdsForRequest`), the same one a direct-chat
 * conversation's list gets — an id the caller may not use is a 400 naming it.
 */

const express = require('express');
const fs = require('fs');
const { sendStream } = require('../core/http/sendStream');
const log = require('../telemetry/log');
const { localTemplateFile, extractParameters, generateTemplateContext, autoCreateTemplateKB, autoParameterizeTemplate } = require('./templateAi');
const router = express.Router();
const { requireBetaFeature } = require('../core/entitlements/betaFeatures');
const multer = require('multer');

// Gate all template routes behind the templates beta feature
router.use(requireBetaFeature('templates'));
const crypto = require('crypto');
const mammoth = require('mammoth');
const templateStore = require('../stores/templateStore');
const storageStore = require('../stores/storageStore');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { contentDisposition, safeFileName } = require('../core/http/contentDisposition');
const { z, worded, bodyOf, choice, idList, typeError } = require('../core/http/schemaParts');
const { badRequest } = require('../core/http/errors');
const { usableKbIdsForRequest } = require('../support/kbAccess');

const MAX_NAME = 200;
const MAX_DESCRIPTION = 5000;
const MAX_INSTRUCTIONS = 50_000;
const MAX_KB_IDS = 50;

const NAME_TEXT = `A template's name is text of 1 to ${MAX_NAME} characters.`;
const DESCRIPTION_TEXT = `description is text of at most ${MAX_DESCRIPTION} characters.`;
const INSTRUCTIONS_TEXT = `instructions is text of at most ${MAX_INSTRUCTIONS} characters.`;
const KB_IDS_TEXT = `knowledgeBaseIds is a list of at most ${MAX_KB_IDS} knowledge base ids.`;

const templateName = worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(MAX_NAME, NAME_TEXT);
const description = worded(DESCRIPTION_TEXT).max(MAX_DESCRIPTION, DESCRIPTION_TEXT);
const instructions = worded(INSTRUCTIONS_TEXT).max(MAX_INSTRUCTIONS, INSTRUCTIONS_TEXT);
const kbIds = idList(KB_IDS_TEXT, MAX_KB_IDS);

// Multipart: every field arrives as text, and a repeated field as a list.
// A blank name keeps meaning "use the file name", as it always did.
const UploadBody = bodyOf({
    name: worded(NAME_TEXT).trim().max(MAX_NAME, NAME_TEXT).optional(),
    description: description.optional(),
    instructions: instructions.optional(),
    knowledgeBaseIds: z.preprocess((v) => (typeof v === 'string' ? [v] : v), kbIds).optional(),
    skipAutoParameterize: choice(['true', 'false'], 'skipAutoParameterize is "true" or "false".').optional(),
}, 'Uploading a template');

// An empty update used to reach the store, build no SQL and answer 404
// "Template not found" for a template that exists.
const UpdateBody = bodyOf({
    name: templateName.optional(),
    description: description.optional(),
    instructions: instructions.optional(),
    knowledgeBaseIds: kbIds.optional(),
}, 'Updating a template').refine((b) => Object.keys(b).length > 0, {
    message: 'Send at least one of name, description, instructions or knowledgeBaseIds.',
});

// docxtemplater renders an object of placeholder values; a list or a string
// used to reach the renderer and come back as a 500.
const VALUES_TEXT = 'values is an object of placeholder values, like {"Name": "Ada"}.';
const FillBody = bodyOf({
    values: z.record(z.string(), z.unknown(), { error: typeError({ required: 'Values object required', invalid: VALUES_TEXT }) }),
}, 'Filling a template');

/**
 * Refuse a knowledge base the caller may not search — see the header.
 * Returns the list unchanged when every id is usable.
 * @param {string[]} ids
 */
async function authorizeKbIds(/** @type {import('express').Request} */ req, ids) {
    if (!ids || ids.length === 0) return ids;
    const usable = await usableKbIdsForRequest(req, ids);
    const invalid = ids.filter((id) => !usable.includes(id));
    if (invalid.length > 0) {
        throw badRequest('invalid_knowledge_bases', 'One or more knowledge bases are not available to you.', invalid.map((id) => ({ path: 'body.knowledgeBaseIds', message: id })));
    }
    return ids;
}

// ── Extract {{parameters}} from text ─────────────────────────────
// Supports both {{Name}} and {{Name: description}} syntax.
// Returns array of { name, description } objects.

// ── Upload template ──────────────────────────────────────────────

router.post('/upload', requireAuth, upload.single('file'), validate({ body: UploadBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof UploadBody>, import('qs').ParsedQs>} */ req, res) => {
    const knowledgeBaseIds = await authorizeKbIds(req, req.body.knowledgeBaseIds);
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileName = req.file.originalname;
    if (!fileName.toLowerCase().endsWith('.docx')) {
        return res.status(400).json({ error: 'Only .docx files are supported' });
    }

    const userId = req.session.user.id;
    const buffer = req.file.buffer;

    // Extract text to detect parameters
    /** @type {{ name: string; description: string; }[]} */
    let parameters = [];
    let extractedText = '';
    try {
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value || '';
        parameters = extractParameters(extractedText);
    } catch (err) {
        log.warn(`[Templates] Failed to extract text from ${log.nameForLog(fileName)}:`, /** @type {Error} */ (err).message);
    }

    // Upload to RustFS
    /** @type {string} */
    let storageKey;
    const storageName = `template_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

    if (storageStore.isAvailable()) {
        storageKey = storageStore.buildKey(userId, 'templates', storageName);
        await storageStore.uploadFile(storageKey, buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        log.info(`[Templates] Uploaded template to RustFS: ${storageKey}`);
    } else {
        // Fallback: store on local disk
        const path = require('path');
        const dir = path.join(__dirname, '..', 'data', 'templates', userId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const localPath = path.join(dir, storageName);
        await fs.promises.writeFile(localPath, buffer);
        storageKey = `local:${localPath}`;
        log.info(`[Templates] Stored template locally: ${localPath}`);
    }

    // Save metadata to DB
    const name = req.body.name || fileName.replace(/\.docx$/i, '');
    const template = await templateStore.createTemplate({
        userId,
        name,
        description: req.body.description || '',
        instructions: req.body.instructions || '',
        fileName,
        storageKey,
        parameters,
        knowledgeBaseIds: knowledgeBaseIds || [],
    });

    // ── Background tasks: auto-generate context + auto-create KB + auto-parameterize ──
    const hasContent = extractedText && extractedText.length > 50;
    const skipAutoParam = req.body.skipAutoParameterize === 'true';
    if (hasContent) {
        // 1. Generate AI context/description + instructions from the document
        generateTemplateContext(template.id, userId, extractedText, parameters).catch(err => {
            log.warn('[Templates] Auto-context generation failed:', err.message);
        });
        // 2. Auto-create a KB and ingest document text
        autoCreateTemplateKB(template.id, userId, fileName, extractedText).catch(err => {
            log.warn('[Templates] Auto-KB creation failed:', err.message);
        });
        // 3. Auto-parameterize: AI identifies placeholders and replaces them in the .docx
        if (!skipAutoParam) {
            autoParameterizeTemplate(template.id, userId, extractedText, buffer).catch(err => {
                log.warn('[Templates] Auto-parameterization failed:', err.message);
            });
        } else {
            log.info(`[Templates] Skipping auto-parameterization (user chose skip)`);
        }
    }

    res.json({ success: true, template, generatingContext: !!hasContent });
});

// ── List templates ───────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const templates = await templateStore.getTemplates(userId);
    res.json({ templates });
});

// ── Get single template ──────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const template = await templateStore.getTemplate(req.params.id, userId);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
});

// ── Update template ──────────────────────────────────────────────

router.put('/:id', requireAuth, validate({ body: UpdateBody }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof UpdateBody>, import('qs').ParsedQs>} */ req, res) => {
    await authorizeKbIds(req, req.body.knowledgeBaseIds);
    const userId = req.session.user.id;
    const { name, description, instructions, knowledgeBaseIds } = req.body;
    const updated = await templateStore.updateTemplate(req.params.id, userId, { name, description, instructions, knowledgeBaseIds });
    if (!updated) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
});

// ── Delete template ──────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const result = await templateStore.deleteTemplate(req.params.id, userId);
    if (!result) return res.status(404).json({ error: 'Template not found' });

    // Clean up storage
    try {
        if (result.storageKey && !result.storageKey.startsWith('local:')) {
            await storageStore.deleteFile(result.storageKey);
        } else if (result.storageKey?.startsWith('local:')) {
            const localPath = localTemplateFile(result.storageKey);
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        }
    } catch (cleanupErr) {
        log.warn('[Templates] Storage cleanup failed:', /** @type {Error} */ (cleanupErr).message);
    }

    res.json({ success: true });
});

// ── Download original template ───────────────────────────────────

router.get('/:id/download', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const template = await templateStore.getTemplate(req.params.id, userId);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    if (template.storageKey.startsWith('local:')) {
        const localPath = localTemplateFile(template.storageKey);
        let localExists = true;
        try { await fs.promises.access(localPath); } catch { localExists = false; }
        if (!localExists) return res.status(404).json({ error: 'File not found' });
        res.setHeader('Content-Disposition', contentDisposition(template.fileName));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        return sendStream(fs.createReadStream(localPath), res);
    }

    const { stream, contentType } = await storageStore.streamFile(template.storageKey);
    res.setHeader('Content-Disposition', contentDisposition(template.fileName));
    res.setHeader('Content-Type', contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    sendStream(stream, res);
});

// ── Fill template with values ────────────────────────────────────

/**
 * Load a template's .docx and render `values` into it. Shared by /fill and
 * /fill-and-store, which differ only in where the result goes.
 */
async function renderTemplate(template, values) {
    /** @type {Buffer<ArrayBuffer> | NonSharedBuffer} */
    let templateBuffer;
    if (template.storageKey.startsWith('local:')) {
        // localTemplateFile refuses any path outside data/templates.
        templateBuffer = await fs.promises.readFile(localTemplateFile(template.storageKey)); // nosemgrep: ajinabraham.njsscan.traversal.path_traversal.generic_path_traversal
    } else {
        const { stream } = await storageStore.streamFile(template.storageKey);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        templateBuffer = Buffer.concat(chunks);
    }

    // Fill using docxtemplater
    const Docxtemplater = require('docxtemplater');
    const PizZip = require('pizzip');
    const zip = new PizZip(templateBuffer);

    // Pre-process: replace {{Name: description}} with {{Name}} in all XML parts
    // so docxtemplater can match tags against the values dict (which uses only names)
    const xmlFiles = Object.keys(zip.files).filter(f => f.endsWith('.xml') || f.endsWith('.xml.rels'));
    for (const xmlFile of xmlFiles) {
        const file = zip.files[xmlFile];
        if (file && !file.dir) {
            const content = zip.file(xmlFile).asText().replace(/\{\{([^}:]+):[^}]*\}\}/g, '{{$1}}');
            zip.file(xmlFile, content);
        }
    }

    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        delimiters: { start: '{{', end: '}}' },
    });
    doc.render(values);

    return {
        filledBuffer: doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
        filledName: template.fileName.replace(/\.docx$/i, '_filled.docx'),
    };
}

router.post('/:id/fill', requireAuth, validate({ body: FillBody }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof FillBody>, import('qs').ParsedQs>} */ req, res) => {
    const userId = req.session.user.id;
    const template = await templateStore.getTemplate(req.params.id, userId);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    // A .docx attachment, not HTML; the filename goes through contentDisposition.
    const { filledBuffer, filledName } = await renderTemplate(template, req.body.values); // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss
    res.setHeader('Content-Disposition', contentDisposition(filledName));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(filledBuffer);
});

// Fill template and store result — returns a download URL for use in chat
router.post('/:id/fill-and-store', requireAuth, validate({ body: FillBody }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof FillBody>, import('qs').ParsedQs>} */ req, res) => {
    const userId = req.session.user.id;
    const template = await templateStore.getTemplate(req.params.id, userId);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const { filledBuffer, filledName } = await renderTemplate(template, req.body.values);
    const crypto = require('crypto');

    // Store in RustFS and return download URL
    if (storageStore.isAvailable()) {
        const storageName = `filled_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeFileName(filledName)}`;
        const key = storageStore.buildKey(userId, 'templates_filled', storageName);
        await storageStore.uploadFile(key, filledBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        const proxyPath = storageStore.buildProxyUrl(key);
        log.info(`[Templates] Filled document stored: ${key}`);
        res.json({ downloadUrl: proxyPath, fileName: filledName });
    } else {
        // Fallback: store locally
        const path = require('path');
        const dir = path.join(__dirname, '..', 'data', 'templates_filled', userId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // safeFileName leaves no separator or leading dot to climb out of dir.
        // nosemgrep: javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
        const localPath = path.join(dir, `${Date.now()}_${safeFileName(filledName)}`);
        await fs.promises.writeFile(localPath, filledBuffer);
        res.json({ downloadUrl: `/api/templates/download-filled/${encodeURIComponent(path.basename(localPath))}`, fileName: filledName });
    }
});

// ── Download filled document (local fallback) ────────────────────
// Serves files stored locally when RustFS is not available.
router.get('/download-filled/:filename', requireAuth, (req, res) => {
    const path = require('path');
    const userId = req.session.user.id; // nosemgrep: ajinabraham.njsscan.traversal.resolve_path_traversal.join_resolve_path_traversal -- filename reduced to its basename, userId from the session
    const filename = req.params.filename;

    // Sanitize filename to prevent directory traversal
    const sanitized = path.basename(filename);
    const filePath = path.join(__dirname, '..', 'data', 'templates_filled', userId, sanitized); // nosemgrep: javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal -- filename reduced to its basename above, userId from the session

    if (!fs.existsSync(filePath)) {
        log.error(`[Templates] Download-filled file not found: ${log.nameForLog(sanitized)}`);
        return res.status(404).json({ error: 'File not found' });
    }

    log.info(`[Templates] Serving filled document: ${log.nameForLog(sanitized)}`);
    res.setHeader('Content-Disposition', contentDisposition(sanitized));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    sendStream(fs.createReadStream(filePath), res);
});

// ── Background: Auto-create KB from uploaded template ───────────────

// ── Background: Auto-parameterize template document ─────────────

module.exports = Object.assign(router, { _test_autoCreateTemplateKB: autoCreateTemplateKB });
