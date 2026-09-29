import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// One mock for the whole transport: KnowledgePanel, useKnowledgeBases and
// KnowledgeStudio/knowledgeApi all import authFetch from this exact module,
// so a single spy sees every request the mounted panel makes.
vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

import KnowledgePanel from './KnowledgePanel';

/**
 * KnowledgePanel after the legacy flat-knowledge removal (Track Z, Z1b).
 *
 * The panel used to carry two knowledge layers: the live multi-KB layer, and a
 * flat per-agent "legacy items" layer whose entire UI sat behind `{false && …}`.
 * That dead branch was the only consumer of a state block, two effects and ten
 * handlers — including a GET of /agents/:id/knowledge fired on every mount
 * whose response nothing could ever display.
 *
 * The tests below pin what survives and what must not come back.
 */

const KB_LIST = /\/api\/kb(\?|$)/;

function mockFetch() {
    globalThis.__seenUrls = [];
    globalThis.__authFetch = vi.fn(async (url) => {
        const u = String(url);
        globalThis.__seenUrls.push(u);
        // The KB list is consumed with .map(), so it answers an array; every
        // other endpoint the hook probes on mount gets a plain empty 200.
        const body = KB_LIST.test(u) ? [] : {};
        return { ok: true, status: 200, json: async () => body };
    });
}

beforeEach(() => {
    mockFetch();
});

describe('KnowledgePanel', () => {
    /**
     * (a) The panel still mounts and still renders its container.
     *
     * The removal deleted 145 lines of JSX out of the middle of the return.
     * If a bracket had gone with them the component would throw on render, so
     * the cheapest possible regression net is: does it come up at all, and is
     * the `knowledge-panel` container — documented in e2e/context/app-map.md —
     * still the thing it comes up as.
     */
    it('renders with an agentId and keeps the knowledge-panel container', async () => {
        render(<KnowledgePanel agentId="agent-1" API_BASE="" />);
        expect(await screen.findByTestId('knowledge-panel')).toBeInTheDocument();
    });

    /**
     * (b) THE POINT OF THIS PACKAGE: no request to /agents/:id/knowledge.
     *
     * That endpoint was fetched on mount to fill `items`, and `items` was read
     * only by the `{false && …}` branch — so every agent-designer mount paid
     * for a round trip whose answer was unreachable. Re-adding the call (by
     * restoring the effect, or by "just fetching it in case someone needs it")
     * is exactly the regression this cleanup exists to prevent, so the
     * assertion is on the URLs the transport actually saw, not on the absence
     * of some rendered element.
     */
    it('fires NO request to the legacy /agents/:id/knowledge endpoint', async () => {
        render(<KnowledgePanel agentId="agent-1" API_BASE="" />);
        await screen.findByTestId('knowledge-panel');
        // Let every mount effect in the hook settle before reading the log.
        await waitFor(() => expect(globalThis.__authFetch).toHaveBeenCalled());
        await waitFor(() => {
            expect(globalThis.__seenUrls.some(u => u.includes('/api/kb'))).toBe(true);
        });

        const legacy = globalThis.__seenUrls.filter(u => /\/agents\/[^/]+\/knowledge/.test(u));
        expect(legacy).toEqual([]);
    });

    /**
     * (c) The live UI was not swept up with the dead branch.
     *
     * `kb-create-btn` is one of the ids e2e/context/app-map.md:198-202 pins on
     * this screen, and that file is out of this package's reach — it cannot be
     * updated to follow a rename or a deletion. It sits a few lines above the
     * removed block, which is precisely the position from which a slightly-too-
     * greedy delete takes live markup with it.
     */
    it('keeps the e2e-documented kb-create-btn', async () => {
        render(<KnowledgePanel agentId="agent-1" API_BASE="" />);
        expect(await screen.findByTestId('kb-create-btn')).toBeInTheDocument();
    });
});
