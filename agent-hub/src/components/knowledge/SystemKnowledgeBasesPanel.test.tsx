import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import SystemKnowledgeBasesPanel from './SystemKnowledgeBasesPanel';
import { setDemoTransport } from '@/utils/helpers';
import { renderWithClient } from '@/test/render';

/**
 * The system knowledge-base panel reads GET /api/kb/system and toggles the org's beta feature.
 * The server has no per-slug seed routes, so the panel offers no re-ingest button and asks for
 * no seed status. The network is authFetch's transport seam (no module mock).
 */

let urls: string[];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    urls = [];
    setDemoTransport(async (url: string) => {
        urls.push(url);
        return json({
            items: [{ id: 'kb1', name: 'Reference set', system_slug: 'ref-set', betaFeatureId: 'ref-set', enabledForOrg: true, allowedForOrg: true, superAdminBypass: true, documentCount: 3, totalChunks: 12 }],
            orgId: 'o1',
            isSuperAdmin: true,
        });
    });
});
afterEach(() => { setDemoTransport(null); });

describe('SystemKnowledgeBasesPanel', () => {
    it('lists a system knowledge base with its toggle, and no seed button for a super-admin', async () => {
        renderWithClient(<SystemKnowledgeBasesPanel />);

        expect(await screen.findByText('Reference set')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Enabled for organisation/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Refresh now|Seeding/ })).not.toBeInTheDocument();
        expect(urls.every((u) => u.endsWith('/api/kb/system'))).toBe(true);
    });
});
