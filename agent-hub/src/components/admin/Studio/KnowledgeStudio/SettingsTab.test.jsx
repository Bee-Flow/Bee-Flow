import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SettingsTab, { surfacesOf, attachedCount } from './SettingsTab';
import { knowledgeApi } from './knowledgeApi';

/**
 * The settings tab puts two questions next to each other that look like one:
 * WHERE a knowledge base may be used (which pickers offer it) and WHO may see
 * what is in it (what the server enforces at retrieval). If somebody unticks
 * "Agents" believing they have revoked access, the screen has failed — so the
 * separation, and the "still attached" count that keeps the first from
 * reading like the second, are what is pinned here.
 */

vi.mock('./knowledgeApi', () => ({
    knowledgeApi: {
        update: vi.fn(async () => ({})),
        setPublished: vi.fn(async () => ({})),
        remove: vi.fn(async () => ({ success: true })),
        duplicate: vi.fn(async () => ({ id: 'kb_copy' })),
        categories: vi.fn(async () => []),
    },
}));

const kb = (over = {}) => ({
    id: 'kb1', name: 'Personeelshandboek', description: 'HR', organization_id: 'org1',
    is_published: true, shared_groups: [], usage_contexts: ['agent', 'direct_chat', 'ai_step'],
    ...over,
});

