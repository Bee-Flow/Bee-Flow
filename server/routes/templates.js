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
const log = require('../telemetry/log');
const router = express.Router();
const { requireBetaFeature } = require('../core/entitlements/betaFeatures');
const multer = require('multer');

// Gate all template routes behind the templates beta feature
router.use(requireBetaFeature('templates'));
const crypto = require('crypto');
const mammoth = require('mammoth');
const templateStore = require('../stores/templateStore');
const storageStore = require('../stores/storageStore');
const kbStore = require('../stores/knowledgeBases');
const configStore = require('../stores/configStore');
const { getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.nl';
const { getServiceHeaders } = require('../core/serviceAuth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { contentDisposition, safeFileName } = require('../core/http/contentDisposition');
const { z, worded, bodyOf, choice, idList } = require('../core/http/schemaParts');
const { badRequest } = require('../core/http/errors');
const { usableKbIdsForRequest } = require('../support/kbAccess');

/**
 * The file behind a `local:` storage key, and only if it lies under
 * data/templates — the one place the upload above writes. The key comes
 * from the database, so a row edited to point elsewhere is refused rather
 * than read, streamed or overwritten.
 */
function localTemplateFile(storageKey) {
    const nodePath = require('path');
    const root = nodePath.resolve(__dirname, '..', 'data', 'templates');
    const file = nodePath.resolve(String(storageKey).slice('local:'.length));
    if (!file.startsWith(root + nodePath.sep)) throw badRequest('invalid_storage_key', 'Template file is outside template storage');
    return file;
}

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
    values: z.record(z.unknown(), { required_error: 'Values object required', invalid_type_error: VALUES_TEXT }),
}, 'Filling a template');

/**
 * Refuse a knowledge base the caller may not search — see the header.
 * Returns the list unchanged when every id is usable.
 */
async function authorizeKbIds(req, ids) {
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

function extractParameters(text) {
    const regex = /\{\{([^}]+)\}\}/g;
    const seen = new Set();
    const params = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const raw = match[1].trim();
        // Split on first colon: {{Name: description}}
        const colonIdx = raw.indexOf(':');
        let name, description;
        if (colonIdx > 0) {
            name = raw.slice(0, colonIdx).trim();
            description = raw.slice(colonIdx + 1).trim();
        } else {
            name = raw;
            description = '';
        }
        if (!seen.has(name)) {
            seen.add(name);
            params.push({ name, description });
        }
    }
    return params;
}

// ── Upload template ──────────────────────────────────────────────

