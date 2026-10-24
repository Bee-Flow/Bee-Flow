import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// MarkdownRenderer isn't under test — stub it to plain text.
vi.mock('../../../components/renderers/MarkdownRenderer', () => ({ default: ({ content }) => <div>{content}</div> }));

import SummaryView from './SummaryView';

const TEMPLATES = {
    builtins: [
        { id: 'general', name: 'General meeting', nameKey: 'meeting_notes.template_general' },
        { id: 'standup', name: 'Stand-up', nameKey: 'meeting_notes.template_standup' },
    ],
    custom: [
        { id: 'u1', scope: 'user', name: 'My board style' },
        { id: 'o1', scope: 'org', name: 'Klant-review NL' },
        { id: 'g1', scope: 'group', name: 'Sales QBR', groupId: 'gid-1' },
    ],
    defaultTemplateId: 'u1',
    canManageOrg: true,
};

describe('SummaryView regenerate menu', () => {
    beforeEach(() => cleanup());

    function open(props = {}) {
        const onRegenerate = vi.fn();
        const onNewTemplate = vi.fn();
        const onEditTemplate = vi.fn();
        render(
            <SummaryView
                summary=""
                regenerating={false}
                onRegenerate={onRegenerate}
                onNewTemplate={onNewTemplate}
                onEditTemplate={onEditTemplate}
                templates={TEMPLATES}
                {...props}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: /Regenerate/i }));
        return { onRegenerate, onNewTemplate, onEditTemplate };
    }

    it('lists built-in and custom templates', () => {
        open();
        expect(screen.getByText('General meeting')).toBeTruthy();
        expect(screen.getByText('My board style')).toBeTruthy();
        expect(screen.getByText('Klant-review NL')).toBeTruthy();
        expect(screen.getByText('Sales QBR')).toBeTruthy();
    });

    it('regenerates a built-in with a { template } payload', () => {
        const { onRegenerate } = open();
        fireEvent.click(screen.getByText('Stand-up'));
        expect(onRegenerate).toHaveBeenCalledWith({ template: 'standup' });
    });

    it('regenerates a custom template with a { templateId } payload', () => {
        const { onRegenerate } = open();
        fireEvent.click(screen.getByText('Klant-review NL'));
        expect(onRegenerate).toHaveBeenCalledWith({ templateId: 'o1' });
    });

    it('offers "New template…" and invokes onNewTemplate', () => {
        const { onNewTemplate } = open();
        fireEvent.click(screen.getByText(/New template/i));
        expect(onNewTemplate).toHaveBeenCalled();
    });

    it('falls back to built-in labels when no templates are loaded', () => {
        const onRegenerate = vi.fn();
        render(<SummaryView summary="" regenerating={false} onRegenerate={onRegenerate} />);
        fireEvent.click(screen.getByRole('button', { name: /Regenerate/i }));
        expect(screen.getByText('Retrospective')).toBeTruthy();
        fireEvent.click(screen.getByText('Sales call'));
        expect(onRegenerate).toHaveBeenCalledWith({ template: 'sales' });
    });

    it('hides the whole menu when onRegenerate is not provided (non-owner)', () => {
        render(<SummaryView summary="Done." templates={TEMPLATES} />);
        expect(screen.queryByRole('button', { name: /Regenerate/i })).toBeNull();
    });
});

// ── "Template (v4)": with which template this summary was written ──
//
// The rule is a statement about the text beneath it. It appears only if it can be made
// good. In any other case it stays silent, and a version number is never invented.

describe('SummaryView sjabloonstempel', () => {
    beforeEach(() => cleanup());

    function show(meeting, templates = TEMPLATES) {
        render(<SummaryView summary="Tekst" regenerating={false} templates={templates} meeting={meeting} />);
        return screen.queryByTestId('summary-template-stamp');
    }

    it('een notitie van vóór deze kolommen toont niets — geen "v1"', () => {
        expect(show({ id: 'm-1', summary: 'Tekst' })).toBeNull();
    });

    it('een opgeslagen sjabloon toont naam én de versie van de notitie', () => {
        const el = show({ summaryTemplateId: 'u1', summaryTemplateVersion: 4 });
        expect(el.textContent).toBe('Template: My board style (v4)');
    });

    it('toont de versie van de NOTITIE, niet die van het sjabloon van nu', () => {
        // The template is now at 9. This summary was written with 2. Saying "v9" would be a
        // statement about the past, read off the present.
        const templates = { ...TEMPLATES, custom: [{ id: 'u1', scope: 'user', name: 'My board style', version: 9 }] };
        const el = show({ summaryTemplateId: 'u1', summaryTemplateVersion: 2 }, templates);
        expect(el.textContent).toBe('Template: My board style (v2)');
        expect(el.textContent).not.toContain('v9');
    });

    it('een sjabloon zonder bekende versie toont alleen de naam', () => {
        const el = show({ summaryTemplateId: 'u1' });
        expect(el.textContent).toBe('Template: My board style');
        expect(el.textContent).not.toMatch(/\(v/);
    });

    it('een ingebouwd sjabloon toont zijn naam en geen versie', () => {
        const el = show({ summaryTemplateId: 'builtin:standup', summaryTemplateVersion: 7 });
        expect(el.textContent).toBe('Template: Stand-up');
    });

    it('een onvindbaar sjabloon noemt geen naam, met de versie die wél bekend is', () => {
        // Not findable in the list of THIS reader. Whether the template has been deleted or is
        // merely invisible to him, this screen does not know, so neither is claimed.
        const el = show({ summaryTemplateId: 'tpl-weg', summaryTemplateVersion: 3 });
        expect(el.textContent).toBe('Template: not available to you (v3)');
    });

    it('zwijgt zolang de sjabloonlijst nog niet binnen is', () => {
        // Saying "no longer exists" about a template that is simply there is worse than saying
        // nothing.
        expect(show({ summaryTemplateId: 'u1', summaryTemplateVersion: 4 }, null)).toBeNull();
    });
});

// ── The shared note: a template of SOMEONE ELSE ─────────────────────────
//
// `GET /api/summary-templates` supplies, per READER, his own user-scope templates plus
// the org and groups he belongs to. A colleague who opens a published note therefore
// never gets Ann's personal template in that list, not because it is gone but because
// it is not his. The rule may not make a deletion of that.

describe('SummaryView sjabloonstempel — gedeelde notitie', () => {
    beforeEach(() => cleanup());

    // Bob's list: his own template and the org template. Ann's personal 'ann-tpl' is not in
    // it, because that is Ann's user scope.
    const BOBS_TEMPLATES = {
        builtins: TEMPLATES.builtins,
        custom: [
            { id: 'bob-1', scope: 'user', name: 'Bob eigen stijl' },
            { id: 'o1', scope: 'org', name: 'Klant-review NL' },
        ],
        defaultTemplateId: 'bob-1',
        canManageOrg: false,
    };

    it('zegt niet dat andermans sjabloon verwijderd is', () => {
        render(
            <SummaryView
                summary="Tekst"
                regenerating={false}
                templates={BOBS_TEMPLATES}
                meeting={{ summaryTemplateId: 'ann-tpl', summaryTemplateVersion: 4 }}
            />,
        );
        const el = screen.getByTestId('summary-template-stamp');
        expect(el.textContent).not.toMatch(/no longer available/i);
        expect(el.textContent).toBe('Template: not available to you (v4)');
    });
});
