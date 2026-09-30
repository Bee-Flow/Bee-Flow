/**
 * The public address and the grants: what PUT /:id/audience/public is sent
 * in each direction (routes/webpagesAudience.js PublicBody), and the grant
 * routes (routes/webpagesGrants.js).
 */

import { api } from '@/core/api/client';

import { getAudience, getPageCalls, grantAutomation, revokeGrant, setPublic } from './audienceEndpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return {
        ...actual,
        api: { ...actual.api, get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
    };
});

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;
const del = api.delete as jest.Mock;

const MODEL = {
    internal: { mode: 'org', isPublished: true, sharedGroups: [] },
    public: { on: true, known: true, accessMode: 'password', hasPassword: true, allowedEmails: [], viewCount: 4 },
    address: { slug: 'launch', path: '/w/launch', url: 'https://bee.example/w/launch' },
    columnGate: {
        tables: [{ datatableId: 't1', columns: ['name', 'email'], publicColumns: ['name'], label: 'Leads' }],
    },
    shareCount: 2,
    shareCountKnown: true,
};

beforeEach(() => jest.clearAllMocks());

describe('setPublic', () => {
    it('sends only `on` when switching off', async () => {
        put.mockResolvedValue({ ...MODEL, public: { on: false } });
        await setPublic('wp1', {
            on: false,
            publicColumns: { t1: ['name'] },
            accessMode: 'password',
            password: 'secret1',
        });
        expect(put).toHaveBeenCalledWith('/api/webpages/wp1/audience/public', { on: false });
    });

    it('sends the column gate and only the fields its access mode uses', async () => {
        put.mockResolvedValue(MODEL);
        const model = await setPublic('wp1', {
            on: true,
            publicColumns: { t1: ['name'] },
            accessMode: 'email',
            password: 'ignored',
            allowedEmails: ['a@b.nl'],
            expiresAt: null,
        });
        expect(put).toHaveBeenCalledWith('/api/webpages/wp1/audience/public', {
            on: true,
            publicColumns: { t1: ['name'] },
            accessMode: 'email',
            allowedEmails: ['a@b.nl'],
            expiresAt: null,
        });
        expect(model.address?.url).toBe('https://bee.example/w/launch');
    });
});

describe('reading', () => {
    it('reads the audience model', async () => {
        get.mockResolvedValue(MODEL);
        const audience = await getAudience('wp1');
        expect(audience.public).toMatchObject({ on: true, accessMode: 'password', viewCount: 4 });
        expect(audience.columnGate).toMatchObject({ anyBound: true, sharingCount: 1 });
        expect(audience.shareCount).toBe(2);
    });

    it('reads the page’s own calls from the bindings `code` section', async () => {
        get.mockResolvedValue({
            code: {
                scanned: true,
                calls: [{ kind: 'fetch', url: 'https://api.x/y', host: 'api.x', source: 'script.js', line: 4 }],
            },
        });
        const calls = await getPageCalls('wp1');
        expect(calls.scanned).toBe(true);
        expect(calls.calls[0]).toMatchObject({ host: 'api.x', line: 4, occurrences: 1 });
    });
});

describe('grants', () => {
    it('adds an automation and removes either kind by key', async () => {
        await grantAutomation('wp1', 'a1', 'Digest');
        expect(post).toHaveBeenCalledWith('/api/webpages/wp1/grants/automations', {
            automationId: 'a1',
            label: 'Digest',
        });
        await revokeGrant('wp1', 'integrations', 'slack/post message');
        expect(del).toHaveBeenCalledWith('/api/webpages/wp1/grants/integrations/slack%2Fpost%20message');
    });
});
