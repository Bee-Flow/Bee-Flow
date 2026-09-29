import { describe, it, expect } from 'vitest';
import { nodeTypeLabel } from './nodeDefs';
import { flightGlyphFor, originKeysFor, resolveOrigin, sectionKeyForKind } from './ribbonOrigin';

/**
 * The pure half of the ribbon flight: which ribbon command a card is dealt
 * from, what its ghost shows, and — the one DOM touch — which stamped element
 * is really on screen. The section map is read off the SAME buildStepGroups
 * the ribbon renders, so a step moved to another Home section moves its
 * origin with it and nothing here has to know.
 */

// Fourteen Nextcloud apps in one category (the same shape as AddStepRibbon.test.jsx).
const NC_IDS = [
    'nextcloud', 'nextcloud-talk', 'nextcloud-calendar', 'nextcloud-deck', 'nextcloud-tables',
    'nextcloud-forms', 'nextcloud-mail', 'nextcloud-tasks', 'nextcloud-notes', 'nextcloud-contacts',
    'nextcloud-teams', 'nextcloud-notifications', 'nextcloud-activity', 'nextcloud-status',
];
const nextcloudCatalog = {
    apps: NC_IDS.map(id => ({
        id, label: `Nextcloud ${id}`, available: true, connected: true,
        actions: [{ name: `${id.replace(/-/g, '_')}_list`, label: 'list', integrationId: id }],
    })),
    steps: [], flags: {},
};

describe('sectionKeyForKind', () => {
    it('maps every Home section\'s steps to that section, and the AI step to its own', () => {
        expect(sectionKeyForKind('loop')).toBe('flow_control');
        expect(sectionKeyForKind('condition')).toBe('flow_control');
        expect(sectionKeyForKind('guard')).toBe('flow_control');
        expect(sectionKeyForKind('approval')).toBe('people');
        expect(sectionKeyForKind('wait')).toBe('people');
        expect(sectionKeyForKind('set')).toBe('data');
        expect(sectionKeyForKind('http_request')).toBe('integrations');
        expect(sectionKeyForKind('code')).toBe('integrations');
        expect(sectionKeyForKind('ai_step')).toBe('ai');
    });

    it('reads the runtime shapes of the Condition node as Condition, and knows nothing about junk', () => {
        expect(sectionKeyForKind('switch')).toBe('flow_control');
        expect(sectionKeyForKind('filter')).toBe('flow_control');
        expect(sectionKeyForKind('parse_json')).toBe('data');
        expect(sectionKeyForKind('teleporter')).toBeNull();
        expect(sectionKeyForKind(null)).toBeNull();
    });
});

describe('originKeysFor', () => {
    it('a trigger has no origin; a plain step is its section, then the tabs, then the ribbon', () => {
        expect(originKeysFor({ type: 'trigger', kind: 'manual' })).toEqual([]);
        expect(originKeysFor({ type: 'set' })).toEqual(['section:data', 'tabs', 'ribbon']);
        expect(originKeysFor({ type: 'ai_step' })).toEqual(['section:ai', 'tabs', 'ribbon']);
        expect(originKeysFor({ type: 'teleporter' })).toEqual(['tabs', 'ribbon']);
        expect(originKeysFor(null)).toEqual([]);
    });

    it('an app step is its app command, resolved from appId or from the tool name', () => {
        expect(originKeysFor({ type: 'integration_action', tool: 'gmail_send' })).toEqual(['app:gmail', 'tabs', 'ribbon']);
        expect(originKeysFor({ type: 'integration_action', appId: 'gmail', tool: 'whatever' })).toEqual(['app:gmail', 'tabs', 'ribbon']);
    });

    it('tries both id spellings — the catalog dashes, the prefix resolver underscores', () => {
        expect(originKeysFor({ type: 'integration_action', appId: 'google-calendar' }))
            .toEqual(['app:google-calendar', 'app:google_calendar', 'tabs', 'ribbon']);
        expect(originKeysFor({ type: 'integration_action', tool: 'calendar_list_events' }))
            .toEqual(['app:google_calendar', 'app:google-calendar', 'tabs', 'ribbon']);
    });

    it('a catalogued app offers its category\'s fold and pill after its own command — whether the ribbon folded it or not', () => {
        // Which of the two the ribbon rendered depends on the window width
        // (appsRibbonLayout / useFitClusters), which this pure module cannot
        // know; both are offered and resolveOrigin takes the one on screen.
        expect(originKeysFor({ type: 'integration_action', appId: 'nextcloud-status' }, nextcloudCatalog))
            .toEqual(['app:nextcloud-status', 'app:nextcloud_status', 'more:Nextcloud', 'cat:Nextcloud', 'tabs', 'ribbon']);
        expect(originKeysFor({ type: 'integration_action', appId: 'nextcloud-talk' }, nextcloudCatalog))
            .toEqual(['app:nextcloud-talk', 'app:nextcloud_talk', 'more:Nextcloud', 'cat:Nextcloud', 'tabs', 'ribbon']);
        // Without a catalog nothing is known about the category.
        expect(originKeysFor({ type: 'integration_action', appId: 'nextcloud-status' }, null))
            .toEqual(['app:nextcloud-status', 'app:nextcloud_status', 'tabs', 'ribbon']);
        // An app the catalog does not list has no category to fall back on.
        expect(originKeysFor({ type: 'integration_action', appId: 'gmail' }, nextcloudCatalog))
            .toEqual(['app:gmail', 'tabs', 'ribbon']);
    });
});

