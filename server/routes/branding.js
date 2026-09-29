/**
 * Branding Routes — theming + wallpaper management.
 *
 *   GET    /api/branding/public               — unauthenticated, safe subset for login/marketing
 *   GET    /api/branding/effective            — auth, resolved theme for the current user
 *   GET    /api/branding/admin                — admin, raw org default
 *   PUT    /api/branding/admin                — admin, update org default
 *   PUT    /api/branding/user                 — auth, update the user override (no body: clear it)
 *   DELETE /api/branding/user                 — auth, clear the user override
 *
 *   POST   /api/branding/wallpaper            — admin, multipart upload (field name: "wallpaper")
 *   DELETE /api/branding/wallpaper            — admin, clear wallpaper
 *   GET    /api/branding/wallpaper/:filename  — public static serve (Cache-Control 1d)
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Both theme bodies are `.strict()`, with every knob in its own vocabulary.
 * brandingStore.sanitize keeps what it recognises and drops the rest, and
 * both PUTs then answer 200 — which the Look editor shows as "Theme saved as
 * organisation default". Three of those drops changed what everyone sees:
 *
 *   - `allowUserOverride: "false"` (the string) was not a boolean, so it was
 *     dropped and members KEPT their own themes after the admin locked it;
 *   - a number knob given text — `radiusScale: 'large'` — was clamped from
 *     NaN, which lands on the MINIMUM: every corner in the org at half radius;
 *   - `accent: '#FFF'` (three digits) and `preset: 'drak'` were dropped and
 *     the old value stayed, under the same "saved".
 *
 * Out-of-range numbers are refused rather than clamped, with the range in the
 * message; the editor's sliders never leave it.
 *
 * Going back to the organisation theme is `DELETE /user`. The documented
 * clear was `PUT` with a literal `null` body — and the app-wide JSON parser
 * refuses that (strict mode: only an object or an array) with a 400 "Invalid
 * JSON body" before this router runs, so the web's clearUserOverride() never
 * cleared anything. A DELETE needs no body to say "nothing". `PUT /user` with
 * NO body still clears as well: that is what the phone's clearUserBranding()
 * sends (its client drops a null body), and it used to get a 200 that cleared
 * nothing.
 *
 * ── The wallpaper file ──────────────────────────────────────────────
 *
 * The upload is multipart with no text fields, so it has no body schema. What
 * it had instead was a filter that believed the part's declared type and a
 * name that kept the CLIENT's extension: `image/png` declared, `x.html` as the
 * name, and the file was stored as `wallpaper-….html` — then served, with no
 * session required, by GET /wallpaper/:filename as text/html from the app's
 * own origin, under a page CSP that allows inline script. An admin of any
 * organisation (requireAdmin passes on `manage_users`) could plant script
 * there. Now the stored extension comes from an allow-list of raster types,
 * never from the name; SVG, which can carry script, is not on it; and every
 * wallpaper is served nosniff and sandboxed, which also defuses anything
 * stored before this. A refused upload is a 400 (a file too big a 413), not
 * the 500 a filter error used to become.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { z } = require('zod');
const { requireAuth: _requireAuth, requireAdmin: _requireAdmin } = require('../auth/permissions');
const brandingStore = require('../stores/brandingStore');
const { validate } = require('../core/http/validate');
const { HttpError } = require('../core/http/errors');

// Async middleware in Node 22 — if `requireAdmin`'s internal hasPermission()
// rejects, the unhandled-rejection default exits the process, which produces
// ERR_EMPTY_RESPONSE on the open socket. Wrap auth middleware so a rejection
// reaches the terminal error handler instead. It used to answer here, with
// 'Auth check failed: ' + the error's own message — the raw text of whatever
// the permission lookup threw, database errors included, in the 500 body.
function safe(middleware) {
    return (req, res, next) => {
        Promise.resolve()
            .then(() => middleware(req, res, next))
            .catch(next);
    };
}
const requireAuth = safe(_requireAuth);
const requireAdmin = safe(_requireAdmin);

// ── The theme vocabulary ────────────────────────────────────────
//
// The same words brandingStore.sanitize accepts. An enum whose refusal is one
// sentence, for a wrong value as much as a wrong type (see validate.js).

const choice = (values, message) => z.enum(values, { errorMap: () => ({ message }) });
const within = (name, lo, hi) => {
    const text = `${name} is a number from ${lo} to ${hi}.`;
    return z.number({ invalid_type_error: text }).min(lo, text).max(hi, text);
};

const PRESET_TEXT = 'preset is one of: light, dark, glass, glass-dark, paper, obsidian, sepia, high-contrast, custom.';
const preset = () => choice(['light', 'dark', 'glass', 'glass-dark', 'paper', 'obsidian', 'sepia', 'high-contrast', 'custom'], PRESET_TEXT);
const ACCENT_TEXT = 'accent is a colour like #3b82f6 (six hex digits).';
const accent = () => z.string({ invalid_type_error: ACCENT_TEXT }).regex(/^#[0-9a-fA-F]{6}$/, ACCENT_TEXT);
const WALLPAPER_TEXT = 'wallpaperPreset is one of: mono, slate, sand, frost, sage, ash.';
const wallpaperPreset = () => choice(['mono', 'slate', 'sand', 'frost', 'sage', 'ash'], WALLPAPER_TEXT);

/** A per-tier glass override, or null to go back to the intensity-derived one. */
const glassTier = (name) => z.object({
    blur: within(`${name}.blur`, 0, 60).optional(),
    saturate: within(`${name}.saturate`, 100, 300).optional(),
    brightness: within(`${name}.brightness`, 0.8, 1.3).optional(),
}, { invalid_type_error: `${name} is { blur, saturate, brightness }, or null.` }).strict().nullable();

const AdminBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    preset: preset().optional(),
    accent: accent().optional(),
    radiusScale: within('radiusScale', 0.5, 1.5).optional(),
    font: choice(['system', 'inter', 'plex', 'geist'], 'font is one of: system, inter, plex, geist.').optional(),
    wallpaperOverlay: within('wallpaperOverlay', 0, 1).optional(),
    glassIntensity: within('glassIntensity', 0, 2).optional(),
    wallpaperPreset: wallpaperPreset().optional(),
    glassTint: choice(['warm', 'neutral', 'cool'], 'glassTint is warm, neutral or cool.').optional(),
    glassLens: choice(['off', 'on'], 'glassLens is off or on.').optional(),
    glassAnimation: choice(['off', 'subtle', 'lively'], 'glassAnimation is off, subtle or lively.').optional(),
    glassGrain: choice(['off', 'subtle', 'frosted'], 'glassGrain is off, subtle or frosted.').optional(),
    glassBorder: choice(['none', 'subtle', 'bright', 'iridescent'], 'glassBorder is none, subtle, bright or iridescent.').optional(),
    glassTierSubtle: glassTier('glassTierSubtle').optional(),
    glassTierDefault: glassTier('glassTierDefault').optional(),
    glassTierOpaque: glassTier('glassTierOpaque').optional(),
    allowUserOverride: z.boolean({ invalid_type_error: 'allowUserOverride is true or false.' }).optional(),
}, { invalid_type_error: 'Send the theme as an object of settings.' }).strict());

/**
 * A member's own theme: the three knobs sanitize lets a non-admin set — or no
 * body at all, which clears the override (see the header for why not `null`).
 */
const USER_TEXT = 'Send { preset, accent, wallpaperPreset } — or no body to go back to the organisation theme.';
const UserBody = z.preprocess((v) => (v === undefined ? null : v), z.object({
    preset: preset().optional(),
    accent: accent().optional(),
    wallpaperPreset: wallpaperPreset().optional(),
}, { invalid_type_error: USER_TEXT }).strict().nullable());

// ── Storage ─────────────────────────────────────────────────────

const uploadDir = path.join(__dirname, '..', 'data', 'wallpapers');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Raster types only, each stored under the one extension it maps to — the
// extension decides the Content-Type the file is later served with, so it is
// never taken from the client's file name. SVG is an image a browser will
// also run script in, so it is not one of these.
const WALLPAPER_TYPES = new Map([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/webp', '.webp'],
    ['image/gif', '.gif'],
    ['image/avif', '.avif'],
]);
const WALLPAPER_TYPES_TEXT = 'A wallpaper is a PNG, JPEG, WebP, GIF or AVIF image.';
const typeOf = (file) => String(file.mimetype || '').toLowerCase();

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, 'wallpaper-' + uniqueSuffix + WALLPAPER_TYPES.get(typeOf(file)));
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (WALLPAPER_TYPES.has(typeOf(file))) cb(null, true);
        else cb(new HttpError(400, 'bad_wallpaper', WALLPAPER_TYPES_TEXT));
    },
});

/** Multer's refusals as the client errors they are — they used to reach the terminal handler as 500s. */
function receiveWallpaper(req, res, next) {
    upload.single('wallpaper')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof HttpError) return next(err);
        if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'wallpaper_too_large', 'A wallpaper is at most 5 MB.'));
        return next(new HttpError(400, 'bad_upload', err.message || 'Upload rejected'));
    });
}

// ── Public endpoints (no auth) ──────────────────────────────────

