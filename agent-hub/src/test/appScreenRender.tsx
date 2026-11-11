// One App Studio screen through the real AppRenderer: the nodes a test cares about in one section.
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppRenderer from '@/components/admin/Studio/AppStudio/runtime/AppRenderer';
import catalog from '@/components/admin/Studio/AppStudio/runtime/catalogSnapshot.generated.json';
import type { AppDefinition } from '@/components/admin/Studio/AppStudio/inspector/appDefinition';
import type { AppRendererProps } from '@/components/admin/Studio/AppStudio/runtime/AppRenderer.types';

type Nodes = Record<string, unknown>[];

const SCREEN = 'scr_case';

/** A schema 3 app whose only screen holds `nodes` in one section, with `actions`. */
export function screenApp(nodes: Nodes, actions: Record<string, unknown> = {}): AppDefinition {
    const section = { id: 'sec_case', style: { padding: 4, gap: 3, background: 'none' }, children: nodes };
    const screen = { id: SCREEN, name: 'Case', icon: null, showInNav: true, maxWidth: 'wide', sections: [section] };
    const app = {
        schemaVersion: 3, meta: { name: 'Case', description: '', icon: 'Box' }, roles: [],
        theme: { primary: '#2563EB', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: SCREEN, screens: [screen], actions,
    };
    // A copy, typed as the stored JSON it stands for: the test nodes are loose literals.
    const stored: AppDefinition = JSON.parse(JSON.stringify(app));
    return stored;
}

/** `nodes` rendered as a run-mode screen (or with `props` on top), plus a user-event session. */
export function renderScreen(nodes: Nodes, props: Partial<AppRendererProps> = {}, actions: Record<string, unknown> = {}) {
    const view = render(<AppRenderer definition={screenApp(nodes, actions)} screenId={SCREEN} mode="run" {...props} />);
    return { ...view, user: userEvent.setup() };
}

/** The part names of `type` (its `bfa-<type>__<part>` classes) in `root`, and the ones its spec declares; both sorted. */
export function partNames(type: string, root: Element): { rendered: string[]; declared: string[] } {
    const prefix = `bfa-${type}__`;
    const rendered = new Set<string>();
    root.querySelectorAll('[class]').forEach((el) => {
        el.classList.forEach((token) => { if (token.startsWith(prefix)) rendered.add(token.slice(prefix.length)); });
    });
    const spec = (catalog.types as Record<string, { parts?: string[] } | undefined>)[type];
    return { rendered: [...rendered].sort(), declared: [...(spec?.parts ?? [])].sort() };
}