function setup(props = {}) {
    return render(<SettingsTab kb={kb()} canManage usage={[]} orgId="org1" {...props} />);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('surfacesOf', () => {
    it('reads the list a base carries', () => {
        expect(surfacesOf({ usage_contexts: ['agent'] })).toEqual(['agent']);
        expect(surfacesOf({ usage_contexts: '["ai_step"]' })).toEqual(['ai_step']);
    });

    it('treats a value that was never expressed as EVERYWHERE', () => {
        // A NULL predates the column. Drawing every box unticked would invite
        // somebody to "fix" it by ticking one — silently removing the base
        // from the other two.
        for (const row of [{ usage_contexts: null }, {}, { usage_contexts: 'not json' }, null]) {
            expect(surfacesOf(row)).toEqual(['agent', 'direct_chat', 'ai_step']);
        }
    });

    it('keeps an explicit empty list empty — that is a real answer', () => {
        expect(surfacesOf({ usage_contexts: [] })).toEqual([]);
    });
});

describe('SettingsTab', () => {
    it('draws a toggle per surface, ticked from the base', () => {
        setup({ kb: kb({ usage_contexts: ['agent'] }) });
        expect(screen.getByTestId('kb-surface-agent').dataset.active).toBe('true');
        expect(screen.getByTestId('kb-surface-direct_chat').dataset.active).toBe('false');
        expect(screen.getByTestId('kb-surface-ai_step').dataset.active).toBe('false');
    });

    it('saves the new surface list when one is ticked', async () => {
        setup({ kb: kb({ usage_contexts: ['agent'] }) });
        fireEvent.click(screen.getByTestId('kb-surface-ai_step'));
        await waitFor(() => expect(knowledgeApi.update).toHaveBeenCalledWith('kb1', {
            usageContexts: ['agent', 'ai_step'],
        }));
    });

    it('refuses to let the LAST surface go', async () => {
        // An empty list is storable and means "nowhere". A settings screen
        // that lets the last tick go quietly removes the base from every
        // picker on one click.
        setup({ kb: kb({ usage_contexts: ['agent'] }) });
        fireEvent.click(screen.getByTestId('kb-surface-agent'));
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(knowledgeApi.update).not.toHaveBeenCalled();
    });

    it('says what is STILL attached after a surface is unticked', async () => {
        // Unticking a surface does not detach anything — the server only
        // refuses new links — so the count has to say so, or somebody will
        // believe they revoked something.
        setup({
            kb: kb({ usage_contexts: ['direct_chat'] }),
            usage: [
                { kind: 'agent', id: 'a1', role: 'chat', title: 'Support' },
                { kind: 'agent', id: 'a2', role: 'chat', title: 'HR' },
            ],
        });
        const card = screen.getByTestId('kb-surface-agent');
        expect(card.dataset.active).toBe('false');
        expect(card.textContent).toMatch(/still attached to 2/);
    });

    it('separates "where" from "who" in words, not only in layout', () => {
        setup();
        expect(screen.getByText(/does not change who may read/i)).toBeTruthy();
        expect(screen.getByText(/only answer from this knowledge base for someone who may see it/i)).toBeTruthy();
    });

    it('shows the audience rows for a base that belongs to an organisation', () => {
        setup();
        expect(screen.getByTestId('audience-rows')).toBeTruthy();
        expect(screen.queryByTestId('kb-personal-notice')).toBeNull();
    });

    it('asks before widening, and publishes through the audience route', async () => {
        // Two routes on purpose: widening who can read the documents has its
        // own authorisation, and a rename must not be able to carry it. And
        // the widening asks first — `confirmWidening` — because "everyone in
        // your organisation" is not a click you take back.
        setup({ kb: kb({ is_published: false }) });
        fireEvent.click(screen.getByText(/entire organisation/i));
        expect(knowledgeApi.setPublished).not.toHaveBeenCalled();

        expect(await screen.findByText(/everyone in your organisation will be able to see/i)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /^share$/i }));

        await waitFor(() => expect(knowledgeApi.setPublished).toHaveBeenCalledWith('kb1', {
            isPublished: true, sharedGroups: [],
        }));
        expect(knowledgeApi.update).not.toHaveBeenCalled();
    });

    it('commits the name on blur, not on every keystroke', async () => {
        setup();
        const input = screen.getByTestId('kb-settings-name');
        fireEvent.change(input, { target: { value: 'Handboek' } });
        expect(knowledgeApi.update).not.toHaveBeenCalled();
        fireEvent.blur(input);
        await waitFor(() => expect(knowledgeApi.update).toHaveBeenCalledWith('kb1', { name: 'Handboek' }));
    });

    it('does not save a name that did not change', () => {
        setup();
        fireEvent.blur(screen.getByTestId('kb-settings-name'));
        expect(knowledgeApi.update).not.toHaveBeenCalled();
    });

    describe('a personal knowledge base', () => {
        const personal = kb({ organization_id: null, is_published: false });

        it('says it cannot be shared, and offers the way out', () => {
            // Until K5 there was none: publishing refuses a base with no
            // organisation, so the only way to share one was to build it again.
            setup({ kb: personal });
            expect(screen.getByTestId('kb-personal-notice')).toBeTruthy();
            expect(screen.queryByTestId('audience-rows')).toBeNull();
            expect(screen.getByTestId('kb-move-to-org')).toBeTruthy();
        });

        it('states the consequence before the button is pressed', () => {
            setup({ kb: personal });
            expect(screen.getByText(/administrators will be able to see and manage it/i)).toBeTruthy();
            expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
        });

        it('moves it into the organisation without publishing it', async () => {
            // Belonging to an organisation and being shared with it are two
            // decisions, and only the second is "everyone may read this".
            setup({ kb: personal });
            fireEvent.click(screen.getByTestId('kb-move-to-org'));
            await waitFor(() => expect(knowledgeApi.update).toHaveBeenCalledWith('kb1', { organizationId: 'org1' }));
            expect(knowledgeApi.setPublished).not.toHaveBeenCalled();
        });

        it('offers nothing when the viewer has no organisation to move it to', () => {
            setup({ kb: personal, orgId: null });
            expect(screen.getByTestId('kb-personal-notice')).toBeTruthy();
            expect(screen.queryByTestId('kb-move-to-org')).toBeNull();
        });
    });

    describe('deleting', () => {
        it('shows what would break before it asks for the name', async () => {
            setup({ usage: [{ kind: 'agent', id: 'a1', role: 'chat', title: 'Support assistant' }] });
            fireEvent.click(screen.getByText(/delete this knowledge base/i));
            expect(await screen.findByTestId('danger-dependents')).toBeTruthy();
            expect(screen.getByText('Support assistant')).toBeTruthy();
        });

        it('confirms breaking only what was actually shown', async () => {
            setup({ usage: [{ kind: 'agent', id: 'a1', role: 'chat', title: 'Support assistant' }] });
            fireEvent.click(screen.getByText(/delete this knowledge base/i));
            fireEvent.change(await screen.findByPlaceholderText('Personeelshandboek'), {
                target: { value: 'Personeelshandboek' },
            });
            fireEvent.click(screen.getByText(/delete for good/i));
            await waitFor(() => expect(knowledgeApi.remove).toHaveBeenCalledWith('kb1', { confirm: true }));
        });

        it('lets the server decide when the list never loaded', async () => {
            // `null` is not `[]`. Passing confirm=true here would confirm
            // breaking things nobody was shown.
            setup({ usage: null });
            fireEvent.click(screen.getByText(/delete this knowledge base/i));
            fireEvent.change(await screen.findByPlaceholderText('Personeelshandboek'), {
                target: { value: 'Personeelshandboek' },
            });
            fireEvent.click(screen.getByText(/delete for good/i));
            await waitFor(() => expect(knowledgeApi.remove).toHaveBeenCalledWith('kb1', { confirm: false }));
        });

        it('says the list is INCOMPLETE when the server could not check something', async () => {
            // "I could not reach apps" and "no app uses this" are different
            // statements. Only one of them is safe to press delete on, and
            // this is the sentence that keeps them apart.
            setup({ usage: [], unchecked: ['app', 'automation'] });
            fireEvent.click(screen.getByText(/delete this knowledge base/i));
            const warning = await screen.findByTestId('kb-delete-unchecked');
            expect(warning.textContent).toMatch(/may be incomplete/i);
            expect(warning.textContent).toMatch(/apps/);
            expect(warning.textContent).toMatch(/automations/);
        });

        it('says nothing about completeness when everything was checked', () => {
            setup({ usage: [], unchecked: [] });
            fireEvent.click(screen.getByText(/delete this knowledge base/i));
            expect(screen.queryByTestId('kb-delete-unchecked')).toBeNull();
        });

        it('is absent for someone who may only read', () => {
            setup({ canManage: false });
            expect(screen.queryByTestId('danger-zone')).toBeNull();
        });
    });

    it('gives a read-only viewer no editable controls', () => {
        setup({ canManage: false });
        expect(screen.getByTestId('kb-settings-name').disabled).toBe(true);
        expect(screen.getByTestId('kb-surface-agent').disabled).toBe(true);
    });
});

