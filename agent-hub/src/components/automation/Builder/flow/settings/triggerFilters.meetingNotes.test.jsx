// The tag filter for meeting-notes.meeting.processed. And above all: does the screen say what an
// EMPTY tag filter means?
//
// The choice (empty = every completed meeting, not none at all) is defensible, but it is only
// good if it IS STATED. An empty field that silently means "everything" is the mistake this
// project has already written down twice as HIGH, so the sentence under the input field is
// pinned here, not just the stored value.
//
// Run from agent-hub:
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
    // Not getByLabelText: FieldHint sets the same name on its ⓘ button.
    const tagBox = () => screen.getByRole('textbox');
    const type = (text) => fireEvent.change(tagBox(), { target: { value: text } });
    const rerender = () => view.rerender(<MeetingNotesProcessedFilterFields filter={{ ...filter }} setFilter={setFilter} />);
    return { filter, setFilter, tagBox, type, rerender };
}

describe('het meeting-notes tagfilter', () => {
    it('is geregistreerd op de (provider, event) die AppEventFields opzoekt', () => {
        // Without this key the builder renders no filter form, and the whole decision below is
        // invisible to the author.
        expect(FILTER_FORM_BY_KEY['meeting-notes.meeting.processed']).toBe(MeetingNotesProcessedFilterFields);
    });

    it('ZEGT dat geen tags "elke afgeronde meeting" betekent', () => {
        setup();
        expect(screen.getByText(/runs after EVERY finished meeting note/i)).toBeTruthy();
        // And it also says what you can do about it, otherwise it is a notice without a way out.
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
        // undefined, not []: the key disappears from the stored filter, exactly as every other filter
        // field in this file does.
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
        // The matcher does that (as the meeting_tag knowledge source does). Whoever does not know it
        // types "Sales" and waits in vain for a run. That sentence therefore does not belong in the ⓘ
        // popover, which only appears in the DOM after a click.
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
        // Leaving it out is something other than false: the key is cleared.
        expect(setFilter).toHaveBeenCalledWith('reprocessed', undefined);
        expect('reprocessed' in filter).toBe(false);
    });

    it('vertelt dat de payload geen inhoud van de notitie draagt', () => {
        setup();
        expect(screen.getByText(/no summary, title or attendees/i)).toBeTruthy();
    });

    it('belooft GEEN vervolgstap die niet bestaat', () => {
        // No action in the catalogue accepts a transcriptionId (grep over server/integrations: zero
        // hits; transcribe_audio processes an uploaded FILE). The screen did name one, and the
        // declaration leaned on that same promise.
        setup();
        expect(screen.queryByText(/Meeting Notes action/i)).toBeNull();
        expect(screen.getByText(/no step that reads a note by id/i)).toBeTruthy();
    });
});
