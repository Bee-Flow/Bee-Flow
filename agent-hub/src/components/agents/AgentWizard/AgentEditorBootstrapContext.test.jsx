/**
 * AgentEditorBootstrapContext — de gedeelde bootstrap-lezing van de agenteditor.
 *
 * Getest wordt één toevoeging (A3 deel A): `automationsState`. De routinelijst
 * landde tot nu toe op `[]` zowel wanneer ze leeg was als wanneer ze niet
 * gelezen kon worden — `/api/automation` hangt achter de automations-module en
 * kan 403'en — en op dat verschil hangt de vraag of een scherm "geen automations"
 * mag zeggen.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/AgentEditorBootstrapContext.test.jsx
 */
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let handler = async () => ({ ok: true, json: async () => ({}) });

vi.mock('../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url, opts = {}) => handler(url, opts)),
}));

import { AgentEditorBootstrapProvider, useAgentEditorBootstrap } from './AgentEditorBootstrapContext';
import { READ } from './canUse/canUseFacts';

function Probe() {
    const { automations, automationsState, loaded } = useAgentEditorBootstrap();
    return (
        <div
            data-testid="probe"
            data-state={automationsState}
            data-count={automations.length}
            data-loaded={String(loaded)}
        />
    );
}

const mount = () => render(
    <AgentEditorBootstrapProvider><Probe /></AgentEditorBootstrapProvider>,
);
const probe = () => screen.getByTestId('probe');

const withAutomations = (res) => async (url) => {
    if (url.includes('/api/automation')) return res;
    return { ok: true, json: async () => ({}) };
};

beforeEach(() => { handler = withAutomations({ ok: true, json: async () => ({ automations: [{ id: 'a1' }] }) }); });
afterEach(() => cleanup());

describe('automationsState', () => {
    it('is OK met de gelezen lijst', async () => {
        mount();
        await waitFor(() => expect(probe().dataset.loaded).toBe('true'));
        expect(probe().dataset.state).toBe(READ.OK);
        expect(probe().dataset.count).toBe('1');
    });

    it('is OK bij een echt lege lijst — dat is een gelezen feit', async () => {
        handler = withAutomations({ ok: true, json: async () => ({ automations: [] }) });
        mount();
        await waitFor(() => expect(probe().dataset.loaded).toBe('true'));
        expect(probe().dataset.state).toBe(READ.OK);
        expect(probe().dataset.count).toBe('0');
    });

    it('is ERROR wanneer de route weigert — nul automatiseringen is dan een bewering', async () => {
        handler = withAutomations({ ok: false, json: async () => ({}) });
        mount();
        await waitFor(() => expect(probe().dataset.loaded).toBe('true'));
        expect(probe().dataset.state).toBe(READ.ERROR);
        expect(probe().dataset.count).toBe('0');
    });

    it('is ERROR bij een 200 zonder herkenbare lijst', async () => {
        handler = withAutomations({ ok: true, json: async () => ({ items: [] }) });
        mount();
        await waitFor(() => expect(probe().dataset.loaded).toBe('true'));
        expect(probe().dataset.state).toBe(READ.ERROR);
    });

    it('is ERROR wanneer de lezing gooit', async () => {
        handler = withAutomations({ ok: true, json: async () => { throw new Error('bad json'); } });
        mount();
        await waitFor(() => expect(probe().dataset.loaded).toBe('true'));
        expect(probe().dataset.state).toBe(READ.ERROR);
    });

    it('is ERROR wanneer de hele bootstrap omvalt', async () => {
        handler = async () => { throw new Error('offline'); };
        mount();
        await waitFor(() => expect(probe().dataset.loaded).toBe('true'));
        expect(probe().dataset.state).toBe(READ.ERROR);
    });

    it('is LOADING zonder provider — de context weet dan nog niets', () => {
        render(<Probe />);
        expect(probe().dataset.state).toBe(READ.LOADING);
    });
});
