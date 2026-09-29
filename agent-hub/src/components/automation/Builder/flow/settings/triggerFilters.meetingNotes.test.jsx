// Het tagfilter voor meeting-notes.meeting.processed — en vooral: zegt het
// scherm wat een LEGE tagfilter betekent?
//
// De keuze (leeg = elke afgeronde meeting, niet geen enkele) is verdedigbaar,
// maar hij is alleen goed als hij er STAAT. Een leeg vak dat stilzwijgend
// "alles" betekent is de fout die dit programma al twee keer als HOOG heeft
// opgeschreven, dus de zin onder het invoerveld wordt hier vastgepind — niet
// alleen de opgeslagen waarde.
//
// Draai vanuit agent-hub:
//   ./node_modules/.bin/vitest run src/components/automation/Builder/flow/settings/triggerFilters.meetingNotes.test.jsx

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MeetingNotesProcessedFilterFields, FILTER_FORM_BY_KEY } from './triggerFilters';

function setup(initial = {}) {
    const filter = { ...initial };
    const setFilter = vi.fn((k, v) => {
        if (v === undefined) delete filter[k];
        else filter[k] = v;
    });
    const view = render(<MeetingNotesProcessedFilterFields filter={filter} setFilter={setFilter} />);
    // Niet getByLabelText: FieldHint zet dezelfde naam op zijn ⓘ-knop.
    const tagBox = () => screen.getByRole('textbox');
    const type = (text) => fireEvent.change(tagBox(), { target: { value: text } });
    const rerender = () => view.rerender(<MeetingNotesProcessedFilterFields filter={{ ...filter }} setFilter={setFilter} />);
    return { filter, setFilter, tagBox, type, rerender };
}

describe('het meeting-notes tagfilter', () => {
    it('is geregistreerd op de (provider, event) die AppEventFields opzoekt', () => {
        // Zonder deze sleutel rendert de builder geen filterformulier en is de
        // hele beslissing hieronder onzichtbaar voor de auteur.
        expect(FILTER_FORM_BY_KEY['meeting-notes.meeting.processed']).toBe(MeetingNotesProcessedFilterFields);
    });

    it('ZEGT dat geen tags "elke afgeronde meeting" betekent', () => {
        setup();
        expect(screen.getByText(/runs after EVERY finished meeting note/i)).toBeTruthy();
        // En het zegt ook wat je eraan doet, want anders is het een mededeling
        // zonder uitweg.
        expect(screen.getByText(/Name a tag to narrow it/i)).toBeTruthy();
    });

    it('vervangt die zin door de belofte zodra er tags staan — enkelvoud en meervoud apart', () => {
        const { type, rerender } = setup();

        type('sales');
        rerender();
        expect(screen.queryByText(/EVERY finished meeting note/i)).toBeNull();
        expect(screen.getByText('Runs only for a note carrying this tag.')).toBeTruthy();

        type('sales, klant-van-dijk');
        rerender();
        expect(screen.getByText('Runs only for a note carrying any of these 2 tags.')).toBeTruthy();
    });

    it('slaat de tags op als lijst, en WIST de sleutel als het vak leeg raakt', () => {
        const { filter, setFilter, type, rerender } = setup();

        type(' sales , klant-van-dijk ');
        expect(setFilter).toHaveBeenCalledWith('tags', ['sales', 'klant-van-dijk']);
        expect(filter.tags).toEqual(['sales', 'klant-van-dijk']);

        type('');
        rerender();
        // undefined, niet []: de sleutel verdwijnt uit het opgeslagen filter,
        // precies zoals elk ander filterveld in dit bestand doet.
        expect(setFilter).toHaveBeenCalledWith('tags', undefined);
        expect('tags' in filter).toBe(false);
        // …en het scherm valt terug op de "elke meeting"-zin in plaats van
        // stil te blijven.
        expect(screen.getByText(/runs after EVERY finished meeting note/i)).toBeTruthy();
    });

    it('opent met de opgeslagen tags in het vak', () => {
        setup({ tags: ['sales', 'inkoop'] });
        expect(screen.getByRole('textbox').value).toBe('sales, inkoop');
        expect(screen.getByText('Runs only for a note carrying any of these 2 tags.')).toBeTruthy();
    });

    it('zegt ZICHTBAAR dat er exact en hoofdlettergevoelig vergeleken wordt', () => {
        // De matcher doet dat (net als de meeting_tag-kennisbron); wie het niet
        // weet, typt "Sales" en wacht vergeefs op een run. Die zin hoort dus
        // niet in de ⓘ-popover te staan, die pas na een klik in de DOM komt.
        const { type, rerender } = setup();
        type('sales');
        rerender();
        expect(screen.getByText(/exactly and case-sensitively/i)).toBeTruthy();
    });

    it('houdt "elke aanleiding" en "alleen een nieuwe notitie" uit elkaar', () => {
        const { filter, setFilter } = setup();
        const select = screen.getByRole('combobox');
        expect(select.value).toBe('');   // geen mening = alle drie de aanleidingen

        fireEvent.change(select, { target: { value: 'no' } });
        expect(setFilter).toHaveBeenCalledWith('reprocessed', false);
        expect(filter.reprocessed).toBe(false);

        fireEvent.change(select, { target: { value: 'yes' } });
        expect(setFilter).toHaveBeenCalledWith('reprocessed', true);

        fireEvent.change(select, { target: { value: '' } });
        // Weglaten is iets anders dan false — de sleutel wordt gewist.
        expect(setFilter).toHaveBeenCalledWith('reprocessed', undefined);
        expect('reprocessed' in filter).toBe(false);
    });

    it('vertelt dat de payload geen inhoud van de notitie draagt', () => {
        setup();
        expect(screen.getByText(/no summary, title or attendees/i)).toBeTruthy();
    });

    it('belooft GEEN vervolgstap die niet bestaat', () => {
        // Er is geen actie in de catalogus die een transcriptionId aanneemt
        // (grep over server/integrations: nul treffers; transcribe_audio
        // verwerkt een geüpload BESTAND). Het scherm noemde er wel een, en de
        // declaratie leunde op diezelfde belofte.
        setup();
        expect(screen.queryByText(/Meeting Notes action/i)).toBeNull();
        expect(screen.getByText(/no step that reads a note by id/i)).toBeTruthy();
    });
});
