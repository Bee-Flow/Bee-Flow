import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/**
 * CHARACTERISATION — the Content tab of a project as it behaves today (PRJ-0).
 *
 * The load-bearing behaviour here is that NULL IS NOT ZERO: the resources
 * endpoint answers null for a section whose store could not be reached and []
 * for a section that is genuinely empty. Rendering the two the same way tells
 * someone their notebooks have disappeared, so the distinction is pinned
 * section by section.
 *
 * Translation is stubbed to the identity translator: this file pins which key
 * is reached for, not today's wording (that is PRJ-11's business).
 */
vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t: (k, fallback) => (typeof fallback === 'string' ? fallback : k), locale: 'en' }),
    useTranslation: () => ({ t: (k, fallback) => (typeof fallback === 'string' ? fallback : k), locale: 'en' }),
}));

const { default: ProjectResourcesTab, SECTIONS } = await import('./ProjectResourcesTab');

const EMPTY = {
    notebooks: [], apps: [], automations: [], webpages: [],
    datatables: [], agents: [], knowledgeBases: [], approvals: [],
};

const renderTab = (props = {}) => render(
    <ProjectResourcesTab resources={EMPTY} loading={false} role="owner" currentUserId="me" {...props} />,
);

// The heading row is icon + label + (only when there are items) the count, so
// the text of that one row says whether a counter is drawn at all.
const sectionHeader = (getByText, labelKey) => getByText(labelKey).parentElement;

