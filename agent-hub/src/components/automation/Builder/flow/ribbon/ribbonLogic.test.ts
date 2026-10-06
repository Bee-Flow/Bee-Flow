import { describe, it, expect } from 'vitest';
import { fitsAfterCards, mergeFrequentKeys, outputShapeOf, resolveFrequent, stepOutputIsArray } from './fitsAfter';
import { addOptionsFor, ribbonAnchor } from './ribbonAnchor';
import { expandQuery, searchRibbon } from './ribbonSearch';
import { NATIVE_APP_HOME, availableCategories, presentingCategory, ribbonSections } from './ribbonCategories';
import { getIntegrationLogo } from '../../../../../utils/integrationLogos';
import { resolveIntegrationFromTool } from '../../../../../utils/integrationIcons';
import { planBlocksRow, planRow } from './ribbonRows';
import type { SegmentPlan } from './ribbonRows';
import { normaliseUsageRows } from '../../../../../api/queries/automation/usage';

const listCatalog = {
    apps: [{ id: 'nc-files', label: 'Nextcloud Files', available: true, actions: [{ name: 'nc_files_list', outputSample: { files: [] } }] }],
};

const def = {
    trigger: { id: 't', type: 'trigger', kind: 'manual', label: 'Manual' },
    steps: [
        { id: 'a', type: 'integration_action', tool: 'nc_files_list', label: 'Files in folder' },
        { id: 'b', type: 'ai_step', label: 'Summarise' },
        { id: 'n', type: 'note', label: 'A note' },
    ],
    edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }],
};

describe('fitsAfter', () => {
    it('reads a list-shaped app action as a list and offers the list cards', () => {
        expect(stepOutputIsArray(def.steps[0], listCatalog)).toBe(true);
        expect(outputShapeOf(def.steps[0], listCatalog)).toBe('list');
        const cards = fitsAfterCards(def.steps[0], listCatalog);
        expect(cards.map(c => c.title)).toEqual(['For each item', 'Filter the list', 'Put in a datatable', 'Summarise with AI']);
        expect(cards[0].payload.kind).toBe('loop');
        expect(cards[3].payload).toMatchObject({ kind: 'ai_step', label: 'Summarise with AI' });
    });

    it('offers record cards after a single value and start cards after the trigger', () => {
        expect(fitsAfterCards(def.steps[1], listCatalog).map(c => c.payload.kind)).toEqual(['ai_step', 'condition', 'set', 'notification']);
        expect(fitsAfterCards(def.trigger, listCatalog).map(c => c.payload.kind)).toEqual(['ai_step', 'data_extraction', 'condition', 'approval']);
        expect(fitsAfterCards(null, listCatalog)).toEqual([]);
    });

    it('blends org counts with personal history, drops triggers, and resolves to addable items', () => {
        const now = Date.now();
        const keys = mergeFrequentKeys(
            [{ key: 'step:loop', count: 40 }, { key: 'trigger:manual', count: 99 }, { key: 'step:wait', count: 4 }],
            { 'step:notification': { count: 5, last: now } },
            8,
            now,
        );
        expect(keys).not.toContain('trigger:manual');
        expect(keys.slice(0, 2).sort()).toEqual(['step:loop', 'step:notification']);
        const items = resolveFrequent([...keys, 'block:gone'], { catalog: { apps: [], steps: [] } });
        expect(items.map(i => i.payload.kind)).toEqual(expect.arrayContaining(['loop', 'notification', 'wait']));
    });

    it('normalises usage rows: bare kinds become step keys, junk is dropped', () => {
        expect(normaliseUsageRows([{ key: 'loop', count: 3 }, { key: 'action:x', count: '2' }, { key: '', count: 1 }, { key: 'y', count: 0 }, null]))
            .toEqual([{ key: 'step:loop', count: 3 }, { key: 'action:x', count: 2 }]);
        expect(normaliseUsageRows({})).toEqual([]);
    });
});

