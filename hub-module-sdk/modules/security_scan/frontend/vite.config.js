import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { moduleViteConfig } from '../../../vite/moduleConfig.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Library build for the Security Scan Studio module frontend: the SDK's shared
 * module config (hub-module-sdk/vite/moduleConfig.js) with the React plugin.
 *
 * Output: `frontend/index.js` (ESM) + `frontend/index.css`. The whole react
 * family is externalised (the host provides the one React instance); everything
 * else (lucide-react icons, Tailwind CSS) is bundled. Tailwind runs through
 * PostCSS (postcss.config.js) and emits ONLY the utilities these files use — no
 * preflight, so the injected stylesheet never resets the surrounding host page.
 */
export default defineConfig(moduleViteConfig({ here, plugins: [react()] }));
