import { render, screen, waitFor, within } from '@testing-library/react';
import type React from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../../../../hooks/useTranslation', async () => {
    const kit = await import('./testKit');
    return { useTranslation: () => ({ t: kit.t }), __esModule: true };
});
vi.mock('../../../../../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ tier: 'enterprise', hasFeature: () => true, hasTier: () => true }),
}));

import OrgShieldEditorJs from '../OrgShieldEditor';
import type { CustomDataType } from './ownDataModel';
import { LEGACY_TYPE, WORDS_TYPE, renderableTab } from './testKit';
import { authFetch } from '../../../../../../utils/helpers';

// The editor is plain JSX, so its props infer loosely; name the one used here.
const OrgShieldEditor = OrgShieldEditorJs as unknown as React.ComponentType<{ orgId: string }>;

/**
 * The "Your own data" tab: the list an Enterprise admin works in, the
 * read-only view a Community admin gets, and the three edits the tab makes
 * to the shield form. Nothing here saves; the editor's Save does, so the
 * assertions read the FORM back.
 */

const PATTERN_TYPE: CustomDataType = {
    id: 'cdt_0000000003', name: 'Customer numbers', description: '', method: 'pattern', tokenKey: 'customer_number',
    origin: 'created', pattern: { source: '(', caseSensitive: false, error: 'Unterminated group' }, status: 'invalid',
};
const AI_TYPE: CustomDataType = {
    id: 'cdt_0000000004', name: 'Project code names', description: '', method: 'ai', tokenKey: 'project_code',
    origin: 'created', ai: { prompt: 'project code name', floor: 0.5 }, quality: { found: 3, total: 4, falseAlarms: 0, sentences: 5, stale: true },
};

describe('the list (Enterprise)', () => {
    it('opens on starters when there is nothing yet', async () => {
        const user = userEvent.setup();
        const { ui } = renderableTab();
        render(ui);
        expect(screen.getByRole('heading', { name: 'Hide things only your organisation uses' })).toBeInTheDocument();
        expect(screen.getByText(/just like names and email addresses, in chat, agents and routines\./)).toBeInTheDocument();
        expect(screen.getByRole('group', { name: 'Start from an example' })).toBeInTheDocument();
        for (const s of ['Project code names', 'Customer or contract numbers', 'A list of names or words', 'Describe it in your words']) {
            expect(screen.getByRole('button', { name: s })).toBeInTheDocument();
        }
        // The tile shows the placeholder the wizard will really give the type.
        expect(screen.getByRole('button', { name: 'Customer or contract numbers' }))
            .toHaveAccessibleDescription('A pattern, like two letters and four digits. KC-2291, KC-0412 becomes [customer_number_1]');
        expect(screen.getByRole('button', { name: 'Project code names' })).toHaveAccessibleDescription(/\[project_code_1\]$/);
        await user.click(screen.getByRole('button', { name: 'Customer or contract numbers' }));
        expect(screen.getByRole('heading', { name: 'New type' })).toBeInTheDocument();
        expect(screen.getByLabelText('Name')).toHaveValue('Customer numbers');
        expect(screen.getByRole('radio', { name: /A fixed format/ })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByText(/The AI sees it as \[customer_number_1\]/)).toBeInTheDocument();
    });

    it('says how each type is doing, in words', () => {
        const { ui } = renderableTab({ init: { types: [WORDS_TYPE, PATTERN_TYPE, AI_TYPE, LEGACY_TYPE] } });
        render(ui);
        const row = (name: string) => screen.getByRole('rowheader', { name: new RegExp(name) }).closest('tr') as HTMLElement;
        // The result is in its own column and, for a narrow pane, again under
        // "How we find it" (CSS shows one of the two), so it appears twice.
        expect(within(row('Product names')).getAllByText('Finds 19 of 20 · 1 false alarm')).toHaveLength(2);
        expect(within(row('Product names')).getByText('A list of words · 2 words')).toBeInTheDocument();
        expect(within(row('Product names')).getByText('[product_1]')).toBeInTheDocument();
        expect(within(row('Customer numbers')).getAllByText('Pattern does not work: Unterminated group')).toHaveLength(2);
        expect(within(row('Project code names')).getAllByText('Changed since the last test')).toHaveLength(2);
        expect(within(row('Old codename')).getAllByText('Not tested yet')).toHaveLength(2);
        expect(within(row('Old codename')).getByText('From your old list')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Hide things only your organisation uses' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add a type' })).toBeEnabled();
    });

    it('opens the wizard with the sentence typed under Or describe it', async () => {
        const user = userEvent.setup();
        const { ui, form } = renderableTab();
        render(ui);
        const create = screen.getByRole('button', { name: 'Create type' });
        expect(create).toBeDisabled();
        await user.type(screen.getByLabelText('Or describe it'), 'Our claim numbers start with SD- and six digits{Enter}');
        expect(screen.getByRole('heading', { name: 'New type' })).toBeInTheDocument();
        expect(screen.getByLabelText('Describe it in one sentence')).toHaveValue('Our claim numbers start with SD- and six digits');
        // Named by the admin, found however they choose: nothing is picked for them.
        expect(screen.getByLabelText('Name')).toHaveValue('');
        expect(screen.getByRole('radio', { name: /A fixed format/ })).toHaveAttribute('aria-checked', 'false');
        // Opening the wizard adds nothing to the form.
        expect(form.current?.customDataTypes).toEqual([]);
    });

    it('does not promise routines when the shield is off for them', () => {
        const { ui } = renderableTab({ init: { applyToAutomations: false } });
        render(ui);
        expect(screen.getByText(/just like names and email addresses, in chat and agents\./)).toBeInTheDocument();
        expect(screen.queryByText(/routines/)).toBeNull();
    });

    it('lets a read-only admin look, not start', () => {
        const { ui } = renderableTab({ readOnly: true });
        render(ui);
        expect(screen.getByRole('button', { name: 'Project code names' })).toBeDisabled();
        expect(screen.getByLabelText('Or describe it')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Create type' })).toBeDisabled();
        expect(screen.queryByLabelText('Add a name that should stay visible')).toBeNull();
    });

});

