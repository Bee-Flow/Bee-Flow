import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import VariablesManager from './VariablesManager';
import { MAX_VARIABLES } from '../runtime/appVariables';

/**
 * The manager is the only place a person can SEE what `vars` an app has. These
 * pin the three things that make it trustworthy: an edit commits straight
 * through (no staged draft to lose), a name in use cannot be renamed out from
 * under the formulas that read it, and deleting something in use says what will
 * break rather than doing it quietly.
 */

const decl = (name, over = {}) => ({ name, label: '', type: 'text', default: '', description: '', ...over });

function baseDef(variables, extra = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'T' },
        homeScreenId: 'scr_a',
        screens: [{ id: 'scr_a', name: 'Home', sections: [{ id: 'sec_a', children: [] }] }],
        actions: {},
        ...(variables ? { variables } : {}),
        ...extra,
    };
}

/** Controlled, like the header: a commit feeds straight back in. */
function renderManager(definition) {
    const onCommit = vi.fn();
    function Harness() {
        const [def, setDef] = useState(definition);
        return <VariablesManager definition={def} onCommit={(next) => { setDef(next); onCommit(next); }} />;
    }
    const utils = render(<Harness />);
    return { onCommit, last: () => onCommit.mock.calls.at(-1)?.[0], ...utils };
}

describe('VariablesManager — the list', () => {
    it('renders each declared variable', () => {
        renderManager(baseDef([decl('statusFilter', { label: 'Status' }), decl('mine', { type: 'yesno', default: false })]));
        expect(screen.getByLabelText('Name of statusFilter').value).toBe('statusFilter');
        expect(screen.getByLabelText('Name of mine').value).toBe('mine');
    });

    it('adding one commits a definition with the new variable', async () => {
        const user = userEvent.setup();
        const { last } = renderManager(baseDef());
        await user.click(screen.getByRole('button', { name: /new variable/i }));
        expect(last().variables).toHaveLength(1);
        expect(last().variables[0].type).toBe('text');
    });

    it('stops at the ceiling and says why', () => {
        const many = Array.from({ length: MAX_VARIABLES }, (_, i) => decl(`v${i}`));
        renderManager(baseDef(many));
        const add = screen.getByRole('button', { name: /new variable/i });
        expect(add.disabled).toBe(true);
        expect(add.getAttribute('title')).toMatch(new RegExp(String(MAX_VARIABLES)));
    });
});

describe('VariablesManager — types and starting values', () => {
    it('changing the type re-coerces the starting value', async () => {
        const user = userEvent.setup();
        // Otherwise a text default survives onto a number variable and the
        // server rejects the save with a type error the user never asked for.
        const { last } = renderManager(baseDef([decl('a', { default: 'abc' })]));
        await user.selectOptions(screen.getByLabelText('Type of a'), 'number');
        expect(last().variables[0]).toMatchObject({ type: 'number', default: 0 });
    });

    it('a yes/no variable gets a switch, not a text box', async () => {
        const user = userEvent.setup();
        const { last } = renderManager(baseDef([decl('mine', { type: 'yesno', default: false })]));
        const control = screen.getByLabelText('Starting value of mine');
        expect(control.type).toBe('checkbox');
        await user.click(control);
        // A real boolean, not the string "true" — the filter compares against it.
        expect(last().variables[0].default).toBe(true);
    });

    it('a date variable gets a date picker and can be left empty', () => {
        const { last } = renderManager(baseDef([decl('due', { type: 'date', default: '2026-08-10' })]));
        const input = screen.getByLabelText('Starting value of due');
        expect(input.type).toBe('date');
        fireEvent.change(input, { target: { value: '' } });
        expect(last().variables[0].default).toBe(null);
    });

    it('a JSON starting value only commits once it parses', async () => {
        const user = userEvent.setup();
        const { last, onCommit } = renderManager(baseDef([decl('cfg', { type: 'record', default: {} })]));
        const input = screen.getByLabelText('Starting value of cfg');
        await user.clear(input);
        await user.type(input, '{{"a"');
        expect(screen.getByText(/not valid json yet/i)).toBeTruthy();
        expect(onCommit).not.toHaveBeenCalled();
        await user.clear(input);
        await user.type(input, '{{"a":1}');
        expect(last().variables[0].default).toEqual({ a: 1 });
    });
});

