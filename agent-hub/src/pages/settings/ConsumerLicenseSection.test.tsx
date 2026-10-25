// Settings → Account → License & Usage for a consumer account. Pinned: the
// AI-usage percentage is shown once, as the "Usage This Period" bar; the
// plan card no longer repeats it as a quick stat.
import { screen } from '@testing-library/react';
import { renderWithClient as render } from '../../test/render';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: (...args: unknown[]) => authFetch(...args) }));

import ConsumerLicenseSection from './ConsumerLicenseSection';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('ConsumerLicenseSection', () => {
    beforeEach(() => {
        authFetch.mockReset();
        authFetch.mockImplementation(async (url: string) => {
            if (url === '/api/subscriptions/consumer/usage') {
                return ok({
                    limits: { plan_name: 'Plus', max_cost_per_month: 20, max_agents: 5, max_knowledge_sources: 3 },
                    usage: { total_billed_cost: 5 },
                    billing_period: null,
                    subscription: null,
                });
            }
            if (url === '/api/stripe/status') return ok({ enabled: false });
            return { ok: false, status: 404, json: async () => ({}) };
        });
    });

    it('shows the AI-usage percentage once, in the usage bar', async () => {
        render(<ConsumerLicenseSection user={{}} />);
        expect(await screen.findByText('Usage This Period')).toBeInTheDocument();
        expect(screen.getAllByText(/25%/)).toHaveLength(1);
        expect(screen.queryByText(/AI usage of cap this period/i)).not.toBeInTheDocument();
    });
});
