// Part classes of the content and layout types (heading, text, button, image, callout, stat,
// tabs, modal, page_header, ...): each type declares `parts` on its spec entry, the runtime
// stamps `bfa-<type>__<part>` on the matching element, and an app's custom CSS targets them.
// Mounts every type of this family and asserts the declared parts and the rendered ones are
// the same set. Where a part only exists in one look or state, several variants are mounted
// and the union is compared. file_preview and pdf_compare are held, with every state, by
// recordPartClasses.fetch.test.tsx and recordPartClasses.documents.test.tsx.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import snapshot from '../catalogSnapshot.generated.json';
import { BrowserRunProvider } from '../BrowserRunContext';
import { DataProvider } from '../DataContext';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';
import AppBadgeList from './AppBadgeList';
import AppBrowserView from './AppBrowserView';
import AppButton from './AppButton';
import AppCallout from './AppCallout';
import AppCard from './AppCard';
import AppContainer from './AppContainer';
import AppDivider from './AppDivider';
import AppHeading from './AppHeading';
import AppImage from './AppImage';
import AppKeyValue from './AppKeyValue';
import AppMarkdown from './AppMarkdown';
import AppModal from './AppModal';
import AppPageHeader from './AppPageHeader';
import AppPane from './AppPane';
import AppProgress from './AppProgress';
import AppRepeater from './AppRepeater';
import AppSpacer from './AppSpacer';
import AppStat from './AppStat';
import AppStepper from './AppStepper';
import AppTab from './AppTab';
import AppTabs from './AppTabs';
import AppText from './AppText';

type Props = Record<string, unknown>;
type Component = (p: { node: never; children?: React.ReactNode }) => ReactElement | null;
const stat = (value: unknown) => ({ kind: 'static', value });

interface Variant { props: Props; children?: unknown[]; style?: Props; mode?: 'run' | 'edit'; kids?: boolean }
interface Case { Comp: unknown; variants: Variant[] }

const kidTabs = [
    { id: 'cmp_ta', type: 'tab', visible: true, props: { label: 'First', icon: 'home', badge: stat(3) }, children: [] },
    { id: 'cmp_tb', type: 'tab', visible: true, props: { label: 'Second', icon: null }, children: [] },
];

