/**
 * RulesPanel — de regels op een afgeronde vergadernotitie (M5, deel D).
 *
 * Wat hier vastligt is niet dat er kaarten renderen, maar wat een kaart mag
 * BEWEREN. De afleidingen zelf (welke stapsoorten, welk filter, wie mag
 * openen) staan in ../lib/meetingRules.test.js; dit bestand toetst de ZINNEN
 * en het gedrag van het paneel:
 *
 *   1. een stapsoort die deze kaart niet kent, verdwijnt niet stil uit de
 *      consequentie-zin;
 *   2. de run-telling is PER GEBRUIKER (`/_runs/facets` is `r.user_id = ik`),
 *      dus de zin zegt "of yours", en een mislukte lees toont NIETS — geen 0;
 *   3. een regel die de lezer niet mag openen krijgt geen link, want
 *      `GET /api/automation/:id` geeft daar 403.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
    listAutomations: vi.fn(),
    getRunFacets: vi.fn(),
    createAutomation: vi.fn(),
    suggestAutomationsStream: vi.fn(),
};
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => api }));

vi.mock('../../../hooks/useTranslation', () => ({
    default: () => ({
        t: (key, fallback, vars) => {
            let out = fallback || key;
            for (const [k, v] of Object.entries(vars || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
    }),
}));

import RulesPanel, { consequenceParts, runLabel } from './RulesPanel';
import { COMPOSER_SEED } from '../lib/meetingRules';

const t = (key, fallback, vars) => {
    let out = fallback || key;
    for (const [k, v] of Object.entries(vars || {})) out = out.split(`{${k}}`).join(String(v));
    return out;
};

const meetingTrigger = (filter = {}) => ({
    id: 'trg', type: 'trigger', kind: 'app_event',
    appEvent: { provider: 'meeting-notes', event: 'meeting.processed', filter },
});

const rule = (over = {}) => ({
    id: 'a-1',
    userId: 'me',
    title: 'Sales notes to the wiki',
    isActive: true,
    definition: {
        trigger: meetingTrigger({ tags: ['sales'] }),
        steps: [{ id: 's1', type: 'knowledge_write', knowledgeBaseId: 'kb-1' }],
        edges: [],
    },
    ...over,
});

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.listAutomations.mockResolvedValue({ automations: [] });
    api.getRunFacets.mockResolvedValue({ facets: { automationId: {} }, rangeHours: 24 });
    api.createAutomation.mockResolvedValue({ automation: { id: 'new-1' } });
    api.suggestAutomationsStream.mockResolvedValue(undefined);
});

/* ── de zinnen ───────────────────────────────────────────────────────── */

describe('consequenceParts', () => {
    it('says how many steps it could not describe, singular and plural', () => {
        expect(consequenceParts({ readable: true, kb: true, notify: false, table: false, other: 1 }, t))
            .toEqual(['files it in a knowledge base', '1 more step this card cannot describe']);
        expect(consequenceParts({ readable: true, kb: false, notify: false, table: false, other: 3 }, t))
            .toEqual(['3 more steps this card cannot describe']);
    });

    it('an empty rule says so, and an unreadable one says something else', () => {
        expect(consequenceParts({ readable: true, kb: false, notify: false, table: false, other: 0, steps: 0 }, t))
            .toEqual(['nothing yet — this rule has no steps']);
        expect(consequenceParts({ readable: false }, t)).toEqual(['its steps could not be read']);
    });

    it('"geen stappen" is iets anders dan "alleen stappen die ik niet meetel"', () => {
        // Een regel met set + condition + parse_json kreeg "this rule has no
        // steps" terwijl de definitie er drie bevat — de auteur die zijn eigen
        // regel terugleest denkt dan dat zijn werk niet is opgeslagen.
        expect(consequenceParts({ readable: true, kb: false, notify: false, table: false, other: 0, steps: 3 }, t))
            .toEqual(['3 steps that only prepare data — nothing leaves the run']);
        expect(consequenceParts({ readable: true, kb: false, notify: false, table: false, other: 0, steps: 1 }, t))
            .toEqual(['1 step that only prepares data — nothing leaves the run']);
    });
});

