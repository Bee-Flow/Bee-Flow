import { describe, it, expect, vi } from 'vitest';

import { appForTool, projectGhostDraft, spotlightKeysFor } from './ghostDraft';

/**
 * toolDraft → what the ghost slot shows. A table: the step being typed (its
 * app, kind, partial name and place in the batch), the inspect (one app or
 * many), one caption per activity tool, and null for anything unknown so the
 * slot keeps its usual caption. Also the spotlight keys: the app's own tile
 * and the fold that hides it, never the tab strip or the whole ribbon.
 */
const draftOf = (over = {}) => ({ name: 'builder_add_steps', steps: [], count: 0, inspect: [], chars: 0, iter: 1, at: 1, ...over });

const CATALOG = {
    apps: [
        { id: 'gmail', label: 'Gmail', available: true, actions: [{ name: 'gmail_send', label: 'gmail send' }] },
        { id: 'acme-crm', label: 'Acme CRM', available: true, actions: [{ name: 'crm_create_deal', label: 'crm create deal' }] },
    ],
};

describe('projectGhostDraft — the step being typed', () => {
    it('uses the LAST step: app from the tool, kind label, the partial name, and its place in the batch', () => {
        const d = projectGhostDraft(draftOf({
            count: 3,
            steps: [
                { type: 'set', tool: null, label: 'Edit data', partial: false },
                { type: 'ai_step', tool: null, label: 'Summarise', partial: false },
                { type: 'integration_action', tool: 'gmail_send', label: 'Send the sum', partial: true },
            ],
        }), { catalog: CATALOG });
        expect(d).toEqual({
            kind: 'step',
            app: { id: 'gmail', name: 'Gmail' },
            tool: 'gmail_send',
            type: 'integration_action',
            typeLabel: 'Action',
            label: 'Send the sum',
            partial: true,
            index: 3,
            count: 3,
            stepOf: 'Step 3 of 3',
            caption: 'Send the sum',
        });
    });

    it('a partial label is shown as far as it goes; a finished one is not partial', () => {
        const typing = projectGhostDraft(draftOf({ count: 1, steps: [{ type: 'set', tool: null, label: 'Sum the inv', partial: true }] }));
        expect(typing).toMatchObject({ label: 'Sum the inv', caption: 'Sum the inv', partial: true, typeLabel: 'Edit data', app: null });
        const done = projectGhostDraft(draftOf({ count: 1, steps: [{ type: 'set', tool: null, label: 'Sum the invoices', partial: false }] }));
        expect(done).toMatchObject({ label: 'Sum the invoices', partial: false });
    });

    it('no label yet: "Placing {app}…" when the app is known, else "Writing the next step…"', () => {
        const app = projectGhostDraft(draftOf({ name: 'builder_add_action', count: 1, steps: [{ type: 'integration_action', tool: 'gmail_send', label: null, partial: true }] }));
        expect(app.caption).toBe('Placing Gmail…');
        const blank = projectGhostDraft(draftOf({ name: 'builder_add_action', count: 1, steps: [{ type: 'integration_action', tool: 'gmail_send', label: '   ', partial: true }] }));
        expect(blank.caption).toBe('Placing Gmail…');
        expect(blank.label).toBeNull();
        const kind = projectGhostDraft(draftOf({ name: 'builder_add_condition', count: 1, steps: [{ type: 'condition', tool: null, label: null, partial: true }] }));
        expect(kind.caption).toBe('Writing the next step…');
        expect(kind.typeLabel).toBe('Condition');
    });

    it('a capped scan shows where it is, never the ceiling as a total', () => {
        // The server reads at most 40 cards out of a streaming call. It used to
        // report 40 as `count` with no way to tell a real total from its own
        // ceiling, so the card read "Step 40 of 40" — measured on a live build,
        // 2026-09-16, for a batch nobody had counted.
        const steps = Array.from({ length: 40 }, () => ({ type: 'datatable', tool: null, label: null, partial: true }));
        const capped = projectGhostDraft(draftOf({ name: 'builder_add_steps', steps, count: 40, capped: true }));
        expect(capped.stepOf).toBe('Step 40+');
        const honest = projectGhostDraft(draftOf({ name: 'builder_add_steps', steps: steps.slice(0, 3), count: 3 }));
        expect(honest.stepOf).toBe('Step 3 of 3');
    });

    it('"Step i of n" only when the batch has more than one card', () => {
        const one = projectGhostDraft(draftOf({ name: 'builder_add_action', count: 1, steps: [{ type: 'set', tool: null, label: 'A', partial: false }] }));
        expect(one.stepOf).toBeNull();
        const two = projectGhostDraft(draftOf({ count: 2, steps: [{ type: 'set', tool: null, label: 'A', partial: false }, { type: 'set', tool: null, label: 'B', partial: true }] }));
        expect(two.stepOf).toBe('Step 2 of 2');
        expect(two.index).toBe(2);
    });

    it('the call has opened but no step is readable yet: an add is writing, an update is adjusting', () => {
        expect(projectGhostDraft(draftOf({ name: 'builder_add_steps', steps: [] }))).toMatchObject({ kind: 'step', caption: 'Writing the next step…', label: null, app: null, index: 0 });
        expect(projectGhostDraft(draftOf({ name: 'builder_update_step', steps: [] }))).toMatchObject({ kind: 'editing', caption: 'Adjusting a step…' });
        expect(projectGhostDraft(draftOf({ name: 'builder_update_steps', steps: [] }))).toMatchObject({ kind: 'editing' });
        expect(projectGhostDraft(draftOf({ name: 'builder_replace_step', steps: [] }))).toMatchObject({ kind: 'editing' });
        expect(projectGhostDraft(draftOf({ name: 'builder_remove_step' }))).toMatchObject({ kind: 'editing', caption: 'Adjusting a step…' });
    });

    it('replace and update WITH a step show that step like an add does', () => {
        const d = projectGhostDraft(draftOf({ name: 'builder_update_step', count: 1, steps: [{ type: 'ai_step', tool: null, label: 'Rewrite', partial: true }] }));
        expect(d).toMatchObject({ kind: 'step', type: 'ai_step', typeLabel: 'AI step', label: 'Rewrite', partial: true });
    });

    it('translates through `t` when given one — keys under routines.canvas.draft, with the English as fallback', () => {
        const t = vi.fn((key, fallback, params) => `[${key}]${params ? JSON.stringify(params) : ''}`);
        const d = projectGhostDraft(draftOf({ name: 'builder_add_action', count: 1, steps: [{ type: 'integration_action', tool: 'gmail_send', label: null, partial: true }] }), { t });
        expect(d.caption).toBe('[routines.canvas.draft.placing]{"app":"Gmail"}');
        expect(t).toHaveBeenCalledWith('routines.canvas.draft.placing', 'Placing {app}…', { app: 'Gmail' });
        // The kind label goes through nodeDefs' own key.
        expect(d.typeLabel).toBe('[routines.node.integration_action.typeLabel]');
        const many = projectGhostDraft(draftOf({ count: 2, steps: [{ type: 'set', tool: null, label: 'A', partial: false }, { type: 'set', tool: null, label: 'B', partial: true }] }), { t });
        expect(many.stepOf).toBe('[routines.canvas.draft.step_of]{"i":2,"n":2}');
    });
});

