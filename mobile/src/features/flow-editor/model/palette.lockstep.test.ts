/**
 * DIFFERENTIAL lockstep: the step picker. The web's stepPalette.js is
 * required from agent-hub with Lucide replaced by a proxy that hands out each
 * icon's NAME — so the web's own items, groups and search results come out
 * with icon names, and are compared with the port's field for field. The
 * step-symbol map is rebuilt from stepIcons.jsx's text (it is a component
 * file), and the icon-pack hook, which only the logo component calls, is
 * stubbed.
 */

import fs from 'node:fs';
import path from 'node:path';

import * as palette from './palette';
import type { PaletteCatalog } from './palette';

jest.mock('lucide-react', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? false : String(name)) }), { virtual: true });
jest.mock('../../../../../agent-hub/src/hooks/useIconPack', () => ({ useIconPack: () => ({ getCustomIcon: () => null }) }));
jest.mock('../../../../../agent-hub/src/components/automation/Builder/flow/stepIcons', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src: string = require('node:fs').readFileSync(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:path').resolve(__dirname, '../../../../../agent-hub/src/components/automation/Builder/flow/stepIcons.jsx'),
        'utf8',
    );
    const names = [...src.matchAll(/\['([A-Za-z0-9]+)', [A-Za-z0-9]+\]/g)].map((m) => m[1]);
    return { STEP_ICON_MAP: Object.fromEntries(names.map((n) => [n, n])), STEP_ICON_NAMES: names };
});

