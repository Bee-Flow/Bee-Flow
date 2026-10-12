import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buildComposerTools } from '../InputArea/composerTools';
import MemoryModeControl from './MemoryModeControl';

describe('MemoryModeControl', () => {
    it('each click proposes the next state: On, Read only, Off for this chat, On', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const { rerender } = render(<MemoryModeControl mode="on" onChange={onChange} />);
        const button = () => screen.getByTestId('memory-mode-control');
        expect(button()).toHaveAttribute('aria-label', 'Memory: On');
        expect(button()).toHaveAttribute('aria-pressed', 'true');
        await user.click(button());
        expect(onChange).toHaveBeenLastCalledWith('read');

        rerender(<MemoryModeControl mode="read" onChange={onChange} />);
        expect(button()).toHaveAttribute('aria-label', 'Memory: Read only');
        expect(button()).toHaveAttribute('aria-pressed', 'false');
        await user.click(button());
        expect(onChange).toHaveBeenLastCalledWith('off');

        rerender(<MemoryModeControl mode="off" onChange={onChange} />);
        expect(button()).toHaveAttribute('aria-label', 'Memory: Off for this chat');
        await user.click(button());
        expect(onChange).toHaveBeenLastCalledWith('on');
    });

    it.each([
        ['user_paused', /paused/],
        ['org_off', /switched off for your organisation/],
    ] as const)('stays locked and explains itself when %s', async (lock, words) => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<MemoryModeControl mode="on" onChange={onChange} lock={lock} />);
        const button = screen.getByTestId('memory-mode-control');
        expect(button).toHaveAttribute('aria-disabled', 'true');
        expect(button).toHaveAttribute('title', expect.stringMatching(words));
        expect(button).toHaveAttribute('aria-pressed', 'false');
        await user.click(button);
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe('the memory row of the composer tools', () => {
    const t = (_k: string, fallback: string) => fallback;
    const row = (extra: Record<string, unknown>) => (buildComposerTools({
        t, simpleMode: false, showTierSlider: false, memoryMode: 'on', changeMemoryMode: vi.fn(), ...extra,
    } as never) as Array<{ id: string } | false>).find((x) => x && x.id === 'memory') as Record<string, unknown>;

    it('selecting it moves to the next state', () => {
        const changeMemoryMode = vi.fn();
        (row({ memoryMode: 'read', changeMemoryMode }).onSelect as () => void)();
        expect(changeMemoryMode).toHaveBeenCalledWith('off');
    });

    it('is off-dotted for Read only and disabled, with the reason, when locked', () => {
        expect(row({ memoryMode: 'on' })).toMatchObject({ on: true, dot: false, disabled: false });
        expect(row({ memoryMode: 'read' })).toMatchObject({ on: false, dot: true, disabled: false });
        expect(row({ memoryMode: 'on', memoryLock: 'org_off' })).toMatchObject({
            on: false, disabled: true, hint: expect.stringMatching(/organisation/),
        });
    });
});