describe('projectGhostDraft — inspect', () => {
    it('one tool: "Looking at {app}…" with the app it belongs to', () => {
        const d = projectGhostDraft(draftOf({ name: 'builder_inspect_tool', inspect: ['gmail_send'] }));
        expect(d).toMatchObject({ kind: 'inspect', tool: 'gmail_send', app: { id: 'gmail', name: 'Gmail' }, caption: 'Looking at Gmail…', index: 1, count: 1 });
    });

    it('many tools: "Looking at {n} apps…", the app being the LAST one read', () => {
        const d = projectGhostDraft(draftOf({ name: 'builder_inspect_tool', inspect: ['gmail_send', 'calendar_create_event', 'drive_upload'] }));
        expect(d.caption).toBe('Looking at 3 apps…');
        expect(d.tool).toBe('drive_upload');
        expect(d.app).toEqual({ id: 'google_drive', name: 'Google Drive' });
    });

    it('a tool nobody knows still reads as an inspect, named after the tool; no tool yet → null', () => {
        const d = projectGhostDraft(draftOf({ name: 'builder_inspect_tool', inspect: ['frobnicate_widget'] }));
        expect(d).toMatchObject({ kind: 'inspect', app: null, caption: 'Looking at Frobnicate widget…' });
        expect(projectGhostDraft(draftOf({ name: 'builder_inspect_tool', inspect: [] }))).toBeNull();
    });
});

