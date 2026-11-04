import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HandoverCard from './HandoverCard';
import { appName, formShareTabPath, handoverActions, startsFromForm } from './handoverActions';
import { finalizedOf } from '@/hooks/automationBuilder/reducer';
import type { FlowDefinition } from '../flow/types';

afterEach(cleanup);

const formDef: FlowDefinition = { trigger: { id: 't', type: 'trigger', kind: 'form' }, steps: [{ id: 's', type: 'ai_step' }] };
const manualDef: FlowDefinition = { trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [{ id: 's', type: 'ai_step' }] };

describe('handoverActions', () => {
    it('orders what a person does: connect, switch on, share the form, test', () => {
        const actions = handoverActions(formDef, ['connect:gmail', 'activate', 'share-form'], {});
        expect(actions.map((a) => a.kind)).toEqual(['connect', 'activate', 'share-form', 'test']);
        expect(actions[0]).toEqual({ kind: 'connect', app: 'gmail', label: 'Gmail' });
    });

    it('reads the form trigger from the definition when the server sent no needs', () => {
        expect(handoverActions(formDef, null).map((a) => a.kind)).toEqual(['activate', 'share-form', 'test']);
        expect(startsFromForm({ trigger: { kind: 'manual' }, triggers: [{ kind: 'form' }] })).toBe(true);
    });

    it('follows the server on activation: a manual trigger (run-once) is not switched on, only tried', () => {
        expect(handoverActions(manualDef, ['run-once']).map((a) => a.kind)).toEqual(['test']);
    });

    it('marks activation done once it is switched on', () => {
        expect(handoverActions(manualDef, ['activate'], { isActive: true })[0]).toEqual({ kind: 'activate', done: true });
    });

    it('never invents a name for an app without a catalogue entry', () => {
        expect(appName('custom:5f1c')).toBeNull();
        expect(appName('mcp:server-1')).toBeNull();
        expect(appName('microsoft-teams')).toBeTruthy();
        expect(formShareTabPath('a 1')).toBe('/app/studio/forms/a%201/share');
    });
});

describe('finalizedOf (the reducer keeps the whole finalized event)', () => {
    it('keeps needs as strings, and null from a server that sends none', () => {
        expect(finalizedOf({ automationId: 'a1', needs: ['activate', 3, '', 'share-form'] } as never)).toEqual({ automationId: 'a1', needs: ['activate', 'share-form'], autoFinalized: false });
        expect(finalizedOf({ automationId: 'a1', autoFinalized: true } as never)).toEqual({ automationId: 'a1', needs: null, autoFinalized: true });
        expect(finalizedOf({} as never)).toBeNull();
    });
});

describe('HandoverCard', () => {
    it('says it is saved and not switched on, and Activate / Run a test call the shell', async () => {
        const user = userEvent.setup();
        const onActivate = vi.fn();
        const onDryRun = vi.fn();
        render(<HandoverCard finalized={{ automationId: 'a1', needs: ['activate'], autoFinalized: false }} definition={manualDef} onActivate={onActivate} onDryRun={onDryRun} />);
        expect(screen.getByRole('region', { name: 'What to do next' }).textContent).toContain('Ready — saved, not switched on yet. To use it:');
        await user.click(screen.getByRole('button', { name: 'Activate' }));
        expect(onActivate).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole('button', { name: 'Run a test' }));
        expect(onDryRun).toHaveBeenCalledWith(null);
    });

    it('once switched on, says so instead of offering Activate', () => {
        render(<HandoverCard finalized={{ automationId: 'a1', needs: ['activate'], autoFinalized: false }} definition={manualDef} isActive onActivate={vi.fn()} onDryRun={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
        expect(screen.getByText('Switched on')).toBeTruthy();
        expect(screen.getByText('Ready and switched on. To use it:')).toBeTruthy();
    });

    it('waits while the shell is busy', () => {
        render(<HandoverCard finalized={{ automationId: 'a1', needs: null, autoFinalized: false }} definition={manualDef} busy onActivate={vi.fn()} onDryRun={vi.fn()} />);
        expect((screen.getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Run a test' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('copies the form\'s whole address, read when the button is pressed', async () => {
        const user = userEvent.setup();
        const readFormPath = vi.fn(async () => '/f/tok123');
        render(<HandoverCard finalized={{ automationId: 'a1', needs: ['activate', 'share-form'], autoFinalized: false }} definition={formDef} readFormPath={readFormPath} />);
        expect(readFormPath).not.toHaveBeenCalled();
        expect(screen.getByRole('link', { name: 'Who can open it' }).getAttribute('href')).toBe('/app/studio/forms/a1/share');
        await user.click(screen.getByRole('button', { name: 'Copy the form link' }));
        expect(readFormPath).toHaveBeenCalledWith('a1');
        expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/f/tok123`);
        expect(screen.getByRole('button', { name: 'Link copied' })).toBeTruthy();
        expect(screen.getByText('The link opens for others once it is switched on.')).toBeTruthy();
    });

    it('points at the form\'s Share tab when the form has no link yet, and refuses a link elsewhere', async () => {
        const user = userEvent.setup();
        const { unmount } = render(<HandoverCard finalized={{ automationId: 'a1', needs: null, autoFinalized: false }} definition={formDef} readFormPath={async () => null} />);
        await user.click(screen.getByRole('button', { name: 'Copy the form link' }));
        expect(screen.getByText(/The form has no link yet/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Open the form\'s Share tab' }).getAttribute('href')).toBe('/app/studio/forms/a1/share');
        unmount();
        render(<HandoverCard finalized={{ automationId: 'a1', needs: null, autoFinalized: false }} definition={formDef} readFormPath={async () => '//evil.example.test/f/x'} />);
        await user.click(screen.getByRole('button', { name: 'Copy the form link' }));
        expect(screen.getByText(/The form has no link yet/)).toBeTruthy();
    });

    it('sends the person to Settings → Connections for an app it uses that is not connected', () => {
        render(<HandoverCard finalized={{ automationId: 'a1', needs: ['connect:gmail', 'connect:custom:9a'], autoFinalized: false }} definition={manualDef} />);
        expect(screen.getByText('Connect Gmail')).toBeTruthy();
        expect(screen.getByText('Connect the app it uses')).toBeTruthy();
        for (const link of screen.getAllByRole('link', { name: 'Open Connections' })) expect(link.getAttribute('href')).toBe('/app/settings/integrations');
    });

    it('uses no job title and no builder jargon in what it says', () => {
        const { container } = render(<HandoverCard finalized={{ automationId: 'a1', needs: ['connect:gmail', 'activate', 'share-form'], autoFinalized: false }} definition={formDef} />);
        expect(container.textContent).not.toMatch(/consult|adviseur|expert|trigger|finali[sz]e|dry run/i);
    });
});
