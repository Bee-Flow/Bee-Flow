/**
 * The Condition node's model fallback, from the editor's side.
 *
 * The offline catalogue (routeIntents.js) answers the common shapes and is
 * pinned elsewhere. What is pinned HERE is the three promises the box makes
 * about the model, each of which is a promise a user would act on:
 *
 *   1. OFFLINE FIRST. A sentence the catalogue understands never reaches a
 *      model. The catalogue answer is fixed, free, works with no model
 *      configured and cannot drift between releases; a model's answer is none
 *      of those, so it may not quietly replace one.
 *   2. NAMES, NOT ROWS. The request carries the shape of the data and never a
 *      cell. A Condition node in this product routinely sits over customer
 *      records, and personal data does not leave Bee Flow (BFSF-441). The
 *      editor's own field options each carry a `sample` value, so this is not
 *      hypothetical — it is one careless spread away.
 *   3. IT SAYS SO BEFORE THE CLICK. A request that leaves the page is the
 *      author's to make, so the box is a button with a sentence next to it,
 *      not an automatic retry.
 *
 * Run: cd agent-hub && npx vitest run src/components/automation/Builder/flow/settings/RouteAssist.askAi.test.jsx
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = { suggestRouteRules: vi.fn() };
vi.mock('../../../../../hooks/useAutomationApi', () => ({ default: () => api }));

const { default: RouteAssist } = await import('./RouteAssist');

/** What the editor really hands this component: paths, labels AND samples. */
const FIELDS = [
    { path: 'item.name', label: 'File name', type: 'text', sample: 'Jan de Vries - offerte.pdf' },
    { path: 'item.status', label: 'Status', type: 'text', sample: 'open' },
];

function setup(props = {}) {
    const onApply = vi.fn();
    render(<RouteAssist fields={FIELDS} onApply={onApply} {...props} />);
    return { onApply };
}

function type(value) {
    fireEvent.change(screen.getByLabelText('Describe the outputs you want'), { target: { value } });
}

beforeEach(() => {
    api.suggestRouteRules.mockReset();
});

describe('offline first', () => {
    it('a sentence the catalogue understands never offers the model at all', () => {
        setup();
        type('split these files by pdf, word and powerpoint');
        // The catalogue names the outputs after the author's own words, so
        // "pdf, word, powerpoint" comes back as three ports with those names.
        expect(screen.getByRole('button', { name: /Use these 3 outputs/i })).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Ask the AI/i })).toBeNull();
        expect(api.suggestRouteRules).not.toHaveBeenCalled();
    });

    it('offers the model only when the catalogue produced nothing', () => {
        setup();
        type('route anything that smells like an escalation');
        expect(screen.getByRole('button', { name: /Ask the AI/i })).toBeTruthy();
        // Still nothing sent: the button is the author's decision, not a retry.
        expect(api.suggestRouteRules).not.toHaveBeenCalled();
    });

    it('says what will be sent BEFORE the click, not after', () => {
        setup();
        type('route anything that smells like an escalation');
        expect(screen.getByText(/never any rows or values/i)).toBeTruthy();
    });

    it('does not offer it for a stray keystroke', () => {
        setup();
        type('a');
        expect(screen.queryByRole('button', { name: /Ask the AI/i })).toBeNull();
    });
});

describe('what leaves the page', () => {
    it('SENDS FIELD NAMES AND NOT ONE CELL OF DATA', async () => {
        api.suggestRouteRules.mockResolvedValue({ rules: [], problem: 'nope' });
        setup();
        type('route anything that smells like an escalation');
        fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
        await waitFor(() => expect(api.suggestRouteRules).toHaveBeenCalled());

        const body = api.suggestRouteRules.mock.calls[0][0];
        expect(body.fields).toEqual([
            { key: 'item.name', name: 'File name', type: 'text' },
            { key: 'item.status', name: 'Status', type: 'text' },
        ]);
        // The blunt version of the same assertion: the sample values the
        // editor handed us must not appear ANYWHERE in the request.
        expect(JSON.stringify(body)).not.toContain('Jan de Vries');
        expect(JSON.stringify(body)).not.toContain('offerte.pdf');
    });

    it('sends the description the author typed, trimmed', async () => {
        api.suggestRouteRules.mockResolvedValue({ rules: [], problem: '' });
        setup();
        type('   route escalations   ');
        fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
        await waitFor(() => expect(api.suggestRouteRules).toHaveBeenCalled());
        expect(api.suggestRouteRules.mock.calls[0][0].description).toBe('route escalations');
    });
});

