import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import entry from './shell';
import { THEME_SECTIONS } from '../themeSections';
import type { AppDefinition } from '../appDefinition';

const { Section } = entry;

const BASE = {
    meta: { name: 'Desk' },
    screens: [{ id: 'scr_home01', name: 'Home', sections: [] }, { id: 'scr_help01', name: 'Help', sections: [] }],
} as unknown as AppDefinition;

function Harness() {
    const [definition, setDefinition] = useState(BASE);
    return (
        <>
            <Section definition={definition} onCommit={setDefinition} disabled={false} screenId="scr_home01" />
            <output data-testid="nav">{JSON.stringify(definition.nav ?? null)}</output>
        </>
    );
}

const nav = () => JSON.parse(screen.getByTestId('nav').textContent || 'null');

describe('the Shell section of the theme panel', () => {
    it('is drawn by the panel', () => {
        expect(THEME_SECTIONS.find((s) => s.name === 'shell')?.Section).toBe(Section);
    });

    it('hides the top bar, writes a footer line and adds a link to a web address', async () => {
        render(<Harness />);
        await userEvent.click(screen.getByRole('checkbox', { name: /Hide the top bar/ }));
        expect(nav().header).toBe('hidden');
        await userEvent.type(screen.getByLabelText('Footer line'), 'Desk');
        expect(nav().footerText).toBe('Desk');
        await userEvent.click(screen.getByRole('button', { name: 'Add a link' }));
        expect(nav().items).toHaveLength(1);
        expect(nav().items[0].screenId).toBe('scr_home01');
        await userEvent.selectOptions(screen.getByLabelText('Opens'), '__url__');
        await userEvent.type(screen.getByLabelText('Web address'), 'https://example.org');
        expect(nav().items[0]).toMatchObject({ url: 'https://example.org' });
        expect(nav().items[0].screenId).toBeUndefined();
        await userEvent.click(screen.getByRole('button', { name: 'Remove link' }));
        expect(nav().items).toBeNull();
    });
});
