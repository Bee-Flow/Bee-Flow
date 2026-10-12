import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations: vi.fn(async () => ({ automations: [AUTOMATION] })) }),
    safeText: vi.fn(async () => ''),
}));

import ActionsSection, { screenIdOfNode } from './ActionsSection';

/**
 * The inspector is where a back-pointer is MINTED. Two halves:
 *   · which screen a component is on — derived from the definition, not taken
 *     from whichever screen the canvas happens to be showing;
 *   · the deep link into the builder, which carries it so the builder can draw
 *     the way back.
 *
 * Both refuse to produce a partial reference: without the app's own id there
 * is nothing to point at, and two thirds of a pointer is worse than none.
 */

const AUTOMATION = {
    id: 'aut_1', title: 'Process claim', isActive: true,
    definition: { trigger: { id: 'trg', kind: 'app_trigger', params: [] }, steps: [], edges: [] },
};

const BUTTON = { id: 'cmp_btn123', type: 'button', props: { label: 'Submit' }, style: {}, onClick: 'act_run001' };

function defWith(node) {
    return {
        schemaVersion: 2,
        meta: { name: 'Expenses' },
        theme: {},
        homeScreenId: 'scr_dash01',
        screens: [
            { id: 'scr_othr01', name: 'Archive', sections: [{ id: 'sec_arch01', style: {}, children: [] }] },
            { id: 'scr_dash01', name: 'Dashboard', sections: [{ id: 'sec_main01', style: {}, children: [node] }] },
        ],
        actions: { act_run001: { kind: 'run_automation', automationId: 'aut_1', inputs: {} } },
    };
}

function renderActions(props) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <ActionsSection node={BUTTON} definition={defWith(BUTTON)} onCommit={vi.fn()} disabled={false} {...props} />
        </QueryClientProvider>,
    );
}

beforeEach(() => { cleanup(); vi.clearAllMocks(); });
afterEach(cleanup);

describe('screenIdOfNode', () => {
    it('finds the screen a component is actually on, not the first one', () => {
        expect(screenIdOfNode(defWith(BUTTON), 'cmp_btn123')).toBe('scr_dash01');
    });

    it('looks inside containers', () => {
        const card = { id: 'cmp_card01', type: 'card', props: {}, children: [BUTTON] };
        expect(screenIdOfNode(defWith(card), 'cmp_btn123')).toBe('scr_dash01');
    });

    it('is null for a component that is not there, and for no id at all', () => {
        expect(screenIdOfNode(defWith(BUTTON), 'cmp_gone01')).toBeNull();
        expect(screenIdOfNode(defWith(BUTTON), null)).toBeNull();
        expect(screenIdOfNode(null, 'cmp_btn123')).toBeNull();
    });
});

describe('the "Open" link on the automation tile', () => {
    it('carries the app, the screen and the button once the app names itself', async () => {
        const { container } = renderActions({ appId: 'app-1' });
        await waitFor(() => expect(container.querySelector('a[href*="/studio/automations/"]')).toBeTruthy());
        expect(container.querySelector('a[href*="/studio/automations/"]').getAttribute('href'))
            .toBe('/app/studio/automations/aut_1?from=app%3Aapp-1%3Ascr_dash01%3Acmp_btn123');
    });

    it('stays the plain link when the editor was mounted without an app id', async () => {
        // The headless runtime and a few tests mount the inspector with no app
        // id. Degrading to the link it always was beats inventing a reference.
        const { container } = renderActions({});
        await waitFor(() => expect(container.querySelector('a[href*="/studio/automations/"]')).toBeTruthy());
        expect(container.querySelector('a[href*="/studio/automations/"]').getAttribute('href'))
            .toBe('/app/studio/automations/aut_1');
    });

    it('still renders the automation it points at', async () => {
        renderActions({ appId: 'app-1' });
        expect(await screen.findByText('Process claim')).toBeTruthy();
    });
});