describe('ribbonAnchor', () => {
    it('is the open step when there is one, numbered in run order', () => {
        const a = ribbonAnchor(def, 'a');
        expect(a).toMatchObject({ id: 'a', number: 2, label: 'Files in folder', explicit: true });
    });

    it('defaults to the last step the flow runs, never a note', () => {
        expect(ribbonAnchor(def, null)).toMatchObject({ id: 'b', number: 3, explicit: false });
        expect(ribbonAnchor(def, 'n')).toMatchObject({ id: 'b', explicit: false });
        expect(ribbonAnchor({ steps: [] }, null)).toBeNull();
    });

    it('splices into the one plain outgoing connection, otherwise wires from the step', () => {
        expect(addOptionsFor(def, ribbonAnchor(def, 'a'))).toEqual({ sourceId: 'a', targetId: 'b' });
        expect(addOptionsFor(def, ribbonAnchor(def, 'b'))).toEqual({ sourceId: 'b' });
        const branched = { ...def, edges: [...def.edges, { from: 'b', to: 'a', label: 'then' }] };
        expect(addOptionsFor(branched, ribbonAnchor(branched, 'b'))).toEqual({ sourceId: 'b' });
        expect(addOptionsFor(def, null)).toEqual({});
    });
});

describe('ribbonSearch', () => {
    const scope = {
        catalog: {
            flags: {}, steps: [],
            apps: [{ id: 'gmail', label: 'Gmail', available: true, actions: [{ name: 'gmail_send', label: 'Send email', integrationId: 'gmail' }] }],
        },
        layers: [],
    };

    it('expands a word to its synonyms, whole words only', () => {
        expect(expandQuery('mail')).toEqual(expect.arrayContaining(['mail', 'email', 'e-mail', 'send']));
        expect(expandQuery('notify')).not.toContain('nottable');
        expect(expandQuery('notify')).toEqual(expect.arrayContaining(['notification', 'alert']));
        expect(expandQuery('   ')).toEqual([]);
    });

    it('finds the email action by "mail" and a datatable by "sheet"', () => {
        expect(searchRibbon('mail', scope).map(r => r.label)).toContain('Send email');
        expect(searchRibbon('sheet', scope).some(r => r.payload.kind === 'datatable')).toBe(true);
    });

    it('never offers a trigger: the start changes on the start card', () => {
        expect(searchRibbon('schedule', scope).some(r => r.payload.kind === 'trigger')).toBe(false);
    });

    it('finds agents and skills, with the payload the AI step reads', () => {
        const res = searchRibbon('quote', scope, {
            agents: [{ id: 'ag1', name: 'Quote assistant', canUse: true }, { id: 'ag2', name: 'Quote checker', canUse: false, reason: 'Not published' }],
            skills: [{ id: 'sk1', name: 'Quote writer' }],
        });
        expect(res.find(r => r.label === 'Quote assistant')?.payload).toEqual({ kind: 'ai_step', label: 'Quote assistant', agentId: 'ag1' });
        expect(res.find(r => r.label === 'Quote checker')).toMatchObject({ disabled: true, disabledReason: 'Not published' });
        expect(res.find(r => r.label === 'Quote writer')?.payload).toEqual({ kind: 'ai_step', label: 'Quote writer', skillIds: ['sk1'] });
    });
});

