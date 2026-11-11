/**
 * The phone half of the App Studio compatibility gate (server/appStudio/compat/README.md).
 *
 * Every corpus app is an app as it is stored today. This feeds each one through the
 * phone's real planner (planScreen, navigableScreens, the input collector inside it) for
 * every screen, as a viewer with no role and as each role the app declares, and compares
 * what the phone decides against a committed snapshot: which blocks it draws, which
 * fields it collects with which defaults, which buttons it can run, and which component
 * types it names as missing (and of those, which are deliberately browser-only).
 *
 * A red test means an app that exists today behaves differently on the phone. Read the
 * snapshot diff first; update the snapshot only when that difference is the point of
 * the change.
 *
 * The corpus is read from the server tree as text, so ci.yml's mobile filter lists it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { navigableScreens, planScreen, type AppBlock, type RunnableAction } from './appDefinition';
import { BROWSER_ONLY_TYPES } from './catalog';
import type { AppInput } from './inputs';
import type { AppDefinition } from './types';

const CORPUS_DIR = path.resolve(__dirname, '../../../../../server/appStudio/compat/corpus');

/** input_date's 'today' default reads the clock. */
const FIXED_NOW = new Date('2026-01-15T12:00:00.000Z');

interface CorpusFile {
    definition: AppDefinition & { roles?: { id?: string; key?: string }[] };
    dataModel?: { roles?: { key?: string }[] };
}

function corpusNames(): string[] {
    return fs
        .readdirSync(CORPUS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .sort();
}

function load(name: string): CorpusFile {
    return JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, `${name}.json`), 'utf8')) as CorpusFile;
}

/** No role, then every role the definition or its data model names, once each. */
function viewerRoles(file: CorpusFile): (string | null)[] {
    const keys = [
        ...(file.definition.roles ?? []).map((r) => r?.key ?? r?.id),
        ...(file.dataModel?.roles ?? []).map((r) => r?.key),
    ].filter((k): k is string => typeof k === 'string' && k.length > 0);
    return [null, ...new Set(keys)];
}

/** The action as the phone sees it, without the whole stored action object. */
function actionView(action: RunnableAction | null) {
    if (!action) return null;
    return { actionId: action.actionId, kind: action.action.kind, runnable: action.runnable, label: action.label };
}

/** An input without the node it was read from (its id stands in for it). */
function inputView(input: AppInput) {
    const { node, ...rest } = input;
    return { nodeId: node.id, ...rest };
}

function blockView(block: AppBlock) {
    if (block.kind === 'form') return { ...block, inputs: block.inputs.map(inputView), action: actionView(block.action) };
    if (block.kind === 'button') return { ...block, action: actionView(block.action) };
    return block;
}

function planView(definition: AppDefinition, screenId: string, role: string | null) {
    const plan = planScreen(definition, screenId, role);
    return {
        screen: plan.screen?.id ?? null,
        blocks: plan.blocks.map(blockView),
        unsupported: plan.unsupported.map((type) =>
            Object.prototype.hasOwnProperty.call(BROWSER_ONLY_TYPES, type) ? `${type} (browser-only)` : type,
        ),
    };
}

/** Per screen, the plans; roles that get the same plan share one entry. */
function describeApp(file: CorpusFile) {
    const { definition } = file;
    const roles = viewerRoles(file);
    return {
        navigable: navigableScreens(definition).map((s) => s.id),
        defaultScreen: planScreen(definition).screen?.id ?? null,
        screens: (definition.screens ?? []).map((screen) => {
            const plans: { roles: string[]; plan: ReturnType<typeof planView> }[] = [];
            for (const role of roles) {
                const plan = planView(definition, screen.id, role);
                const same = plans.find((p) => JSON.stringify(p.plan) === JSON.stringify(plan));
                const label = role ?? '(no role)';
                if (same) same.roles.push(label);
                else plans.push({ roles: [label], plan });
            }
            return { id: screen.id, plans };
        }),
    };
}

describe('compat corpus: what the phone plans for every stored app', () => {
    beforeAll(() => {
        jest.useFakeTimers({ now: FIXED_NOW });
    });
    afterAll(() => {
        jest.useRealTimers();
    });

    const names = corpusNames();

    it('has corpus apps to plan', () => {
        expect(names.length).toBeGreaterThan(0);
    });

    it.each(names)('%s', (name) => {
        expect(describeApp(load(name))).toMatchSnapshot();
    });
});
