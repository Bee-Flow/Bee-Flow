import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import AddStepRibbon from './AddStepRibbon';
import scopedStorage, { setCurrentUser } from '../../../../utils/scopedStorage';
import { STEP_DND_MIME } from './stepDrag';
import { ribbonAnchor } from './ribbon/ribbonAnchor';

vi.mock('../../../../api/queries/automation/usage', () => ({
    useOrgStepUsageQuery: () => ({ data: [{ key: 'step:wait', count: 12 }, { key: 'step:approval', count: 3 }] }),
}));
vi.mock('../../../../api/queries/skills', () => ({
    useSkillsQuery: () => ({ data: [{ id: 'sk1', name: 'Meeting summary', description: 'Summarise a meeting' }] }),
}));

const ncApp = (id: string, label: string, actions: Array<[string, string]>) => ({
    id, label, available: true, connected: true,
    actions: actions.map(([name, l]) => ({ name, label: l, integrationId: id, description: `${l} in ${label}.` })),
});

const catalog = {
    flags: {},
    steps: [{ id: 'blk1', title: 'Fast websearch', category: 'Research', params: [{}], outputFields: [{}], available: true }],
    agents: [{ id: 'ag1', name: 'Quote assistant', canUse: true }, { id: 'ag2', name: 'Quote checker', canUse: false, reason: 'Not published' }],
    apps: [
        ncApp('nextcloud-talk', 'Nextcloud Talk', [['nextcloud_talk_send_message', 'Send message'], ['nextcloud_talk_list_rooms', 'List rooms']]),
        ncApp('nextcloud-deck', 'Nextcloud Deck', [['nextcloud_deck_create_card', 'Create card']]),
        { ...ncApp('gmail', 'Gmail', [['gmail_send', 'Send email']]), actions: [{ name: 'gmail_send', label: 'Send email', integrationId: 'gmail', outputSample: [] }] },
    ],
};

const def = {
    trigger: { id: 't', type: 'trigger', kind: 'manual', label: 'Manual' },
    steps: [{ id: 'a', type: 'integration_action', tool: 'gmail_send', label: 'Mail the team' }],
    edges: [{ from: 't', to: 'a' }],
};

const scope = { catalog, layers: [], inLayer: false, canAddLayerOutput: false, isBlockRoot: false };

function renderRibbon(props: Record<string, unknown> = {}) {
    const onAddNode = vi.fn();
    const utils = render(<AddStepRibbon scope={scope} onAddNode={onAddNode} anchor={ribbonAnchor(def, null)} {...props} />);
    return { onAddNode, ...utils };
}

const tab = (name: RegExp | string) => screen.getByRole('tab', { name });
/** The open dropdown (portalled to <body>). */
const menu = () => document.querySelector('[data-ribbon-dropdown]') as HTMLElement | null;
/** The pills on the open tab's row, by their visible label. */
const pillLabels = () => within(screen.getByTestId('ribbon-panel').querySelector('[data-ribbon-pill-row]') as HTMLElement)
    .getAllByRole('button').map(b => b.textContent);
/** The same, from the label alone: a brand logo can carry text of its own (Calendar's "31", Outlook's "O"). */
const pillNames = () => within(screen.getByTestId('ribbon-panel').querySelector('[data-ribbon-pill-row]') as HTMLElement)
    .getAllByRole('button').map(b => b.querySelector('span.truncate')?.textContent ?? b.textContent);

