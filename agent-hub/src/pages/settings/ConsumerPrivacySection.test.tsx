import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ConsumerPrivacySection from './ConsumerPrivacySection';
import { renderWithClient as render } from '../../test/render';
import { authFetch } from '../../utils/helpers';
import { asMock } from '@/test/mocks';

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const jsonRes = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

// The server's USER_SHIELD_DEFAULTS as delivered by GET /user/me when the user
// has never saved (BFSF-289): protecting, and flagged as an implicit default.
const IMPLICIT_DEFAULTS = {
    enabled: true,
    euModeEnabled: false,
    disableSearchOnUpload: false,
    piiDetectionEnabled: true,
    piiDetectionCategories: [],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'tokenize',
    piiFailureMode: 'fail_closed',
    showRawPayload: false,
    implicitDefault: true,
};

/** Route the two GETs the panel fires on mount, and the PUT of Save. */
function mockApi({ config = IMPLICIT_DEFAULTS, guard = { configured: true, reachable: true }, save = () => jsonRes({ ok: true }) } = {}) {
    asMock(authFetch).mockImplementation(async (url: string, opts = {}) => {
        if (opts.method === 'PUT') return save();
        if (String(url).includes('guard-status')) return jsonRes(guard);
        return jsonRes(config);
    });
}

describe('ConsumerPrivacySection', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('BFSF-289: a never-configured account shows the shield ON and labels it a default', async () => {
        mockApi();
        render(<ConsumerPrivacySection />);

        await screen.findByText('On by default');
        expect(screen.getByText(/already in force with the secure defaults/i)).toBeInTheDocument();

        expect(screen.getByRole('checkbox', { name: 'Enable Privacy Shield' })).toBeChecked();
    });

    it('names every switch after the row it controls', async () => {
        mockApi({ config: { ...IMPLICIT_DEFAULTS, euModeEnabled: true } });
        render(<ConsumerPrivacySection />);

        expect(await screen.findByRole('checkbox', { name: 'EU Data Residency' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Disable Search on File Upload' })).not.toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Look for personal data' })).toBeChecked();
    });

    it('a switch changes what Save sends', async () => {
        mockApi();
        const user = userEvent.setup();
        render(<ConsumerPrivacySection />);

        await user.click(await screen.findByRole('checkbox', { name: 'EU Data Residency' }));
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-privacy-shield/user/me', expect.objectContaining({ method: 'PUT' })));
        const put = asMock(authFetch).mock.calls.find(([, opts]) => opts?.method === 'PUT');
        expect(JSON.parse(put![1].body).euModeEnabled).toBe(true);
        expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
    });

    it('says so when the server refuses the save', async () => {
        mockApi({ save: () => jsonRes({ error: 'nope' }, 500) });
        const user = userEvent.setup();
        render(<ConsumerPrivacySection />);

        await user.click(await screen.findByRole('button', { name: 'Save' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
        expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
    });

    it('says so when the save request does not go through', async () => {
        mockApi({ save: () => { throw new Error('offline'); } });
        const user = userEvent.setup();
        render(<ConsumerPrivacySection />);

        await user.click(await screen.findByRole('button', { name: 'Save' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
    });

    it('does not label a saved configuration as a default', async () => {
        mockApi({ config: { ...IMPLICIT_DEFAULTS, implicitDefault: false } });
        render(<ConsumerPrivacySection />);

        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByText('Enable Privacy Shield')).toBeInTheDocument());
        expect(screen.queryByText('On by default')).not.toBeInTheDocument();
    });

    it('warns when the shield is on but the PII Guard is not configured', async () => {
        mockApi({ guard: { configured: false, reachable: false } });
        render(<ConsumerPrivacySection />);

        await screen.findByText('Personal-data check unavailable');
        expect(screen.getByText(/not set up on this server/i)).toBeInTheDocument();
    });

    it('warns when the guard is configured but unreachable', async () => {
        mockApi({ guard: { configured: true, reachable: false } });
        render(<ConsumerPrivacySection />);
        await screen.findByText('Personal-data check unavailable');
    });

    it('stays quiet when the guard is healthy', async () => {
        mockApi();
        render(<ConsumerPrivacySection />);

        await screen.findByText('Enable Privacy Shield');
        expect(screen.queryByText('Personal-data check unavailable')).not.toBeInTheDocument();
    });

    it('does not warn about the guard when the shield is switched off', async () => {
        mockApi({
            config: { ...IMPLICIT_DEFAULTS, enabled: false, implicitDefault: false },
            guard: { configured: false, reachable: false },
        });
        render(<ConsumerPrivacySection />);

        await screen.findByText('Enable Privacy Shield');
        expect(screen.queryByText('Personal-data check unavailable')).not.toBeInTheDocument();
    });
});
