import { findNodeElement, scrollToElement } from '../domTarget';
import type { BrowserStepModule } from '../browserSteps';

/**
 * scroll_to (server/appStudio/componentSpecs/steps/scroll_to.js): a component's
 * top edge to the top of the view, or with "top" the top of the app's screen
 * (the renderer's root, so the scroll area around it moves as well).
 */
const entry: BrowserStepModule = {
    kind: 'scroll_to',
    run: (_env, step) => {
        if (typeof step.nodeId !== 'string' || !step.nodeId) return;
        const el = step.nodeId === 'top' ? document.querySelector('.app-runtime') : findNodeElement(step.nodeId);
        if (el) scrollToElement(el);
    },
};

export default entry;
