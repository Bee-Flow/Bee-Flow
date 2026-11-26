import { createContext } from 'react';

export const GuidedPanelContext = createContext(false);

export const PanelFocusContext = createContext<string | undefined>(undefined);
