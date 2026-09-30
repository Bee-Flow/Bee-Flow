/**
 * The trigger editor's edits, as the node editor saves them: the step becomes
 * a draft (extractFormState), the editor's pure edits change it (kinds.ts,
 * appEvent.ts, the filter specs), and the draft becomes the patch that is
 * merged into the step (buildPatch) — only what changed.
 */

import type { FlowCatalog , FlowWebhook } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, extractFormState, type FormDraft } from '@/features/flow-editor/formState';

import { currentEvent, pickEvent, pickProvider, providerDefs, providerLabel } from './appEvent';
import { filterFormFor, FILTER_FORMS } from './filters';
import { chooseKind, hasKindForm, isSecondaryTrigger, kindOptions, kindTitle } from './kinds';
import { buildCurlSnippet, maskSecret, webhooksFor } from './webhook';
import { readField, writeField } from '../declarative/runtime';
import { specContext } from '../declarative/testing';

const trigger = (extra: Record<string, unknown> = {}) => ({ id: 'trg', type: 'trigger', kind: 'manual', label: 'Manual trigger', ...extra }) as FlowNode;

function edit(step: FlowNode, change: (draft: FormDraft) => FormDraft) {
    const draft = extractFormState(step);
    const next = { ...draft, ...change(draft) };
    return { draft: next, patch: buildPatch(step, next) };
}

describe('the kind', () => {
    it('renames a generated name with the kind, and clears what the old kind used', () => {
        const step = trigger({ kind: 'schedule', label: 'Schedule', schedule: { cron: '0 9 * * *', tz: 'UTC' } });
        const { patch } = edit(step, (d) => chooseKind(d, 'webhook'));
        expect(patch.kind).toBe('webhook');
        expect(patch.label).toBe('Webhook');
        expect(patch.schedule).toBeNull();
    });

    it('keeps a name somebody typed', () => {
        const { patch } = edit(trigger({ label: 'Every Monday report' }), (d) => chooseKind(d, 'schedule'));
        expect(patch.kind).toBe('schedule');
        expect(patch.label).toBeUndefined();
        expect(patch.schedule).toEqual({ cron: '', tz: 'Europe/Amsterdam' });
    });

    it('offers an additional trigger only webhook, app event and schedule — and keeps a stored legacy kind, disabled', () => {
        expect(kindOptions(false, 'manual').map((o) => o.value)).toEqual(['manual', 'form', 'schedule', 'webhook', 'app_event', 'agent_call', 'app_trigger']);
        expect(kindOptions(true, 'webhook').map((o) => o.value)).toEqual(['schedule', 'webhook', 'app_event']);
        const legacy = kindOptions(true, 'manual');
        expect(legacy.at(-1)).toMatchObject({ value: 'manual', disabled: true });
    });

    it('knows an additional trigger when it sees one', () => {
        const def = { trigger: { id: 'trg', type: 'trigger' as const }, triggers: [{ id: 't2', type: 'trigger' as const }], steps: [], edges: [] };
        expect(isSecondaryTrigger(def, 't2')).toBe(true);
        expect(isSecondaryTrigger(def, 'trg')).toBe(false);
        expect(isSecondaryTrigger(def, 'nope')).toBe(false);
    });

    it('names the kind’s band, and has none for manual', () => {
        expect(hasKindForm('manual')).toBe(false);
        expect(hasKindForm('schedule')).toBe(true);
        expect(kindTitle('webhook')[1]).toBe('Endpoint');
        expect(kindTitle('something_new')[1]).toBe('Event');
    });
});

describe('a schedule', () => {
    it('round-trips the cron and the zone', () => {
        const step = trigger({ kind: 'schedule', label: 'Schedule', schedule: { cron: '0 9 * * *', tz: 'UTC' } });
        expect(edit(step, () => ({})).patch.schedule).toBeUndefined();
        const { patch } = edit(step, () => ({ scheduleCron: '30 8 * * 1', scheduleTz: 'Europe/Amsterdam' }));
        expect(patch.schedule).toEqual({ cron: '30 8 * * 1', tz: 'Europe/Amsterdam' });
    });
});

describe('an app event', () => {
    const catalog = {
        triggers: [
            {
                kind: 'app_event',
                providers: [
                    { id: 'gmail', label: 'Gmail', defaultEvent: 'mail.new', events: [{ id: 'mail.new', label: 'New email' }, { id: 'label.added', label: 'Label added' }] },
                    'legacy-provider',
                ],
            },
        ],
    } as unknown as FlowCatalog;

    it('reads the providers, a bare string list included', () => {
        const defs = providerDefs(catalog);
        expect(defs.map((d) => d.id)).toEqual(['gmail', 'legacy-provider']);
        expect(defs[1]?.events).toEqual([]);
        expect(providerLabel('msgraph', null)).toBe('Microsoft 365 (Outlook)');
        expect(providerLabel('who', null)).toBe('who');
    });

    it('snaps to the provider’s default event and clears the filter', () => {
        const step = trigger({ kind: 'app_event', label: 'App event', appEvent: { provider: 'x', event: 'y', filter: { from: 'a' } } });
        const { patch } = edit(step, () => pickProvider(providerDefs(catalog), 'gmail'));
        expect(patch.appEvent).toEqual({ provider: 'gmail', event: 'mail.new', filter: null });
    });

    it('clears the filter when the event changes', () => {
        const step = trigger({ kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: { from: 'a' } } });
        expect(edit(step, () => pickEvent('label.added')).patch.appEvent).toEqual({ provider: 'gmail', event: 'label.added', filter: null });
    });

    it('falls back to the provider’s default event while none is stored', () => {
        const def = providerDefs(catalog)[0] ?? null;
        expect(currentEvent({ appEventName: '' }, def)).toBe('mail.new');
        expect(currentEvent({ appEventName: 'label.added' }, def)).toBe('label.added');
    });
});

