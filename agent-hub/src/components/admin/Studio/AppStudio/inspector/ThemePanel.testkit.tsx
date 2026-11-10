import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { ComponentProps } from 'react';
import ThemePanel from './ThemePanel';
import { stub } from '@/test/mocks';

/** What the ThemePanel tests share: a one-screen app, and the panel rendered on a screen of it. */

export const THEME_PANEL_DEF = {
    schemaVersion: 2,
    meta: { name: 'T', description: '', icon: null },
    theme: {},
    homeScreenId: 'scr_1',
    screens: [{ id: 'scr_1', name: 'One', maxWidth: 'medium', refreshInterval: 0, showInNav: true, icon: null, sections: [] }],
    actions: {},
};

/** The panel over `definition` on `screenId`, with a spy for what it commits. */
export function renderThemePanel(definition: Record<string, unknown> = THEME_PANEL_DEF, screenId = 'scr_1') {
    const onCommit = vi.fn();
    const utils = render(<ThemePanel definition={stub<ComponentProps<typeof ThemePanel>['definition']>(definition)} onCommit={onCommit} screenId={screenId} />);
    return { onCommit, ...utils };
}
