import { readIconPacks, readOrgTheme } from './brandingReaders';
import {
    readAcademyOverview,
    readEncryptionSave,
    readLogoUpload,
    readOrgAiContext,
    readOrgEncryption,
    readOrgIntegrationCache,
    readOrgLanguages,
} from './sectionReaders';

describe('the org settings readers', () => {
    it('reads the default language, dropping locales without a code', () => {
        expect(readOrgLanguages({ defaultLocale: 'nl', locales: [{ code: 'en', name: 'English' }, { name: 'x' }] })).toEqual({
            defaultLocale: 'nl',
            locales: [{ code: 'en', name: 'English' }],
        });
        expect(readOrgLanguages(null)).toEqual({ defaultLocale: 'en', locales: [] });
        expect(readLogoUpload({ success: true, logo: '/uploads/a.png' })).toEqual({ logo: '/uploads/a.png' });
    });

    it('reads encryption with its tier options, and a refusal as null', () => {
        const enc = readOrgEncryption({
            tier: 'managed',
            entitled: true,
            tierOptions: [{ tier: 'zk', selectable: false, reason: 'No OPAQUE', blockedBy: 'readiness' }],
        });
        expect(enc?.tierOptions[0]).toEqual({
            tier: 'zk',
            selectable: false,
            reason: 'No OPAQUE',
            warningReason: null,
            blockedBy: 'readiness',
        });
        expect(readOrgEncryption(null)).toBeNull();
        expect(readEncryptionSave({ success: true, tier: 'zk', sessionsBusted: true })).toEqual({ tier: 'zk', sessionsBusted: true });
    });

    it('reads the AI context with the server defaults for what an older server omits', () => {
        expect(readOrgAiContext({ compactionEnabled: true })).toEqual({
            compactionEnabled: true,
            compactionThreshold: 16,
            recentWindow: 8,
            contextBudgetPercent: 75,
            contextWindowExamples: [],
            contextBudgetRange: { min: 25, max: 95 },
        });
    });

    it('reads the integration cache, with app answers on and web calls off by default', () => {
        const cache = readOrgIntegrationCache({ enabled: true, entries: 3, expiredEntries: '2', bytes: 100 });
        expect(cache).toMatchObject({
            enabled: true,
            ttlSeconds: 300,
            scopes: { integration: true, http: false },
            ttlRange: { min: 60, max: 3600 },
            entries: 3,
            expiredEntries: 2,
            purged: 0,
        });
    });

    it('reads the Academy overview', () => {
        const overview = readAcademyOverview({
            courses: [{ id: 'c1', title: 'Basics', lessonCount: 4 }],
            totals: { members: 2, coursesCompleted: 1 },
            members: [{ userId: 'u1', displayName: 'Ada', coursesDone: ['c1'], certificates: [{ certificateId: 'x', level: 'gold' }] }],
        });
        expect(overview?.totals).toEqual({ members: 2, coursesCompleted: 1, certificatesIssued: null, activeLast30d: null });
        expect(overview?.members[0]).toMatchObject({ userId: 'u1', email: null, badges: [], lastActivity: null });
        expect(overview?.members[0]?.certificates[0]).toEqual({ certificateId: 'x', level: 'gold', issuedAt: null });
    });
});

describe('the theme and icon readers', () => {
    it('reads the org theme, falling back to the store defaults for unknown values', () => {
        expect(readOrgTheme({ preset: 'drak', accent: '#3b82f6', radiusScale: 1.2, font: 'comic', glassTint: 'warm' })).toEqual({
            preset: 'light',
            accent: '#3b82f6',
            radiusScale: 1.2,
            font: 'system',
            allowUserOverride: true,
        });
    });

    it('reads icon packs with their override counts and the active one', () => {
        expect(
            readIconPacks({
                packs: [{ id: 'p1', name: 'Mine', icons: { 'tools.search': {}, 'a.b': {} } }, { name: 'no id' }],
                activeIconPackId: 'p1',
            }),
        ).toEqual({ packs: [{ id: 'p1', name: 'Mine', iconCount: 2 }], activeIconPackId: 'p1' });
        expect(readIconPacks(undefined)).toEqual({ packs: [], activeIconPackId: null });
    });
});
