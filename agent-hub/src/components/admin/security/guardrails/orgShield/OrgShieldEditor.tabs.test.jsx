/**
 * The Privacy Shield editor's tab strip.
 *
 * The load-bearing test here is the routing one. This component is mounted on
 * TWO unrelated routes — the org settings page and the admin console — so a
 * tab that writes a PATH segment would navigate the admin console out of
 * itself, and would also fight AdvancedSettings, which pushState's its own
 * 3-segment URL whenever the pathname differs. The tab therefore lives in a
 * query parameter, and "the pathname does not move" is the assertion that
 * keeps it that way.
 *
 * Run: npx vitest run src/components/admin/guardrails/orgShield/OrgShieldEditor.tabs.test.jsx
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(),
}));

vi.mock('../../../../../hooks/useTranslation', () => ({
    // Mirrors the real `t(key, fallbackOrParams?, params?)`, INCLUDING `{x}`
    // interpolation. A mock that drops the params renders raw "{n}"
    // placeholders, so any assertion on a sentence that counts something
    // tests the mock rather than the screen.
    useTranslation: () => ({
        t: (key, fallbackOrParams, paramsArg) => {
            const hasStringFallback = typeof fallbackOrParams === 'string';
            const params = hasStringFallback ? paramsArg : fallbackOrParams;
            let out = hasStringFallback ? fallbackOrParams : key;
            if (params && typeof params === 'object') {
                for (const [k, v] of Object.entries(params)) {
                    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
                }
            }
            return out;
        },
    }),
    __esModule: true,
}));

vi.mock('../../../../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ tier: 'enterprise', hasFeature: () => true, hasTier: () => true }),
}));

import OrgShieldEditor from './OrgShieldEditor';
import { authFetch } from '../../../../../utils/helpers';

const ORG_ID = 'org-alpha';
const SHIELD = {
    enabled: true,
    piiDetectionCategories: ['Email'],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'block',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
};

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

const PATH = '/app/settings/organisation/privacy';

beforeEach(() => {
    window.history.replaceState({}, '', PATH);
    authFetch.mockReset();
    authFetch.mockImplementation(async (url, opts) => {
        if (url.includes('/auth/organizations')) return ok([{ id: ORG_ID, name: 'Alpha BV' }]);
        if (url.includes('/ai/config/chat-models-eu')) return ok({});
        if (url.includes('/ai/config')) return ok({ searchProvider: 'serper' });
        if (url.includes('/api/org-privacy-shield/')) {
            if (opts?.method === 'PUT') return ok({ ok: true, config: SHIELD });
            return ok(SHIELD);
        }
        return ok({});
    });
});

const renderEditor = async (props = {}) => {
    render(<OrgShieldEditor orgId={ORG_ID} {...props} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Overview/ })).toBeInTheDocument());
};

describe('OrgShieldEditor tabs', () => {
    it('offers exactly five tabs, "Your own data" third, and lands on Overview', async () => {
        await renderEditor();
        const tabs = screen.getAllByRole('tab');
        // Anchored at the start, not equality: each tab also carries its own
        // read-out (see the summaries test below), so the accessible name is
        // the label followed by the current value. The step number in front
        // is decoration and must not be part of the name.
        expect(tabs).toHaveLength(5);
        // The org's own kinds sit right after the built-in ones: they are
        // found in the same scan, so they are the same stage of the path.
        ['Overview', 'What we look for', 'Your own data', 'When we find something', 'Leaving your org'].forEach((label, i) => {
            expect(tabs[i]).toHaveAccessibleName(new RegExp(`^${label}`));
        });
        expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('is a pipeline: each stage shows the value it currently holds', async () => {
        // The strip doubles as a read-out, so the whole policy is legible
        // without opening three panes — and a stage whose value is a problem
        // says so where you can see it from any pane.
        await renderEditor();
        // SHIELD has one category of 21 at the Balanced level, action
        // 'block', no last check and no kind held back from outside tools.
        expect(screen.getByRole('tab', { name: /What we look for/ }).textContent).toContain('1 of 21 · Balanced');
        expect(screen.getByRole('tab', { name: /When we find something/ }).textContent).toContain('stopped');
        expect(screen.getByRole('tab', { name: /Leaving your org/ }).textContent).toContain('no last check · tools open');
        // The optional last check is the one thing on the review list.
        expect(screen.getByRole('tab', { name: /Overview/ }).textContent).toContain('1 to review');
        expect(screen.getByRole('tab', { name: /Your own data/ }).textContent).toContain('none yet');
    });

    it('counts the org\'s own types apart from the 21 built-in kinds', async () => {
        // Their ids ride in the same category list, so a naive count would
        // read "2/21" for one built-in kind plus one custom type.
        authFetch.mockImplementation(async (url) => {
            if (url.includes('/auth/organizations')) return ok([{ id: ORG_ID, name: 'Alpha BV' }]);
            if (url.includes('/ai/config')) return ok({});
            if (url.includes('/api/org-privacy-shield/')) {
                return ok({
                    ...SHIELD,
                    piiDetectionCategories: ['Email', 'cdt_0123456789'],
                    customDataTypes: [{ id: 'cdt_0123456789', name: 'Codes', method: 'words', tokenKey: 'code', origin: 'created', words: { values: ['A'] } }],
                });
            }
            return ok({});
        });
        await renderEditor();
        expect(screen.getByRole('tab', { name: /What we look for/ }).textContent).toContain('1 of 21 ·');
        expect(screen.getByRole('tab', { name: /Your own data/ }).textContent).toContain('1 type');
    });

    it('the bookends that draw the flow are decoration, not destinations', async () => {
        // "Message" and "AI model" picture what the pipeline runs between.
        // They are not places you can go, so they must not be tabs — four
        // tabs and seven tab stops would be a lie to a keyboard user.
        await renderEditor();
        expect(screen.getAllByRole('tab')).toHaveLength(5);
        expect(screen.queryByRole('tab', { name: /AI model/ })).toBeNull();
    });

    it('surfaces zero-categories on the strip itself', async () => {
        // The misconfiguration this screen exists to catch: shield on, nothing
        // ticked, so nothing is ever found. Visible from every pane now, not
        // only from the Overview summary.
        authFetch.mockImplementation(async (url, opts) => {
            if (url.includes('/auth/organizations')) return ok([{ id: ORG_ID, name: 'Alpha BV' }]);
            if (url.includes('/ai/config/chat-models-eu')) return ok({});
            if (url.includes('/ai/config')) return ok({ searchProvider: 'serper' });
            if (url.includes('/api/org-privacy-shield/')) {
                if (opts?.method === 'PUT') return ok({ ok: true });
                return ok({ ...SHIELD, piiDetectionCategories: [] });
            }
            return ok({});
        });
        await renderEditor();
        expect(screen.getByRole('tab', { name: /What we look for/ }).textContent).toContain('0 of 21');
        expect(screen.getByRole('tab', { name: /Overview/ }).textContent).toMatch(/2 to review/);
    });

    it('moves selection AND focus with the arrow keys', async () => {
        // Two things at once, and the second is the fragile one. The strip is
        // built from a `Tab` component that must be declared at MODULE level:
        // declared inside ShieldPipeline it is a new component type on every
        // render, so React replaces all five buttons whenever anything
        // changes — and the focus this test asserts lands on a node that no
        // longer exists, dropping the keyboard user back to the body.
        const user = userEvent.setup();
        await renderEditor();

        const overview = screen.getByRole('tab', { name: /Overview/ });
        overview.focus();
        await user.keyboard('{ArrowRight}');

        const detection = screen.getByRole('tab', { name: /What we look for/ });
        expect(detection).toHaveAttribute('aria-selected', 'true');
        expect(detection).toHaveFocus();

        await user.keyboard('{End}');
        const last = screen.getByRole('tab', { name: /Leaving your org/ });
        expect(last).toHaveAttribute('aria-selected', 'true');
        expect(last).toHaveFocus();
    });

    it('skips a disabled stage when arrowing, rather than landing on it', async () => {
        // With the shield off the three policy stages are disabled, so the
        // only arrow destinations are Overview and What happened.
        authFetch.mockImplementation(async (url, opts) => {
            if (url.includes('/auth/organizations')) return ok([{ id: ORG_ID, name: 'Alpha BV' }]);
            if (url.includes('/ai/config/chat-models-eu')) return ok({});
            if (url.includes('/ai/config')) return ok({ searchProvider: 'serper' });
            if (url.includes('/api/org-privacy-shield/')) {
                if (opts?.method === 'PUT') return ok({ ok: true });
                return ok({ ...SHIELD, enabled: false });
            }
            return ok({});
        });
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });

        screen.getByRole('tab', { name: /Overview/ }).focus();
        await user.keyboard('{ArrowRight}');

        expect(screen.getByRole('tab', { name: /What happened/ })).toHaveFocus();
        expect(screen.getByRole('tab', { name: /What we look for/ })).toBeDisabled();
    });

    it('explains itself IN the app, not by leaving it', async () => {
        // It used to be an <a> to docs.beeflow.nl: it abandoned a screen that
        // may hold unsaved edits, it is unreachable on an air-gapped
        // self-host, and the page it pointed at documented an older version of
        // this very screen.
        const user = userEvent.setup();
        await renderEditor();

        const button = screen.getByRole('button', { name: /How this works/ });
        expect(button.tagName).toBe('BUTTON');
        expect(button).not.toHaveAttribute('href');

        await user.click(button);
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toBeInTheDocument();
        // The two things an admin most often gets wrong about this screen.
        expect(dialog.textContent).toMatch(/not alternatives/i);
        expect(dialog.textContent).toMatch(/LOWER percentage finds MORE/i);
    });

    it('the explainer can hand you straight to the pane it just described', async () => {
        const user = userEvent.setup();
        await renderEditor();

        await user.click(screen.getByRole('button', { name: /How this works/ }));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: /Open the matrix/ }));

        // The panel closes and the strip moves — an explanation you have to
        // dismiss and then navigate from yourself is a worse docs page.
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.getByRole('tab', { name: /What we look for/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('keeps the pathname byte-identical when a tab is clicked', async () => {
        // THE regression test for the routing decision. A path-segment tab
        // would rewrite this to /app/settings/organisation/privacy/detection —
        // and on the admin console mount it would navigate away entirely.
        const user = userEvent.setup();
        await renderEditor();

        await user.click(screen.getByRole('tab', { name: /Leaving your org/ }));

        expect(window.location.pathname).toBe(PATH);
        expect(new URLSearchParams(window.location.search).get('tab')).toBe('outbound');
    });

    it('honours ?tab= on mount', async () => {
        window.history.replaceState({}, '', `${PATH}?tab=processing`);
        await renderEditor();
        expect(screen.getByRole('tab', { name: /When we find something/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('falls back to Overview for an unknown tab rather than rendering nothing', async () => {
        window.history.replaceState({}, '', `${PATH}?tab=nonsense`);
        await renderEditor();
        expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('does not write the default tab into the URL on mount', async () => {
        // Normalising on mount would litter the admin console's URL and race
        // its own replaceState.
        await renderEditor();
        expect(window.location.search).toBe('');
    });

    it('puts each control on exactly one tab', async () => {
        const user = userEvent.setup();
        await renderEditor();

        // Overview is a read-only summary plus the master switch.
        expect(screen.getByText('Kinds of data')).toBeInTheDocument();
        expect(screen.queryByText('When we find personal data')).toBeNull();

        await user.click(screen.getByRole('tab', { name: /What we look for/ }));
        expect(screen.getByRole('radio', { name: /Balanced/ })).toBeInTheDocument();
        expect(screen.queryByText('When we find personal data')).toBeNull();

        // Steps 3 and 4 are two panes: each shows its own card only. They
        // used to share one pane, which made ?tab=processing and
        // ?tab=outbound the same screen.
        await user.click(screen.getByRole('tab', { name: /When we find something/ }));
        expect(screen.getByText('When we find personal data')).toBeInTheDocument();
        expect(screen.queryByRole('radio', { name: /Balanced/ })).toBeNull();
        expect(screen.queryByText('One last check before an outside AI')).toBeNull();

        await user.click(screen.getByRole('tab', { name: /Leaving your org/ }));
        expect(screen.getByText('One last check before an outside AI')).toBeInTheDocument();
        expect(screen.queryByText('When we find personal data')).toBeNull();
    });

    it('disables the control tabs while the shield is off', async () => {
        authFetch.mockImplementation(async (url) => {
            if (url.includes('/auth/organizations')) return ok([{ id: ORG_ID, name: 'Alpha BV' }]);
            if (url.includes('/ai/config/chat-models-eu')) return ok({});
            if (url.includes('/ai/config')) return ok({});
            if (url.includes('/api/org-privacy-shield/')) return ok({ ...SHIELD, enabled: false });
            return ok({});
        });
        await renderEditor();

        // Three panes of inert switches would be worse than saying why.
        expect(screen.getByRole('tab', { name: /What we look for/ })).toBeDisabled();
        expect(screen.getByRole('tab', { name: /When we find something/ })).toBeDisabled();
        expect(screen.getByRole('tab', { name: /Leaving your org/ })).toBeDisabled();
        expect(screen.getByRole('tab', { name: /Your own data/ })).toBeDisabled();
        expect(screen.getByRole('tab', { name: /Overview/ })).toBeEnabled();
        expect(screen.getByText(/Protection is off/i)).toBeInTheDocument();
    });

    it('lets the Overview summary jump to the tab that owns a setting', async () => {
        const user = userEvent.setup();
        await renderEditor();
        // The summary never duplicates a control; it points at one. Each step
        // card's link opens the tab that owns that step.
        await user.click(screen.getByRole('button', { name: 'Change What we look for' }));
        expect(screen.getByRole('tab', { name: /What we look for/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('does not touch the URL at all when the host opts out', async () => {
        // GuardrailsHub owns its own URL; a tab click there must not write one.
        const user = userEvent.setup();
        await renderEditor({ urlParam: null });
        await user.click(screen.getByRole('tab', { name: /Leaving your org/ }));
        expect(window.location.search).toBe('');
        expect(screen.getByRole('tab', { name: /Leaving your org/ })).toHaveAttribute('aria-selected', 'true');
    });
});
