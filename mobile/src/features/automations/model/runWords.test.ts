import { _reset, setCatalogue, translate } from '@/core/i18n';

import { errorClassText, errorClassWords, triggerText, triggerWords } from './runWords';

beforeEach(() => _reset());

describe('triggerText — what started a run, never its token', () => {
    it('says the web’s words for the kinds the web names', () => {
        expect(triggerText('app_event', translate)).toBe('An app event');
        expect(triggerText('manual_step', translate)).toBe('Started by hand');
        expect(triggerText('SCHEDULE', translate)).toBe('On a schedule');
    });

    it('says the phone’s words for the kinds only the phone names', () => {
        expect(triggerText('agent_call', translate)).toBe('Called by an agent');
        expect(triggerText('studio_app', translate)).toBe('From an app');
        // …and keeps them out of the web's table, which the lockstep holds.
        expect(triggerWords('agent_call')).toBeNull();
    });

    it('spaces out a kind nobody has named, and dashes a missing one', () => {
        expect(triggerText('some_new_kind', translate)).toBe('some new kind');
        expect(triggerText(null, translate)).toBe('—');
    });

    it('is translated through its key', () => {
        setCatalogue('nl', { 'mobile.runs.trigger.app_event': 'Een app-gebeurtenis' });
        expect(triggerText('app_event', translate)).toBe('Een app-gebeurtenis');
    });

    it('never answers a question about Object.prototype', () => {
        expect(triggerText('constructor', translate)).toBe('constructor');
        expect(errorClassWords('toString')).toBeNull();
    });
});

describe('errorClassText — why a run failed, in words', () => {
    it('says the class as a sentence', () => {
        expect(errorClassText('rate_limit', translate)).toBe('a connected app asked us to slow down');
        expect(errorClassText('auth', translate)).toBe('a connection is no longer signed in');
        expect(errorClassText('Validation', translate)).toBe('a step received data it could not accept');
    });

    it('says nothing for a class nobody has put into words', () => {
        expect(errorClassText('HttpError', translate)).toBeNull();
        expect(errorClassText(null, translate)).toBeNull();
    });
});
