import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import ActionsSection from './ActionsSection';
import { findNode } from '../state/definitionOps';
import type { ComponentProps } from 'react';
import { stub } from '@/test/mocks';

/**
 * Deleting an action and renaming an automation parameter — the two places where
 * the inspector used to leave the app in a state it could not save (a dangling
 * event reference) or silently destroy work (a mapping renamed onto another).
 */
const require = createRequire(import.meta.url);
const { canonicalizeAppDefinition } = require('../../../../../../../server/appStudio/canonicalize.js');
const { validateAppDefinition } = require('../../../../../../../server/appStudio/validate.js');

vi.mock('@/hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations: vi.fn(async () => ({ automations: [] })) }),
    safeText: vi.fn(async () => ''),
}));

function defWith(node: unknown, actions = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'T' },
        theme: {},
        homeScreenId: 'scr_act',
        screens: [{
            id: 'scr_act', name: 'T', showInNav: true, maxWidth: 'medium',
            sections: [{ id: 'sec_act', style: {}, children: [node] }],
        }],
        actions,
    };
}

function saveErrors(def: unknown) {
    const { def: canon } = canonicalizeAppDefinition(def);
    return validateAppDefinition(canon).errors;
}

/** ActionsSection is controlled by the shell — feed its commits back in. */
function Harness({ initial, nodeId, onCommit }: { initial?: unknown; nodeId?: unknown; onCommit: (...args: unknown[]) => void }) {
    const [definition, setDefinition] = useState(initial);
    return (
        <ActionsSection
            node={findNode(definition, nodeId).node}
            definition={stub<ComponentProps<typeof ActionsSection>['definition']>(definition)}
            onCommit={(next) => { setDefinition(next); onCommit(next); }}
            disabled={false}
        />
    );
}

function renderActions(node: unknown, actions: Parameters<typeof defWith>[1]) {
    const onCommit = vi.fn();
    // The automation tile reads its run count and its solution through
    // react-query (both degrade to nothing), so the section needs a client the
    // way the real editor shell provides one.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(
        <QueryClientProvider client={client}>
            <Harness initial={defWith(node, actions)} nodeId={(node as { id: string }).id} onCommit={onCommit} />
        </QueryClientProvider>,
    );
    const lastDef = () => onCommit.mock.calls.at(-1)?.[0];
    return { onCommit, lastDef, ...utils };
}

const MAPPED_FORM = {
    id: 'cmp_form1', type: 'form', props: { name: 'f' }, style: {}, onSubmit: 'act1', children: [],
};
const MAPPED_ACTION = {
    act1: {
        kind: 'run_automation', automationId: 'auto1',
        inputMapping: { alpha: { kind: 'static', value: '1' }, beta: { kind: 'static', value: '2' } },
    },
};

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

describe('ActionsSection — deleting an action', () => {
    it('clears the grid/kanban/calendar event that pointed at it', async () => {
        const user = userEvent.setup();
        const node = { id: 'cmp_grid1', type: 'data_grid', props: {}, style: {}, onRowClick: 'act1' };
        const { lastDef, getByLabelText } = renderActions(node, { act1: { kind: 'toast', message: 'hi', tone: 'info' } });

        await user.click(getByLabelText('Delete action'));
        const next = lastDef();
        expect(next.actions.act1).toBeUndefined();
        expect(findNode(next, 'cmp_grid1').node.onRowClick).toBeUndefined();
        expect(saveErrors(next)).toEqual([]);
    });

    it('a left-behind reference is invalid, and the server rewrites it away behind the app', () => {
        const dangling = defWith({ id: 'cmp_grid1', type: 'data_grid', props: {}, style: {}, onRowClick: 'act1' }, {});
        expect(validateAppDefinition(dangling).errors.some((e: { code: unknown }) => e.code === 'event.action_unresolved')).toBe(true);
        const { def: canon } = canonicalizeAppDefinition(dangling);
        expect(canon.screens[0].sections[0].children[0].onRowClick).toBeUndefined();
    });
});

describe('ActionsSection — renaming an automation parameter', () => {
    it('keeps focus in the field across a keystroke', async () => {
        const user = userEvent.setup();
        const { getAllByLabelText } = renderActions(MAPPED_FORM, MAPPED_ACTION);
        openDisclosures();
        const field = getAllByLabelText('Parameter name')[0];
        field.focus();
        await user.clear(field);
        await user.type(field, 'alphax');
        expect(document.activeElement).toBe(getAllByLabelText('Parameter name')[0]);
        expect((getAllByLabelText('Parameter name')[0] as HTMLInputElement).value).toBe('alphax');
    });

    it('commits the rename', async () => {
        const user = userEvent.setup();
        const { lastDef, getAllByLabelText } = renderActions(MAPPED_FORM, MAPPED_ACTION);
        openDisclosures();
        await user.clear(getAllByLabelText('Parameter name')[0]);
        await user.type(getAllByLabelText('Parameter name')[0], 'alphax');
        expect(Object.keys(lastDef().actions.act1.inputMapping)).toEqual(['alphax', 'beta']);
    });

    it('refuses to rename onto another parameter instead of deleting it', () => {
        const { onCommit, getAllByLabelText, getByText } = renderActions(MAPPED_FORM, MAPPED_ACTION);
        openDisclosures();
        fireEvent.change(getAllByLabelText('Parameter name')[0], { target: { value: 'beta' } });
        expect(onCommit).not.toHaveBeenCalled();
        expect(getByText(/already a parameter called/)).toBeTruthy();
    });
});
