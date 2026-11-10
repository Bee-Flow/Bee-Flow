import { render } from '@testing-library/react';
import { Gauge } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import AppRenderer from './AppRenderer';
import { types as catalogTypes } from './catalogSnapshot.generated.json';
import { COMPONENT_EXTENSION_MODULES, collectComponentExtensions } from './componentExtensions';
import { APP_COMPONENT_TYPES } from './componentRegistry';
import type { ComponentExtension } from './componentRegistry.types';

// Test-only fixture: whatever the registry ships is only held to the rules below.
const Fixture = () => <div data-testid="fixture-widget" />;
const fixture: ComponentExtension = { Component: Fixture, icon: Gauge, sample: { props: { title: 'Hi' } } };
const CATALOG = { heading: {}, fixture_widget: { since: 3 }, zeta_widget: { since: 3 } };
const BASE = ['heading'];

const extensionTypes = Object.entries(catalogTypes as Record<string, { since?: number }>)
    .filter(([, spec]) => spec.since !== undefined)
    .map(([type]) => type);

describe('component extensions', () => {
    it('has one registry file per extension type of the catalog, and no other', () => {
        // A type the server added (componentSpecs/types/<type>.js) without its file here has no renderer:
        // add runtime/components/registry/<type>.ts exporting { Component, icon, sample }.
        const files = Object.keys(COMPONENT_EXTENSION_MODULES).map((file) => file.slice(file.lastIndexOf('/') + 1, file.lastIndexOf('.')));
        expect(files.sort()).toEqual([...extensionTypes].sort());
    });

    it('collects one entry per file, keyed by its name, in file-name order', () => {
        const out = collectComponentExtensions({
            './components/registry/zeta_widget.ts': { default: fixture },
            './components/registry/fixture_widget.ts': { default: fixture },
        }, CATALOG, BASE);
        expect(Object.keys(out)).toEqual(['fixture_widget', 'zeta_widget']);
        expect(out.fixture_widget).toBe(fixture);
    });

    it('refuses a base type, a type the catalog lacks, and an entry without a sample', () => {
        const one = (file: string, entry: ComponentExtension) => () => collectComponentExtensions({ [file]: { default: entry } }, CATALOG, BASE);
        expect(one('./components/registry/heading.ts', fixture)).toThrow(/base type/);
        expect(one('./components/registry/other_widget.ts', fixture)).toThrow(/no extension type "other_widget"/);
        expect(one('./components/registry/fixture_widget.ts', { ...fixture, sample: undefined } as unknown as ComponentExtension)).toThrow(/sample/);
    });

    it('every shipped extension type has a registry entry with a sample, and the sample renders', () => {
        const children = extensionTypes.map((type, i) => {
            const entry = APP_COMPONENT_TYPES[type];
            expect(entry?.sample, `${type} sample`).toBeTruthy();
            return { id: `cmp_ext${String(i).padStart(3, '0')}`, type, props: {}, style: {}, ...entry?.sample };
        });
        const definition = {
            schemaVersion: 2,
            meta: { name: 'Extensions', description: '', icon: 'LayoutGrid' },
            theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
            homeScreenId: 'scr_ext001',
            screens: [{ id: 'scr_ext001', name: 'Extensions', icon: null, showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_ext001', style: {}, children }] }],
            actions: {},
        };
        const { container } = render(<AppRenderer definition={definition as never} screenId="scr_ext001" mode="run" />);
        expect(container.querySelectorAll('.app-node')).toHaveLength(children.length);
    });
});
