/**
 * The outer frame of a sealed React block (App Studio's react_block): a sandboxed srcdoc
 * document that holds the frame the component runs in, and whose own policy has
 * `frame-src 'none'`. A frame's navigation is held to the policy of the document that embeds
 * it, so the component's frame can no longer navigate itself (location.href, a meta refresh, a
 * link) to an outside address carrying data, whatever page the app is shown in (the Nextcloud
 * connector serves the SPA with a policy of its own).
 *
 * The outer document runs one script: this relay. It passes on exactly three kinds of message
 * and rebuilds each from its allowed fields, checking where every message came from:
 *   from its parent (the app page)   { type: 'bf-react-props', props }   -> the inner frame
 *   from the inner frame             { type: 'bf-react-resize', height } -> the app page
 *                                    { type: 'bf-react-event', event, value }
 * Everything else, from anyone, is dropped.
 *
 * `installRelay` is written into the outer document as its own source text
 * (`(${installRelay})(window, …)`), so it may use nothing from outside its body.
 */

interface RelayWindow {
    parent: { postMessage: (message: unknown, target: string) => void };
    addEventListener: (type: 'message', listener: (e: { source: unknown; data: unknown }) => void) => void;
}

interface RelayFrame {
    contentWindow: { postMessage: (message: unknown, target: string) => void } | null;
}

type Message = { type?: unknown; props?: unknown; height?: unknown; event?: unknown; value?: unknown };

export function installRelay(win: RelayWindow, frame: RelayFrame): void {
    const MAX_HEIGHT = 20000;
    const MAX_EVENT_NAME = 40;
    /** What the inner frame may say to the app page, rebuilt from its allowed fields; null for anything else. */
    const outgoing = (data: Message): Message | null => {
        if (data.type === 'bf-react-resize') {
            const height = Number(data.height);
            return Number.isFinite(height) && height >= 0 ? { type: 'bf-react-resize', height: Math.min(Math.ceil(height), MAX_HEIGHT) } : null;
        }
        const named = typeof data.event === 'string' && data.event !== '' && data.event.length <= MAX_EVENT_NAME;
        return data.type === 'bf-react-event' && named ? { type: 'bf-react-event', event: data.event, value: data.value } : null;
    };
    win.addEventListener('message', (e) => {
        const data = e.data as Message | null;
        if (!data || typeof data !== 'object') return;
        const inner = frame.contentWindow;
        if (e.source === win.parent) {
            // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- the inner sandboxed srcdoc frame has an opaque origin; it gets the props the app page handed this frame
            if (data.type === 'bf-react-props' && inner) inner.postMessage({ type: 'bf-react-props', props: data.props }, '*');
            return;
        }
        if (!inner || e.source !== inner) return;
        const out = outgoing(data);
        // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- this frame is opaque to its parent, so '*' is the only target; the app page checks an event against the block's wired events and caps its size
        if (out) win.parent.postMessage(out, '*');
    });
}
