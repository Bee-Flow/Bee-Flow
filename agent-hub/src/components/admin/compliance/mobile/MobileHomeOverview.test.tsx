import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import MobileHomeOverview, { attentionTarget } from './MobileHomeOverview';

/**
 * Where a tap on the phone's Overview goes. The server hands every deadline
 * and attention row an APP PATH (`/app/admin/compliance/<section>[/<id>][?tab=]`);
 * the client fallback hands `{ section, id }`. Both shapes must navigate, and a
 * `?tab=` that moved to another section (sections.js legacyTabs) lands there.
 */
vi.mock('../../../../hooks/useTranslation', () => {
    const t = (key: string, fallback?: unknown, vars?: Record<string, unknown>) => {
        let s = typeof fallback === 'string' ? fallback : key;
        for (const [k, v] of Object.entries(vars || {})) s = s.replace(`{${k}}`, String(v));
        return s;
    };
    return { useTranslation: () => ({ t }), default: () => ({ t }) };
});

const DUE = new Date(Date.now() + 3 * 86_400_000).toISOString();
const STARTED = new Date(Date.now() - 27 * 86_400_000).toISOString();

const DEADLINES = [
    { id: 'dsr:dsr_2417', kind: 'dsr', ref: '#2417', title: 'Access request', state: 'urgent', due_at: DUE, started_at: STARTED,
        target: '/app/admin/compliance/dsr/dsr_2417' },
    { id: 'obligation:obl_3', kind: 'obligation', ref: 'training', title: 'Annual security awareness refresher', state: 'overdue', due_at: STARTED,
        target: '/app/admin/compliance/audits?tab=obligations' },
    { id: 'attestation_expiry:agent:a1', kind: 'attestation_expiry', ref: 'Agent', title: 'Helpdesk', state: 'ok', due_at: DUE,
        target: '/app/admin/compliance/frameworks?tab=per_automation' },
    { id: 'dsr:local', kind: 'dsr', ref: '#9', title: 'Deletion request', state: 'ok', due_at: DUE,
        target: { section: 'dsr', id: 'req/9' } },
];

function mount() {
    const navigate = vi.fn();
    const data = {
        core: { checks: [] },
        counts: null,
        attention: { items: [], failed: false },
        deadlines: { items: DEADLINES, failed: false },
        frameworks: { isEnabled: () => false },
    };
    render(<MobileHomeOverview data={data} navigate={navigate} />);
    return { navigate, user: userEvent.setup() };
}

describe('MobileHomeOverview — every deadline row opens its target', () => {
    it('opens the request from a server path', async () => {
        const { navigate, user } = mount();
        await user.click(screen.getByTestId('mobile-deadline-dsr:dsr_2417'));
        expect(navigate).toHaveBeenCalledWith('dsr', 'dsr_2417', undefined);
    });

    it('sends the obligation row to Training (the legacy audits tab is aliased)', async () => {
        const { navigate, user } = mount();
        await user.click(screen.getByTestId('mobile-deadline-obligation:obl_3'));
        expect(navigate).toHaveBeenCalledWith('training', undefined, undefined);
    });

    it('keeps the tab of a target that carries one (a moved tab goes where it went)', async () => {
        const { navigate, user } = mount();
        await user.click(screen.getByTestId('mobile-deadline-attestation_expiry:agent:a1'));
        expect(navigate).toHaveBeenCalledWith('aia', undefined, 'systems');
    });

    it('still follows a client-fallback object target', async () => {
        const { navigate, user } = mount();
        await user.click(screen.getByTestId('mobile-deadline-dsr:local'));
        expect(navigate).toHaveBeenCalledWith('dsr', 'req/9', undefined);
    });
});

describe('attentionTarget', () => {
    it('keeps the tab and applies the legacy alias', () => {
        expect(attentionTarget({ action: { target: '/app/admin/compliance/frameworks?tab=per_automation' } }))
            .toEqual({ section: 'aia', id: null, tab: 'systems' });
        expect(attentionTarget({ action: { target: '/app/admin/compliance/audits?tab=obligations' } }))
            .toEqual({ section: 'training', id: null });
        expect(attentionTarget({ action: { target: '/app/settings/organisation/compliance/dpia/ag%2F9' } }))
            .toEqual({ section: 'dpia', id: 'ag/9' });
    });
});