describe('VariablesManager — names', () => {
    it('renames an unused variable', async () => {
        const user = userEvent.setup();
        const { last } = renderManager(baseDef([decl('old')]));
        const input = screen.getByLabelText('Name of old');
        await user.clear(input);
        await user.type(input, 'renamed');
        fireEvent.blur(input);
        expect(last().variables[0].name).toBe('renamed');
    });

    it('refuses a name no formula could read, and says what is wrong', async () => {
        const user = userEvent.setup();
        const { onCommit } = renderManager(baseDef([decl('ok')]));
        const input = screen.getByLabelText('Name of ok');
        await user.clear(input);
        await user.type(input, 'my var');
        fireEvent.blur(input);
        expect(onCommit).not.toHaveBeenCalled();
        expect(screen.getByText(/one word/i)).toBeTruthy();
    });

    it('refuses the filter bar’s reserved name with an explanation', async () => {
        const user = userEvent.setup();
        const { onCommit } = renderManager(baseDef([decl('ok')]));
        const input = screen.getByLabelText('Name of ok');
        await user.clear(input);
        await user.type(input, 'filters');
        fireEvent.blur(input);
        expect(onCommit).not.toHaveBeenCalled();
        expect(screen.getByText(/belongs to the filter bar/i)).toBeTruthy();
    });

    // No rename/rewrite subsystem: the formulas reading it are not rewritten,
    // so the name is fixed the moment anything depends on it.
    it('locks the name once something uses it', () => {
        const def = baseDef([decl('used')]);
        def.screens[0].sections[0].children = [
            { id: 'cmp_a', type: 'text', props: {}, computed: { text: { kind: 'formula', expr: 'vars.used' } } },
        ];
        renderManager(def);
        expect(screen.getByLabelText('Name of used').disabled).toBe(true);
        expect(screen.getByText('used 1×')).toBeTruthy();
    });
});

describe('VariablesManager — deleting', () => {
    it('an unused variable goes straight away', async () => {
        const user = userEvent.setup();
        const { last } = renderManager(baseDef([decl('idle')]));
        await user.click(screen.getByRole('button', { name: 'Delete idle' }));
        expect(last()).not.toHaveProperty('variables');
    });

    it('one in use asks first, and names where it is used', async () => {
        const user = userEvent.setup();
        const def = baseDef([decl('used')]);
        def.screens[0].sections[0].children = [
            { id: 'cmp_a', type: 'text', props: {}, computed: { text: { kind: 'formula', expr: 'vars.used' } } },
        ];
        const { onCommit } = renderManager(def);
        await user.click(screen.getByRole('button', { name: 'Delete used' }));
        expect(onCommit).not.toHaveBeenCalled();
        expect(screen.getByText(/still uses? it/i)).toBeTruthy();
        expect(screen.getByText(/Screen “Home”/)).toBeTruthy();
    });

    it('removing the last one drops the key entirely', async () => {
        const user = userEvent.setup();
        const { last } = renderManager(baseDef([decl('only')]));
        await user.click(screen.getByRole('button', { name: 'Delete only' }));
        expect('variables' in last()).toBe(false);
    });
});

describe('VariablesManager — the unknown-variable banner', () => {
    // The direct answer to the typo: a formula reading vars.statusfilter where
    // vars.statusFilter was meant.
    function defWithTypo() {
        const def = baseDef([decl('statusFilter')]);
        def.screens[0].sections[0].children = [
            { id: 'cmp_a', type: 'text', props: {}, computed: { text: { kind: 'formula', expr: 'vars.statusfilter' } } },
        ];
        return def;
    }

    it('names what nothing gives a value', () => {
        renderManager(defWithTypo());
        expect(screen.getByText(/vars\.statusfilter/)).toBeTruthy();
    });

    it('offers to declare it in one click', async () => {
        const user = userEvent.setup();
        const { last } = renderManager(defWithTypo());
        await user.click(screen.getByRole('button', { name: /declare it/i }));
        expect(last().variables.map((v) => v.name).sort()).toEqual(['statusFilter', 'statusfilter']);
    });

    it('stays quiet when every read resolves', () => {
        const def = baseDef([decl('statusFilter')]);
        def.screens[0].sections[0].children = [
            { id: 'cmp_a', type: 'text', props: {}, computed: { text: { kind: 'formula', expr: 'vars.statusFilter' } } },
        ];
        const { container } = renderManager(def);
        expect(container.querySelector('[data-unknown-vars]')).toBeNull();
    });

    it('does not count vars.filters as unknown', () => {
        const def = baseDef([decl('a')]);
        def.screens[0].sections[0].children = [
            { id: 'cmp_a', type: 'text', props: {}, computed: { text: { kind: 'formula', expr: 'vars.filters.q' } } },
        ];
        const { container } = renderManager(def);
        expect(container.querySelector('[data-unknown-vars]')).toBeNull();
    });
});
