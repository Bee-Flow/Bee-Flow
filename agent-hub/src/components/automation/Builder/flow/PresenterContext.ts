import { createContext } from 'react';

/**
 * Is the canvas in presenter mode (flow/presenterMode.js)?
 *
 * A context rather than a prop or the runtime context: every step card
 * derives its level of detail from it (flow/useZoomLod.js), and the flag
 * flips once per toggle, never per pan frame — so a context that re-renders
 * its consumers on change is exactly the right cost. Provided by DiagramPane
 * around the whole canvas; `false` everywhere else (thumbnails, inspectors).
 *
 * Its own file so useZoomLod.js and presenterMode.js can both import it
 * without importing each other.
 */
export const PresenterContext = createContext(false);
