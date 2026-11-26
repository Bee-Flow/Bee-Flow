import {fileURLToPath} from 'node:url';
import tailwind from '@tailwindcss/postcss';
const src=fileURLToPath(new URL('../src/',import.meta.url));
export default {css:{postcss:{plugins:[tailwind({base:src})]}},esbuild:{jsx:'automatic'},resolve:{alias:{'@':src,'@shared':src+'shared'}},build:{outDir:'../dist/orb-demo'},base:'./'};
