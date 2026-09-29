/**
 * The quick-ask field.
 *
 * One input, two keys. Everything else — which conversation it lands in, which
 * agent answers — is the workspace's business, and this window's only job is to
 * get the sentence out of the user's head before they lose it.
 */

import { byId } from './bridge.ts';

const input = byId<HTMLInputElement>('ask');
const quickAsk = window.beeflowQuickAsk;

const prefill = new URLSearchParams(window.location.search).get('text');
if (prefill) input.value = prefill;

quickAsk?.onPrefill((text) => {
    input.value = text;
    input.select();
});

input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.value.trim()) {
        quickAsk?.submit(input.value.trim());
        input.value = '';
        return;
    }
    if (event.key === 'Escape') {
        // The main process hides the window when it loses focus; blurring is
        // enough, and means this page never needs a window-closing capability.
        input.value = '';
        window.blur();
    }
});

// Re-focus whenever the window is shown again: it is summoned by a shortcut,
// and a summoned window the user has to click into has failed at its one job.
window.addEventListener('focus', () => {
    input.focus();
    input.select();
});
input.focus();
