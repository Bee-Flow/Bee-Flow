import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import SectionThemeFields from './SectionThemeFields';
import type { AppDefinition, AppSection } from './appDefinition';

// section.theme in the section inspector: the screen theme's fields without canvas; one key set
// and cleared, and a section left alone keeps no theme key.
const start = (): AppDefinition => ({
    theme: { primary: '#0F766E' },
    screens: [{ id: 'scr_one', name: 'One', theme: { accent: '#B45309' }, sections: [{ id: 'sec_one', children: [] }] }],
} as unknown as AppDefinition);

function Panel() {
    const [def, setDef] = useState(start());
    const section = def.screens?.[0]?.sections?.[0] as AppSection;
    return (
        <div>
            <SectionThemeFields definition={def} section={section} onCommit={setDef} disabled={false} />
            <pre data-testid="out">{JSON.stringify((section as { theme?: unknown }).theme ?? null)}</pre>
        </div>
    );
}

const out = () => JSON.parse(screen.getByTestId('out').textContent || 'null');

describe('SectionThemeFields', () => {
    it('sets and clears one key of the section theme, and offers no page ground', async () => {
        const user = userEvent.setup();
        render(<Panel />);
        expect(screen.queryByText('Page ground')).toBeNull();
        expect(screen.getByText('Accent colour')).toBeInTheDocument();
        await user.selectOptions(screen.getByRole('combobox', { name: 'Density' }), 'compact');
        expect(out()).toEqual({ density: 'compact' });
        await user.selectOptions(screen.getByRole('combobox', { name: 'Density' }), '');
        expect(out()).toBeNull();
    });
});