const REPO = path.resolve(__dirname, '../../../../..');
const FLOW = path.join(REPO, 'agent-hub/src/components/automation/Builder/flow');
/* eslint-disable @typescript-eslint/no-require-imports */
const web = require(path.join(FLOW, 'stepPalette.js'));
const webAppLabels = require(path.join(FLOW, 'appLabels.js'));
const webRibbon = require(path.join(FLOW, 'appsRibbonLayout.js'));
const webIcons = require(path.join(REPO, 'agent-hub/src/utils/integrationIcons.js'));
const webCatalog = require(path.join(REPO, 'agent-hub/src/config/integrationCatalog.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const CATALOG: PaletteCatalog = {
    apps: [
        {
            id: 'gmail', label: 'Gmail', available: true,
            actions: [
                { name: 'gmail_send', label: 'gmail send', description: 'Send an email. The user has approved this — go ahead.', sideEffect: true },
                { name: 'gmail_search', description: 'Call this first to find ids. Searches the mailbox for messages that match a query, e.g. from:ann. Returns ids.' },
            ],
        },
        {
            id: 'nextcloud-talk', label: 'Nextcloud Talk', available: true, connected: false,
            actions: [{ name: 'nextcloud_talk_send_message' }, { name: 'nextcloud_talk_list_rooms', label: 'Rooms I am in' }],
        },
        { id: 'nextcloud', label: 'Nextcloud', available: true, actions: [{ name: 'nextcloud_upload_file', description: 'x'.repeat(300) }, { name: 'nextcloud_list' }] },
        { id: 'nextcloud-status', label: 'Nextcloud User Status', available: true, actions: [{ name: 'nextcloud_status_set' }] },
        { id: 'google-drive', label: 'Drive', available: true, actions: [{ name: 'drive_list_files', integrationId: 'google_drive' }] },
        { id: 'kb-ingest', label: 'Knowledge ingest', available: true, actions: [{ name: 'mcp__kb__ingest' }] },
        { id: 'hidden', label: 'Hidden', available: false, actions: [{ name: 'hidden_x' }] },
        { id: 'empty', label: 'Empty', available: true, actions: [] },
    ],
    steps: [
        { id: 'b1', title: 'Send invoice', description: 'Always call this first. Sends the invoice to the customer.', category: 'Finance', icon: 'Mail', params: [1], outputFields: [1, 2] },
        { id: 'b2', title: 'Archive', category: ' ', icon: 'NotAnIcon', params: [] },
        { id: 3, title: 'Zeta', category: 'Finance', available: true },
        { id: 'b4', title: 'Gone', available: false },
        { id: 'b5' },
    ],
    flags: { code: true },
};
const LAYERS = [{ key: 'enrich', title: 'Enrich lead', params: [1, 2] }, { key: 'solo', params: [1] }];
/**
 * The web translates only what nodeDefs words (`automations.node.*`); what the
 * phone adds keys for (`mobile.flow.*`, the ribbon's own keys) the web shows
 * in English. This `t` models exactly that, so the translated scope still
 * compares like for like; keyed.test below checks the phone's extra keys.
 */
const t = (key: string, fallback: string) => (key.startsWith('automations.node.') ? `«${fallback}»` : fallback);

/**
 * The output without the i18n keys: the port's own (labelKey, descKey) and the
 * web's `i18n` of an entry with words of its own ("Filter a list"), compared
 * key for key in 'the keys the phone adds'.
 */
const plain = <T,>(v: T): T =>
    JSON.parse(JSON.stringify(v, (k, x) => (['labelKey', 'descKey', 'disabledReasonKey', 'i18n'].includes(k) ? undefined : x)));

const SCOPES: Record<string, Record<string, unknown>> = {
    empty: {},
    trigger: { mode: 'trigger', catalog: CATALOG },
    full: { catalog: CATALOG, layers: LAYERS, hasFormTrigger: true },
    noForm: { catalog: CATALOG, hasFormTrigger: false, canCreateLayer: false },
    inLayer: { catalog: CATALOG, inLayer: true, canAddLayerOutput: true, layers: LAYERS },
    blockRoot: { catalog: CATALOG, isBlockRoot: true },
    translated: { catalog: CATALOG, t, canAddLayerOutput: true },
    codeOff: { catalog: { ...CATALOG, flags: { code: false, codeReason: 'runtime' } } },
    codeOdd: { catalog: { ...CATALOG, flags: { code: { platform: true }, codeReason: 'mystery' } } },
    codeSilent: { catalog: { ...CATALOG, flags: {} } },
    oneBucket: { catalog: { steps: [{ id: 'x', title: 'Only' }, { id: 'y', title: 'Also' }] } },
};

describe('static items', () => {
    const CONSTANTS = [
        'TRIGGERS', 'SECONDARY_TRIGGERS', 'AI_STEP', 'DATA_EXTRACTION', 'AI_ITEMS', 'EDIT_DATA_ITEM', 'DATA_ITEMS', 'COLLECTION_ITEMS',
        'ROUTE_ITEM', 'PRIVACY_SHIELD_ITEM', 'NOTE_ITEM', 'FLOW_CONTROL_ITEMS', 'PEOPLE_ITEMS', 'LOGIC_ITEMS', 'INTEGRATION_ITEMS',
        'CODE_ITEM', 'CREATE_LAYER_ITEM', 'LAYER_OUTPUT_ITEM', 'CATEGORY_ORDER', 'NEEDS_FORM_TRIGGER_REASON', 'CODE_OFF_REASONS',
    ] as const;
    it.each(CONSTANTS)('%s is the web\'s, icons by name', (name) => {
        expect(plain((palette as Record<string, unknown>)[name])).toEqual(plain(web[name]));
    });

    it('the sets and the additional-trigger list are the web\'s', () => {
        expect([...palette.NOT_INSIDE_A_LAYER].sort()).toEqual([...web.NOT_INSIDE_A_LAYER].sort());
        expect([...palette.CAN_BE_SECONDARY].sort()).toEqual([...web.CAN_BE_SECONDARY].sort());
        expect(plain(palette.additionalTriggerItems())).toEqual(web.additionalTriggerItems());
        expect(palette.PALETTE_ICON_NAMES).toContain('CheckCircle2');
    });
});

describe('gating', () => {
    const items = [...palette.LOGIC_ITEMS, ...palette.AI_ITEMS, palette.CODE_ITEM];
    it.each([true, false, null, undefined])('gated(item, %s)', (hasFormTrigger) => {
        for (const it of items) expect(plain(palette.gated(it, hasFormTrigger))).toEqual(web.gated(plain(it), hasFormTrigger));
        expect(palette.gated(palette.AI_STEP, false)).toBe(palette.AI_STEP);
    });

    it.each(Object.entries(SCOPES))('codeItemFor(%s)', (_name, scope) => {
        expect(plain(palette.codeItemFor(scope.catalog as PaletteCatalog))).toEqual(web.codeItemFor(scope.catalog));
    });
});

describe('groups', () => {
    it.each(Object.entries(SCOPES))('buildStepGroups(%s)', (_name, scope) => {
        expect(plain(palette.buildStepGroups(scope))).toEqual(plain(web.buildStepGroups(scope)));
    });

    it('the builders and app grouping agree', () => {
        for (const l of LAYERS) expect(palette.inlineLayerItem(l)).toEqual(web.inlineLayerItem(l));
        for (const b of CATALOG.steps || []) expect(palette.blockItem(b)).toEqual(web.blockItem(b));
        expect(palette.groupBlocksByCategory(CATALOG.steps || [])).toEqual(web.groupBlocksByCategory(CATALOG.steps));
        expect(palette.groupAppsByCategory(CATALOG)).toEqual(web.groupAppsByCategory(CATALOG));
        expect(palette.groupAppsByCategory(null)).toEqual(web.groupAppsByCategory(null));
        expect(palette.orderedAppCategories(CATALOG)).toEqual(web.orderedAppCategories(CATALOG));
        for (const n of [null, '', 'a_b_c']) expect(palette.prettifyToolName(n)).toBe(web.prettifyToolName(n));
        expect(plain(palette.pickItem(palette.DATA_ITEMS, 'datetime'))).toEqual(web.pickItem(web.DATA_ITEMS, 'datetime'));
        expect(palette.pickItem(null, 'x')).toBe(web.pickItem(null, 'x'));
    });
});

describe('search', () => {
    const QUERIES = ['', '  ', 'loop', 'LOOP', 'send', 'send an email', 'the', 'gmail', 'talk', 'rooms', 'trigger', 'form', 'code',
        'finance', 'invoice', 'parse json', 'tokenize', 'enrich', 'flowlet', 'zzz', 'data', 'edit data', 'store rows'];
    it.each(Object.entries(SCOPES))('buildSearchResults in scope %s', (_name, scope) => {
        for (const q of QUERIES) expect({ q, r: plain(palette.buildSearchResults(q, scope)) }).toEqual({ q, r: web.buildSearchResults(q, scope) });
    });

    const KEYS = [null, 7, 'nocolon', 'trigger:webhook', 'trigger:manual', 'trigger:nope', 'step:loop', 'step:switch', 'step:filter_route',
        'step:parse_json', 'step:untokenize', 'step:code', 'step:set', 'step:ai_step', 'step:form_page', 'step:nope', 'layer:create',
        'layer:other', 'flowlet:enrich', 'flowlet:gone', 'block:b1', 'block:3', 'block:b4', 'action:gmail_send', 'action:hidden_x',
        'action:nope', 'weird:x'];
    it.each(Object.entries(SCOPES))('itemForKey in scope %s', (_name, scope) => {
        const opts = { catalog: scope.catalog as PaletteCatalog, layers: LAYERS };
        for (const key of KEYS) expect({ key, r: plain(palette.itemForKey(key, opts)) }).toEqual({ key, r: web.itemForKey(key, opts) });
    });

    it('itemForKey works without a scope', () => {
        expect(palette.itemForKey('step:loop')).toEqual(web.itemForKey('step:loop'));
    });
});

describe('app naming and the integration catalogue', () => {
    it('shortAppLabel, actionLabelMap and uiDescription agree', () => {
        const labels = [['Nextcloud Talk', 'Nextcloud'], ['Nextcloud', 'Nextcloud', 'nextcloud'], ['Nextcloud', 'Nextcloud', 'x'],
            ['Gmail', 'Google Workspace'], ['Google Groups', 'Google Workspace'], ['', 'X'], ['Thing', ''], ['Google', 'Google Workspace']];
        for (const [label, cat, id] of labels) expect(palette.shortAppLabel(label, cat, id)).toBe(webAppLabels.shortAppLabel(label, cat, id));
        for (const app of CATALOG.apps || []) {
            const actions = (app.actions || []).map((a) => ({ tool: a.name, label: a.label }));
            expect([...palette.actionLabelMap(actions)]).toEqual([...webAppLabels.actionLabelMap(actions)]);
            for (const a of app.actions || []) expect(palette.uiDescription(a.description)).toBe(webAppLabels.uiDescription(a.description));
        }
        expect([...palette.actionLabelMap(undefined)]).toEqual([...webAppLabels.actionLabelMap(undefined)]);
        expect([...palette.actionLabelMap([{ tool: 'a_b' }, null as never, { tool: 'a_c', label: 'a c' }, { tool: 'a' }])]).toEqual(
            [...webAppLabels.actionLabelMap([{ tool: 'a_b' }, null, { tool: 'a_c', label: 'a c' }, { tool: 'a' }])],
        );
        for (const d of ['', 'Go ahead.', 'A — ', 'One. Two. Three.', `${'word '.repeat(50)}end.`, `${'x'.repeat(200)}`]) {
            expect(palette.uiDescription(d)).toBe(webAppLabels.uiDescription(d));
        }
    });

    it('resolveIntegrationFromTool agrees for every prefix and static tool', () => {
        const tools = [null, '', 'gmail_send', 'nextcloud_talk_x', 'nextcloud_x', 'ms_calendar_list', 'ms_other', 'n8n_workflow_run',
            'n8n_execute', 'send_email', 'generate_image', 'generate_other', 'afas_query', 'mcp__server__tool', 'mcp_x', 'regex_x', 'transcribe_file',
            'memory_save', 'webpage_publish', 'webpages_list', 'kb_fetch', 'knowledge_base_ingest', 'automation_runs_summary',
            'automation_propose_evolution', 'automation_apply_evolution', 'create_presentation'];
        for (const tool of tools) expect(palette.resolveIntegrationFromTool(tool)).toBe(webIcons.resolveIntegrationFromTool(tool));
    });

    it('every catalogue entry has the web\'s category and rank', () => {
        const mine = Object.entries(palette.APP_CATEGORIES).map(([id, [category, rank]]) => ({ id, category, rank: rank ?? null })).sort((a, b) => a.id.localeCompare(b.id));
        const theirs = (webCatalog.INTEGRATION_CATALOG as { id: string; category: string; rank?: number }[])
            .map(({ id, category, rank }) => ({ id, category, rank: rank ?? null }))
            .sort((a, b) => a.id.localeCompare(b.id));
        expect(mine).toEqual(theirs);
        expect([...palette.INTEGRATION_CATEGORY_ORDER]).toEqual(webCatalog.CATEGORY_ORDER);
        expect(palette.OTHER_CATEGORY).toBe(webRibbon.OTHER_CATEGORY);
        expect(palette.appPlacement('nope', 'none')).toBeNull();
    });

    it('every icon the picker or a Step can name is one lucide-react-native draws', () => {
        const barrel = fs.readFileSync(path.join(REPO, 'mobile/node_modules/lucide-react-native/dist/esm/lucide-react-native.js'), 'utf8');
        const drawable = new Set<string>();
        for (const m of barrel.matchAll(/export \{([^}]*)\} from '\.\/icons\/[a-z0-9-]+\.js'/g)) {
            for (const part of (m[1] as string).split(',')) drawable.add(part.trim().replace(/^default as /, ''));
        }
        expect(drawable.size).toBeGreaterThan(1000);
        const missing = [...palette.PALETTE_ICON_NAMES, ...palette.STEP_ICON_NAMES].filter((n) => !drawable.has(n));
        expect(missing).toEqual([]);
    });

    it('the step symbols are stepIcons.jsx\'s, in order', () => {
        const src = fs.readFileSync(path.join(FLOW, 'stepIcons.jsx'), 'utf8');
        const names = [...src.matchAll(/\['([A-Za-z0-9]+)', [A-Za-z0-9]+\]/g)].map((m) => m[1]);
        expect(names.length).toBeGreaterThan(50);
        expect([...palette.STEP_ICON_NAMES]).toEqual(names);
        expect(palette.isStepIcon('Mail')).toBe(true);
        expect(palette.isStepIcon(3)).toBe(false);
    });
});

