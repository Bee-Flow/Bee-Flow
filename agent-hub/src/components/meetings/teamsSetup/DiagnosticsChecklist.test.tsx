import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import DiagnosticsChecklist from './DiagnosticsChecklist';
import type { TeamsCheck } from './types';

const check = (patch: Partial<TeamsCheck> & Pick<TeamsCheck, 'id' | 'status' | 'code'>): TeamsCheck => ({
    option: 'A', params: {}, remediation: null, fixer: null, dependsOn: [], ...patch,
});

const CHECKS: TeamsCheck[] = [
    check({ id: 'a.connection', status: 'pass', code: 'ok', params: { source: 'connection' } }),
    check({ id: 'a.scope_recordings', status: 'fail', code: 'scope_missing', params: { permission: 'OnlineMeetingRecording.Read.All' }, remediation: 'teams_setup.fix.admin_consent_needed', fixer: 'entra_admin' }),
    check({ id: 'a.scope_transcripts', status: 'warn', code: 'scope_missing', params: { permission: 'OnlineMeetingTranscript.Read.All' }, remediation: 'teams_setup.fix.admin_consent_needed', fixer: 'entra_admin' }),
    check({ id: 'a.meeting_lookup', status: 'unknown', code: 'no_meeting_to_probe', remediation: 'teams_setup.fix.schedule_test_meeting', fixer: 'user' }),
    check({ id: 'a.recordings', status: 'skipped', code: 'prerequisite_failed', params: { prerequisite: 'a.scope_recordings' } }),
    check({ id: 'a.transcript_content', status: 'skipped', code: 'prerequisite_failed', params: { prerequisite: 'a.transcripts' } }),
];

const row = (id: string) => document.querySelector(`[data-check-id="${id}"]`) as HTMLElement;

describe('DiagnosticsChecklist', () => {
    it('renders each status with its title, sentence and label', () => {
        render(<DiagnosticsChecklist checks={CHECKS} overall="fail" />);
        expect(within(row('a.connection')).getByText('Your Microsoft 365 account is connected')).toBeTruthy();
        expect(within(row('a.connection')).getByText('Passed')).toBeTruthy();
        expect(within(row('a.connection')).getByText('Works.')).toBeTruthy();
        expect(within(row('a.scope_recordings')).getByText('Failed')).toBeTruthy();
        expect(within(row('a.scope_transcripts')).getByText('Needs attention')).toBeTruthy();
        expect(within(row('a.meeting_lookup')).getByText('Could not be tested')).toBeTruthy();
        expect(within(row('a.meeting_lookup')).getByText('There is no Teams meeting to test with.')).toBeTruthy();
        expect(screen.getByRole('status').textContent).toBe('Teams meeting notes cannot work yet. Fix the failed checks from the top down.');
    });

    it('fills placeholders from the params', () => {
        render(<DiagnosticsChecklist checks={CHECKS} />);
        expect(within(row('a.scope_recordings')).getByText('Microsoft did not grant OnlineMeetingRecording.Read.All.')).toBeTruthy();
        expect(within(row('a.scope_transcripts')).getByText('Microsoft did not grant OnlineMeetingTranscript.Read.All.')).toBeTruthy();
    });

    it('shows what to do and who fixes it only when the check has them', () => {
        render(<DiagnosticsChecklist checks={CHECKS} />);
        const failing = row('a.scope_recordings');
        expect(within(failing).getByText(/opens the admin consent link/)).toBeTruthy();
        expect(within(failing).getByText('A Microsoft Entra administrator must fix this')).toBeTruthy();
        expect(within(row('a.meeting_lookup')).getByText('You can fix this yourself')).toBeTruthy();
        const passing = row('a.connection');
        expect(within(passing).queryByText(/Who can fix this/)).toBeNull();
        expect(passing.querySelectorAll('p')).toHaveLength(2);
    });

    it('folds the skipped checks away under one line', async () => {
        const user = userEvent.setup();
        render(<DiagnosticsChecklist checks={CHECKS} />);
        const details = screen.getByText('Skipped (2)').closest('details') as HTMLDetailsElement;
        expect(details.open).toBe(false);
        await user.click(screen.getByText('Skipped (2)'));
        expect(details.open).toBe(true);
        expect(within(details).getByText('Recordings of that meeting can be listed')).toBeTruthy();
        // Each skipped row names the check it waits for, so the fold still points at the blocker.
        expect(within(row('a.recordings')).getByText('Not tested until this check passes: Permission to read meeting recordings.')).toBeTruthy();
        expect(within(row('a.transcript_content')).getByText('Not tested until this check passes: Transcripts of that meeting can be listed.')).toBeTruthy();
    });

    it('a list without skipped checks has no fold, and without a verdict no summary line', () => {
        render(<DiagnosticsChecklist checks={CHECKS.slice(0, 1)} />);
        expect(screen.queryByText(/Skipped \(/)).toBeNull();
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('an unknown check id and code still render, as the raw id and the generic sentence', () => {
        render(<DiagnosticsChecklist checks={[check({ id: 'z.future', status: 'fail', code: 'brand_new_code' })]} />);
        expect(screen.getByText('z.future')).toBeTruthy();
        expect(screen.getByText('Microsoft Graph could not be reached.')).toBeTruthy();
    });

    it('says when the report ran', () => {
        render(<DiagnosticsChecklist checks={CHECKS} overall="warn" ranAt="2026-11-10T09:30:00.000Z" />);
        expect(screen.getByText(`Tested ${new Date('2026-11-10T09:30:00.000Z').toLocaleString()}`)).toBeTruthy();
        expect(screen.getByRole('status').textContent).toBe('Teams meeting notes work, but some parts need attention.');
    });
});
