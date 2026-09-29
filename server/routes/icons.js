/**
 * Icon Routes — Appearance / icon-pack management.
 *
 *   GET    /api/icons                       — list user's packs + catalog + active id
 *   GET    /api/icons/catalog               — icon categories shared with frontend
 *   POST   /api/icons                       — create pack
 *   PUT    /api/icons/:id                   — update pack (name / icons)
 *   PATCH  /api/icons/:id/icons/:key        — set or clear a single icon override
 *   DELETE /api/icons/:id                   — delete pack
 *   POST   /api/icons/:id/activate          — set active pack for this user (id="default" clears)
 *
 *   POST   /api/icons/upload                — direct file upload (multipart)
 *   POST   /api/icons/generate              — AI-generate a single icon (returns saved url)
 *   POST   /api/icons/:id/bulk-generate     — AI-generate every missing icon in a pack
 *
 *   GET    /api/icons/:id/export            — download pack JSON
 *   POST   /api/icons/import                — import pack JSON (new pack)
 *
 *   GET    /api/icons/data/:filename        — static serve generated/uploaded icon
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * One `.strict()` zod schema per JSON body, so a key this API does not know
 * is refused by name. /upload is multipart and keeps no body schema:
 * uploadGuard reads the stream, checks the file's bytes, and there are no
 * text fields to type. What the schemas closed:
 *
 *   - bulk-generate read `overwrite` as truthy, so `{ "overwrite": "false" }`
 *     regenerated EVERY icon in the pack, replacing the person's own ones and
 *     running ~90 image generations on the install's Google key. And `only`
 *     fell back to the whole catalogue whenever it was not a non-empty array:
 *     `only: []` or `only: "tools.search"` generated all of them. Now
 *     `overwrite` is a JSON boolean and `only` a non-empty list of icon keys,
 *     capped at the catalogue's own size and deduplicated: `only` had no
 *     maximum length and did not collapse repeats, so one request naming the
 *     same key thousands of times ran one real Google generation per entry —
 *     unbounded work behind a request count of one.
 *   - PATCH /:id/icons/:key cleared the icon unless BOTH `type` and `value`
 *     were present, so `{ "type": "emoji", "valeu": "🌟" }` deleted the
 *     person's override under a 200. An empty body (what the editor sends to
 *     clear) still clears; half an icon is refused.
 *   - PUT /:id passed the body to the store as it came: `{ "icons": null }`
 *     wiped every icon in the pack under a 200, `{ "name": null }` was a 500,
 *     and a misspelled key was a 200 that changed nothing.
 *   - An icon's `type` was stored whatever it said (`imgae` rendered as
 *     nothing), and an image could point anywhere. It is 'emoji' or 'image'
 *     now, and an image is a file this route serves (`/api/icons/data/…`):
 *     a pack imported from someone else's file can no longer make every
 *     screen fetch from a third-party address.
 *   - /generate and bulk-generate passed any `model` to Google with the
 *     install's key; it has to be a Gemini image model now, and
 *     `aspectRatio` a ratio like 16:9 instead of a Google 500.
 *   - /generate and bulk-generate had no rate limit, so any logged-in user
 *     could run unlimited image generations on the install's Google key.
 *     Both now share `imageGenLimiter` (utils/perUserRateLimit, 20/min per
 *     user); a bulk run is one request against that budget, not one per icon.
 *   - /import took any object with an `icons` key. A file that says it is
 *     something else (`kind`), or comes from a newer format (`version`), is
 *     refused. Its name is still cut to 100 characters rather than refused:
 *     the file is not the importer's own writing.
 *
 * Icon keys are a shape, not the catalogue: `integration.<id>` keys are
 * overrides too (utils/integrationIcons.js), and they are not in it.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth } = require('../auth/permissions');
const { uploadGuard } = require('../middleware/uploadGuard');
const iconStore = require('../stores/iconStore');
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { googleAdapter } = require('../core/providers');
const { EMOJI_CATEGORIES, ALL_EMOJI_IDS, EMOJI_BY_ID } = require('../core/cms/emojiCatalog');
const { z } = require('zod');
const { validate } = require('../core/http/validate');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

// ── Storage ─────────────────────────────────────────────────────

const uploadDir = path.join(__dirname, '..', 'data', 'icons');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Uploads run through the shared middleware/uploadGuard rather than bare
// multer. The old diskStorage kept `path.extname(file.originalname)` — a fully
// attacker-controlled extension — and only checked that the CLIENT-DECLARED
// mimetype started with "image/". Since /data below is an express.static mount
// that derives Content-Type from the extension, `payload.svg` (or `payload.html`
// declared as image/png) was stored verbatim and served back as executable
// markup on the application origin: stored XSS. uploadGuard sniffs the magic
// bytes against the declared type and pipes SVG through utils/svgSanitizer, and
// the filename below is built from the VERIFIED mime, never from the client's.
//
// The allowlist is the set of image types uploadGuard can actually vouch for by
// magic bytes (its own DEFAULT_ALLOW image family). Exotic formats that the old
// `startsWith('image/')` filter waved through — .ico, .bmp, .avif — are now
// refused, because accepting bytes we cannot verify is the hole itself.
const ICON_MIME_EXT = Object.freeze({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
});

const uploadIcon = uploadGuard({
    maxBytes: 2 * 1024 * 1024,
    allow: Object.keys(ICON_MIME_EXT),
    field: 'icon',
});

// /generate and /bulk-generate both spend real money on the install's Google
// key — bulk-generate can burn through dozens of images in one call, but that
// call still costs 1 against this budget: the limiter counts REQUESTS, not
// icons, so a normal editor session (a bulk run, then a few individual
// touch-ups) never gets near it. Without this, any logged-in user could run
// unlimited image generations. Shared between the two routes because both
// draw from the same key and the same concern — an unbounded /generate loop
// is exactly as costly as an unbounded /bulk-generate loop.
const imageGenLimiter = perUserRateLimit({ windowMs: 60_000, max: 20 });

// ── Request schemas (see the header) ────────────────────────────────

/** A string whose every refusal, including "you left it out", is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const KEY_TEXT = 'An icon key is letters, digits and . _ : -, like tools.search.';
const iconKey = worded(KEY_TEXT).regex(/^[A-Za-z0-9_.:-]{1,120}$/, KEY_TEXT);

const IMAGE_TEXT = 'An image icon is a file uploaded or generated here (/api/icons/data/…).';
const EMOJI_TEXT = 'An emoji icon is at most 64 characters.';
const TYPE_TEXT = "An icon's type is 'emoji' or 'image'.";
const iconType = z.enum(['emoji', 'image'], { errorMap: () => ({ message: TYPE_TEXT }) });
const iconValue = worded('An icon needs a value.').min(1, 'An icon needs a value.');
function checkIconValue(icon, ctx) {
    if (icon.type === 'image' && !/^\/api\/icons\/data\/[A-Za-z0-9._-]+$/.test(icon.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: IMAGE_TEXT });
    }
    if (icon.type === 'emoji' && icon.value.length > 64) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: EMOJI_TEXT });
    }
}
const Icon = z.object({ type: iconType, value: iconValue }, { invalid_type_error: 'An icon is { type, value }.' })
    .strict()
    .superRefine(checkIconValue);
const ICONS_TEXT = 'icons is an object of icon key to { type, value }.';
const IconMap = z.record(iconKey, Icon, { required_error: ICONS_TEXT, invalid_type_error: ICONS_TEXT });

const NAME_TEXT = 'A pack needs a name.';
const packName = worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(100, 'A pack name is at most 100 characters.');

const CreateBody = z.object({ name: packName, icons: IconMap.default({}) }).strict();
const UpdateBody = z.object({ name: packName.optional(), icons: IconMap.optional() }).strict();

// {} clears the override (what the editor sends); both halves set it.
const HALF_ICON_TEXT = 'Send both type and value to set an icon, or neither to clear it.';
const SetIconBody = bodyOf({ type: iconType.optional(), value: iconValue.optional() })
    .superRefine((b, ctx) => {
        if ((b.type === undefined) !== (b.value === undefined)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [b.type === undefined ? 'type' : 'value'], message: HALF_ICON_TEXT });
            return;
        }
        if (b.type !== undefined) checkIconValue(b, ctx);
    })
    .transform((b) => (b.type === undefined ? null : { type: b.type, value: b.value }));
const IconParams = z.object({ id: z.string(), key: iconKey });

// A Gemini image model, whichever of them the picker offers; anything else
// (a text model, another vendor's id) is not an icon generator.
const MODEL_TEXT = 'model is a Gemini image model, like gemini-3.1-flash-image-preview.';
const imageModel = worded(MODEL_TEXT).regex(/^gemini-[a-z0-9.-]*image[a-z0-9.-]*$/, MODEL_TEXT);
const STYLE_TEXT = 'A style is text of at most 500 characters.';
const style = worded(STYLE_TEXT).max(500, STYLE_TEXT);

const PROMPT_TEXT = 'Describe the icon to generate.';
const RATIO_TEXT = 'aspectRatio is a ratio like 1:1 or 16:9.';
const GenerateBody = z.object({
    prompt: worded(PROMPT_TEXT).trim().min(1, PROMPT_TEXT).max(2000, 'A prompt is at most 2000 characters.'),
    style: style.optional(),
    aspectRatio: worded(RATIO_TEXT).regex(/^\d{1,2}:\d{1,2}$/, RATIO_TEXT).optional(),
    model: imageModel.nullish(),
}).strict();

const ONLY_TEXT = 'only is a list of the icon keys to generate.';
const BulkGenerateBody = bodyOf({
    style: style.optional(),
    model: imageModel.nullish(),
    overwrite: z.boolean({ invalid_type_error: 'overwrite is true or false.' }).default(false),
    // Capped at the catalogue's own size: `only` names icons to (re)generate,
    // and generating more than the catalogue has is never a real request. A
    // bulk run is one request against imageGenLimiter, but nothing capped how
    // much WORK that one request could carry — `only` had no maximum length
    // and repeats were not collapsed, so a single request with thousands of
    // (duplicate) entries ran one real Google generation per entry. The
    // dedupe also means the count above is a request's own generations, not
    // its raw entry count.
    only: z.array(iconKey, { invalid_type_error: ONLY_TEXT })
        .min(1, ONLY_TEXT)
        .max(ALL_EMOJI_IDS.length, ONLY_TEXT)
        .transform((ids) => [...new Set(ids)])
        .optional(),
});

// The shape GET /:id/export writes; the name of someone else's file is cut
// to size rather than refused (see the header).
const ImportBody = z.object({
    kind: z.literal('beeflow.iconpack', { errorMap: () => ({ message: 'This file is not a Bee Flow icon pack.' }) }).optional(),
    version: z.literal(1, { errorMap: () => ({ message: 'This icon pack comes from a newer version of Bee Flow.' }) }).optional(),
    name: worded('A pack name must be text.').nullish().transform((v) => ((v || '').trim() || 'Imported Pack').slice(0, 100)),
    exportedAt: worded('exportedAt must be text.').optional(),
    icons: IconMap,
}).strict();

const NoBody = bodyOf({});

router.use(requireAuth);

// ── Catalog (no DB hit, safe to cache aggressively) ──────────────

router.get('/catalog', (req, res) => {
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ categories: EMOJI_CATEGORIES, totalKeys: ALL_EMOJI_IDS.length });
});

// ── List + active pack ──────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const packs = await iconStore.getIconPacks(userId);
        const user = await userStore.getUser(userId);
        res.json({
            packs,
            activeIconPackId: user ? user.activeIconPackId : null,
            categories: EMOJI_CATEGORIES,
            totalKeys: ALL_EMOJI_IDS.length,
        });
    } catch (e) {
        log.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ── Pack CRUD ───────────────────────────────────────────────────

router.post('/', validate({ body: CreateBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, icons } = req.body;
        const newPack = await iconStore.createIconPack(userId, name, icons);
        res.status(201).json(newPack);
    } catch (e) {
        log.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/:id', validate({ body: UpdateBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const ok = await iconStore.updateIconPack(req.params.id, userId, req.body);
        if (ok) res.json({ success: true });
        else res.status(404).json({ error: 'Pack not found or access denied' });
    } catch (e) {
        log.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PATCH /api/icons/:id/icons/:key — single-icon edit (no full-pack PUT race)
router.patch('/:id/icons/:key', validate({ params: IconParams, body: SetIconBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        // null clears the override (see SetIconBody).
        const data = req.body;
        const next = await iconStore.setIcon(req.params.id, userId, req.params.key, data);
        if (!next) return res.status(404).json({ error: 'Pack not found or access denied' });
        res.json({ success: true, icons: next });
    } catch (e) {
        log.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const ok = await iconStore.deleteIconPack(req.params.id, userId);
        if (!ok) return res.status(404).json({ error: 'Pack not found or access denied' });
        const user = await userStore.getUser(userId);
        if (user && user.activeIconPackId === req.params.id) {
            await userStore.updateUser(userId, { activeIconPackId: null });
        }
        res.json({ success: true });
    } catch (e) {
        log.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:id/activate', validate({ body: NoBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const packId = req.params.id;

        if (packId === 'default' || packId === 'null') {
            await userStore.updateUser(userId, { activeIconPackId: null });
            return res.json({ success: true, activeIconPackId: null });
        }

        const pack = await iconStore.getIconPack(packId);
        if (!pack || pack.user_id !== userId) {
            return res.status(404).json({ error: 'Pack not found or access denied' });
        }
        await userStore.updateUser(userId, { activeIconPackId: packId });
        res.json({ success: true, activeIconPackId: packId });
    } catch (e) {
        log.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ── Direct file upload ──────────────────────────────────────────

router.post('/upload', uploadIcon, async (req, res) => {
    try {
        // uploadGuard already answered 400/413/415 for anything it rejected, so
        // reaching here means the bytes matched an allowed image type (and an
        // SVG has been replaced by its sanitized rendering).
        const ext = ICON_MIME_EXT[String(req.file.mimetype || '').toLowerCase()];
        if (!ext) return res.status(415).json({ error: 'Unsupported image type' });

        const filename = `icon-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
        await fs.promises.writeFile(path.join(uploadDir, filename), req.file.buffer);
        res.json({ url: `/api/icons/data/${filename}` });
    } catch (e) {
        log.error('[Icons API upload]', e);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// ── AI generation (Nano Banana) ─────────────────────────────────

/**
 * Build the prompt sent to Nano Banana. We always layer in our base style
 * so a customised pack stays visually coherent; the user prompt is appended.
 */