describe('ribbonCategories', () => {
    it('shows the Nextcloud tab only with a Nextcloud app, and presents on it', () => {
        const none = ribbonSections({ catalog: { apps: [], steps: [], flags: {} } });
        // 'suggested' is switched off by design (SUGGESTED_TAB_ENABLED); it only
        // appears when the flag is passed on.
        // No apps at all: no app tab, not even Other apps (Call a web service is on Logic).
        expect(availableCategories(none).map(c => c.id)).toEqual(['ai', 'logic', 'people', 'data', 'blocks']);
        expect(availableCategories(none, true).map(c => c.id)).toEqual(['suggested', 'ai', 'logic', 'people', 'data', 'blocks']);
        expect(presentingCategory(availableCategories(none))).toBe('ai');
        const nc = ribbonSections({
            catalog: { steps: [], flags: {}, apps: [{ id: 'nextcloud-talk', label: 'Nextcloud Talk', available: true, actions: [{ name: 'nextcloud_talk_send_message', integrationId: 'nextcloud-talk' }] }] },
        });
        expect(nc.suiteApps.nextcloud.map(a => a.id)).toEqual(['nextcloud-talk']);
        expect(nc.otherAppCategories).toEqual([]);
        expect(presentingCategory(availableCategories(nc))).toBe('nextcloud');
    });

    it('gives Google Workspace and Microsoft 365 a tab of their own, like Nextcloud', () => {
        const app = (id: string, label: string, tool: string) => ({ id, label, available: true, actions: [{ name: tool, integrationId: id }] });
        const s = ribbonSections({
            catalog: { steps: [], flags: {}, apps: [
                app('gmail', 'Gmail', 'gmail_search'),
                app('google-drive', 'Google Drive', 'drive_list_files'),
                app('outlook', 'Outlook', 'outlook_search'),
                app('onedrive', 'OneDrive', 'onedrive_list_files'),
                app('fireflies', 'Fireflies', 'fireflies_list_transcripts'),
            ] },
        });
        expect(s.suiteApps.google.map(a => a.id)).toEqual(['google-drive', 'gmail']);
        expect(s.suiteApps.microsoft.map(a => a.id)).toEqual(['onedrive', 'outlook']);
        expect(s.otherAppCategories.flatMap(c => c.apps.map(a => a.id))).toEqual(['fireflies']);
        const tabs = availableCategories(s);
        expect(tabs.map(c => c.id)).toEqual(['ai', 'logic', 'people', 'data', 'google', 'microsoft', 'other_apps', 'blocks']);
        expect(tabs.find(c => c.id === 'google')?.origin).toBe('cat:Google Workspace');
        expect(tabs.find(c => c.id === 'microsoft')?.origin).toBe('cat:Microsoft 365');
        // The build film presents on the first suite tab there is.
        expect(presentingCategory(tabs)).toBe('google');
    });

    it('puts Bee Flow\'s own tools on the tab of their job, not under Other apps', () => {
        const app = (id: string, label: string, tool: string) => ({ id, label, available: true, actions: [{ name: tool, integrationId: id }] });
        const s = ribbonSections({
            catalog: { steps: [], flags: { code: true }, apps: [
                app('agent-search', 'Web Search', 'agent_search'),
                app('memory', 'Memory', 'memory_search'),
                app('transcription', 'Transcription', 'transcribe_audio'),
                app('kb-ingest', 'Knowledge Base Ingest', 'knowledge_base_ingest'),
                app('webpages', 'Webpages', 'webpages_list'),
                app('automation-evolution', 'Automation evolution', 'automation_runs_summary'),
                app('elevenlabs', 'ElevenLabs', 'generate_tts'),
                app('fireflies', 'Fireflies', 'fireflies_list_transcripts'),
            ] },
        });
        expect(s.nativeApps.ai.map(a => a.id).sort()).toEqual(['agent-search', 'memory', 'transcription']);
        expect(s.nativeApps.data.map(a => a.id).sort()).toEqual(['kb-ingest', 'webpages']);
        expect(s.nativeApps.logic.map(a => a.id)).toEqual(['automation-evolution']);
        // Outside apps stay where they were; Code and Call a web service are on Logic.
        expect(s.otherAppCategories.flatMap(c => c.apps.map(a => a.id)).sort()).toEqual(['elevenlabs', 'fireflies']);
        expect(s.logic.map(i => i.id)).toEqual(expect.arrayContaining(['code', 'http_request']));
        expect(presentingCategory(availableCategories(s))).toBe('other_apps');
    });

});

describe('Bee Flow tool marks', () => {
    // Bee Flow's own tools sit on the AI, Logic and Data & documents tabs
    // beside steps that each have an icon; one of them falling back to the
    // ribbon's puzzle piece (Memory, Knowledge Base Ingest and Automation
    // evolution did) reads as a broken entry.
    it('has a mark for every Bee Flow tool the ribbon places on a step tab', () => {
        expect(Object.keys(NATIVE_APP_HOME).filter(id => !getIntegrationLogo(id))).toEqual([]);
    });

    it('finds that mark from the tool name too, for a step the AI builder added without an app id', () => {
        for (const tool of ['memory_search', 'knowledge_base_ingest', 'automation_propose_evolution', 'webpage_db_query', 'kb_fetch', 'agent_search']) {
            expect(getIntegrationLogo(resolveIntegrationFromTool(tool)), tool).not.toBeNull();
        }
    });
});