describe('attachedCount', () => {
    it('counts what depends on a base through one surface', () => {
        const usage = [
            { kind: 'agent', id: 'a', role: 'chat' },
            { kind: 'automation', id: 'b', role: 'ai_step' },
            { kind: 'app', id: 'c', role: 'ai_step' },
            { kind: 'project', id: 'd', role: 'contains' },
        ];
        expect(attachedCount(usage, 'agent')).toBe(1);
        expect(attachedCount(usage, 'ai_step')).toBe(2);
    });

    it('counts nothing when the list is not loaded', () => {
        expect(attachedCount(null, 'agent')).toBe(0);
    });
});

describe('duplicating', () => {
    it('offers both answers, because they are wanted for different reasons', () => {
        // "The same shape, I will fill it myself" and "the same shape,
        // reading the same places" are different intentions, and guessing
        // wrong either leaves an empty base or starts fetches nobody asked for.
        setup();
        expect(screen.getByTestId('kb-duplicate-shell')).toBeTruthy();
        expect(screen.getByTestId('kb-duplicate-sources')).toBeTruthy();
    });

    it('copies the shell alone by default', async () => {
        setup();
        fireEvent.click(screen.getByTestId('kb-duplicate-shell'));
        await waitFor(() => expect(knowledgeApi.duplicate).toHaveBeenCalledWith('kb1', { withSources: false }));
    });

    it('copies the sources when asked', async () => {
        setup();
        fireEvent.click(screen.getByTestId('kb-duplicate-sources'));
        await waitFor(() => expect(knowledgeApi.duplicate).toHaveBeenCalledWith('kb1', { withSources: true }));
    });

    it('hands the copy back so the caller can open it', async () => {
        // The point of duplicating is to work on the new one; leaving somebody
        // on the original makes them hunt for what they just made.
        const onDuplicated = vi.fn();
        setup({ onDuplicated });
        fireEvent.click(screen.getByTestId('kb-duplicate-shell'));
        await waitFor(() => expect(onDuplicated).toHaveBeenCalledWith({ id: 'kb_copy' }));
    });

    it('says documents never travel, so nobody expects a filled copy', () => {
        setup();
        expect(screen.getByText(/Documents are never copied/i)).toBeTruthy();
    });

    it('is absent for someone who may only read', () => {
        setup({ canManage: false });
        expect(screen.queryByTestId('kb-duplicate')).toBeNull();
    });
});