function buildIconPrompt(userPrompt, opts = {}) {
    const style = opts.style?.trim() || 'flat 2D vector icon, single subject centred, solid background, no text, no watermark, app-icon style';
    const subject = (userPrompt || '').trim();
    if (!subject) return style;
    return `${subject}. Style: ${style}.`;
}

async function saveBase64Png(base64, mimeType) {
    const ext = (mimeType || '').includes('jpeg') ? 'jpg' : 'png';
    const filename = `icon_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const fullPath = path.join(uploadDir, filename);
    await fs.promises.writeFile(fullPath, Buffer.from(base64, 'base64'));
    return `/api/icons/data/${filename}`;
}

// POST /api/icons/generate — single-icon generation, returns the saved URL
router.post('/generate', imageGenLimiter, validate({ body: GenerateBody }), async (req, res) => {
    const { prompt, style, aspectRatio, model } = req.body;

    const apiKey = await configStore.getSecret('google_api_key');
    if (!apiKey) {
        return res.status(503).json({ error: 'Image generation unavailable — Google API key not configured.' });
    }

    const fullPrompt = buildIconPrompt(prompt, { style });
    const result = await googleAdapter.generateImage(apiKey, fullPrompt, {
        aspectRatio: aspectRatio || '1:1',
        model: model || 'gemini-3.1-flash-image-preview',
    });

    if (!result?.imageBase64) {
        return res.status(502).json({ error: 'Generation returned no image' });
    }

    const url = await saveBase64Png(result.imageBase64, result.mimeType);
    res.json({ url, prompt: fullPrompt });
});

// POST /api/icons/:id/bulk-generate — generate every missing icon in a pack
//   body: { style?: string, model?: string, overwrite?: boolean, only?: string[] }
router.post('/:id/bulk-generate', imageGenLimiter, validate({ body: BulkGenerateBody }), async (req, res) => {
    const userId = req.session.user.id;
    const pack = await iconStore.getIconPack(req.params.id);
    if (!pack || pack.user_id !== userId) {
        return res.status(404).json({ error: 'Pack not found or access denied' });
    }

    const apiKey = await configStore.getSecret('google_api_key');
    if (!apiKey) {
        return res.status(503).json({ error: 'Image generation unavailable — Google API key not configured.' });
    }

    const { style, model, overwrite, only } = req.body;
    const targetIds = (only || ALL_EMOJI_IDS)
        .filter(id => overwrite || !(pack.icons || {})[id]);

    if (targetIds.length === 0) {
        return res.json({ success: true, generated: 0, total: 0, message: 'No missing icons to generate.' });
    }

    const next = { ...(pack.icons || {}) };
    let generated = 0;
    let errors = 0;

    // Cap concurrency — Gemini image gen is rate-limited.
    const CONCURRENCY = 3;
    for (let i = 0; i < targetIds.length; i += CONCURRENCY) {
        const batch = targetIds.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (id) => {
            const entry = EMOJI_BY_ID[id];
            const label = entry?.label || id;
            const subject = `An icon representing "${label}"`;
            const fullPrompt = buildIconPrompt(subject, { style });
            const r = await googleAdapter.generateImage(apiKey, fullPrompt, {
                aspectRatio: '1:1',
                model: model || 'gemini-3.1-flash-image-preview',
            });
            if (!r?.imageBase64) throw new Error('no image');
            const url = await saveBase64Png(r.imageBase64, r.mimeType);
            return { id, url };
        }));

        for (const r of results) {
            if (r.status === 'fulfilled') {
                next[r.value.id] = { type: 'image', value: r.value.url };
                generated++;
            } else {
                errors++;
                log.warn('[Icons bulk-generate] failed:', r.reason?.message);
            }
        }
    }

    await iconStore.updateIconPack(pack.id, userId, { icons: next });

    res.json({
        success: true,
        generated,
        total: targetIds.length,
        errors,
        message: errors > 0
            ? `Generated ${generated} icons (${errors} failed).`
            : `Generated ${generated} icons.`,
    });
});

// ── Import / Export ─────────────────────────────────────────────

router.get('/:id/export', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const pack = await iconStore.getIconPack(req.params.id);
        if (!pack || pack.user_id !== userId) {
            return res.status(404).json({ error: 'Pack not found or access denied' });
        }
        const bundle = {
            kind: 'beeflow.iconpack',
            version: 1,
            name: pack.name,
            exportedAt: new Date().toISOString(),
            icons: pack.icons || {},
        };
        res.setHeader('Content-Disposition', `attachment; filename="beeflow-iconpack-${pack.name.replace(/[^a-z0-9]/gi, '_')}.json"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(bundle);
    } catch (e) {
        log.error('[Icons API export]', e);
        res.status(500).json({ error: 'Export failed' });
    }
});

