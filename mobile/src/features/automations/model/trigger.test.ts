/** What starts a routine: one sentence and one glyph per trigger kind. */

import { describeTrigger, triggerIcon } from './trigger';

describe('describeTrigger', () => {
    it('reads a missing trigger as manual', () => {
        expect(describeTrigger(null)).toBe('Runs when you start it');
    });

    it('describes a schedule through its cron', () => {
        expect(describeTrigger({ kind: 'schedule', schedule: { cron: '0 9 * * 1-5', tz: 'UTC' } })).toBe(
            'Every weekday at 09:00 (UTC)',
        );
    });

    it('names the app event, and says when it is filtered', () => {
        expect(
            describeTrigger({ kind: 'app_event', appEvent: { provider: 'gmail', event: 'new_email', filter: { from: 'x' } } }),
        ).toBe('Runs on gmail “new_email”, filtered');
        expect(describeTrigger({ kind: 'app_event' })).toBe('Runs on an app “an event”');
    });

    it('has a sentence for the fixed kinds, and never reads the prototype', () => {
        expect(describeTrigger({ kind: 'webhook' })).toBe('Runs when its webhook URL is called');
        expect(describeTrigger({ kind: 'constructor' })).toBe('Runs on constructor');
    });
});

describe('triggerIcon', () => {
    it('gives each kind its glyph and anything else the play mark', () => {
        expect(triggerIcon('schedule')).toBe('Clock');
        expect(triggerIcon('app_event')).toBe('Inbox');
        expect(triggerIcon(undefined)).toBe('Play');
    });
});