describe('the sections themselves', () => {
    it('always lists the same eight kinds, in order', () => {
        expect(SECTIONS.map(s => s.key)).toEqual([
            'notebooks', 'apps', 'automations', 'webpages',
            'datatables', 'agents', 'knowledgeBases', 'approvals',
        ]);
    });

    it('every section names a server kind, and no two share one', () => {
        // The failure this catches: a section whose `key` the resources payload
        // never carries renders "could not load this" for ever, and a duplicate
        // kind makes the remove button act on the wrong list.
        const kinds = SECTIONS.map(s => s.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
        expect(new Set(SECTIONS.map(s => s.key)).size).toBe(SECTIONS.length);
        for (const s of SECTIONS) expect(typeof s.labelKey).toBe('string');
    });

    it('renders every section heading even when the project holds nothing', () => {
        const { getByText } = renderTab();
        for (const s of SECTIONS) expect(getByText(s.labelKey)).toBeTruthy();
    });

    it('spins instead of drawing sections while the first load is running', () => {
        const { container, queryByText } = renderTab({ loading: true, resources: null });
        expect(container.querySelector('.animate-spin')).toBeTruthy();
        expect(queryByText('projects.notebooks')).toBeNull();
    });
});

describe('empty is not the same as unreachable', () => {
    it('says "nothing here yet" for a section that came back empty', () => {
        const { getAllByText } = renderTab();
        expect(getAllByText('Nothing here yet.')).toHaveLength(8);
    });

    it('warns, and promises the items are safe, for a section that came back null', () => {
        const { getByText } = renderTab({ resources: { ...EMPTY, notebooks: null } });
        expect(getByText('Could not load this section. Your items are safe — try again shortly.')).toBeTruthy();
    });

    it('treats a section the payload never mentioned as unreachable, not empty', () => {
        const { getAllByText } = renderTab({ resources: { notebooks: [] } });
        // Seven sections are missing from the payload entirely.
        expect(getAllByText('Could not load this section. Your items are safe — try again shortly.')).toHaveLength(7);
    });

    it('warns for every section when the whole payload is still null', () => {
        const { getAllByText } = renderTab({ resources: null });
        expect(getAllByText('Could not load this section. Your items are safe — try again shortly.')).toHaveLength(8);
    });
});

describe('the items in a section', () => {
    it('counts a section only once it holds something', () => {
        const { getByText } = renderTab({
            resources: {
                ...EMPTY,
                apps: [
                    { id: 'a1', name: 'Invoice desk', userId: 'me' },
                    { id: 'a2', name: 'Payroll', userId: 'me' },
                ],
            },
        });
        expect(getByText('Invoice desk')).toBeTruthy();
        expect(sectionHeader(getByText, 'projects.apps').textContent).toBe('projects.apps2');
        // The other seven are empty and carry no badge — not even a '0'.
        for (const { labelKey } of SECTIONS.filter(s => s.key !== 'apps')) {
            expect(sectionHeader(getByText, labelKey).textContent).toBe(labelKey);
        }
    });

    it('counts nothing for a section that could not be loaded', () => {
        const { getByText } = renderTab({ resources: { ...EMPTY, notebooks: null } });
        expect(sectionHeader(getByText, 'projects.notebooks').textContent).toBe('projects.notebooks');
    });

    it('names an item by name, then title, then the question it asks', () => {
        const { getByText } = renderTab({
            resources: {
                ...EMPTY,
                apps: [{ id: 'a1', name: 'By name' }],
                webpages: [{ id: 'w1', title: 'By title' }],
                approvals: [{ id: 'p1', prompt: 'Ship it?' }],
            },
        });
        expect(getByText('By name')).toBeTruthy();
        expect(getByText('By title')).toBeTruthy();
        expect(getByText('Ship it?')).toBeTruthy();
    });

    // wrat: an item with none of name/title/prompt renders as the literal
    // English word "Untitled" — the one string on this tab that never goes
    // through t(). Hoort in stage PRJ-11 te veranderen.
    it('falls back to a hard-coded "Untitled" for a nameless item', () => {
        const { getByText } = renderTab({ resources: { ...EMPTY, apps: [{ id: 'a1' }] } });
        expect(getByText('Untitled')).toBeTruthy();
    });

    it('hands the kind and the whole item back when one is opened', () => {
        const onOpen = vi.fn();
        const item = { id: 'n1', name: 'Field notes', userId: 'me' };
        const { getByText } = renderTab({ resources: { ...EMPTY, notebooks: [item] }, onOpen });
        fireEvent.click(getByText('Field notes'));
        expect(onOpen).toHaveBeenCalledWith('notebook', item);
    });
});

describe('who may pull something back out', () => {
    const withApp = (extra = {}) => ({
        ...EMPTY,
        apps: [{ id: 'a1', name: 'Invoice desk', userId: 'me', ...extra }],
    });

    it('offers remove to an owner on their own item', () => {
        const { getByTitle } = renderTab({ resources: withApp() });
        expect(getByTitle('projects.remove_from_project')).toBeTruthy();
    });

    it('offers remove to an editor on their own item', () => {
        const { getByTitle } = renderTab({ resources: withApp(), role: 'editor' });
        expect(getByTitle('projects.remove_from_project')).toBeTruthy();
    });

    it('withholds remove from a viewer', () => {
        const { queryByTitle } = renderTab({ resources: withApp(), role: 'viewer' });
        expect(queryByTitle('projects.remove_from_project')).toBeNull();
    });

    it('withholds remove on a colleague\'s item, even from the project owner', () => {
        const { queryByTitle } = renderTab({ resources: withApp({ userId: 'anna' }) });
        expect(queryByTitle('projects.remove_from_project')).toBeNull();
    });

    it('accepts ownerId as well as userId when deciding whose item it is', () => {
        const { getByTitle } = renderTab({
            resources: { ...EMPTY, apps: [{ id: 'a1', name: 'X', ownerId: 'me' }] },
        });
        expect(getByTitle('projects.remove_from_project')).toBeTruthy();
    });

    it('never offers remove on an approval — a decision is a record, not a resource', () => {
        const { queryByTitle } = renderTab({
            resources: { ...EMPTY, approvals: [{ id: 'p1', prompt: 'Ship it?', userId: 'me' }] },
        });
        expect(queryByTitle('projects.remove_from_project')).toBeNull();
    });

    it('hands the kind and the item to the remove handler', () => {
        const onRemove = vi.fn();
        const item = { id: 'r1', name: 'Nightly invoices', userId: 'me' };
        const { getByTitle } = renderTab({ resources: { ...EMPTY, automations: [item] }, onRemove });
        fireEvent.click(getByTitle('projects.remove_from_project'));
        expect(onRemove).toHaveBeenCalledWith('automation', item);
    });
});

describe('the read-only note', () => {
    it('closes the tab with a read-only line for a viewer', () => {
        const { getByText } = renderTab({ role: 'viewer' });
        expect(getByText('projects.viewer_readonly')).toBeTruthy();
    });

    it('leaves the note off for an owner and an editor', () => {
        expect(renderTab().queryByText('projects.viewer_readonly')).toBeNull();
        expect(renderTab({ role: 'editor' }).queryByText('projects.viewer_readonly')).toBeNull();
    });
});

describe('whose item it is, per kind', () => {
    // The stores each spell ownership differently, and the old rule was a
    // `item.userId || item.ownerId` chain that covered none of the three new
    // kinds — so the remove button simply never appeared for them, and would
    // have started appearing for any field a future store happened to name
    // `userId`. The allow-list per section is what fixes both halves.
    const one = (key, item) => ({ ...EMPTY, [key]: [{ id: 'x1', name: 'Thing', ...item }] });

    it('reads ownerUserId for a table', () => {
        const { getByTitle } = renderTab({ resources: one('datatables', { ownerUserId: 'me' }) });
        expect(getByTitle('projects.remove_from_project')).toBeTruthy();
    });

    it('withholds remove on a colleague\'s table', () => {
        const { queryByTitle } = renderTab({ resources: one('datatables', { ownerUserId: 'anna' }) });
        expect(queryByTitle('projects.remove_from_project')).toBeNull();
    });

    it('reads ownerId for an agent', () => {
        const { getByTitle } = renderTab({ resources: one('agents', { ownerId: 'me' }) });
        expect(getByTitle('projects.remove_from_project')).toBeTruthy();
    });

    it('does NOT accept another kind\'s owner field', () => {
        // An app carrying only `ownerUserId` is an app whose owner we could not
        // read. Unknown ownership must not become "yours".
        const { queryByTitle } = renderTab({ resources: one('apps', { ownerUserId: 'me' }) });
        expect(queryByTitle('projects.remove_from_project')).toBeNull();
    });

    it('lets any editor take a knowledge base out — its link is on the project', () => {
        // No owner field at all, and that is the point: the base is linked from
        // projects.knowledge_base_ids, so removing it is a project act. The
        // server agrees — detaching needs no read access.
        const { getByTitle } = renderTab({
            resources: one('knowledgeBases', { }), role: 'editor',
        });
        expect(getByTitle('projects.remove_from_project')).toBeTruthy();
    });

    it('still withholds it from a viewer', () => {
        const { queryByTitle } = renderTab({ resources: one('knowledgeBases', {}), role: 'viewer' });
        expect(queryByTitle('projects.remove_from_project')).toBeNull();
    });

    it('withholds remove when nobody is signed in', () => {
        const { queryByTitle } = renderTab({
            resources: one('datatables', { ownerUserId: undefined }), currentUserId: undefined,
        });
        expect(queryByTitle('projects.remove_from_project')).toBeNull();
    });

    it('hands the new kinds to the remove handler by their server kind', () => {
        const onRemove = vi.fn();
        const item = { id: 'ag1', name: 'Helper', ownerId: 'me' };
        const { getByTitle } = renderTab({ resources: { ...EMPTY, agents: [item] }, onRemove });
        fireEvent.click(getByTitle('projects.remove_from_project'));
        expect(onRemove).toHaveBeenCalledWith('agent', item);
    });
});
