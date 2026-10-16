import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import BlockStyleEditor from './BlockStyleEditor';

function mount(style: object, onChange = vi.fn()) {
    render(<BlockStyleEditor style={style} blockType="features" onChange={onChange} onToggleEnabled={() => {}} />);
    return onChange;
}

describe('BlockStyleEditor section rhythm', () => {
    afterEach(() => cleanup());

    it('writes the tight rhythm and keeps the rest of the style', async () => {
        const onChange = mount({ band: 'dark' });
        await userEvent.setup().click(screen.getByRole('button', { name: 'Tight' }));
        expect(onChange).toHaveBeenCalledWith({ band: 'dark', rhythm: 'tight' });
    });

    it('Default removes the rhythm key', async () => {
        const onChange = mount({ rhythm: 'spacious' });
        await userEvent.setup().click(screen.getByRole('button', { name: 'Site default' }));
        expect(onChange).toHaveBeenCalledWith({});
    });
});

describe('BlockStyleEditor anchor id', () => {
    afterEach(() => cleanup());

    it('writes a slug and removes the key when emptied', async () => {
        const user = userEvent.setup();
        const onChange = mount({ band: 'dark' });
        await user.type(screen.getByPlaceholderText('install'), 'A');
        expect(onChange).toHaveBeenCalledWith({ band: 'dark', anchor: 'a' });
    });
});
