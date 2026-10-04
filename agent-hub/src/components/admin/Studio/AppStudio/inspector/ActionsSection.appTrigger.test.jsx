import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ActionsSection, { getFormFields } from './ActionsSection';

/**
 * app_trigger automations in the action inspector: typed param prefill from
 * trigger.params, type badges on mapping rows, and file params locked to
 * file-upload form fields.
 */

const APP_TRIGGER_AUTOMATION = {
    id: 'auto-app',
    title: 'Process invoice',
    isActive: true,
    definition: {
        trigger: {
            id: 'trg', kind: 'app_trigger',
            params: [
                { name: 'title', type: 'string', required: true },
                { name: 'doc', type: 'file', required: true, description: 'the invoice' },
            ],
        },
        steps: [], edges: [],
    },
};

vi.mock('../../../../../hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations: vi.fn(async () => ({ automations: [APP_TRIGGER_AUTOMATION] })) }),
    safeText: vi.fn(async () => ''),
}));

const formNode = {
    id: 'cmp_form1', type: 'form', props: { name: 'f' }, style: {},
    onSubmit: 'act1',
    children: [
        { id: 'cmp_t', type: 'input_text', props: { name: 'title' }, style: {} },
        { id: 'cmp_f', type: 'input_file', props: { name: 'upload', multiple: false }, style: {} },
    ],
};

function defWith(node, actions = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'T' },
        theme: {},
        homeScreenId: 'scr_t',
        screens: [{ id: 'scr_t', name: 'T', showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_t', style: {}, children: [node] }] }],
        actions,
    };
}

function renderActions(node, actions) {
    const definition = defWith(node, actions);
    const onCommit = vi.fn();
    // The automation tile reads its run count and its solution through react-query
    // (both degrade to nothing), so the section needs a client the way the real
    // editor shell provides one.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(
        <QueryClientProvider client={client}>
            <ActionsSection node={node} definition={definition} onCommit={onCommit} disabled={false} />
        </QueryClientProvider>,
    );
    return { onCommit, definition, ...utils };
}

beforeEach(() => vi.clearAllMocks());

/**
 * The redesign (P2) moved the kind `<select>` under an "All options"
 * disclosure and the per-parameter editors under "Change what gets sent". The
 * BEHAVIOUR these tests pin is unchanged — one click deeper is now part of
 * reaching it, so the click is part of the test.
 */
function openDisclosures() {
    for (const button of screen.queryAllByRole('button', { expanded: false })) {
        if (/all options|change what gets sent/i.test(button.textContent || '')) {
            fireEvent.click(button);
        }
    }
}

describe('ActionsSection — app_trigger typed mapping', () => {
    it('getFormFields returns names WITH component types (file inputs identifiable)', () => {
        const def = defWith(formNode);
        expect(getFormFields(def, formNode)).toEqual([
            { name: 'title', type: 'input_text', multiple: false },
            { name: 'upload', type: 'input_file', multiple: false },
        ]);
    });

    it('shows type badges from the automation contract on mapping rows', async () => {
        const actions = {
            act1: {
                kind: 'run_automation', automationId: 'auto-app',
                inputMapping: {
                    title: { kind: 'field', name: 'title' },
                    doc: { kind: 'field', name: 'upload' },
                },
            },
        };
        const { getByTitle } = renderActions(formNode, actions);
        // Badges render once the automations list (with contracts) loads, and
        // the editor rows they sit on are one disclosure deeper since the
        // redesign — so retry the open until the contract has arrived.
        await waitFor(() => {
            openDisclosures();
            expect(screen.getByText('string*')).toBeTruthy();
        });
        expect(screen.getByText('file*')).toBeTruthy();
        expect(getByTitle('the invoice')).toBeTruthy();
    });

    it('a file param hides the Static mode and offers only file-upload fields', async () => {
        const actions = {
            act1: {
                kind: 'run_automation', automationId: 'auto-app',
                inputMapping: { doc: { kind: 'field', name: 'upload' } },
            },
        };
        const { getByRole, queryByRole } = renderActions(formNode, actions);
        await waitFor(() => {
            openDisclosures();
            expect(screen.getByText('file*')).toBeTruthy();
        });
        // No Form field / Static segmented control for the file row (locked to field mode).
        expect(queryByRole('radiogroup', { name: 'doc source' })).toBeNull();
        const select = getByRole('combobox', { name: 'doc form field' });
        const values = Array.from(select.options).map((o) => o.value).filter(Boolean);
        expect(values).toEqual(['upload']); // input_text 'title' filtered out
    });

    it('picking an app_trigger automation prefills typed rows (file → first file field)', async () => {
        const actions = { act1: { kind: 'run_automation', automationId: null } };
        const { onCommit, findByText, getByText } = renderActions(formNode, actions);
        fireEvent.click(await findByText('Choose an automation…'));
        // AutomationPicker body lists the app_trigger automation with its badge.
        fireEvent.click(await findByText('Process invoice'));

        await waitFor(() => expect(onCommit).toHaveBeenCalled());
        const nextDef = onCommit.mock.calls.at(-1)[0];
        expect(nextDef.actions.act1.automationId).toBe('auto-app');
        expect(nextDef.actions.act1.inputMapping).toEqual({
            title: { kind: 'field', name: 'title' },   // same-named form field
            doc: { kind: 'field', name: 'upload' },    // file → first input_file
        });
        expect(getByText).toBeTruthy();
    });
});