router.post('/upload', requireAuth, upload.single('file'), validate({ body: UploadBody }), async (req, res) => {
    const knowledgeBaseIds = await authorizeKbIds(req, req.body.knowledgeBaseIds);
    try {
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
        let parameters = [];
        let extractedText = '';
        try {
            const result = await mammoth.extractRawText({ buffer });
            extractedText = result.value || '';
            parameters = extractParameters(extractedText);
        } catch (err) {
            log.warn(`[Templates] Failed to extract text from ${fileName}:`, err.message);
        }

        // Upload to RustFS
        let storageKey;
        const storageName = `template_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

        if (storageStore.isAvailable()) {
            storageKey = storageStore.buildKey(userId, 'templates', storageName);
            await storageStore.uploadFile(storageKey, buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            log.info(`[Templates] Uploaded template to RustFS: ${storageKey}`);
        } else {
            // Fallback: store on local disk
            const fs = require('fs');
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
    } catch (err) {
        log.error('[Templates] Upload failed:', err);
        res.status(500).json({ error: 'Failed to upload template' });
    }
});

// ── List templates ───────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const templates = await templateStore.getTemplates(userId);
        res.json({ templates });
    } catch (err) {
        log.error('[Templates] List failed:', err);
        res.status(500).json({ error: 'Failed to list templates' });
    }
});

// ── Get single template ──────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const template = await templateStore.getTemplate(req.params.id, userId);
        if (!template) return res.status(404).json({ error: 'Template not found' });
        res.json({ template });
    } catch (err) {
        log.error('[Templates] Get failed:', err);
        res.status(500).json({ error: 'Failed to get template' });
    }
});

// ── Update template ──────────────────────────────────────────────

router.put('/:id', requireAuth, validate({ body: UpdateBody }), async (req, res) => {
    await authorizeKbIds(req, req.body.knowledgeBaseIds);
    try {
        const userId = req.session.user.id;
        const { name, description, instructions, knowledgeBaseIds } = req.body;
        const updated = await templateStore.updateTemplate(req.params.id, userId, { name, description, instructions, knowledgeBaseIds });
        if (!updated) return res.status(404).json({ error: 'Template not found' });
        res.json({ success: true });
    } catch (err) {
        log.error('[Templates] Update failed:', err);
        res.status(500).json({ error: 'Failed to update template' });
    }
});

// ── Delete template ──────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const result = await templateStore.deleteTemplate(req.params.id, userId);
        if (!result) return res.status(404).json({ error: 'Template not found' });

        // Clean up storage
        try {
            if (result.storageKey && !result.storageKey.startsWith('local:')) {
                await storageStore.deleteFile(result.storageKey);
            } else if (result.storageKey?.startsWith('local:')) {
                const fs = require('fs');
                const localPath = localTemplateFile(result.storageKey);
                if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
            }
        } catch (cleanupErr) {
            log.warn('[Templates] Storage cleanup failed:', cleanupErr.message);
        }

        res.json({ success: true });
    } catch (err) {
        log.error('[Templates] Delete failed:', err);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

// ── Download original template ───────────────────────────────────

router.get('/:id/download', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const template = await templateStore.getTemplate(req.params.id, userId);
        if (!template) return res.status(404).json({ error: 'Template not found' });

        if (template.storageKey.startsWith('local:')) {
            const fs = require('fs');
            const localPath = localTemplateFile(template.storageKey);
            let localExists = true;
            try { await fs.promises.access(localPath); } catch { localExists = false; }
            if (!localExists) return res.status(404).json({ error: 'File not found' });
            res.setHeader('Content-Disposition', contentDisposition(template.fileName));
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            return fs.createReadStream(localPath).pipe(res);
        }

        const { stream, contentType } = await storageStore.streamFile(template.storageKey);
        res.setHeader('Content-Disposition', contentDisposition(template.fileName));
        res.setHeader('Content-Type', contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        stream.pipe(res);
    } catch (err) {
        log.error('[Templates] Download failed:', err);
        res.status(500).json({ error: 'Failed to download template' });
    }
});

// ── Fill template with values ────────────────────────────────────

/**
 * Load a template's .docx and render `values` into it. Shared by /fill and
 * /fill-and-store, which differ only in where the result goes.
 */
async function renderTemplate(template, values) {
    let templateBuffer;
    if (template.storageKey.startsWith('local:')) {
        const fs = require('fs');
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

router.post('/:id/fill', requireAuth, validate({ body: FillBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const template = await templateStore.getTemplate(req.params.id, userId);
        if (!template) return res.status(404).json({ error: 'Template not found' });

        // A .docx attachment, not HTML; the filename goes through contentDisposition.
        const { filledBuffer, filledName } = await renderTemplate(template, req.body.values); // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss
        res.setHeader('Content-Disposition', contentDisposition(filledName));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(filledBuffer);
    } catch (err) {
        log.error('[Templates] Fill failed:', err);
        res.status(500).json({ error: 'Failed to fill template' });
    }
});

// Fill template and store result — returns a download URL for use in chat
router.post('/:id/fill-and-store', requireAuth, validate({ body: FillBody }), async (req, res) => {
    try {
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
            const fs = require('fs');
            const path = require('path');
            const dir = path.join(__dirname, '..', 'data', 'templates_filled', userId);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            // safeFileName leaves no separator or leading dot to climb out of dir.
            // nosemgrep: javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
            const localPath = path.join(dir, `${Date.now()}_${safeFileName(filledName)}`);
            await fs.promises.writeFile(localPath, filledBuffer);
            res.json({ downloadUrl: `/api/templates/download-filled/${encodeURIComponent(path.basename(localPath))}`, fileName: filledName });
        }
    } catch (err) {
        log.error('[Templates] Fill-and-store failed:', err);
        res.status(500).json({ error: 'Failed to generate document' });
    }
});

// ── Download filled document (local fallback) ────────────────────
// Serves files stored locally when RustFS is not available.
router.get('/download-filled/:filename', requireAuth, (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const userId = req.session.user.id;
    const filename = req.params.filename;

    // Sanitize filename to prevent directory traversal
    const sanitized = path.basename(filename);
    const filePath = path.join(__dirname, '..', 'data', 'templates_filled', userId, sanitized);

    if (!fs.existsSync(filePath)) {
        log.error(`[Templates] Download-filled file not found: ${filePath}`);
        return res.status(404).json({ error: 'File not found' });
    }

    log.info(`[Templates] Serving filled document: ${filePath}`);
    res.setHeader('Content-Disposition', contentDisposition(sanitized));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    fs.createReadStream(filePath).pipe(res);
});

async function generateTemplateContext(templateId, userId, text, parameters) {
    log.info(`[Templates] Generating context + instructions for template ${templateId}...`);

    // Resolve writer tier model — MUST be configured
    const tiers = await configStore.getConfig('chat_model_tiers') || {};
    const writeTier = tiers['pro'] || {};
    const modelId = writeTier.modelId;
    if (!modelId) {
        throw new Error('Pro tier model not configured in chat_model_tiers');
    }

    const config = await getProviderForModel(modelId);
    const apiUrl = (config.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(config.providerType, apiUrl);

    // Truncate text to avoid huge payloads (first ~6000 chars is enough for context)
    const truncatedText = text.length > 6000 ? text.slice(0, 6000) + '\n\n[... document continues ...]' : text;

    const paramList = parameters.length > 0
        ? parameters.map(p => `- ${p.name}${p.description ? ': ' + p.description : ''}`).join('\n')
        : '(none detected)';

    const messages = [
        {
            role: 'system',
            content: `You are a document analysis assistant. Analyze the uploaded Word template and generate TWO sections:

SECTION 1 — DESCRIPTION:
A concise context summary (2-4 paragraphs) covering: document type, purpose, key sections, and what information is needed to fill the template parameters.

SECTION 2 — INSTRUCTIONS:
Specific instructions for an AI that will fill this template. These should cover:
- What language to use (detect from the document content)
- Tone and formality level
- Any formatting conventions to follow
- Domain-specific knowledge needed
- How to handle each parameter
- Any legal/compliance considerations if applicable

Write both sections in the same language as the document.

Separate the two sections with exactly this line on its own:
---INSTRUCTIONS---

First write the description, then the separator line, then the instructions. Do NOT use any other formatting, headers, or wrapping.`
        },
        {
            role: 'user',
            content: `Template document content:\n\n---\n${truncatedText}\n---\n\nDetected parameters:\n${paramList}\n\nGenerate the description and then the instructions.`
        }
    ];

    const response = await adapter.chat(config.apiKey, apiUrl, modelId, messages, {
        maxTokens: 1000,
        temperature: 0.3,
    });

    // Extract content from various adapter response shapes
    let raw = '';
    if (response?.choices?.[0]?.message?.content) {
        raw = response.choices[0].message.content;
    } else if (response?.content) {
        raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    } else if (typeof response === 'string') {
        raw = response;
    }
    raw = raw.trim();
    if (!raw) return;

    log.info(`[Templates] AI response (${raw.length} chars): ${raw.slice(0, 200)}...`);

    // Split on the separator
    const updates = {};
    if (raw.includes('---INSTRUCTIONS---')) {
        const parts = raw.split('---INSTRUCTIONS---');
        updates.description = parts[0].trim();
        updates.instructions = parts[1].trim();
    } else {
        // Fallback: use everything as description
        updates.description = raw;
    }

    if (Object.keys(updates).length > 0) {
        await templateStore.updateTemplate(templateId, userId, updates);
        log.info(`[Templates] Auto-generated context + instructions for ${templateId} (desc: ${(updates.description || '').length}c, instr: ${(updates.instructions || '').length}c)`);
    }
}

// ── Background: Auto-create KB from uploaded template ───────────────

async function autoCreateTemplateKB(templateId, userId, fileName, text) {
    log.info(`[Templates] Auto-creating KB for template ${templateId}...`);

    const template = await templateStore.getTemplate(templateId, userId);
    if (!template) return;

    // Create a KB named after the template
    const kbName = `📄 ${template.name || fileName.replace(/\.docx$/i, '')}`;
    const kb = await kbStore.createKB(userId, kbName, `Auto-generated knowledge base for template "${template.name}"`);

    // Link the KB to the template
    const existingIds = template.knowledgeBaseIds || [];
    const newIds = [...existingIds, kb.id];
    await templateStore.updateTemplate(templateId, userId, { knowledgeBaseIds: newIds });

    // Ingest the document text into the KB
    const hash = kbStore.hashContent(text);
    const doc = await kbStore.createDocument(
        userId, kb.id,
        fileName, 'upload', fileName, hash
    );

    try {
        const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
        const { resolveKbProvider } = require('../core/kb/resolveProvider');
        const kbProvider = await resolveKbProvider();
        const useLocalIngest = useAzure || kbProvider === 'local';

        if (useLocalIngest) {
            const { ingestLocally } = require('../core/kb/localKBIngest');
            const result = await ingestLocally(userId, kb.id, doc.id, text, {
                title: fileName,
                source_uri: fileName,
            });
            await kbStore.updateChunkCount(doc.id, result.chunks_created || 0);
            await kbStore.bumpKBVersion(kb.id);
            log.info(`[Templates] Auto-KB "${kbName}" created locally with ${result.chunks_created || 0} chunks (kb_provider=${kbProvider})`);
        } else {
            const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({
                    tenant_id: userId,
                    knowledge_base_id: kb.id,
                    document_id: doc.id,
                    content: text,
                    title: fileName,
                    source_uri: fileName,
                }),
                signal: AbortSignal.timeout(120000)
            });

            if (ingestRes.ok) {
                const result = await ingestRes.json();
                await kbStore.updateChunkCount(doc.id, result.chunks_created || 0);
                await kbStore.bumpKBVersion(kb.id);
                log.info(`[Templates] Auto-KB "${kbName}" created with ${result.chunks_created || 0} chunks`);
            } else {
                const err = await ingestRes.text();
                log.warn(`[Templates] Auto-KB ingestion failed: ${err}`);
                await kbStore.deleteDocument(doc.id);
            }
        }
    } catch (e) {
        log.warn(`[Templates] Auto-KB ingestion error: ${e.message}`);
        await kbStore.deleteDocument(doc.id);
    }
}

// ── Background: Auto-parameterize template document ─────────────

async function autoParameterizeTemplate(templateId, userId, extractedText, originalBuffer) {
    log.info(`[Templates] Auto-parameterizing template ${templateId}...`);

    // Resolve writer tier model
    const tiers = await configStore.getConfig('chat_model_tiers') || {};
    const writeTier = tiers['pro'] || {};
    const modelId = writeTier.modelId;
    if (!modelId) {
        throw new Error('pro tier model not configured in chat_model_tiers');
    }

    const config = await getProviderForModel(modelId);
    const apiUrl = (config.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(config.providerType, apiUrl);

    // Send the full text (up to ~12000 chars) for thorough analysis
    const textForAI = extractedText.length > 12000
        ? extractedText.slice(0, 12000) + '\n\n[... document continues ...]'
        : extractedText;

    const messages = [
        {
            role: 'system',
            content: `You are a document parameterization expert. Your job is to analyze a Word document and identify ALL placeholders, fill-in fields, blanks, and variable content that should be converted into template parameters.

For each placeholder you find, return a JSON array entry with:
- "original": the EXACT text as it appears in the document (must match precisely for find-and-replace)
- "param_name": a lowercase_underscore parameter name
- "description": a clear description of what should be filled in (in the same language as the document)

Rules:
- Parameter names: lowercase, underscores, no spaces, descriptive
- Descriptions: clear and helpful, in the document's language
- Look for: [Invulveld], [Invullen: ...], <placeholder>, choice sections like "optie A / optie B", empty lines meant to be filled, version/date fields, company names, addresses, etc.
- Do NOT parameterize fixed legal text, article numbers, or boilerplate that should stay unchanged
- Be thorough — find EVERY fill-in field

Respond with ONLY a valid JSON array, no other text:
[
  {"original": "[exact text from document]", "param_name": "parameter_name", "description": "What goes here"},
  ...
]`
        },
        {
            role: 'user',
            content: `Analyze this document and find all placeholders to parameterize:\n\n---\n${textForAI}\n---`
        }
    ];

    const response = await adapter.chat(config.apiKey, apiUrl, modelId, messages, {
        maxTokens: 4000,
        temperature: 0.1,
    });

    // Extract response content
    let raw = '';
    if (response?.choices?.[0]?.message?.content) {
        raw = response.choices[0].message.content;
    } else if (response?.content) {
        raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    } else if (typeof response === 'string') {
        raw = response;
    }
    raw = raw.trim();
    if (!raw) throw new Error('Empty AI response');

    log.info(`[Templates] Parameterize AI response (${raw.length} chars)`);

    // Parse the JSON array
    let replacements;
    try {
        // Handle potential markdown fences
        const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
        replacements = JSON.parse(cleaned);
    } catch (e) {
        log.error(`[Templates] Failed to parse parameterization JSON: ${e.message}`);
        log.error(`[Templates] Raw response: ${raw.slice(0, 500)}`);
        throw new Error('AI returned invalid JSON for parameterization');
    }

    if (!Array.isArray(replacements) || replacements.length === 0) {
        log.info(`[Templates] No replacements found for template ${templateId}`);
        return;
    }

    log.info(`[Templates] AI identified ${replacements.length} parameters to insert`);

    // ── Replace in .docx XML ─────────────────────────────────────
    const PizZip = require('pizzip');
    const zip = new PizZip(originalBuffer);

    const xmlFiles = Object.keys(zip.files).filter(f =>
        (f.endsWith('.xml') || f.endsWith('.xml.rels')) && !zip.files[f].dir
    );

    let totalReplacements = 0;

    for (const xmlFile of xmlFiles) {
        let content = zip.file(xmlFile).asText();
        let modified = false;

        for (const r of replacements) {
            if (!r.original || !r.param_name) continue;

            const paramTag = r.description
                ? `{{${r.param_name}: ${r.description}}}`
                : `{{${r.param_name}}}`;

            // Strategy 1: Direct text replacement (works when text isn't split across runs)
            if (content.includes(r.original)) {
                content = content.split(r.original).join(paramTag);
                modified = true;
                totalReplacements++;
                continue;
            }

            // Strategy 2: Handle Word's run-splitting by searching within <w:p> paragraphs
            // Word often splits text like "[Invullen: naam]" across multiple <w:r><w:t> elements
            const paragraphRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
            let match;
            const newContent = [];
            let lastIndex = 0;

            while ((match = paragraphRegex.exec(content)) !== null) {
                const paragraph = match[0];
                const paraStart = match.index;

                // Extract all text from <w:t> tags in this paragraph
                const textParts = [];
                const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
                let tMatch;
                while ((tMatch = tRegex.exec(paragraph)) !== null) {
                    textParts.push({
                        text: tMatch[1],
                        fullMatch: tMatch[0],
                        index: tMatch.index
                    });
                }

                const fullText = textParts.map(t => t.text).join('');

                if (fullText.includes(r.original)) {
                    // Found it! Rebuild the paragraph with the replacement
                    // Find which text parts contain the original and replace across them
                    let rebuiltParagraph = paragraph;

                    // Simple approach: find the original in concatenated text,
                    // replace in the first <w:t> that starts the match,
                    // empty subsequent <w:t>'s that were part of the match
                    const origIdx = fullText.indexOf(r.original);
                    if (origIdx >= 0) {
                        let charCount = 0;
                        let startPartIdx = -1;
                        let endPartIdx = -1;
                        let startOffset = 0;

                        for (let i = 0; i < textParts.length; i++) {
                            const partEnd = charCount + textParts[i].text.length;

                            if (startPartIdx === -1 && origIdx < partEnd) {
                                startPartIdx = i;
                                startOffset = origIdx - charCount;
                            }
                            if (startPartIdx !== -1 && origIdx + r.original.length <= partEnd) {
                                endPartIdx = i;
                                break;
                            }
                            charCount += textParts[i].text.length;
                        }

                        if (startPartIdx >= 0 && endPartIdx >= 0) {
                            // Calculate end offset within the last part
                            let endCharCount = 0;
                            for (let i = 0; i < endPartIdx; i++) endCharCount += textParts[i].text.length;
                            const endOffset = origIdx + r.original.length - endCharCount;

                            // Build replacement for each text part
                            for (let i = startPartIdx; i <= endPartIdx; i++) {
                                const part = textParts[i];
                                let newText;

                                if (i === startPartIdx && i === endPartIdx) {
                                    // Single part contains whole match
                                    newText = part.text.slice(0, startOffset) + paramTag + part.text.slice(startOffset + r.original.length);
                                } else if (i === startPartIdx) {
                                    // First part of multi-part match
                                    newText = part.text.slice(0, startOffset) + paramTag;
                                } else if (i === endPartIdx) {
                                    // Last part of multi-part match
                                    newText = part.text.slice(endOffset);
                                } else {
                                    // Middle part — clear it
                                    newText = '';
                                }

                                const oldTag = part.fullMatch;
                                const preserveSpace = oldTag.includes('xml:space="preserve"') ? ' xml:space="preserve"' : '';
                                const newTag = `<w:t${preserveSpace}>${newText}</w:t>`;
                                rebuiltParagraph = rebuiltParagraph.split(oldTag).join(newTag);
                            }

                            newContent.push(content.slice(lastIndex, paraStart));
                            newContent.push(rebuiltParagraph);
                            lastIndex = paraStart + paragraph.length;
                            totalReplacements++;
                            modified = true;
                        }
                    }
                }
            }

            if (modified && newContent.length > 0) {
                newContent.push(content.slice(lastIndex));
                content = newContent.join('');
            }
        }

        if (modified) {
            zip.file(xmlFile, content);
        }
    }

    log.info(`[Templates] Made ${totalReplacements} replacements in .docx XML`);

    if (totalReplacements === 0) {
        log.info(`[Templates] No XML replacements made (text may not match exactly)`);
        // Still update the template with AI-identified parameters so they're visible
        const newParams = replacements
            .filter(r => r.param_name)
            .map(r => ({ name: r.param_name, description: r.description || '' }));
        if (newParams.length > 0) {
            await templateStore.updateTemplate(templateId, userId, { parameters: newParams });
        }
        return;
    }

    // Generate modified buffer
    const modifiedBuffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

    // Re-upload the modified file
    const template = await templateStore.getTemplate(templateId, userId);
    if (!template) return;

    if (template.storageKey && !template.storageKey.startsWith('local:')) {
        // Re-upload to same RustFS key
        await storageStore.uploadFile(template.storageKey, modifiedBuffer,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        log.info(`[Templates] Re-uploaded parameterized .docx to ${template.storageKey}`);
    } else if (template.storageKey?.startsWith('local:')) {
        const fs = require('fs');
        await fs.promises.writeFile(localTemplateFile(template.storageKey), modifiedBuffer);
        log.info(`[Templates] Updated local parameterized .docx`);
    }

    // Re-extract parameters from the modified text
    const newResult = await mammoth.extractRawText({ buffer: modifiedBuffer });
    const newText = newResult.value || '';
    const newParams = extractParameters(newText);

    await templateStore.updateTemplate(templateId, userId, { parameters: newParams });
    log.info(`[Templates] Template ${templateId} now has ${newParams.length} parameters after auto-parameterization`);
}

module.exports = router;
