import { describe, expect, it } from 'vitest';
import { widgetChatUrl, widgetSnippet, type WidgetOptions } from './embedSnippet';

const base: WidgetOptions = {
    agentId: 'a1', origin: 'https://bee.example', bubbleColor: '#123456', bubblePosition: 'right', bubbleSize: 60,
    bubbleIcon: '🐝', windowWidth: 400, windowHeight: 600, chatFont: 'System Default', chatFontSize: 14,
    chatLineHeight: 1.5, userBubbleColor: '', assistantBubbleColor: '', warningText: '',
};

describe('embedSnippet', () => {
    it('leaves the defaults out of the chat URL and adds what differs', () => {
        expect(widgetChatUrl(base)).toBe('https://bee.example/chat/a1');
        expect(widgetChatUrl({ ...base, chatFont: 'Open Sans', chatFontSize: 16, warningText: 'Let op' }))
            .toBe('https://bee.example/chat/a1?font=Open%20Sans&fontSize=16&warning=Let%20op');
    });

    it('the preview ends in an escaped closing tag, the copied code in a real one, and nothing else differs', () => {
        const preview = widgetSnippet(base, true);
        const copied = widgetSnippet(base);
        expect(preview.endsWith('<\\/script>')).toBe(true);
        expect(copied.endsWith('\n</script>')).toBe(true);
        expect(preview.slice(0, -'<\\/script>'.length)).toBe(copied.slice(0, -'</script>'.length));
        expect(copied).toContain('right:24px;width:60px;height:60px');
        expect(copied).toContain('<iframe src="https://bee.example/chat/a1">');
    });

    it('puts the bubble on the left when asked', () => {
        expect(widgetSnippet({ ...base, bubblePosition: 'left' })).toContain('left:24px;width:60px');
    });
});