describe('the list\'s edits to the form', () => {
    it('writes the three switches into the shield\'s own lists', async () => {
        const user = userEvent.setup();
        const { ui, form } = renderableTab({
            init: { types: [WORDS_TYPE], piiCategories: ['Email', WORDS_TYPE.id] },
        });
        render(ui);
        await user.click(screen.getByRole('checkbox', { name: 'Product names, Own server' }));
        await user.click(screen.getByRole('checkbox', { name: 'Product names, Outside tools' }));
        await user.click(screen.getByRole('checkbox', { name: 'Product names, Hide from AI' }));
        expect(form.current?.toolPiiPolicy.internal.blockCategories).toEqual([WORDS_TYPE.id]);
        expect(form.current?.toolPiiPolicy.external.blockCategories).toEqual([WORDS_TYPE.id]);
        expect(form.current?.piiCategories).toEqual(['Email']);
    });

    it('locks Outside tools without the Enterprise tool guard, like the matrix', () => {
        const { ui } = renderableTab({ init: { types: [WORDS_TYPE] }, canUseWebSearchGuard: false });
        render(ui);
        expect(screen.queryByRole('checkbox', { name: 'Product names, Outside tools' })).toBeNull();
        expect(screen.getByRole('checkbox', { name: 'Product names, Own server' })).toBeEnabled();
    });

    it('removes a type with its tests and its list entries, after asking', async () => {
        const user = userEvent.setup();
        const { ui, form } = renderableTab({
            init: {
                types: [WORDS_TYPE],
                tests: { [WORDS_TYPE.id]: { examples: [], sentences: [] } },
                piiCategories: ['Email', WORDS_TYPE.id],
                toolPiiPolicy: { external: { blockCategories: [WORDS_TYPE.id] }, internal: { blockCategories: ['Person', WORDS_TYPE.id] } },
            },
        });
        render(ui);
        await user.click(screen.getByRole('button', { name: 'Remove Product names' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(form.current?.customDataTypes).toEqual([]));
        expect(form.current?.customDataTests).toEqual({});
        expect(form.current?.piiCategories).toEqual(['Email']);
        expect(form.current?.toolPiiPolicy).toEqual({ external: { blockCategories: [] }, internal: { blockCategories: ['Person'] } });
        expect(screen.getByRole('status')).toHaveTextContent('Removed. Press Save to make it final.');
    });

    it('keeps the type when the admin cancels the removal', async () => {
        const user = userEvent.setup();
        const { ui, form } = renderableTab({ init: { types: [WORDS_TYPE] } });
        render(ui);
        await user.click(screen.getByRole('button', { name: 'Remove Product names' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
        expect(form.current?.customDataTypes).toHaveLength(1);
    });

    it('warns that AI types find nothing while the detection service is down', () => {
        const { ui } = renderableTab({ init: { types: [AI_TYPE] }, guard: { configured: true, reachable: false } });
        render(ui);
        expect(screen.getByText(/Types recognised by AI find nothing while the detection service is not running/)).toBeInTheDocument();
    });

    it('marks the row the server refused on the last save', () => {
        const { ui } = renderableTab({ init: { types: [WORDS_TYPE] }, typeErrors: [{ id: WORDS_TYPE.id, message: 'Too many words.' }] });
        render(ui);
        expect(screen.getByRole('alert')).toHaveTextContent('Not saved: Too many words.');
    });
});

describe('the locked view (Community)', () => {
    it('shows migrated types read-only, with Remove as the only change', async () => {
        const user = userEvent.setup();
        const { ui, form } = renderableTab({ licensed: false, init: { types: [LEGACY_TYPE, WORDS_TYPE], piiCategories: ['Email', LEGACY_TYPE.id] } });
        render(ui);
        expect(screen.getByText(/Your own data is part of Enterprise/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Upgrade/ })).toHaveAttribute('href', 'https://example.test/upgrade');
        expect(screen.getByText(/These words and patterns were added earlier\. They are still hidden\./)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Add a type/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Test and tune / })).toBeNull();
        for (const box of within(screen.getByRole('table')).getAllByRole('checkbox')) expect(box).toBeDisabled();
        // A type made on Enterprise before the licence lapsed is paused, and
        // cannot be removed here: only the old migrated terms can.
        expect(screen.getAllByText('Paused. Needs Enterprise.')).toHaveLength(2);
        expect(screen.queryByRole('button', { name: 'Remove Product names' })).toBeNull();

        // The words can be looked at.
        await user.click(screen.getAllByRole('button', { name: /A list of words · 1 word/ })[0]);
        expect(screen.getByText('AURORA')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Remove Old codename' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(form.current?.customDataTypes.map(x => x.id)).toEqual([WORDS_TYPE.id]));
        expect(form.current?.piiCategories).toEqual(['Email']);
    });

    it('says what Enterprise adds when there is nothing to show', () => {
        const { ui } = renderableTab({ licensed: false });
        render(ui);
        expect(screen.getByText('Add your own kinds of data with Enterprise')).toBeInTheDocument();
    });

    it('keeps Never hidden editable: those exceptions are saved on every plan', async () => {
        const user = userEvent.setup();
        const { ui, form } = renderableTab({ licensed: false, init: { allowTerms: ['Kifid'] } });
        render(ui);
        expect(screen.getByRole('heading', { name: 'Never hidden' })).toBeInTheDocument();
        await user.type(screen.getByLabelText('Add a name that should stay visible'), 'Van Dael{Enter}');
        expect(form.current?.piiAllowTerms).toEqual(['Kifid', 'Van Dael']);
        await user.click(screen.getByRole('checkbox', { name: /well-known companies/i }));
        expect(form.current?.piiAllowPublicOrgs).toBe(false);
    });
});

describe('inside the editor', () => {
    const SHIELD = {
        enabled: true,
        piiDetectionCategories: ['Email', WORDS_TYPE.id],
        piiDetectionConfidenceThreshold: 0.7,
        piiDetectionAction: 'block',
        toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
        customDataTypes: [WORDS_TYPE],
    };
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

    beforeEach(() => {
        vi.mocked(authFetch).mockImplementation(async (url: string) => {
            if (url.includes('/auth/organizations')) return ok([{ id: 'org-1', name: 'Alpha BV' }]);
            if (url.includes('/ai/config')) return ok({});
            if (url.includes('/api/org-privacy-shield/')) return ok(SHIELD);
            return ok({});
        });
    });

    it('puts a switch edit on the Your own data chip of the save bar', async () => {
        const user = userEvent.setup();
        render(<OrgShieldEditor orgId="org-1" />);
        await user.click(await screen.findByRole('tab', { name: /Your own data/ }));
        await user.click(screen.getByRole('checkbox', { name: 'Product names, Own server' }));
        expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
        const chip = screen.getByRole('button', { name: /^Your own data\s*· 1$/ });
        expect(chip).toBeInTheDocument();
        // And not on the matrix's pane: that pane has no row for this type.
        expect(screen.queryByRole('button', { name: /^What we look for\s*· / })).toBeNull();
    });
});
