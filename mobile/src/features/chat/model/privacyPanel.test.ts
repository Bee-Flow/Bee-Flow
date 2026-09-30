/** The privacy sheet's words: the action, the tally, per attachment, and the reply with its placeholders. */

import { aiReturnedText, anyIncomplete, categoryList, countsLine, incompleteReasonOf, privacyActionOf, privacyBadgeOf } from './privacyPanel';

it('says what the shield did, and "nothing found" as a result of its own', () => {
    expect(privacyActionOf({ categories: [] }).i18nKey).toBe('privacy.scanned_no_findings');
    expect(privacyActionOf({ categories: [], count: 2, source: 'dlp' }).i18nKey).toBe('privacy.action_tokenised_dlp');
    expect(privacyActionOf({ categories: [], count: 2, action: 'restore' }).i18nKey).toBe('privacy.action_restored');
    expect(privacyBadgeOf({ categories: [], count: 1 })).toMatchObject({ i18nKey: 'privacy.badge_redacted', en: '1 item redacted' });
    expect(privacyBadgeOf({ categories: [], count: 3, action: 'protected' })).toMatchObject({ i18nKey: 'privacy.badge_protected_plural' });
});

it('tallies categories and per-file counts as the web writes them', () => {
    expect(categoryList(['Email', 'Person', 'Email'])).toBe('Email ×2, Person');
    expect(countsLine({ Email: 2, Phone: 1 })).toBe('2 emails, 1 phone');
    expect(incompleteReasonOf({ timeout: true })).toBe('timeout');
    expect(incompleteReasonOf({ reason: 'guard_down' })).toBe('degraded');
    expect(incompleteReasonOf({})).toBeNull();
    expect(anyIncomplete({ categories: [], attachments: [{ truncated: true }] })).toBe(true);
});

it("puts the placeholders back into the shown reply, longest value first", () => {
    const info = { categories: [], tokenMap: { '[person_1]': 'Jan de Vries', '[person_2]': 'Jan' } };
    expect(aiReturnedText(info, 'Jan de Vries met Jan')).toBe('[person_1] met [person_2]');
    expect(aiReturnedText({ ...info, rawResponse: 'raw' }, 'x')).toBe('raw');
});
