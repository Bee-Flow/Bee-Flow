import { VIEW_EVENT } from './experiment';

/**
 * Experiment events for the self-hosted Umami tracker.
 *
 * No consent logic here, on purpose: `window.umami` only exists once the
 * tracker script loaded, and that script is already gated on consent mode and
 * the preview bail (components/AnalyticsTracker.tsx). Without it every call is
 * a no-op. The payload is the experiment name and the variant letter and
 * nothing else: no visitor id, no URL, no text.
 */

type UmamiTrack = (name: string, data?: Record<string, string>) => void;
type UmamiWindow = Window & { umami?: { track?: UmamiTrack } };

const RETRY_MS = 500;
const RETRIES = 10;

/** Sends once the tracker has loaded (it is a deferred script, usually after React mounts). */
export function trackWhenReady(name: string, data: Record<string, string>, tries = RETRIES): void {
    if (typeof window === 'undefined') return;
    const fn = (window as UmamiWindow).umami?.track;
    if (typeof fn === 'function') {
        try {
            fn(name, data);
        } catch {
            return; // analytics must never break the page
        }
        return;
    }
    if (tries > 0) setTimeout(() => trackWhenReady(name, data, tries - 1), RETRY_MS);
}

const sent = new Set<string>();

/** Once per experiment and page view. */
function trackOnce(name: string, data: { experiment: string; variant: string }): void {
    const id = `${name}:${data.experiment}`;
    if (sent.has(id)) return;
    sent.add(id);
    trackWhenReady(name, data);
}

export const trackView = (experiment: string, variant: string) => trackOnce(VIEW_EVENT, { experiment, variant });

// A link, or a submit button / form: not the plain buttons of tabs, tours and accordions.
const CTA = 'a[href], button[type="submit"], input[type="submit"]';

function onClick(e: Event) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target?.closest(CTA)) return;
    reportGoal(target);
}

function onSubmit(e: Event) {
    if (e.target instanceof Element) reportGoal(e.target);
}

function reportGoal(from: Element) {
    const holder = from.closest<HTMLElement>('[data-cms-experiment]');
    const experiment = holder?.dataset.cmsExperiment;
    const variant = holder?.dataset.cmsVariant;
    const goal = holder?.dataset.cmsGoal;
    if (!experiment || !variant || !goal) return;
    trackOnce(goal, { experiment, variant });
}

let listeners = 0;

/** A click on a link or submit button, or a form submit, inside an experiment block is its goal. Returns the cleanup. */
export function startGoalTracking(): () => void {
    if (typeof document === 'undefined') return () => {};
    if (listeners++ === 0) {
        document.addEventListener('click', onClick, true);
        document.addEventListener('submit', onSubmit, true);
    }
    return () => {
        if (--listeners === 0) {
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('submit', onSubmit, true);
        }
    };
}

/** Tests only. */
export const resetSent = () => sent.clear();