router.post('/import', validate({ body: ImportBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, icons } = req.body;
        const newPack = await iconStore.createIconPack(userId, name, icons);
        res.status(201).json(newPack);
    } catch (e) {
        log.error('[Icons API import]', e);
        res.status(500).json({ error: 'Import failed' });
    }
});

// ── Static serve ────────────────────────────────────────────────

// Serving hardening — the same policy routes/storageProxy.js applies to
// user-uploaded objects: never sniff, and only render inline what is safe to
// render. The upload path above can no longer create anything but the five icon
// extensions, but files the OLD path already wrote keep their extension on
// disk, so the defence has to live in the response headers:
//
//   • nosniff       — a .png that is really HTML stays a broken image.
//   • sandbox CSP   — a top-level navigation to a stored icon gets an opaque
//                     origin with scripting off, which neutralises a hostile
//                     legacy `.svg`. helmet runs with contentSecurityPolicy:false
//                     (index.js), so this per-response header IS the policy.
//   • attachment    — anything outside the icon extension set downloads instead
//                     of rendering.
//
// None of the three affects the `<img src="/api/icons/data/…">` the Appearance
// UI actually uses: CSP and Content-Disposition are only consulted for
// navigations, not for image subresource loads.
// '.jpeg' is not produced by the upload path (it normalises to '.jpg') but old
// AI-generated / uploaded files may carry it.
const INLINE_ICON_EXTS = new Set([...Object.values(ICON_MIME_EXT), '.jpeg']);

router.use('/data', express.static(uploadDir, {
    index: false,
    dotfiles: 'deny',
    setHeaders(res, filePath) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
        const inline = INLINE_ICON_EXTS.has(path.extname(filePath).toLowerCase());
        res.setHeader('Content-Disposition', inline ? 'inline' : 'attachment');
    },
}));

module.exports = router;