describe('flightGlyphFor', () => {
    it('an app: its logo id and tool, the app family, the step\'s own name', () => {
        expect(flightGlyphFor({ type: 'integration_action', tool: 'gmail_send', label: ' Send it ' })).toMatchObject({
            type: 'integration_action', integrationId: 'gmail', tool: 'gmail_send', family: 'app', label: 'Send it', iconName: null,
        });
    });

    it('a step: the palette icon of its kind, its family, and its type name when it has no label', () => {
        const g = flightGlyphFor({ type: 'loop' });
        expect(typeof g.icon === 'function' || (g.icon && typeof g.icon === 'object')).toBe(true);
        expect(g).toMatchObject({ type: 'loop', integrationId: null, tool: null, family: 'loop', label: nodeTypeLabel('loop') });
        // A custom icon name on the step rides along for StepIcon.
        expect(flightGlyphFor({ type: 'set', icon: 'Pencil' }).iconName).toBe('Pencil');
    });

    it('degrades to nothing invented for an unknown type', () => {
        expect(flightGlyphFor({ type: 'teleporter' })).toMatchObject({ icon: null, family: null, label: '' });
        expect(flightGlyphFor(null)).toMatchObject({ type: null, label: '' });
    });
});

describe('resolveOrigin', () => {
    const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
    function root(children, bounds = rect(0, 0, 1200, 48)) {
        const el = document.createElement('div');
        el.setAttribute('data-ribbon-origin', 'ribbon');
        el.getBoundingClientRect = () => bounds;
        for (const [key, r, extra] of children) {
            const c = document.createElement('button');
            c.setAttribute('data-ribbon-origin', key);
            c.getBoundingClientRect = () => r;
            if (extra?.hidden) c.checkVisibility = () => false;
            el.appendChild(c);
        }
        return el;
    }

    it('takes the first key that is stamped AND on screen', () => {
        const r = root([['section:data', rect(300, 10, 80, 24)], ['tabs', rect(100, 10, 120, 24)]]);
        const found = resolveOrigin(r, ['app:gmail', 'section:data', 'tabs']);
        expect(found.el.getAttribute('data-ribbon-origin')).toBe('section:data');
        expect(found.rect).toMatchObject({ left: 300, top: 10, width: 80, height: 24 });
    });

    it('skips a zero-width stamp and one checkVisibility() denies, and can land on the root itself', () => {
        const r = root([['section:data', rect(300, 10, 0, 24)], ['tabs', rect(100, 10, 120, 24), { hidden: true }]]);
        const found = resolveOrigin(r, ['section:data', 'tabs', 'ribbon']);
        expect(found.el).toBe(r);
        expect(found.rect).toMatchObject({ left: 0, top: 0, width: 1200, height: 48 });
    });

    it('clamps the rect to the ribbon\'s own box', () => {
        const r = root([['tabs', rect(1150, 10, 200, 24)]]);
        expect(resolveOrigin(r, ['tabs']).rect).toMatchObject({ left: 1150, top: 10, width: 50, height: 24 });
        // …unless the box has no area (jsdom), when the rect is trusted as is.
        const bare = root([['tabs', rect(1150, 10, 200, 24)]], rect(0, 0, 0, 0));
        expect(resolveOrigin(bare, ['tabs']).rect).toMatchObject({ left: 1150, width: 200 });
    });

    it('returns null with nothing to find, no root, or no keys', () => {
        expect(resolveOrigin(root([]), ['section:data', 'tabs'])).toBeNull();
        expect(resolveOrigin(null, ['ribbon'])).toBeNull();
        expect(resolveOrigin(root([]), [])).toBeNull();
        expect(resolveOrigin(root([]), null)).toBeNull();
    });

    it('a key with a quote in it cannot break the selector', () => {
        expect(() => resolveOrigin(root([]), ['app:x"y'])).not.toThrow();
    });
});
