/**
 * App Studio runtime: the "backdrop" knob group (server/appStudio/componentSpecs/styleKnobGroups/backdrop.js).
 *
 * The handler only marks the cell (a positioned stacking context) when a picture is set; the
 * picture itself is drawn by BackgroundImageLayer (../assets), which knows the page's asset
 * transport. backgroundFit and backgroundOverlay without a picture draw nothing.
 */

import './backdrop.css';
import { isAssetRef } from '../assets/assetUrl';
import type { StyleKnobHandler } from '../styleKnobHandlers';

const backdrop: StyleKnobHandler = {
    title: ['studio_apps_backdrop.title', 'Background image'],
    labels: {
        backgroundImage: ['studio_apps_backdrop.knobs.image', 'Image'],
        backgroundFit: ['studio_apps_backdrop.knobs.fit', 'Fit'],
        backgroundOverlay: ['studio_apps_backdrop.knobs.overlay', 'Veil'],
    },
    valueLabels: {
        backgroundFit: {
            cover: ['studio_apps_backdrop.values.cover', 'Cover'],
            contain: ['studio_apps_backdrop.values.contain', 'Contain'],
            tile: ['studio_apps_backdrop.values.tile', 'Tile'],
        },
        backgroundOverlay: {
            none: ['studio_apps_backdrop.values.none', 'None'],
            dim: ['studio_apps_backdrop.values.dim', 'Dim'],
            light: ['studio_apps_backdrop.values.light', 'Light'],
        },
    },
    node: (s) => (isAssetRef(s.backgroundImage) ? 'app-has-backdrop' : ''),
};

export default backdrop;
