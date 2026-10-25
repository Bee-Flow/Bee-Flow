import { beforeEach, describe, expect, it } from 'vitest';
import { MASKED_ACTION_NAME, scrubRumEvent } from './openobserve';

// The SDK names an automatic click after the element's visible text: a
// conversation title, a contact's name. Only a name a developer set on purpose
// (data-dd-action-name, name_source "custom_attribute") may leave the browser.
const click = (name: string, nameSource: string) => ({
    type: 'action',
    action: { target: { name } },
    _o2: { action: { name_source: nameSource } },
});

describe('scrubRumEvent: click names', () => {
    // Inside the app; on the public site without consent every event is dropped.
    beforeEach(() => { window.history.replaceState(null, '', '/chat'); });

    it('masks a name taken from the element text', () => {
        const event = click('Contract renewal with Jansen', 'text_content');
        expect(scrubRumEvent(event)).toBe(true);
        expect(event.action.target.name).toBe(MASKED_ACTION_NAME);
    });

    it('masks a name taken from a standard attribute such as aria-label or title', () => {
        const event = click('Open chat with Priya', 'standard_attribute');
        scrubRumEvent(event);
        expect(event.action.target.name).toBe(MASKED_ACTION_NAME);
    });

    it('keeps a name set with data-dd-action-name', () => {
        const event = click('sidebar.new-chat', 'custom_attribute');
        scrubRumEvent(event);
        expect(event.action.target.name).toBe('sidebar.new-chat');
    });

    it('leaves events that are not clicks alone', () => {
        const event = { type: 'view', view: { url: 'https://example.test/chat' } };
        scrubRumEvent(event);
        expect(event.view.url).toBe('https://example.test/chat');
    });
});