router.get('/public', async (req, res) => {
    try {
        const data = await brandingStore.getPublic();
        res.set('Cache-Control', 'public, max-age=60');
        res.json(data);
    } catch (e) {
        log.error('[Branding API] public', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Static serve for wallpapers — public so the login page can show the image.
router.get('/wallpaper/:filename', (req, res) => {
    const safe = path.basename(req.params.filename || '');
    if (!safe || safe.includes('..')) return res.status(400).end();
    const full = path.join(uploadDir, safe);
    if (!fs.existsSync(full)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400');
    // Whatever a stored file turns out to be — including one uploaded before
    // the type allow-list existed — it is never a document that runs: no
    // sniffing, no script, a sandbox. An image displays the same either way.
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    // Relative to its root, so `send` judges only the file name — not every
    // directory above the upload dir (a checkout under a dot-directory read
    // as a hidden file, and 404'd every wallpaper).
    res.sendFile(safe, { root: uploadDir });
});

// ── Authenticated endpoints ─────────────────────────────────────

router.get('/effective', requireAuth, async (req, res) => {
    try {
        const userId = req.session?.user?.id || null;
        const data = await brandingStore.getEffective(userId);
        res.json(data);
    } catch (e) {
        log.error('[Branding API] effective', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/user', requireAuth, validate({ body: UserBody }), async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const orgDefault = await brandingStore.getOrgDefault();
        if (!orgDefault.allowUserOverride) {
            return res.status(403).json({ error: 'User theme override is disabled by the administrator' });
        }

        // null — no body at all — clears the override; an object is a merge.
        const next = await brandingStore.setUserOverride(userId, req.body);
        const data = await brandingStore.getEffective(userId);
        res.json({ override: next, effective: data });
    } catch (e) {
        log.error('[Branding API] put user', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Back to the organisation theme. Same gate as the PUT: when the admin has
// locked the look there is no member override to manage.
router.delete('/user', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const orgDefault = await brandingStore.getOrgDefault();
    if (!orgDefault.allowUserOverride) {
        return res.status(403).json({ error: 'User theme override is disabled by the administrator' });
    }

    const next = await brandingStore.setUserOverride(userId, null);
    const data = await brandingStore.getEffective(userId);
    res.json({ override: next, effective: data });
});

// ── Admin endpoints ─────────────────────────────────────────────

/**
 * Diagnostic dump — shows the raw DB state alongside the resolved values so
 * we can see whether saves are actually persisting. Admin-only.
 */
router.get('/debug', requireAdmin, async (req, res) => {
    const configStore = require('../stores/configStore');
    const userId = req.session?.user?.id || null;
    const rawDefault = await configStore.getConfig('branding.default');
    const rawWallpaper = await configStore.getConfig('branding.wallpaperFilename');
    const rawUserOverride = userId ? await configStore.getConfig(`branding.user.${userId}`) : null;
    const orgDefault = await brandingStore.getOrgDefault();
    const effective = await brandingStore.getEffective(userId);
    res.json({
        session: {
            userId,
            hasOrganization: !!req.session?.user?.organizationId,
            organizationId: req.session?.user?.organizationId || null,
            role: req.session?.user?.role || null,
        },
        raw: {
            'branding.default': rawDefault,
            'branding.wallpaperFilename': rawWallpaper,
            [`branding.user.${userId}`]: rawUserOverride,
        },
        resolved: {
            orgDefault,
            effective,
        },
    });
});

router.get('/admin', requireAdmin, async (req, res) => {
    try {
        const data = await brandingStore.getOrgDefault();
        const wallpaperFilename = await brandingStore.getWallpaperFilename();
        res.json({
            ...data,
            wallpaperUrl: wallpaperFilename ? `/api/branding/wallpaper/${wallpaperFilename}` : null,
        });
    } catch (e) {
        log.error('[Branding API] get admin', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/admin', requireAdmin, validate({ body: AdminBody }), async (req, res) => {
    try {
        const next = await brandingStore.setOrgDefault(req.body);
        const wallpaperFilename = await brandingStore.getWallpaperFilename();
        res.json({
            ...next,
            wallpaperUrl: wallpaperFilename ? `/api/branding/wallpaper/${wallpaperFilename}` : null,
        });
    } catch (e) {
        log.error('[Branding API] put admin', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/wallpaper', requireAdmin, receiveWallpaper, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        // Delete the previous wallpaper file (single-wallpaper-per-org).
        const previous = await brandingStore.getWallpaperFilename();
        if (previous && previous !== req.file.filename) {
            const prevPath = path.join(uploadDir, previous);
            fs.promises.unlink(prevPath).catch(() => { /* missing is fine */ });
        }

        await brandingStore.setWallpaperFilename(req.file.filename);
        res.json({
            filename: req.file.filename,
            url: `/api/branding/wallpaper/${req.file.filename}`,
        });
    } catch (e) {
        log.error('[Branding API] wallpaper upload', e);
        res.status(500).json({ error: 'Upload failed' });
    }
});

router.delete('/wallpaper', requireAdmin, async (req, res) => {
    try {
        const previous = await brandingStore.getWallpaperFilename();
        if (previous) {
            const prevPath = path.join(uploadDir, previous);
            fs.promises.unlink(prevPath).catch(() => { /* missing is fine */ });
        }
        await brandingStore.setWallpaperFilename(null);
        res.json({ success: true });
    } catch (e) {
        log.error('[Branding API] wallpaper delete', e);
        res.status(500).json({ error: 'Delete failed' });
    }
});

module.exports = router;