describe('what comes back', () => {
    const ANSWER = {
        rules: [
            { name: 'Escalations', expr: 'item.status == "escalated"' },
            { name: 'Everything else', expr: 'item.status != "escalated"' },
        ],
        problem: '',
    };

    it('is shown as rules, and accepted through the same path as a hand-made one', async () => {
        api.suggestRouteRules.mockResolvedValue(ANSWER);
        const { onApply } = setup();
        type('route anything that smells like an escalation');
        fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
        await screen.findByText('Escalations');
        fireEvent.click(screen.getByRole('button', { name: /Use these 2 outputs/i }));
        expect(onApply).toHaveBeenCalledWith(ANSWER.rules);
    });

    it('SAYS it came from the AI, instead of borrowing the catalogue\'s voice', async () => {
        // The catalogue names the field it matched on and cannot drift; a
        // model does neither. Presenting them identically would make the two
        // indistinguishable to the person deciding whether to trust them.
        api.suggestRouteRules.mockResolvedValue(ANSWER);
        setup();
        type('route anything that smells like an escalation');
        fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
        expect(await screen.findByText(/Written by the AI/i)).toBeTruthy();
    });

    it('is thrown away when the sentence changes', async () => {
        // Rules that answer the OLD sentence, still accept-able, is how
        // someone commits to a question they changed their mind about.
        api.suggestRouteRules.mockResolvedValue(ANSWER);
        setup();
        type('route anything that smells like an escalation');
        fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
        await screen.findByText('Escalations');
        type('actually never mind, something else entirely');
        expect(screen.queryByText('Escalations')).toBeNull();
    });

    it('reads a rule the rows cannot show as "a custom rule", never as code', async () => {
        api.suggestRouteRules.mockResolvedValue({
            rules: [{ name: 'loud', expr: 'lower(item.status) == "escalated"' }], problem: '',
        });
        setup();
        type('route anything that smells like an escalation');
        await userEvent.setup().click(screen.getByRole('button', { name: /Ask the AI/i }));
        await screen.findByText('loud');
        expect(screen.getByText(/a custom rule/)).toBeTruthy();
        expect(screen.queryByText(/lower\(/)).toBeNull();
    });

    it('passes the model\'s own sentence through when it could not answer', async () => {
        api.suggestRouteRules.mockResolvedValue({
            rules: [], problem: 'There is no date field to compare against.',
        });
        setup();
        type('split by anything older than last week');
        fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
        expect(await screen.findByText(/no date field/i)).toBeTruthy();
    });
});

describe('when there is no model behind the box', () => {
    it('says so plainly — that is the normal state on a self-hosted install', async () => {
        const err = new Error('nope');
        err.status = 403;
        api.suggestRouteRules.mockRejectedValue(err);
        setup();
        type('route anything that smells like an escalation');
        fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
        expect(await screen.findByText(/not switched on for your organisation/i)).toBeTruthy();
        // And the offline half is still there to use.
        expect(screen.getByLabelText('Describe the outputs you want')).toBeTruthy();
    });

    it('a transient failure does not read as a refusal', async () => {
        api.suggestRouteRules.mockRejectedValue(new Error('boom'));
        setup();
        type('route anything that smells like an escalation');
        fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
        expect(await screen.findByText(/Could not reach the AI just now/i)).toBeTruthy();
    });
});