const CASES: Record<string, Case> = {
    heading: { Comp: AppHeading, variants: ['none', 'bar', 'tinted'].map((accent) => ({ props: { text: 'Title', accent } })) },
    text: { Comp: AppText, variants: [{ props: { text: 'Hello' } }] },
    button: { Comp: AppButton, variants: [{ props: { label: 'Go', iconLeft: 'plus' } }] },
    image: {
        Comp: AppImage,
        variants: [{ props: { src: 'https://example.test/a.png', alt: 'a' } }, { props: { src: null } }],
    },
    divider: { Comp: AppDivider, variants: [{ props: {} }, { props: { orientation: 'vertical' } }] },
    spacer: { Comp: AppSpacer, variants: [{ props: { steps: 2 } }] },
    callout: { Comp: AppCallout, variants: [{ props: { title: 'T', text: 'Body', tone: 'info', meta: 'M' } }] },
    stat: {
        Comp: AppStat,
        variants: [
            { props: { label: 'Open', value: stat('42'), icon: 'home', delta: stat(4), caption: 'cap', trend: stat([1, 3, 2, 5]) } },
            { props: { label: 'Open', value: stat('42'), captionSegments: [{ text: 'seg', tone: 'success' }] } },
        ],
    },
    keyValue: {
        Comp: AppKeyValue,
        variants: ['rows', 'grid'].map((layout) => ({
            props: { layout, source: stat({ a: 1 }), fields: [{ key: 'a', label: 'A' }] },
        })),
    },
    tabs: { Comp: AppTabs, variants: [{ props: {}, children: kidTabs, kids: true }] },
    tab: { Comp: AppTab, variants: [{ props: {} }] },
    repeater: {
        Comp: AppRepeater,
        variants: [{ props: { source: stat([{ n: 1 }]), itemActions: [{ actionId: 'act_x', label: 'Open' }] } }],
    },
    container: { Comp: AppContainer, variants: [{ props: {} }] },
    pane: { Comp: AppPane, variants: [{ props: {} }] },
    page_header: {
        Comp: AppPageHeader,
        variants: ['plain', 'banner', 'hero', 'split'].map((look) => ({
            props: { title: 'Page', subtitle: 'Sub', icon: 'home', tagsFrom: stat(['a']), showDivider: true, look },
            kids: true,
        })),
    },
    markdown: {
        Comp: AppMarkdown,
        variants: [
            { props: { content: '# Head\n\npara\n\n- a\n- b\n\n```\ncode\n```' } },
            // rich (since 3) draws the parts that only it has: a table, a task, a quote, a picture.
            { props: { rich: true, content: '| a |\n| - |\n| 1 |\n\n- [x] done\n\n> quote\n\n![p](asset:img_1)' } },
        ],
    },
    badge_list: {
        Comp: AppBadgeList,
        variants: [{ props: { source: stat([{ label: 'x', n: 2 }]), countKey: 'n' } }],
    },
    progress: {
        Comp: AppProgress,
        variants: [
            { props: { value: stat(40), label: 'L', format: 'percent' } },
            { props: { look: 'ring', value: stat(40), label: 'L', format: 'percent' } },
            { props: { label: 'L', segments: [{ value: stat(3), tone: 'success' }, { value: stat(1), tone: 'danger' }] } },
        ],
    },
    stepper: {
        Comp: AppStepper,
        variants: [{ props: { value: stat('b'), steps: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', hint: stat('wait') }] } }],
    },
    card: { Comp: AppCard, variants: [{ props: { title: 'T', description: 'D' } }] },
};

function declaredParts(type: string): string[] {
    return (snapshot.types as Record<string, { parts?: string[] }>)[type]?.parts ?? [];
}

function tokensIn(root: ParentNode): Set<string> {
    const found = new Set<string>();
    for (const el of Array.from(root.querySelectorAll('[class*="bfa-"]'))) {
        for (const token of (el.getAttribute('class') || '').split(/\s+/)) {
            if (token.startsWith('bfa-')) found.add(token);
        }
    }
    return found;
}

function mountVariant(type: string, Comp: unknown, v: Variant, extra?: { previews?: Record<string, unknown> }) {
    const C = Comp as Component;
    const node = {
        id: `cmp_${type}`, type, visible: true, props: v.props,
        style: { span: 12, ...(v.style || {}) },
        ...(v.children ? { children: v.children } : {}),
    } as never;
    const kids = v.kids ? [<div key="1">Panel A</div>, <div key="2">Panel B</div>] : undefined;
    const runtime = { ...DEFAULT_RUNTIME, mode: v.mode ?? 'run', scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }) };
    let ui: ReactElement = (
        <DataProvider appId="app_1">
            <RuntimeProvider value={runtime as never}>
                <C node={node}>{kids}</C>
            </RuntimeProvider>
        </DataProvider>
    );
    if (extra?.previews) ui = <BrowserRunProvider value={{ previews: extra.previews, publish: () => {} } as never}>{ui}</BrowserRunProvider>;
    return render(ui);
}

function expectParts(type: string, found: Set<string>) {
    const declared = declaredParts(type).map((p) => `bfa-${type}__${p}`).sort();
    expect([...found].sort()).toEqual(declared);
}

describe('part classes: content and layout types', () => {
    for (const [type, { Comp, variants }] of Object.entries(CASES)) {
        it(`${type} renders exactly its declared parts`, () => {
            expect(declaredParts(type).length).toBeGreaterThan(0);
            const found = new Set<string>();
            for (const v of variants) {
                const { container, unmount } = mountVariant(type, Comp, v);
                tokensIn(container).forEach((t) => found.add(t));
                unmount();
            }
            expectParts(type, found);
        });
    }

    it('browser_view renders exactly its declared parts', () => {
        const found = new Set<string>();
        const empty = mountVariant('browser_view', AppBrowserView, { props: { actionId: 'act_b' } });
        tokensIn(empty.container).forEach((t) => found.add(t));
        empty.unmount();
        const previews = { act_b: { frame: 'AAAA', action: 'Click', url: 'https://example.test' } };
        const live = mountVariant('browser_view', AppBrowserView, { props: { actionId: 'act_b' } }, { previews });
        tokensIn(live.container).forEach((t) => found.add(t));
        expectParts('browser_view', found);
    });

    it('modal renders exactly its declared parts', async () => {
        const found = new Set<string>();
        const edit = mountVariant('modal', AppModal, { props: { title: 'Dlg' }, mode: 'edit' });
        tokensIn(edit.container).forEach((t) => found.add(t));
        edit.unmount();
        const run = mountVariant('modal', AppModal, { props: { title: 'Dlg', triggerLabel: 'Open' } });
        await userEvent.click(run.getByText('Open'));
        tokensIn(document.body).forEach((t) => found.add(t));
        expectParts('modal', found);
        run.unmount();
    });

    it('declares parts for every type of the family', () => {
        for (const type of [...Object.keys(CASES), 'browser_view', 'modal']) {
            expect(declaredParts(type).length, type).toBeGreaterThan(0);
        }
    });

    it('names every part as one lower-case token', () => {
        for (const type of [...Object.keys(CASES), 'browser_view', 'modal']) {
            const parts = declaredParts(type);
            expect(new Set(parts).size, type).toBe(parts.length);
            for (const p of parts) expect(p, `${type}.${p}`).toMatch(/^[a-z][a-z0-9-]*$/);
        }
    });

    it('is not referenced by any product stylesheet of agent-hub', () => {
        const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'); // agent-hub/src
        const offenders: string[] = [];
        const walk = (d: string) => {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
                if (!entry.name.endsWith('.css')) continue;
                if (fs.readFileSync(full, 'utf8').includes('bfa-')) offenders.push(path.relative(dir, full));
            }
        };
        walk(dir);
        expect(offenders).toEqual([]);
    });
});
