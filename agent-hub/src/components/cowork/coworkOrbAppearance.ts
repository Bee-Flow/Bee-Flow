import { createContext } from 'react';

export const orbDefaults = {
    version: 0, themeColors: true, tempo: .65, breath: .036, transparency: .14,
    lightSurface: false, coreColor: '#0c112a', rimColor: '#384682', mistColor: '#ad90d4',
    starColor: '#abb4e6', deepColor: '#909ac8', nerveColor: '#a3c9f4', pulseColor: '#cdeaff',
};
export type OrbLook = typeof orbDefaults;
export const OrbAppearanceContext = createContext(orbDefaults);