describe('AddStepRibbon (design 5a)', () => {
    beforeEach(() => { localStorage.clear(); setCurrentUser('user-1'); });
    afterEach(() => { cleanup(); setCurrentUser(null); });

    it('rests as one row: search, the category tabs and where a click lands, no panel', () => {
        renderRibbon();
        expect(screen.getByRole('combobox', { name: 'Add a step' })).toBeInTheDocument();
        expect(screen.getAllByRole('tab').map(el => el.getAttribute('aria-label'))).toEqual([
            // No outside app in this catalog, so no Other apps tab.
            'AI', 'Logic', 'People', 'Data & documents', 'Nextcloud apps', 'Google Workspace', 'My building blocks',
        ]);
        expect(screen.getByTestId('ribbon-adds-after')).toHaveTextContent('Adds afterstep 2 · Mail the team');
        expect(screen.queryByTestId('ribbon-panel')).toBeNull();
        // Home / Apps / Reusable and the trigger command are gone.
        expect(screen.queryByRole('tab', { name: 'Home' })).toBeNull();
        expect(screen.queryByText(/Change or add/)).toBeNull();
    });

    it('"Adds after": the whole sentence is the tooltip, and a small ribbon keeps only "step n" in the pill', () => {
        renderRibbon();
        const where = screen.getByTestId('ribbon-adds-after');
        expect(where.getAttribute('title')).toBe('Adds after step 2 · Mail the team');
        // Both forms are rendered; the ribbon's own width picks one (no viewport
        // breakpoint). Two suite tabs (Nextcloud, Google Workspace) fold 150px
        // sooner than one.
        expect(within(where).getByText('step 2 · Mail the team').className).toContain('@max-[1590px]/ribbon:hidden');
        expect(within(where).getByText('step 2').className).toContain('@max-[1590px]/ribbon:inline');
        expect(tab('Logic').className).toContain('@max-[1330px]/ribbon:px-2');
    });

    it('folds by how many suite tabs the row carries', () => {
        const nextcloudOnly = { ...catalog, apps: catalog.apps.filter(a => a.id !== 'gmail') };
        renderRibbon({ scope: { ...scope, catalog: nextcloudOnly } });
        expect(within(screen.getByTestId('ribbon-adds-after')).getByText('step 2').className).toContain('@max-[1440px]/ribbon:inline');
        expect(tab('Logic').className).toContain('@max-[1180px]/ribbon:px-2');
        cleanup();
        const all = { ...catalog, apps: [...catalog.apps, ncApp('outlook', 'Outlook', [['outlook_search', 'Search email']])] };
        renderRibbon({ scope: { ...scope, catalog: all } });
        expect(within(screen.getByTestId('ribbon-adds-after')).getByText('step 2').className).toContain('@max-[1740px]/ribbon:inline');
        expect(tab('Logic').className).toContain('@max-[1480px]/ribbon:px-2');
    });

    it('opens ONE category per tab click and folds again on a second click', async () => {
        const user = userEvent.setup();
        renderRibbon();
        await user.click(tab('Logic'));
        expect(screen.getByTestId('ribbon-panel')).toHaveAttribute('data-category', 'logic');
        expect(screen.queryByTestId('ribbon-people')).toBeNull();
        await user.click(tab('People'));
        expect(screen.getByTestId('ribbon-people')).toBeInTheDocument();
        expect(scopedStorage.getItem('automationsRibbonCategory')).toBe('people');
        await user.click(tab('People'));
        expect(screen.queryByTestId('ribbon-panel')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Show this category' }));
        expect(screen.getByTestId('ribbon-people')).toBeInTheDocument();
    });

    it('adds from a category and folds the panel away', async () => {
        const user = userEvent.setup();
        const { onAddNode } = renderRibbon();
        await user.click(tab('Logic'));
        await user.click(within(screen.getByTestId('ribbon-logic')).getByRole('button', { name: 'Repeat for each' }));
        expect(onAddNode).toHaveBeenCalledWith(expect.objectContaining({ kind: 'loop' }));
        expect(screen.queryByTestId('ribbon-panel')).toBeNull();
    });

    // The Suggested tab is switched off by design (owner, 2026-09-28); see
    // SUGGESTED_TAB_ENABLED in ribbon/ribbonCategories.ts. Its cards stay
    // covered by the fitsAfter tests in ribbon/ribbonLogic.test.ts.
    it('offers no Suggested tab and opens on the first real category', async () => {
        const user = userEvent.setup();
        renderRibbon({ anchor: ribbonAnchor(def, 'a') });
        expect(screen.queryByRole('tab', { name: /Suggested/ })).toBeNull();
        expect(screen.queryByText('Suggested')).toBeNull();
        await user.click(tab('AI'));
        expect(screen.getByTestId('ribbon-ai')).toBeInTheDocument();
        expect(screen.queryByTestId('ribbon-fits-after')).toBeNull();
    });

    describe('every tab is ONE row of pills, like the Nextcloud apps', () => {
        it.each([
            ['AI', ['AI step', 'Extract data', 'Use an agent', 'Apply a skill']],
            ['Logic', ['Condition', 'Repeat for each', 'Call a web service', 'Privacy Shield', 'End the run', 'Note']],
            ['People', ['Ask someone to approve', 'Notification', 'Wait', 'Form pages']],
            ['Data & documents', ['Edit data', 'Date & time', 'Tables', 'Documents', 'Lists']],
            ['Nextcloud apps', ['Talk', 'Deck']],
            ['Google Workspace', ['Gmail']],
            ['My building blocks', ['Create flowlet', 'Fast websearch']],
        ])('%s', async (name, pills) => {
            const user = userEvent.setup();
            renderRibbon();
            await user.click(tab(name));
            expect(pillLabels()).toEqual(pills);
            // No bordered cluster boxes and none of their uppercase captions.
            const panel = screen.getByTestId('ribbon-panel');
            expect(panel.querySelector('.border.rounded-lg, .rounded-xl.border')).toBeNull();
            for (const caption of ['Records & tables', 'More AI', 'Web & code', 'Agents', 'Skills', 'Drag an agent or skill straight onto the canvas']) {
                expect(within(panel).queryByText(caption)).toBeNull();
            }
        });

    });

    describe('pills and their dropdowns', () => {
        it('a group pill opens its steps as a list; a row adds and folds the panel', async () => {
            const user = userEvent.setup();
            const { onAddNode } = renderRibbon();
            await user.click(tab('Data & documents'));
            const documents = screen.getByRole('button', { name: 'Documents' });
            expect(documents).toHaveAttribute('aria-haspopup', 'true');
            expect(documents).toHaveAttribute('aria-expanded', 'false');
            // The group carries the section stamp, so a card still has an origin while its command is hidden.
            expect(documents).toHaveAttribute('data-ribbon-origin', 'section:data');
            await user.click(documents);
            expect(documents).toHaveAttribute('aria-expanded', 'true');
            const list = menu() as HTMLElement;
            expect(within(list).getByText('Documents')).toBeInTheDocument();
            expect(within(list).getAllByRole('button').map(b => b.querySelector('.text-sm')?.textContent))
                .toEqual(['Make a document', 'Fill a document', 'Slide', 'Presentation']);
            await user.click(within(list).getByRole('button', { name: /Fill a document/ }));
            expect(onAddNode).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fill_document' }));
            expect(menu()).toBeNull();
            expect(screen.queryByTestId('ribbon-panel')).toBeNull();
        });

        it('a direct pill adds on click and on Enter; a dropdown row drags onto the canvas', async () => {
            const user = userEvent.setup();
            const { onAddNode } = renderRibbon();
            await user.click(tab('Data & documents'));
            await user.click(screen.getByRole('button', { name: 'Edit data' }));
            expect(onAddNode).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'set' }));
            await user.click(tab('Data & documents'));
            screen.getByRole('button', { name: 'Date & time' }).focus();
            await user.keyboard('{Enter}');
            expect(onAddNode).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'datetime' }));
            await user.click(tab('Data & documents'));
            await user.click(screen.getByRole('button', { name: 'Lists' }));
            const setData = vi.fn();
            fireEvent.dragStart(within(menu() as HTMLElement).getByRole('button', { name: /Remove duplicates/ }), { dataTransfer: { setData, effectAllowed: '' } });
            expect(setData).toHaveBeenCalledWith(STEP_DND_MIME, expect.stringContaining('"kind":"dedupe"'));
        });

        it('Escape and a click outside close a dropdown', async () => {
            const user = userEvent.setup();
            renderRibbon();
            await user.click(tab('Logic'));
            const end = screen.getByRole('button', { name: 'End the run' });
            expect(end).toHaveAttribute('data-ribbon-origin', 'section:flow_control');
            await user.click(end);
            expect(within(menu() as HTMLElement).getByRole('button', { name: /Back to the app/ })).toBeInTheDocument();
            await user.keyboard('{Escape}');
            expect(menu()).toBeNull();
            await user.click(end);
            expect(menu()).not.toBeNull();
            await user.click(document.body);
            expect(menu()).toBeNull();
        });

        it('a step the graph cannot take stays in its list, disabled, with the reason', async () => {
            const user = userEvent.setup();
            const { onAddNode } = renderRibbon({ scope: { ...scope, hasFormTrigger: false } });
            await user.click(tab('People'));
            await user.click(screen.getByRole('button', { name: 'Form pages' }));
            const row = within(menu() as HTMLElement).getByRole('button', { name: /Form: ask for more info/ });
            expect(row).toBeDisabled();
            expect(row).toHaveTextContent(/switch the trigger to "Form"/);
            expect(row).not.toHaveAttribute('draggable');
            expect(onAddNode).not.toHaveBeenCalled();
        });
    });

    describe('AI', () => {
        it('AI step is a pill of its own; an agent from "Use an agent" lands as an AI step with agentId', async () => {
            const user = userEvent.setup();
            const { onAddNode } = renderRibbon();
            await user.click(tab('AI'));
            const panel = screen.getByTestId('ribbon-ai');
            expect(within(panel).getByRole('button', { name: 'AI step' })).toHaveAttribute('data-ribbon-origin', 'section:ai');
            const useAgent = within(panel).getByRole('button', { name: 'Use an agent' });
            expect(useAgent).toHaveAttribute('aria-haspopup', 'true');
            expect(useAgent).toHaveAttribute('data-ribbon-origin', 'section:ai');
            await user.click(useAgent);
            const list = menu() as HTMLElement;
            // The drag hint moved from the old caption into the list's header.
            expect(list).toHaveTextContent('Drag an agent or skill straight onto the canvas');
            const checker = within(list).getByRole('button', { name: /Quote checker/ });
            expect(checker).toBeDisabled();
            expect(checker).toHaveTextContent('Not published');
            await user.click(within(list).getByRole('button', { name: /Quote assistant/ }));
            expect(onAddNode).toHaveBeenCalledWith({ kind: 'ai_step', label: 'Quote assistant', agentId: 'ag1' });
        });

        it('lists skills under "Apply a skill", each dragging with its skillIds', async () => {
            const user = userEvent.setup();
            renderRibbon();
            await user.click(tab('AI'));
            await user.click(screen.getByRole('button', { name: 'Apply a skill' }));
            const skill = within(menu() as HTMLElement).getByRole('button', { name: /Meeting summary/ });
            const setData = vi.fn();
            fireEvent.dragStart(skill, { dataTransfer: { setData, effectAllowed: '' } });
            expect(setData).toHaveBeenCalledWith(STEP_DND_MIME, JSON.stringify({ kind: 'ai_step', label: 'Meeting summary', skillIds: ['sk1'] }));
        });

        it('a long list of agents gets a filter', async () => {
            const user = userEvent.setup();
            const agents = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, name: i === 5 ? 'Invoice reader' : `Helper ${i}`, canUse: true }));
            renderRibbon({ scope: { ...scope, catalog: { ...catalog, agents } } });
            await user.click(tab('AI'));
            await user.click(screen.getByRole('button', { name: 'Use an agent' }));
            await user.type(within(menu() as HTMLElement).getByRole('textbox', { name: 'Filter 8 agents…' }), 'invoice');
            expect(within(menu() as HTMLElement).getAllByRole('button').map(b => b.querySelector('.text-sm')?.textContent)).toEqual(['Invoice reader']);
        });
    });

    describe('apps', () => {
        it('Nextcloud apps: a single-action app adds directly, a multi-action app opens its actions', async () => {
            const user = userEvent.setup();
            const { onAddNode } = renderRibbon();
            await user.click(tab('Nextcloud apps'));
            const panel = screen.getByTestId('ribbon-nextcloud');
            await user.click(within(panel).getByRole('button', { name: 'Deck' }));
            expect(onAddNode).toHaveBeenCalledWith(expect.objectContaining({ kind: 'integration_action', tool: 'nextcloud_deck_create_card', label: 'Nextcloud Deck' }));
            await user.click(tab('Nextcloud apps'));
            await user.click(within(screen.getByTestId('ribbon-nextcloud')).getByRole('button', { name: /Talk/ }));
            await user.click(screen.getByRole('button', { name: /Send message/ }));
            expect(onAddNode).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'nextcloud_talk_send_message' }));
        });

        it('Google Workspace and Microsoft 365: a tab each, every app a pill by its short name', async () => {
            const user = userEvent.setup();
            const suites = { ...catalog, apps: [
                ncApp('google-calendar', 'Google Calendar', [['gcal_create', 'Create event'], ['gcal_list', 'List events']]),
                ncApp('google-drive', 'Google Drive', [['gdrive_upload', 'Upload file']]),
                ncApp('gmail', 'Gmail', [['gmail_send', 'Send email']]),
                ncApp('outlook', 'Outlook', [['outlook_search', 'Search email']]),
                ncApp('onedrive', 'OneDrive', [['onedrive_upload', 'Upload file']]),
            ] };
            const { onAddNode } = renderRibbon({ scope: { ...scope, catalog: suites } });
            expect(tab('Google Workspace')).toHaveAttribute('data-ribbon-origin', 'cat:Google Workspace');
            expect(tab('Microsoft 365')).toHaveAttribute('data-ribbon-origin', 'cat:Microsoft 365');
            await user.click(tab('Google Workspace'));
            expect(pillNames()).toEqual(['Calendar', 'Drive', 'Gmail']);
            const google = screen.getByTestId('ribbon-google');
            expect(within(google).getByRole('button', { name: 'Gmail' })).toHaveAttribute('data-ribbon-origin', 'app:gmail');
            await user.click(within(google).getByRole('button', { name: 'Drive' }));
            // The payload keeps the full name: a card on the canvas names its vendor.
            expect(onAddNode).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'gdrive_upload', label: 'Google Drive' }));
            await user.click(tab('Google Workspace'));
            await user.click(within(screen.getByTestId('ribbon-google')).getByRole('button', { name: /Calendar/ }));
            await user.click(screen.getByRole('button', { name: /List events/ }));
            expect(onAddNode).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'gcal_list' }));
            await user.click(tab('Microsoft 365'));
            expect(pillNames()).toEqual(['OneDrive', 'Outlook']);
            expect(within(screen.getByTestId('ribbon-microsoft')).getByRole('button', { name: /Outlook/ })).toHaveAttribute('data-ribbon-origin', 'app:outlook');
        });

        it('Other apps: only the outside apps without a tab of their own, and no tab when there are none', async () => {
            const user = userEvent.setup();
            renderRibbon();
            expect(screen.queryByRole('tab', { name: 'Other apps' })).toBeNull();
            cleanup();
            const withOutside = { ...catalog, apps: [...catalog.apps, ncApp('youtrack', 'YouTrack', [['youtrack_create_issue', 'Create issue']])] };
            renderRibbon({ scope: { ...scope, catalog: withOutside } });
            await user.click(tab('Other apps'));
            expect(pillNames()).toEqual(['YouTrack']);
        });

        it('Other apps: a category of three apps is ONE pill listing them; an app of several actions opens them, with a way back', async () => {
            const user = userEvent.setup();
            const productivity = { ...catalog, apps: [
                ncApp('fireflies', 'Fireflies', [['fireflies_list', 'List transcripts'], ['fireflies_get', 'Get transcript']]),
                ncApp('gamma', 'Gamma', [['gamma_create', 'Create presentation']]),
                ncApp('signrequest', 'SignRequest', [['signrequest_send', 'Send for signing']]),
            ] };
            const { onAddNode } = renderRibbon({ scope: { ...scope, catalog: productivity } });
            await user.click(tab('Other apps'));
            const suite = within(screen.getByTestId('ribbon-other-apps')).getByRole('button', { name: 'Productivity' });
            expect(suite).toHaveAttribute('data-ribbon-origin', 'cat:Productivity');
            await user.click(suite);
            const list = menu() as HTMLElement;
            expect(within(list).getAllByRole('button').map(b => b.querySelector('.text-sm')?.textContent)).toEqual(['Fireflies', 'Gamma', 'SignRequest']);
            await user.click(within(list).getByRole('button', { name: /Fireflies/ }));
            expect(within(menu() as HTMLElement).getByRole('button', { name: /Get transcript/ })).toBeInTheDocument();
            await user.click(within(menu() as HTMLElement).getByRole('button', { name: 'Back' }));
            await user.click(within(menu() as HTMLElement).getByRole('button', { name: /Gamma/ }));
            expect(onAddNode).toHaveBeenCalledWith(expect.objectContaining({ tool: 'gamma_create', label: 'Gamma' }));
        });
    });

    describe('Bee Flow\'s own steps and tools', () => {
        it('sit on the tab of their job: Code and Call a web service on Logic, the tools beside them', async () => {
            const user = userEvent.setup();
            const native = { ...catalog, flags: { code: true }, apps: [
                ncApp('agent-search', 'Web Search', [['agent_search', 'Search the web']]),
                ncApp('memory', 'Memory', [['memory_search', 'Search memory'], ['memory_remember', 'Remember']]),
                ncApp('kb-ingest', 'Knowledge Base Ingest', [['knowledge_base_ingest', 'Add to knowledge base']]),
                ncApp('automation-evolution', 'Automation evolution', [['automation_runs_summary', 'Runs summary'], ['automation_propose_evolution', 'Propose a change']]),
                ncApp('fireflies', 'Fireflies', [['fireflies_list', 'List transcripts']]),
            ] };
            const { onAddNode } = renderRibbon({ scope: { ...scope, catalog: native } });
            await user.click(tab('AI'));
            expect(pillNames()).toEqual(['AI step', 'Extract data', 'Use an agent', 'Apply a skill', 'Web Search', 'Memory']);
            await user.click(within(screen.getByTestId('ribbon-ai')).getByRole('button', { name: /Web Search/ }));
            expect(onAddNode).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'integration_action', tool: 'agent_search' }));
            await user.click(tab('Logic'));
            expect(pillNames()).toEqual(['Condition', 'Repeat for each', 'Code', 'Call a web service', 'Privacy Shield', 'End the run', 'Note', 'Automation evolution']);
            await user.click(tab('Data & documents'));
            expect(pillNames()).toEqual(['Edit data', 'Date & time', 'Tables', 'Documents', 'Lists', 'Knowledge Base Ingest']);
            await user.click(tab('Other apps'));
            expect(pillNames()).toEqual(['Fireflies']);
        });

        it('My building blocks lists flowlets and reusable steps', async () => {
            const user = userEvent.setup();
            renderRibbon();
            await user.click(tab('My building blocks'));
            const panel = screen.getByTestId('ribbon-blocks');
            expect(within(panel).getByRole('button', { name: 'Create flowlet' })).toBeInTheDocument();
            expect(within(panel).getByRole('button', { name: 'Fast websearch' })).toBeInTheDocument();
        });
    });

    describe('search', () => {
        it('"/" focuses it from anywhere but a field, and a synonym finds the step', async () => {
            const user = userEvent.setup();
            const { onAddNode } = renderRibbon();
            const input = screen.getByRole('combobox', { name: 'Add a step' });
            await user.keyboard('/');
            expect(input).toHaveFocus();
            await user.keyboard('mail');
            expect(screen.getByRole('option', { name: /Send email/ })).toBeInTheDocument();
            await user.keyboard('{Enter}');
            expect(onAddNode).toHaveBeenCalledWith(expect.objectContaining({ tool: 'gmail_send' }));
            expect(input).toHaveValue('');
        });

        it('does not steal "/" from a field that has focus', async () => {
            const user = userEvent.setup();
            render(<><input aria-label="other" /><AddStepRibbon scope={scope} onAddNode={vi.fn()} /></>);
            await user.click(screen.getByRole('textbox', { name: 'other' }));
            await user.keyboard('/');
            expect(screen.getByRole('textbox', { name: 'other' })).toHaveValue('/');
        });

        it('finds agents and skills too, and says so when nothing matches', async () => {
            const user = userEvent.setup();
            renderRibbon();
            await user.click(screen.getByRole('combobox', { name: 'Add a step' }));
            await user.keyboard('meeting');
            expect(screen.getByRole('option', { name: /Meeting summary/ })).toBeInTheDocument();
            await user.clear(screen.getByRole('combobox', { name: 'Add a step' }));
            await user.keyboard('zzqx');
            expect(screen.getByRole('listbox')).toHaveTextContent('Nothing matches “zzqx”.');
        });
    });

    it('with no trigger yet it offers the ways to start', async () => {
        const user = userEvent.setup();
        const onAddNode = vi.fn();
        render(<AddStepRibbon scope={scope} hasTrigger={false} onAddNode={onAddNode} />);
        expect(screen.getByText('Start with a trigger')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Trigger manually/ }));
        expect(onAddNode).toHaveBeenCalledWith(expect.objectContaining({ kind: 'trigger', triggerKind: 'manual' }));
    });

    describe('presenting (the build film)', () => {
        it('opens the apps tab without a click, inert but not dimmed, and returns to the author tab after', () => {
            scopedStorage.setItem('automationsRibbonCategory', 'logic');
            const { rerender } = renderRibbon({ presenting: true });
            const root = screen.getByTestId('add-step-ribbon');
            expect(root.className).toContain('pointer-events-none');
            expect(root.className).not.toContain('opacity-50');
            expect(screen.getByTestId('ribbon-panel')).toHaveAttribute('data-category', 'nextcloud');
            rerender(<AddStepRibbon scope={scope} onAddNode={vi.fn()} presenting={false} />);
            expect(tab('Logic')).toHaveAttribute('aria-selected', 'true');
            expect(scopedStorage.getItem('automationsRibbonExpanded')).toBe('0');
        });

        it('stamps the root, the tab strip, the category tabs and every app command', () => {
            const rootRef = { current: null as HTMLElement | null };
            renderRibbon({ presenting: true, rootRef });
            const root = screen.getByTestId('add-step-ribbon');
            expect(rootRef.current).toBe(root);
            expect(root).toHaveAttribute('data-ribbon-origin', 'ribbon');
            expect(screen.getByRole('tablist')).toHaveAttribute('data-ribbon-origin', 'tabs');
            expect(tab('AI')).toHaveAttribute('data-ribbon-origin', 'section:ai');
            expect(tab('Logic')).toHaveAttribute('data-ribbon-origin', 'section:flow_control');
            expect(root.querySelector('[data-ribbon-origin="app:nextcloud-deck"]')).not.toBeNull();
        });
    });
});
