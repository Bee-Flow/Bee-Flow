import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithClient } from '@/test/render';
import TeamsHowItWorksCard from './TeamsHowItWorksCard';

describe('TeamsHowItWorksCard', () => {
    it('says that Teams records and Bee Flow, not Microsoft, turns speech into text', () => {
        renderWithClient(<TeamsHowItWorksCard />);
        expect(screen.getByRole('heading', { name: 'How a meeting becomes a note, and who turns speech into text' })).toBeTruthy();
        const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
        expect(steps).toHaveLength(3);
        expect(steps[0]).toMatch(/^Teams records the meeting\. Someone presses record in Teams, or Bee Flow sets the meeting to record automatically/);
        expect(steps[0]).toMatch(/No bot joins the call\./);
        expect(steps[1]).toMatch(/^Bee Flow turns speech into text\./);
        expect(steps[1]).toMatch(/transcribes it with the transcription service chosen for Bee Flow \(Admin, Platform services, Transcription\)/);
        expect(steps[1]).toMatch(/Microsoft does not do the transcription, and Teams transcription does not have to be on\./);
        expect(steps[2]).toMatch(/^Bee Flow writes the note\. The summary and the action items come from your own AI models\. Microsoft Copilot is not used\./);
    });

    it('names the one case in which Microsoft\'s text is used, and what that needs', () => {
        renderWithClient(<TeamsHowItWorksCard />);
        const fallback = screen.getByTestId('teams-how-fallback');
        expect(within(fallback).getByText('Only when there is no recording.')).toBeTruthy();
        expect(fallback.textContent).toMatch(/transcribed in Teams but not recorded, Bee Flow uses the text Microsoft made/);
        expect(fallback.textContent).toMatch(/Transcript API access and speaker names/);
        expect(fallback.textContent).toMatch(/the note then has no audio/);
    });
});
