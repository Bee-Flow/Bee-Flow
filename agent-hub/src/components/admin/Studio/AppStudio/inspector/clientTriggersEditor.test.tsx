import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { stub } from '@/test/mocks';
import ScreenTriggers, { clampSeconds } from './ScreenTriggers';
import ThenAlsoRun from './ThenAlsoRun';
import { slotIds, withAdded, withFirst, withRemoved, withReplaced, withoutAction } from './eventSlots';
import { TYPE_EVENT_LISTS } from './styleKnobMeta';
import WatchersPanel, { formulaProblem } from '../editor/WatchersPanel';
import { removeAction } from '../state/definitionOps';
import { setScreenOpen, setScreenTimers, setWatchers } from '../state/triggerOps';
import type { AppDefinition } from './appDefinition';

/**
 * The human editor's controls for the client triggers of schema 3: the event slots the
 * inspector now offers (generated from the spec), a "then also run" list under a slot, a
 * screen's Triggers (onOpen, timers), the watchers in the Logic tab, and the clean-up when
 * an action is deleted. A slot of one id stays a string; empty lists remove their key.
 */

function app(extra: Record<string, unknown> = {}): AppDefinition {
    return stub<AppDefinition>({
        schemaVersion: 3,
        homeScreenId: 'scr_a',
        screens: [{ id: 'scr_a', name: 'A', sections: [{ id: 'sec_a', style: {}, children: [
            { id: 'cmp_btn', type: 'button', props: { label: 'Go' }, onClick: 'act_a' },
        ] }] }],
        actions: { act_a: { kind: 'toast', message: 'A' }, act_b: { kind: 'toast', message: 'B' }, act_c: { kind: 'toast', message: 'C' } },
        ...extra,
    });
}

describe('event slots', () => {
    it('the inspector offers onClick on the tiles and onChange on the five inputs (generated from the spec)', () => {
        for (const type of ['card', 'image', 'stat', 'callout', 'container']) expect(TYPE_EVENT_LISTS[type], type).toEqual(['onClick']);
        for (const type of ['input_datetime', 'input_relation', 'input_person', 'input_richtext', 'input_html']) expect(TYPE_EVENT_LISTS[type], type).toEqual(['onChange']);
    });

    it('slot edits keep one id a plain string and a list a list', () => {
        expect(slotIds('a')).toEqual(['a']);
        expect(withAdded('a', 'b')).toEqual(['a', 'b']);
        expect(withFirst(['a', 'b'], 'c')).toEqual(['c', 'b']);
        expect(withFirst(['a', 'b'], null)).toBeNull();
        expect(withReplaced(['a', 'b'], 1, 'c')).toEqual(['a', 'c']);
        expect(withRemoved(['a', 'b'], 1)).toBe('a');
        expect(withoutAction(['a', 'b', 'a'], 'a')).toBe('b');
        expect(withAdded(['a', 'b', 'c', 'd', 'e'], 'f')).toHaveLength(5);
    });

    it('"then also run" adds a second action and removes it again', async () => {
        const user = userEvent.setup();
        const onCommit = vi.fn();
        const def = app();
        const node = def.screens![0].sections![0].children![0];
        const { rerender } = render(<ThenAlsoRun node={node} event="onClick" definition={def} onCommit={onCommit} />);
        await user.click(screen.getByRole('button', { name: 'Then also run another action' }));
        const extended = onCommit.mock.calls[0][0] as AppDefinition;
        const wired = extended.screens![0].sections![0].children![0];
        expect(wired.onClick).toEqual(['act_a', 'act_a']);
        rerender(<ThenAlsoRun node={wired} event="onClick" definition={extended} onCommit={onCommit} />);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Action 2 of this event' }), 'act_b');
        expect((onCommit.mock.calls[1][0] as AppDefinition).screens![0].sections![0].children![0].onClick).toEqual(['act_a', 'act_b']);
        await user.click(screen.getByRole('button', { name: 'Do not run this one' }));
        expect((onCommit.mock.calls[2][0] as AppDefinition).screens![0].sections![0].children![0].onClick).toBe('act_a');
    });
});

describe('screen triggers and watchers', () => {
    it('the Triggers panel sets onOpen and adds a timer, clamped to the bounds', async () => {
        const user = userEvent.setup();
        const onCommit = vi.fn();
        render(<ScreenTriggers definition={app()} screenId="scr_a" onCommit={onCommit} />);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Action when the screen opens' }), 'act_b');
        expect((onCommit.mock.calls[0][0] as AppDefinition).screens![0].events).toEqual({ onOpen: 'act_b' });
        await user.click(screen.getByRole('button', { name: 'Add a timer' }));
        expect((onCommit.mock.calls[1][0] as AppDefinition).screens![0].timers).toEqual([{ id: 'timer1', everySeconds: 30, actionId: 'act_a' }]);
        expect(clampSeconds(2)).toBe(5);
        expect(clampSeconds(99999)).toBe(3600);
    });

    it('the watchers panel adds a watcher with a formula that parses, and shows a parse error', async () => {
        const user = userEvent.setup();
        const onCommit = vi.fn();
        render(<WatchersPanel definition={app({ variables: [{ name: 'status', type: 'text' }] })} onCommit={onCommit} />);
        await user.click(screen.getByRole('button', { name: 'Add a watcher' }));
        expect((onCommit.mock.calls[0][0] as AppDefinition).watchers).toEqual([{ id: 'watch1', expr: 'vars.status', actionId: 'act_a' }]);
        expect(formulaProblem('vars.status')).toBeNull();
        expect(formulaProblem('vars.status ==')).toBeTruthy();
    });

    it('empty lists remove their keys, and deleting an action takes it out of every slot, trigger and watcher', () => {
        let def = app();
        def = setScreenOpen(def, 'scr_a', ['act_a', 'act_b']);
        def = setScreenTimers(def, 'scr_a', [{ id: 't', everySeconds: 10, actionId: 'act_a' }, { id: 'u', everySeconds: 10, actionId: 'act_c' }]);
        def = setWatchers(def, [{ id: 'w', expr: 'vars.x', actionId: 'act_a' }]);
        def.screens![0].sections![0].children![0].onClick = ['act_a', 'act_c'] as unknown as string;
        const out = removeAction(def, 'act_a');
        expect(out.screens![0].events).toEqual({ onOpen: 'act_b' });
        expect(out.screens![0].timers).toEqual([{ id: 'u', everySeconds: 10, actionId: 'act_c' }]);
        expect('watchers' in out).toBe(false);
        expect(out.screens![0].sections![0].children![0].onClick).toBe('act_c');
        expect('events' in setScreenOpen(out, 'scr_a', null).screens![0]).toBe(false);
        expect('timers' in setScreenTimers(out, 'scr_a', []).screens![0]).toBe(false);
    });
});