describe('the app-event filters', () => {
    const step = trigger({ kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: { from: 'boss' } } });
    const ctx = specContext(step);
    const field = (key: string, id: string) => {
        const form = FILTER_FORMS[key];
        const f = form?.fields.find((x) => x.id === id);
        if (!f) throw new Error(`${key} has no ${id}`);
        return f;
    };

    it('stores a filled box and clears an emptied one', () => {
        const draft = extractFormState(step);
        const filled = writeField(field('gmail.mail.new', 'subjectContains'), 'invoice', draft, ctx);
        expect(buildPatch(step, filled).appEvent).toEqual({ provider: 'gmail', event: 'mail.new', filter: { from: 'boss', subjectContains: 'invoice' } });
        const emptied = writeField(field('gmail.mail.new', 'from'), '', draft, ctx);
        expect(buildPatch(step, emptied).appEvent).toEqual({ provider: 'gmail', event: 'mail.new', filter: null });
    });

    it('stores a tick as true and removes it when off; an inverse tick stores only false', () => {
        const draft = extractFormState(step);
        const on = writeField(field('gmail.mail.new', 'hasAttachment'), true, draft, ctx);
        expect((on.filter as Record<string, unknown>).hasAttachment).toBe(true);
        expect('hasAttachment' in (writeField(field('gmail.mail.new', 'hasAttachment'), false, on, ctx).filter as object)).toBe(false);
        const genuine = field('support.ticket.resolved', 'requireGenuineContact');
        expect(readField(genuine, draft, ctx)).toBe(true);
        const off = writeField(genuine, false, draft, ctx);
        expect((off.filter as Record<string, unknown>).requireGenuineContact).toBe(false);
        expect('requireGenuineContact' in (writeField(genuine, true, off, ctx).filter as object)).toBe(false);
    });

    it('numbers clear on blank; a list clears when empty; the meeting notes choice maps to true / false / nothing', () => {
        const draft = extractFormState(step);
        const lead = field('google-calendar.event.upcoming', 'leadMinutes');
        expect(readField(lead, draft, ctx)).toBe(15);
        expect((writeField(lead, 30, draft, ctx).filter as Record<string, unknown>).leadMinutes).toBe(30);
        expect('leadMinutes' in (writeField(lead, '', draft, ctx).filter as object)).toBe(false);
        const labels = field('gmail.label.added', 'excludeLabelIds');
        expect((writeField(labels, ['IMPORTANT', ' '], draft, ctx).filter as Record<string, unknown>).excludeLabelIds).toEqual(['IMPORTANT']);
        expect('excludeLabelIds' in (writeField(labels, [], draft, ctx).filter as object)).toBe(false);
        const when = field('meeting-notes.meeting.processed', 'reprocessed');
        expect((writeField(when, 'no', draft, ctx).filter as Record<string, unknown>).reprocessed).toBe(false);
        expect((writeField(when, 'yes', draft, ctx).filter as Record<string, unknown>).reprocessed).toBe(true);
        expect('reprocessed' in (writeField(when, '', draft, ctx).filter as object)).toBe(false);
    });

    it('has a form per mapped event and none for the rest', () => {
        expect(filterFormFor('nextcloud', 'file.renamed')).toBe(FILTER_FORMS['nextcloud.file.new']);
        expect(filterFormFor('gmail', 'nothing')).toBeNull();
    });
});

describe('the declared parameters', () => {
    it('an agent tool saves its name, description and a JSON Schema of its parameters', () => {
        const step = trigger({ kind: 'agent_call', label: 'Agent' });
        const { patch } = edit(step, () => ({
            toolName: ' summarise_inbox ',
            description: 'Summarise.',
            params: [{ name: 'limit', type: 'number', required: true, description: 'How many' }],
        }));
        expect(patch.toolName).toBe('summarise_inbox');
        expect(patch.description).toBe('Summarise.');
        expect(patch.parametersSchema).toMatchObject({ type: 'object', required: ['limit'] });
    });

    it('a flowlet input and a Studio App input save as params, unnamed rows dropped', () => {
        const step = trigger({ kind: 'app_trigger', label: 'Studio App' });
        const { patch } = edit(step, () => ({ params: [{ name: 'file', type: 'file', required: true }, { name: '', type: 'string' }] }));
        expect(patch.params).toEqual([{ name: 'file', type: 'file', required: true }]);
    });
});

describe('the webhook panel', () => {
    const wh = (id: string, triggerStepId: string | null) => ({ id, triggerStepId, url: `https://x/${id}` }) as FlowWebhook;

    it('shows a node its own URLs, and the primary its unscoped ones too', () => {
        const rows = [wh('a', 'trg'), wh('b', null), wh('c', 't2')];
        expect(webhooksFor(rows, 'trg', 'trg').map((r) => r.id)).toEqual(['a', 'b']);
        expect(webhooksFor(rows, 't2', 'trg').map((r) => r.id)).toEqual(['c']);
    });

    it('signs nonce + body in the cURL command, and masks all but the last four', () => {
        const curl = buildCurlSnippet('https://h/w', 's3cret');
        expect(curl).toContain("-hmac 's3cret'");
        expect(curl).toContain('X-BeeFlow-Nonce');
        expect(maskSecret('abcdefghijkl')).toBe('••••••••ijkl');
        expect(maskSecret('short')).toBe('••••••••');
    });
});
