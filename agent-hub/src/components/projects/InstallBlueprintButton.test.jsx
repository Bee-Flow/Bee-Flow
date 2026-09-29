import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

import InstallBlueprintButton from './InstallBlueprintButton';

/**
 * Naming a Blueprint to install.
 *
 * This component used to BE the install: pick a file and a Solution appeared.
 * It now opens InstallBlueprintModal, so the behaviour pinned here narrowed to
 * the two ways of naming a Blueprint plus the one failure that happens before
 * there is a dialog to fail inside — a file that is not JSON.
 *
 * The cases that moved rather than went away, and where they live now:
 *
 *   - the report, the skipped list and the licence refusal → the wizard's
 *     result step, in InstallBlueprintModal.test.jsx;
 *   - "a saved Blueprint installs by id, so the stored bytes are the ones
 *     used" → the same file, where the install body is asserted.
 *
 * One case is new. A gallery that could not be READ used to render exactly like
 * a gallery with nothing in it, which is the "empty list and failed read must
 * be distinguishable" rule broken in the smallest possible way: it taught
 * people their organisation had no Blueprints.
 */

function pick(container, contents) {
    const input = container.querySelector('input[type="file"]');
    const file = new File([contents], 'x.blueprint.json', { type: 'application/json' });
    // jsdom's File has no text(); the component awaits it.
    file.text = async () => contents;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
}

/** The gallery listing plus whatever the wizard asks for once it is open. */
function mockFetch({ blueprints = [], galleryFails = false } = {}) {
    globalThis.__authFetch = vi.fn(async (url) => {
        if (url.includes('/api/projects/package/blueprints/')) {
            return { ok: true, status: 200, json: async () => ({ blueprint: { manifest: BLUEPRINT } }) };
        }
        if (url.includes('/api/projects/package/blueprints')) {
            if (galleryFails) throw new Error('offline');
            return { ok: true, status: 200, json: async () => ({ blueprints }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });
}

const BLUEPRINT = {
    format: 'beeflow.blueprint',
    solution: {
        key: 'sol_1', version: 3, name: 'Onboarding', description: '',
        entities: { automations: [{ ref: 'aut_1', kind: 'automation', title: 'R', definition: { steps: [] } }] },
    },
};

const posted = () => globalThis.__authFetch.mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(() => mockFetch());
afterEach(() => { delete globalThis.__authFetch; });

describe('naming a Blueprint', () => {
    it('hands the parsed file to the wizard rather than installing it', async () => {
        const { container } = render(<InstallBlueprintButton />);
        pick(container, JSON.stringify(BLUEPRINT));

        // The wizard opens on step 1, describing what it read…
        expect(await screen.findByTestId('install-contents')).toBeTruthy();
        expect(screen.getByTestId('install-contents').textContent).toContain('1 routine');
        // …and nothing has been created.
        expect(posted()).toHaveLength(0);
    });

    it('rejects a file that is not JSON without opening anything', async () => {
        const { container, findByText } = render(<InstallBlueprintButton />);
        pick(container, 'this is not json');
        expect(await findByText('That file is not a Blueprint.')).toBeTruthy();
        expect(screen.queryByTestId('install-contents')).toBeNull();
        expect(posted()).toHaveLength(0);
    });
});

describe('the gallery', () => {
    it('offers Blueprints kept on this instance, by name and version', async () => {
        mockFetch({ blueprints: [{ id: 'bp_1', name: 'Onboarding', version: 3 }] });
        const { findByText } = render(<InstallBlueprintButton />);
        expect(await findByText('Onboarding · v3')).toBeTruthy();
    });

    it('opens the wizard on a saved one by id, so the stored bytes are the ones described', async () => {
        mockFetch({ blueprints: [{ id: 'bp_1', name: 'Onboarding', version: 3 }] });
        const { findByText } = render(<InstallBlueprintButton />);
        fireEvent.click(await findByText('Onboarding · v3'));

        await waitFor(() => expect(screen.getByTestId('install-contents')).toBeTruthy());
        const read = globalThis.__authFetch.mock.calls
            .find(([url]) => url.includes('/package/blueprints/bp_1'));
        expect(read).toBeTruthy();
        expect(posted()).toHaveLength(0);
    });

    it('an empty gallery looks like "there are none"', async () => {
        mockFetch({ blueprints: [] });
        const { queryByText, container } = render(<InstallBlueprintButton />);
        await waitFor(() => expect(container.querySelector('button')).toBeTruthy());
        expect(queryByText('Kept on this instance:')).toBeNull();
        expect(screen.queryByTestId('blueprint-gallery-unavailable')).toBeNull();
    });

    it('A GALLERY THAT COULD NOT BE READ DOES NOT LOOK EMPTY', async () => {
        mockFetch({ galleryFails: true });
        const { container } = render(<InstallBlueprintButton />);
        expect(await screen.findByTestId('blueprint-gallery-unavailable')).toBeTruthy();
        // And the other way in still works.
        pick(container, JSON.stringify(BLUEPRINT));
        expect(await screen.findByTestId('install-contents')).toBeTruthy();
    });
});
