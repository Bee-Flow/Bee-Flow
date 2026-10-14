import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { moduleViteConfig } from '../../vite/moduleConfig.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Library build for a Bee Flow module frontend: the SDK's shared module config
 * (hub-module-sdk/vite/moduleConfig.js) with the React plugin. When you copy
 * template/ elsewhere (e.g. to modules/<id>/), point the import above at it.
 *
 * Output: `frontend/index.js` (ESM) + `frontend/index.css`; pack.mjs zips both
 * alongside the built server. react / react-dom / their entrypoints AND
 * jsx-runtime are externalised: the host serves exactly one React, and a module
 * bundling its own would break hooks. Everything else (icons too) is bundled.
 */
export default defineConfig(moduleViteConfig({ here, plugins: [react()] }));