describe('runLabel', () => {
    const base = { automationId: 'a-1', hours: 24 };

    it('says whose runs it counted', () => {
        expect(runLabel({ ...base, facets: { automationId: { 'a-1': 1 } } }, t))
            .toBe('1 run of yours in the last 24 hours');
        expect(runLabel({ ...base, facets: { automationId: { 'a-1': 4 } } }, t))
            .toBe('4 runs of yours in the last 24 hours');
    });

    it('shows nothing at all when the count could not be read', () => {
        expect(runLabel({ ...base, facets: null, facetsError: true }, t)).toBeNull();
        expect(runLabel({ ...base, facets: null }, t)).toBeNull();
        // Een 200 met een body die GEEN automationId-map draagt is óók
        // onleesbaar; die landde stilzwijgend als een nul.
        expect(runLabel({ ...base, facets: { status: {} } }, t)).toBeNull();
        // …and a real zero over a real window is said out loud instead.
        expect(runLabel({ ...base, facets: { automationId: {} } }, t))
            .toBe('no runs of yours in the last 24 hours');
    });
});

/* ── het paneel ──────────────────────────────────────────────────────── */

describe('RulesPanel', () => {
    it('asks only for the meeting-notes routines and reads them as one sentence', async () => {
        api.listAutomations.mockResolvedValue({ automations: [rule()] });
        api.getRunFacets.mockResolvedValue({ facets: { automationId: { 'a-1': 2 } }, rangeHours: 24 });
        render(<RulesPanel currentUserId="me" onNavigate={vi.fn()} />);

        await screen.findByTestId('rule-card');
        expect(api.listAutomations).toHaveBeenCalledWith({ triggerProvider: 'meeting-notes' });
        expect(screen.getByTestId('rule-sentence').textContent)
            .toBe('When a meeting tagged sales is finished → files it in a knowledge base');
        expect(screen.getByTestId('rule-runs').textContent).toBe('2 runs of yours in the last 24 hours');
        expect(screen.getByText('Active')).toBeTruthy();
    });

    it('a step kind it cannot describe still shows up in the sentence', async () => {
        api.listAutomations.mockResolvedValue({
            automations: [rule({
                definition: {
                    trigger: meetingTrigger({ tags: ['sales'] }),
                    steps: [
                        { id: 's1', type: 'knowledge_write' },
                        { id: 's2', type: 'integration_action', tool: 'gmail_send_email' },
                    ],
                },
            })],
        });
        render(<RulesPanel currentUserId="me" />);
        const sentence = await screen.findByTestId('rule-sentence');
        expect(sentence.textContent).toContain('files it in a knowledge base');
        expect(sentence.textContent).toContain('1 more step this card cannot describe');
    });

    it('says when the rule is narrowed further than the sentence can show', async () => {
        api.listAutomations.mockResolvedValue({
            automations: [rule({
                definition: {
                    trigger: meetingTrigger({ tags: ['sales'], expr: 'trigger.reprocessed == false', reprocessed: false }),
                    steps: [{ id: 's1', type: 'notification' }],
                },
            })],
        });
        render(<RulesPanel currentUserId="me" />);
        const narrowing = await screen.findByTestId('rule-narrowing');
        expect(narrowing.textContent).toContain('Only a brand-new note');
        expect(narrowing.textContent).toContain('conditions this card cannot show');
    });

    it('shows no count at all — and never a 0 — when the facets could not be read', async () => {
        api.listAutomations.mockResolvedValue({ automations: [rule()] });
        api.getRunFacets.mockRejectedValue(new Error('facets exploded'));
        render(<RulesPanel currentUserId="me" />);

        await screen.findByTestId('rule-card');
        await waitFor(() => expect(screen.getByTestId('rules-runs-error')).toBeTruthy());
        expect(screen.getByTestId('rule-runs').textContent).toBe('');
        expect(screen.queryByText(/no runs of yours/i)).toBeNull();
        expect(screen.queryByText(/0 runs/i)).toBeNull();
    });

    it('gives a rule the reader may not open no link, and says whose it is', async () => {
        const onNavigate = vi.fn();
        api.listAutomations.mockResolvedValue({ automations: [rule({ userId: 'someone-else' })] });
        render(<RulesPanel currentUserId="me" onNavigate={onNavigate} />);

        await screen.findByTestId('rule-card');
        expect(screen.queryByTestId('rule-open')).toBeNull();
        expect(screen.getByTestId('rule-foreign').textContent).toMatch(/Someone else/i);
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('an unverifiable owner gets no link either, and no claim about whose it is', async () => {
        api.listAutomations.mockResolvedValue({ automations: [rule({ userId: undefined })] });
        render(<RulesPanel currentUserId="me" onNavigate={vi.fn()} />);

        await screen.findByTestId('rule-card');
        expect(screen.queryByTestId('rule-open')).toBeNull();
        expect(screen.queryByTestId('rule-foreign')).toBeNull();
    });

    it('opens your own rule in the automations builder', async () => {
        const onNavigate = vi.fn();
        api.listAutomations.mockResolvedValue({ automations: [rule()] });
        render(<RulesPanel currentUserId="me" onNavigate={onNavigate} />);

        fireEvent.click(await screen.findByTestId('rule-open'));
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/a-1');
    });

    it('"+ Rule" creates a draft with the trigger already set and opens it', async () => {
        const onNavigate = vi.fn();
        render(<RulesPanel currentUserId="me" onNavigate={onNavigate} />);
        await screen.findByTestId('rules-empty');

        fireEvent.click(screen.getByTestId('rules-new'));
        await waitFor(() => expect(api.createAutomation).toHaveBeenCalled());
        const body = api.createAutomation.mock.calls[0][0];
        expect(body.definition.trigger.appEvent).toEqual({
            provider: 'meeting-notes', event: 'meeting.processed', filter: {},
        });
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/automations/new-1'));
    });

    it('a plan without automations explains itself instead of showing a raw error', async () => {
        api.createAutomation.mockRejectedValue(new Error('403 Forbidden: licence'));
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rules-empty');

        fireEvent.click(screen.getByTestId('rules-new'));
        const banner = await screen.findByTestId('rules-create-error');
        expect(banner.textContent).toMatch(/not part of this plan/i);
    });

    it('the composer scans with the meeting seed in front of what the user typed', async () => {
        api.suggestAutomationsStream.mockImplementation(async (body, onEvent) => {
            onEvent('done', { suggestions: [{ id: 's1', title: 'File decisions', description: 'Put them in the wiki', buildPrompt: 'Build it' }] });
        });
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rules-empty');

        fireEvent.click(screen.getByTestId('rules-composer-toggle'));
        fireEvent.change(screen.getByLabelText(/Say what should happen/i), { target: { value: 'tell the team' } });
        fireEvent.click(screen.getByTestId('rules-composer-run'));

        await waitFor(() => expect(api.suggestAutomationsStream).toHaveBeenCalled());
        const [body] = api.suggestAutomationsStream.mock.calls[0];
        expect(body.focus.startsWith(COMPOSER_SEED)).toBe(true);
        expect(body.focus).toContain('tell the team');

        const idea = await screen.findByTestId('rules-idea');
        expect(idea.textContent).toContain('File decisions');
    });

    it('hands a chosen idea to the caller as a build prompt when there is one', async () => {
        const onComposeRule = vi.fn();
        const suggestion = { id: 's1', title: 'File decisions', description: 'Put them in the wiki', buildPrompt: 'Build the rule', requiredIntegrations: ['nextcloud'] };
        api.suggestAutomationsStream.mockImplementation(async (body, onEvent) => { onEvent('done', { suggestions: [suggestion] }); });
        render(<RulesPanel currentUserId="me" onComposeRule={onComposeRule} />);
        await screen.findByTestId('rules-empty');

        fireEvent.click(screen.getByTestId('rules-composer-toggle'));
        fireEvent.click(screen.getByTestId('rules-composer-run'));
        fireEvent.click(await screen.findByText('Start this rule'));

        expect(api.createAutomation).not.toHaveBeenCalled();
        expect(onComposeRule).toHaveBeenCalledTimes(1);
        expect(onComposeRule.mock.calls[0][0]).toContain('Build the rule');
        expect(onComposeRule.mock.calls[0][1]).toBe(suggestion);
    });

    it('with nowhere to send the prompt, the idea still becomes a preset draft', async () => {
        const onNavigate = vi.fn();
        api.suggestAutomationsStream.mockImplementation(async (body, onEvent) => {
            onEvent('done', { suggestions: [{ id: 's1', title: 'File decisions', description: 'Put them in the wiki', buildPrompt: 'Build it' }] });
        });
        render(<RulesPanel currentUserId="me" onNavigate={onNavigate} />);
        await screen.findByTestId('rules-empty');

        fireEvent.click(screen.getByTestId('rules-composer-toggle'));
        fireEvent.click(screen.getByTestId('rules-composer-run'));
        fireEvent.click(await screen.findByText('Start this rule'));

        await waitFor(() => expect(api.createAutomation).toHaveBeenCalled());
        const body = api.createAutomation.mock.calls[0][0];
        expect(body.title).toBe('File decisions');
        expect(body.definition.trigger.appEvent.provider).toBe('meeting-notes');
    });

    it('says there is nothing to scan rather than showing an empty idea list', async () => {
        api.suggestAutomationsStream.mockImplementation(async (body, onEvent) => {
            onEvent('done', { suggestions: [], reason: 'no_integrations' });
        });
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rules-empty');

        fireEvent.click(screen.getByTestId('rules-composer-toggle'));
        fireEvent.click(screen.getByTestId('rules-composer-run'));
        expect((await screen.findByTestId('rules-ai-reason')).textContent).toMatch(/No connected apps/i);
    });

    it('a failed list never reads as "no rules"', async () => {
        api.listAutomations.mockRejectedValue(new Error('nope'));
        const onRulesChange = vi.fn();
        render(<RulesPanel currentUserId="me" onRulesChange={onRulesChange} />);

        await screen.findByTestId('rules-error');
        expect(screen.queryByTestId('rules-empty')).toBeNull();
        // …and the rail badge gets no number rather than a 0 that reads as none.
        expect(onRulesChange).toHaveBeenCalledWith(null);
        expect(onRulesChange).not.toHaveBeenCalledWith(0);
    });

    it('reports how many rules there are once the list has actually answered', async () => {
        api.listAutomations.mockResolvedValue({ automations: [rule(), rule({ id: 'a-2' })] });
        const onRulesChange = vi.fn();
        render(<RulesPanel currentUserId="me" onRulesChange={onRulesChange} />);
        await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith(2));
    });
});

/* ── de bevindingen van de sluitronde ────────────────────────────────── */

describe('RulesPanel — wat een kaart NIET mag beweren', () => {
    it('een verse regel heet "Draft", niet "Paused"', async () => {
        // Élke regel die de knop "+ Rule" hier maakt komt als
        // `is_active=FALSE, is_draft=TRUE` uit de store. "Paused" is hetzelfde
        // woord als een afgemaakte regel die je bewust hebt uitgezet, en de
        // trigger-bus slaat een concept om een ANDERE reden over.
        api.listAutomations.mockResolvedValue({ automations: [rule({ isActive: false, isDraft: true })] });
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rule-card');
        expect(screen.getByText('Draft')).toBeTruthy();
        expect(screen.queryByText('Paused')).toBeNull();
    });

    it('isDraft wint van isActive — dispatch.js slaat hem evengoed over', async () => {
        api.listAutomations.mockResolvedValue({ automations: [rule({ isActive: true, isDraft: true })] });
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rule-card');
        expect(screen.getByText('Draft')).toBeTruthy();
        expect(screen.queryByText('Active')).toBeNull();
    });

    it('een ai_step met tools verdwijnt niet uit de zin', async () => {
        api.listAutomations.mockResolvedValue({
            automations: [rule({
                definition: {
                    trigger: meetingTrigger({}),
                    steps: [{ id: 's1', type: 'ai_step', allowTools: true, tools: ['gmail_send_email'] }],
                },
            })],
        });
        render(<RulesPanel currentUserId="me" />);
        const sentence = await screen.findByTestId('rule-sentence');
        expect(sentence.textContent).toContain('1 more step this card cannot describe');
        expect(sentence.textContent).not.toContain('has no steps');
    });

    it('een ander event krijgt niet de zin van meeting.processed', async () => {
        // `meetingTriggersOf` filtert bewust alleen op de PROVIDER. Vandaag al
        // bereikbaar: een onbekend app_event-event is voor de validator een
        // WARNING, dus zo'n definitie slaat op en verschijnt hier.
        api.listAutomations.mockResolvedValue({
            automations: [rule({
                definition: {
                    trigger: {
                        id: 'trg', type: 'trigger', kind: 'app_event',
                        appEvent: { provider: 'meeting-notes', event: 'meeting.scheduled', filter: {} },
                    },
                    steps: [{ id: 's1', type: 'notification' }],
                },
            })],
        });
        render(<RulesPanel currentUserId="me" />);
        const sentence = await screen.findByTestId('rule-sentence');
        expect(sentence.textContent).toContain('meeting.scheduled');
        expect(sentence.textContent).not.toContain('is finished');
    });

    it('een 200 zonder automationId-map is onleesbaar, geen nul', async () => {
        api.listAutomations.mockResolvedValue({ automations: [rule()] });
        api.getRunFacets.mockResolvedValue({ facets: { status: {} }, rangeHours: 24 });
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rule-card');
        expect(screen.getByTestId('rules-runs-error')).toBeTruthy();
        expect(screen.getByTestId('rule-runs').textContent).toBe('');
    });

    it('telt alleen ECHTE runs, geen dry-runs uit de builder', async () => {
        api.listAutomations.mockResolvedValue({ automations: [rule()] });
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rule-card');
        expect(api.getRunFacets).toHaveBeenCalledWith({ range: 24, mode: 'live' });
    });

    it('noemt het venster dat de SERVER teruggaf, niet het gevraagde', async () => {
        // De route klemt `range` op [1,720] en kan dus iets anders terugmelden.
        api.listAutomations.mockResolvedValue({ automations: [rule()] });
        api.getRunFacets.mockResolvedValue({ facets: { automationId: { 'a-1': 2 } }, rangeHours: 12 });
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rule-card');
        expect(screen.getByTestId('rule-runs').textContent).toBe('2 runs of yours in the last 12 hours');
    });

    it('vertaalt het licentietoken dat de server echt stuurt', async () => {
        // De gate antwoordt `{error:'feature_locked'}`; `safeText` geeft dat
        // als `err.message` terug en `send` hangt er geen `.status` aan. Een
        // test op /403|forbidden|licen/ was dus altijd onwaar en de klant kreeg
        // de kale string te zien.
        api.createAutomation.mockRejectedValue(new Error('feature_locked'));
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rules-empty');
        fireEvent.click(screen.getByTestId('rules-new'));
        const banner = await screen.findByTestId('rules-create-error');
        expect(banner.textContent).toMatch(/not part of this plan/i);
        expect(banner.textContent).not.toContain('feature_locked');
    });

    it('… ook op tier_required, en ook bij het LADEN van de lijst', async () => {
        api.listAutomations.mockRejectedValue(new Error('tier_required'));
        render(<RulesPanel currentUserId="me" />);
        const banner = await screen.findByTestId('rules-error');
        expect(banner.textContent).toMatch(/not part of this plan/i);
    });

    it('meldt óók de andere lege uitkomsten van de scan', async () => {
        api.suggestAutomationsStream.mockImplementation(async (body, onEvent) => {
            onEvent('done', { suggestions: [], reason: 'no_patterns' });
        });
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rules-empty');
        fireEvent.click(screen.getByTestId('rules-composer-toggle'));
        fireEvent.click(screen.getByTestId('rules-composer-run'));
        expect((await screen.findByTestId('rules-ai-reason')).textContent).toMatch(/found nothing worth turning into a rule/i);
    });

    it('een stream die zonder `done` eindigt is geen lege uitslag', async () => {
        // Afgekapte verbinding, of een crash na de headers: 0 kaarten, geen
        // banner en een knop die weer op "Get ideas" staat — "onbekend" en
        // "niets gevonden" werden hetzelfde scherm.
        api.suggestAutomationsStream.mockImplementation(async () => { /* geen enkel event */ });
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rules-empty');
        fireEvent.click(screen.getByTestId('rules-composer-toggle'));
        fireEvent.click(screen.getByTestId('rules-composer-run'));
        expect((await screen.findByTestId('rules-ai-error')).textContent).toMatch(/stopped before it finished/i);
    });

    it('de 429-tak zegt dat het aan de drukte ligt', async () => {
        const err = Object.assign(new Error('too many'), { status: 429 });
        api.suggestAutomationsStream.mockRejectedValue(err);
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rules-empty');
        fireEvent.click(screen.getByTestId('rules-composer-toggle'));
        fireEvent.click(screen.getByTestId('rules-composer-run'));
        expect((await screen.findByTestId('rules-ai-error')).textContent).toMatch(/Too many scans/i);
    });

    it('zonder statuskolommen staat er geen chip — undefined is geen "uit"', async () => {
        api.listAutomations.mockResolvedValue({ automations: [rule({ isActive: undefined })] });
        render(<RulesPanel currentUserId="me" />);
        await screen.findByTestId('rule-card');
        expect(screen.queryByText('Paused')).toBeNull();
        expect(screen.queryByText('Active')).toBeNull();
        expect(screen.queryByText('Draft')).toBeNull();
    });
});
