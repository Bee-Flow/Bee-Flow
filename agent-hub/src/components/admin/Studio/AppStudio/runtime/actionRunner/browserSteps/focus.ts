import { findNodeElement, focusableIn, scrollToElement } from '../domTarget';
import type { BrowserStepModule } from '../browserSteps';

/**
 * focus (server/appStudio/componentSpecs/steps/focus.js): the first field,
 * button or link inside the component takes the focus; a component with
 * nothing focusable is scrolled into view. Not on the page: nothing happens.
 */
const entry: BrowserStepModule = {
    kind: 'focus',
    run: (_env, step) => {
        if (typeof step.nodeId !== 'string' || !step.nodeId) return;
        const el = findNodeElement(step.nodeId);
        if (!el) return;
        const target = focusableIn(el);
        if (target) target.focus();
        else scrollToElement(el);
    },
};

export default entry;