describe('ribbonRows (one row of pills per tab)', () => {
    const t = (_k: string, fallback?: string) => fallback || '';
    const shape = (segments: SegmentPlan[]) => segments.map(seg => seg.map(p => (p.type === 'menu'
        ? `${p.title} ▾ [${p.items.map(i => i.id).join(', ')}]`
        : p.item.id)));
    const plain = ribbonSections({ catalog: { apps: [], steps: [], flags: {} } });

    it('Data & documents: the everyday steps as pills, documents, lists and tables behind one pill each', () => {
        const row = planRow(plain.data, 'data', 'section:data', t);
        expect(shape(row)).toEqual([
            ['set', 'datetime'],
            [
                'Tables ▾ [datatable, knowledge_write]',
                'Documents ▾ [generate_document, fill_document, slide, presentation]',
                'Lists ▾ [limit, dedupe, aggregate, summarize]',
            ],
        ]);
        // A group pill carries the tab's section stamp; a plain command has none of its own.
        expect(row[1].every(p => p.origin === 'section:data')).toBe(true);
        expect(row[0].every(p => p.origin === null)).toBe(true);
        // Every data step is on the row exactly once.
        const ids = row.flat().flatMap(p => (p.type === 'menu' ? p.items.map(i => i.id) : [p.item.id]));
        expect(ids.sort()).toEqual(plain.data.map(i => i.id).sort());
    });

    it('Logic, People and AI: the AI step keeps its own stamp; the form pages share one pill', () => {
        expect(shape(planRow(plain.logic, 'logic', 'section:flow_control', t))).toEqual([
            ['route', 'loop'], ['http_request'], ['privacy_shield'], ['End the run ▾ [stop_error, return_to_app]', 'note'],
        ]);
        // Code, when the server can run it, joins Call a web service: the logic you write yourself.
        const withCode = ribbonSections({ catalog: { apps: [], steps: [], flags: { code: true } } });
        expect(shape(planRow(withCode.logic, 'logic', 'section:flow_control', t)).slice(0, 2)).toEqual([['route', 'loop'], ['code', 'http_request']]);
        expect(shape(planRow(plain.people, 'people', 'section:people', t))).toEqual([
            ['approval', 'notification', 'wait'], ['Form pages ▾ [form_page, form_ending]'],
        ]);
        const ai = planRow(plain.ai, 'ai', 'section:ai', t);
        expect(shape(ai)).toEqual([['ai_step', 'data_extraction']]);
        expect(ai[0].map(p => p.origin)).toEqual(['section:ai', null]);
    });

    it('a group left with one command is that command\'s pill, and an unknown step is never lost', () => {
        // Inside a flowlet "Back to the app" is filtered away, so "End the run" has one command left.
        const inLayer = ribbonSections({ catalog: { apps: [], steps: [], flags: {} }, inLayer: true });
        expect(shape(planRow(inLayer.logic, 'logic', null, t))).toEqual([['route', 'loop'], ['http_request'], ['privacy_shield'], ['stop_error', 'note']]);
        const extra = { id: 'brand_new', label: 'Brand new', payload: { kind: 'brand_new' } };
        expect(shape(planRow([...plain.ai, extra], 'ai', null, t))).toEqual([['ai_step', 'data_extraction'], ['brand_new']]);
    });

    it('My building blocks: create a flowlet as a pill, saved flowlets and each Step category behind one', () => {
        const withBlocks = ribbonSections({
            catalog: { apps: [], flags: {}, steps: [
                { id: 'b1', title: 'Web search', category: 'Research', available: true },
                { id: 'b2', title: 'Scrape', category: 'Research', available: true },
                { id: 'b3', title: 'Invoice total', category: 'Finance', available: true },
            ] },
            layers: [{ key: 'l1', title: 'Notify team' }, { key: 'l2', title: 'Archive' }],
        });
        expect(shape(planBlocksRow(withBlocks.flowlets, withBlocks.blockSections, t))).toEqual([
            ['__create_layer', 'Flowlets ▾ [l1, l2]'],
            ['block_b3', 'Research ▾ [block_b2, block_b1]'], // alphabetical within a category
        ]);
        expect(planBlocksRow([], [], t)).toEqual([]);
    });
});