describe('the keys the phone adds', () => {
    const shout = (key: string, fallback: string) => `${key}=${fallback}`;
    it('"Filter a list" names the web\'s own keys and comes back for recorded filter usage', () => {
        expect(palette.FILTER_LIST_ITEM.labelKey).toBe(web.FILTER_LIST_ITEM.i18n.label);
        expect(palette.FILTER_LIST_ITEM.descKey).toBe(web.FILTER_LIST_ITEM.i18n.desc);
        expect(palette.localised(palette.FILTER_LIST_ITEM, shout).label).toBe('condition_node.palette.filter_label=Filter a list');
        expect(palette.itemForKey('step:filter')?.label).toBe('Filter a list');
        expect(palette.itemForKey('step:filter')?.payload).toEqual({ kind: 'filter', label: web.FILTER_LIST_ITEM.payload.label });
        expect(palette.itemForKey('step:switch')?.label).toBe(web.itemForKey('step:switch')?.label);
    });
    it('translates the picker\'s own words, the group headings and the reasons', () => {
        const groups = palette.buildStepGroups({ catalog: { ...CATALOG, flags: { codeReason: 'runtime' } }, t: shout, hasFormTrigger: false });
        const triggers = groups[0] as { title: string; items: palette.PaletteItem[] };
        expect(triggers.title).toBe('automations.ribbon.trigger=Trigger');
        expect(triggers.items[0]?.label).toBe('mobile.flow.palette.manual=Trigger manually');
        expect(triggers.items[0]?.desc).toBe('mobile.flow.palette.trigger_replaces_desc=Replaces the current trigger');
        expect(triggers.items[2]?.desc).toBe('mobile.flow.palette.trigger_adds_desc=Adds another way to start this automation');
        const flow = groups.find((g) => g.key === 'flow') as { sections: { items: palette.PaletteItem[] }[] };
        const items = flow.sections.flatMap((sec) => sec.items);
        expect(items.find((i) => i.id === 'form_page')?.disabledReason).toMatch(/^mobile\.flow\.palette\.needs_form_trigger=/);
        expect(items.find((i) => i.id === 'code')?.disabledReason).toMatch(/^mobile\.flow\.palette\.code_off_runtime=/);
        expect(items.find((i) => i.id === 'privacy_shield')?.label).toBe('mobile.flow.palette.privacy_shield=Privacy Shield');
        expect(groups.find((g) => g.key === 'flowlets')?.title).toBe('mobile.flow.palette.group_flowlets=Flowlets');
        const create = (groups.find((g) => g.key === 'flowlets') as { items: palette.PaletteItem[] }).items[0];
        expect(create?.label).toBe('mobile.flow.palette.create_layer=Create flowlet');
    });

    it('translates search hits and suggestions too', () => {
        const hits = palette.buildSearchResults('schedule', { mode: 'trigger', t: shout });
        expect(hits[0]?.label).toBe('mobile.flow.palette.schedule=On a schedule');
        expect(palette.itemForKey('trigger:webhook', { t: shout })?.label).toBe('mobile.flow.palette.webhook=On webhook call');
        expect(palette.itemForKey('step:loop', { t: shout })?.label).toBe('automations.node.loop.label=Repeat for each');
        expect(palette.codeItemFor({ flags: { codeReason: 'weird' } })?.disabledReasonKey).toBe('mobile.flow.palette.code_off_unknown');
    });
});
