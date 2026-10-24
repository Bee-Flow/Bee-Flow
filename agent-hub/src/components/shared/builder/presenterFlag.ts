/**
 * The presenter flag — Shift+P on a builder canvas. One storage key for both
 * builders (automations and App Studio): a presenter who switched it on for the
 * automation film expects the app film to be in the same mode.
 */
import scopedStorage from '../../../utils/scopedStorage';
import { logger } from '../../../utils/logger';

export const PRESENTER_KEY = 'automations.canvas.presenter';

export function readPresenter(): boolean {
    try {
        return scopedStorage.getItem(PRESENTER_KEY) === '1';
    } catch {
        return false;
    }
}

export function writePresenter(on: boolean): void {
    try {
        scopedStorage.setItem(PRESENTER_KEY, on ? '1' : '0');
    } catch (err) { logger.debug('Storage refused — the toggle still holds for this session.', err); }
    notifyPresenter(on);
}

// A page that HOSTS a builder (Studio Playbooks) mirrors the flag the
// builder's own Shift+P toggles, without binding the key a second time.
const PRESENTER_EVENT = 'bf:presenter';

export function subscribePresenter(cb: EventListener): () => void {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener(PRESENTER_EVENT, cb);
    return () => window.removeEventListener(PRESENTER_EVENT, cb);
}

export function notifyPresenter(on: boolean): void {
    if (typeof window === 'undefined') return;
    try { window.dispatchEvent(new CustomEvent(PRESENTER_EVENT, { detail: !!on })); } catch (err) { logger.debug('no CustomEvent — nothing listens', err); }
}
