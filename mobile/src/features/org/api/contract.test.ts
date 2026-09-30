/**
 * The org-admin sections' contract, pinned against the server's own source
 * (read as TEXT: the route files import the database pool). Each block names
 * the file api/profile.ts, api/policies.ts or api/branding.ts was verified
 * against; a red line here means the server moved, and the answer is to
 * follow it in the endpoint and its reader, not to loosen the pin.
 */

import fs from 'node:fs';
import path from 'node:path';

import { FONT_IDS, RADIUS_RANGE, THEME_PRESET_IDS } from '../model/theme';

const SERVER = path.resolve(__dirname, '../../../../../server');
const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

function expectAll(src: string, needles: string[]) {
    for (const needle of needles) expect({ needle, found: src.includes(needle) }).toEqual({ needle, found: true });
}

describe('the org record, logo and default language', () => {
    it('keeps the logo routes, their multer field and the answer', () => {
        const src = read('auth/admin/orgRoutes.js');
        expectAll(src, [
            "router.post('/organizations/:id/logo'",
            "orgLogoUpload.single('logo')",
            'fileSize: 2 * 1024 * 1024',
            'res.json({ success: true, logo: logoPath })',
            "router.delete('/organizations/:id/logo'",
            "router.put('/organizations/:id', requireOrgAdmin('id')",
        ]);
        for (const key of ['billingLine2', 'billingPostalCode', 'billingCity', 'billingCountry', 'allowedDomains', 'authMethod']) {
            expect(src).toContain(key);
        }
        // The domain rule the Sign-in screen validates with.
        expect(src).toContain('/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z]{2,})+$/');
    });

    it('keeps GET/PUT /api/languages/org/default and its body', () => {
        const src = read('routes/admin/languageRoutes.js');
        expectAll(src, [
            "router.get('/org/default'",
            "router.put('/org/default'",
            'res.json({ defaultLocale, locales })',
            'bodyOf({ defaultLocale:',
        ]);
        expect(read('index.js')).toContain("app.use('/api/languages'");
    });
});

describe('the processing policies', () => {
    it('keeps the encryption routes and the tier option shape', () => {
        const src = read('auth/admin/orgRoutes.js');
        expectAll(src, [
            "router.get('/organizations/:id/encryption'",
            "router.put('/organizations/:id/encryption'",
            'tierOptions: availability.tiers',
            'entitled: availability.entitled',
            'sessionsBusted: enteringZk',
        ]);
        expectAll(read('stores/encryptionAvailability.js'), ['selectable', 'blockedBy', 'warningReason', 'reason']);
    });

    it('keeps the AI context body and envelope', () => {
        const src = read('routes/orgAiContext.js');
        expectAll(src, [
            "router.get('/:orgId'",
            "router.put('/:orgId'",
            'compactionEnabled: z.boolean(',
            "compactionThreshold: tunable('compactionThreshold')",
            "recentWindow: tunable('recentWindow')",
            "contextBudgetPercent: tunable('contextBudgetPercent')",
            'contextWindowExamples: contextWindowExamples()',
            'contextBudgetRange: {',
        ]);
        expect(read('index.js')).toContain("'/api/org-ai-context'");
    });

    it('keeps the integration cache body, envelope and purge', () => {
        const src = read('routes/orgIntegrationCache.js');
        expectAll(src, [
            "router.put('/:orgId'",
            "router.delete('/:orgId/entries'",
            'enabled: z.boolean(',
            'ttlSeconds: z.number(',
            "integration: tick('scopes.integration')",
            "http: tick('scopes.http')",
            'killSwitch: killSwitchOn()',
            'ttlRange: { min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS }',
            'expiredEntries: stats.expiredEntries',
            'res.json({ purged })',
        ]);
        expect(read('index.js')).toContain("'/api/org-integration-cache'");
    });
});

describe('the organisation theme, icon packs and the Academy', () => {
    it('keeps /api/branding/admin with the knobs and vocabulary the screen sends', () => {
        const src = read('routes/branding.js');
        expectAll(src, [
            "router.get('/admin', requireAdmin",
            "router.put('/admin', requireAdmin, validate({ body: AdminBody })",
            `within('radiusScale', ${RADIUS_RANGE.min}, ${RADIUS_RANGE.max})`,
            "choice(['system', 'inter', 'plex', 'geist']",
            "allowUserOverride: z.boolean(",
            '/^#[0-9a-fA-F]{6}$/',
        ]);
        const presetLine = src.split('\n').find((line) => line.startsWith('const PRESET_TEXT')) ?? '';
        for (const id of THEME_PRESET_IDS) expect(presetLine).toMatch(new RegExp(`[ :,]${id}[,.]`));
        expect(FONT_IDS).toEqual(['system', 'inter', 'plex', 'geist']);
        // PUT merges over the stored default: a partial body keeps the glass knobs.
        expect(read('stores/brandingStore.js')).toContain('const next = { ...current, ...clean };');
    });

    it('keeps the icon pack list and activation', () => {
        const src = read('routes/icons.js');
        expectAll(src, [
            "router.get('/', async",
            'activeIconPackId: user ? user.activeIconPackId : null',
            "router.post('/:id/activate', validate({ body: NoBody })",
            "packId === 'default'",
        ]);
    });

    it('keeps the Academy overview route and its member fields', () => {
        expect(read('routes/ai/learning.js')).toContain("router.get('/org-overview'");
        expect(read('routes/ai.js')).toContain("require('./ai/learning')");
        expectAll(read('learning/orgOverview.js'), [
            'userId: u.id',
            'coursesDone,',
            'certificates,',
            'lastActivity: last,',
            'certificatesIssued: 0',
            'activeLast30d: 0',
            'lessonCount:',
        ]);
    });
});
