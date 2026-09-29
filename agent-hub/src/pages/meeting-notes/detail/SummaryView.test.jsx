import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

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

// ── "Sjabloon (v4)" — met welk sjabloon is deze samenvatting geschreven ──
//
// De regel is een uitspraak over de tekst die eronder staat. Hij verschijnt
// alleen als hij waar te maken is; in elk ander geval zwijgt hij, en er wordt
// nooit een versienummer verzonnen.

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
        // Het sjabloon staat inmiddels op 9; deze samenvatting is met 2
        // geschreven. "v9" zeggen zou een uitspraak over het verleden zijn,
        // afgelezen aan het heden.
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
        // Onvindbaar in de lijst van DEZE lezer. Of het sjabloon verwijderd is
        // of alleen onzichtbaar voor hem, weet dit scherm niet — dus wordt er
        // geen van beide beweerd.
        const el = show({ summaryTemplateId: 'tpl-weg', summaryTemplateVersion: 3 });
        expect(el.textContent).toBe('Template: not available to you (v3)');
    });

    it('zwijgt zolang de sjabloonlijst nog niet binnen is', () => {
        // "Bestaat niet meer" zeggen over een sjabloon dat er gewoon is, is
        // erger dan even niets zeggen.
        expect(show({ summaryTemplateId: 'u1', summaryTemplateVersion: 4 }, null)).toBeNull();
    });
});

// ── De gedeelde notitie: het sjabloon van een ÁNDER ──────────────────────
//
// `GET /api/summary-templates` levert per LEZER: zijn eigen user-scope
// sjablonen plus de org/groepen waar hij in zit. Een collega die een
// gepubliceerde notitie opent krijgt Ann's persoonlijke sjabloon dus nooit in
// die lijst — niet omdat het weg is, maar omdat het niet van hem is. De regel
// mag daar geen verwijdering van maken.

describe('SummaryView sjabloonstempel — gedeelde notitie', () => {
    beforeEach(() => cleanup());

    // Bob's lijst: zijn eigen sjabloon en het org-sjabloon. Ann's persoonlijke
    // 'ann-tpl' staat er niet in, want dat is user-scope van Ann.
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