describe('projectGhostDraft — activities and the unknown', () => {
    it.each([
        ['builder_request_dry_run', 'testing', 'Running a test…'],
        ['builder_set_plan', 'planning', 'Writing the plan…'],
        ['builder_summarise', 'summarising', 'Summarising the routine…'],
        ['builder_finalize', 'finalizing', 'Saving the routine…'],
        ['builder_wire_error_branch', 'wiring', 'Wiring the error branch…'],
        ['builder_remove_step', 'editing', 'Adjusting a step…'],
    ])('%s → %s', (name, kind, caption) => {
        expect(projectGhostDraft(draftOf({ name }))).toMatchObject({ kind, caption, app: null, label: null, stepOf: null });
    });

    it('unknown tool, no name, or no draft → null (the slot keeps its own caption)', () => {
        expect(projectGhostDraft(draftOf({ name: 'builder_list_layers' }))).toBeNull();
        expect(projectGhostDraft(draftOf({ name: null }))).toBeNull();
        expect(projectGhostDraft(null)).toBeNull();
        expect(projectGhostDraft(undefined)).toBeNull();
    });
});

describe('appForTool', () => {
    it('names the app from the catalog, by the action that owns the tool, before the prefix resolver', () => {
        expect(appForTool('crm_create_deal', CATALOG)).toEqual({ id: 'acme-crm', name: 'Acme CRM' });
        expect(appForTool('gmail_send', CATALOG)).toEqual({ id: 'gmail', name: 'Gmail' });
    });

    it('falls back to the bundled meta, then to a prettified id; null for nothing', () => {
        expect(appForTool('calendar_create_event')).toEqual({ id: 'google_calendar', name: 'Google Calendar' });
        expect(appForTool('mcp__things__add')).toEqual({ id: 'mcp', name: 'MCP' });
        expect(appForTool('nobody_knows_this')).toBeNull();
        expect(appForTool(null)).toBeNull();
    });
});

describe('spotlightKeysFor', () => {
    it('an app step → the app tile (every id spelling); never the tab strip or the ribbon', () => {
        const d = projectGhostDraft(draftOf({ name: 'builder_add_action', count: 1, steps: [{ type: 'integration_action', tool: 'calendar_create_event', label: null, partial: true }] }));
        const keys = spotlightKeysFor(d, null);
        expect(keys).toEqual(['app:google_calendar', 'app:google-calendar']);
        expect(keys.some(k => k === 'tabs' || k === 'ribbon')).toBe(false);
    });

    it('with a catalog, also the fold and the category pill the ribbon may have put the tile behind', () => {
        const d = projectGhostDraft(draftOf({ name: 'builder_add_action', count: 1, steps: [{ type: 'integration_action', tool: 'gmail_send', label: null, partial: true }] }), { catalog: CATALOG });
        const keys = spotlightKeysFor(d, CATALOG);
        expect(keys).toEqual(['app:gmail', 'more:Google Workspace', 'cat:Google Workspace']);
        expect(keys.some(k => k === 'tabs' || k === 'ribbon')).toBe(false);
    });

    it('an inspect spotlights the app being looked at; a kind step, an activity or nothing → []', () => {
        const inspect = projectGhostDraft(draftOf({ name: 'builder_inspect_tool', inspect: ['gmail_send'] }));
        expect(spotlightKeysFor(inspect)).toEqual(['app:gmail']);
        const kind = projectGhostDraft(draftOf({ name: 'builder_add_condition', count: 1, steps: [{ type: 'condition', tool: null, label: 'If', partial: true }] }));
        expect(spotlightKeysFor(kind)).toEqual([]);
        expect(spotlightKeysFor(projectGhostDraft(draftOf({ name: 'builder_set_plan' })))).toEqual([]);
        expect(spotlightKeysFor(null)).toEqual([]);
    });

    it("maps the server's shorthand type 'action' onto the engine type integration_action", () => {
        const d = projectGhostDraft({
            name: 'builder_add_action', count: 1, chars: 30, inspect: [],
            steps: [{ type: 'action', tool: 'nextcloud_list_files', label: null, partial: true }],
        }, { catalog: [], t: (k, fb) => fb });
        expect(d.type).toBe('integration_action');
        expect(d.kind).toBe('step');
    });
});
