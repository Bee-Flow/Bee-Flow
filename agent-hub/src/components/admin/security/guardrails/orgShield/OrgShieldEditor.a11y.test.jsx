/**
 * Accessibility contract for the Privacy Shield editor.
 *
 * Every assertion here corresponds to something that was actually broken:
 *
 *   - seven switches were `<input class="sr-only">` inside a `<label>` that
 *     wrapped only the visual track, with the title as a sibling. A screen
 *     reader announced seven anonymous checkboxes, one of them the master
 *     enable, and clicking the title did nothing;
 *   - the sensitivity and action cards were plain `<button>`s, so "which one
 *     is selected" was carried by colour alone and nothing said the options
 *     were mutually exclusive;
 *   - the twenty-one category checkboxes were a bare grid under a `<label>`
 *     that labelled nothing;
 *   - every category icon rendered `role="img"` with an accessible name of
 *     `null`, because the id lookup feeding it had `return null` as its entire
 *     body — twenty-one nameless "image" announcements between the labels.
 *
 * Run: npx vitest run src/components/admin/guardrails/orgShield/OrgShieldEditor.a11y.test.jsx
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
    dlpEnabled: true,
    dlpMode: 'ask',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
};

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    window.history.replaceState({}, '', '/app/settings/organisation/privacy');
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

async function renderOn(tabName) {
    const user = userEvent.setup();
    render(<OrgShieldEditor orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Overview/ })).toBeInTheDocument());
    if (tabName) await user.click(screen.getByRole('tab', { name: tabName }));
    return user;
}

describe('Privacy Shield accessibility', () => {
    it('gives every switch an accessible name', async () => {
        await renderOn(/Leaving your org/);
        const switches = screen.getAllByRole('checkbox');
        expect(switches.length).toBeGreaterThan(0);
        for (const box of switches) {
            expect(box).toHaveAccessibleName();
        }
    });

    it('names the master enable switch', async () => {
        await renderOn();
        expect(screen.getByRole('checkbox', { name: /Enable/i })).toBeInTheDocument();
    });

    it('renders the action choice as a radiogroup with exactly one checked option', async () => {
        await renderOn(/When we find something/);
        const group = screen.getByRole('radiogroup', { name: /What happens when we find personal data/ });
        const radios = within(group).getAllByRole('radio');
        expect(radios.length).toBe(2);
        expect(radios.filter(r => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    });

    it('renders the sensitivity choice as a radiogroup with exactly one checked option', async () => {
        await renderOn(/What we look for/);
        const group = screen.getByRole('radiogroup', { name: /How strict should we be/ });
        const radios = within(group).getAllByRole('radio');
        expect(radios.length).toBe(3);
        // Native radio inputs: their state is `checked`, not aria-checked.
        expect(radios.filter(r => r.checked)).toHaveLength(1);
    });

    it('names every category checkbox by its kind AND its column', async () => {
        await renderOn(/What we look for/);

        // The three 21-item grids became one matrix, so the grouping problem
        // changed shape. A fieldset+legend named twenty-one checkboxes as one
        // group, which was right when the group answered ONE question. Here
        // each row answers three ("hide from the AI", "withhold from outside
        // tools", "withhold from own-server tools"), and a screen-reader user
        // needs to know which cell they are in — so every box carries both
        // coordinates in its accessible name.
        const boxes = screen.getAllByRole('checkbox');
        expect(boxes.length).toBeGreaterThanOrEqual(21);
        for (const box of boxes) {
            expect(box).toHaveAccessibleName();
        }

        // Asserted on the COLUMN half only. The kind half is a `pii.*` i18n
        // key, which the mocked `t` here returns raw (the real catalogue sets
        // no inline fallback for the 21 labels — they live in en-defaults), so
        // pinning "Email addresses" would test the mock rather than the markup.
        const names = boxes.map(b => b.getAttribute('aria-label') || '');
        for (const column of ['Hide from AI', 'Outside tools', 'Own server']) {
            expect(names.filter(n => n.endsWith(`— ${column}`)).length).toBe(21);
        }
        // And every name carries BOTH coordinates, not just the column.
        expect(names.every(n => / — /.test(n))).toBe(true);
    });

    it('renders the matrix as a real table with row and column headers', async () => {
        // The whole value of the control is the cross-reference, and a table
        // cell is what announces "Person names, Outside tools, checked".
        // Sixty-three divs do not.
        await renderOn(/What we look for/);
        // ONE table, one <tbody> per group, with one set of column headers.
        const tables = screen.getAllByRole('table', { name: /kind of personal data/i });
        expect(tables).toHaveLength(1);
        for (const table of tables) {
            for (const column of ['Hide from AI', 'Outside tools', 'Own server']) {
                expect(within(table).getByRole('columnheader', { name: new RegExp(column, 'i') })).toBeTruthy();
            }
        }
        // One row header per kind — that is what makes a cell announce its row.
        expect(screen.getAllByRole('rowheader')).toHaveLength(21);
    });

    it('has no icon announced as a nameless image', async () => {
        const user = await renderOn(/What we look for/);
        for (const tab of [/What we look for/, /When we find something/, /Leaving your org/]) {
            await user.click(screen.getByRole('tab', { name: tab }));
            // getAllByRole('img') only returns elements EXPOSED as images.
            // Decorative icons are aria-hidden and must not appear at all.
            const imgs = screen.queryAllByRole('img');
            for (const img of imgs) {
                expect(img, `an icon on ${tab} has no accessible name`).toHaveAccessibleName();
            }
        }
    });

    it('labels the org picker when it is shown', async () => {
        authFetch.mockImplementation(async (url) => {
            if (url.includes('/auth/organizations')) {
                return ok([{ id: ORG_ID, name: 'Alpha BV' }, { id: 'org-beta', name: 'Beta NV' }]);
            }
            if (url.includes('/ai/config/chat-models-eu')) return ok({});
            if (url.includes('/ai/config')) return ok({});
            if (url.includes('/api/org-privacy-shield/')) return ok(SHIELD);
            return ok({});
        });
        render(<OrgShieldEditor allowOrgPicker />);
        await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
        expect(screen.getByRole('combobox')).toHaveAccessibleName();
    });

    it('names every switch on Your own data by type AND column, in a real table', async () => {
        // Same contract as the matrix: a cell has to announce which type and
        // which question it answers.
        authFetch.mockImplementation(async (url) => {
            if (url.includes('/auth/organizations')) return ok([{ id: ORG_ID, name: 'Alpha BV' }]);
            if (url.includes('/ai/config')) return ok({});
            if (url.includes('/api/org-privacy-shield/')) {
                return ok({
                    ...SHIELD,
                    piiDetectionCategories: ['Email', 'cdt_0123456789'],
                    customDataTypes: [{ id: 'cdt_0123456789', name: 'Project codes', method: 'ai', tokenKey: 'project_code', origin: 'created', ai: { prompt: 'project code', floor: 0.5 } }],
                });
            }
            return ok({});
        });
        await renderOn(/Your own data/);
        const table = screen.getByRole('table', { name: /Your own kinds of data/ });
        expect(within(table).getByRole('rowheader', { name: /Project codes/ })).toBeInTheDocument();
        const boxes = within(table).getAllByRole('checkbox');
        expect(boxes.map(b => b.getAttribute('aria-label'))).toEqual([
            'Project codes, Hide from AI', 'Project codes, Outside tools', 'Project codes, Own server',
        ]);
        expect(boxes[0]).toBeChecked();
        for (const img of screen.queryAllByRole('img')) expect(img).toHaveAccessibleName();
    });

    it('exposes the DLP mode as a named radiogroup rather than a bare select', async () => {
        await renderOn(/Leaving your org/);
        const group = screen.getByRole('radiogroup', { name: /What to do when it finds something/ });
        expect(within(group).getAllByRole('radio')).toHaveLength(3);
    });
});
