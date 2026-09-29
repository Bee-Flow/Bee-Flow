import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import remarkScreenshots from './src/remark/screenshots.mjs';

const config: Config = {
  title: 'Bee Flow',
  tagline: 'AI-native workspace for Nextcloud',
  favicon: 'img/logo.svg',

  url: 'https://docs.beeflow.ai',
  baseUrl: '/',

  organizationName: 'Bee-Flow',
  projectName: 'docs',
  trailingSlash: false,

  onBrokenLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  themes: ['@docusaurus/theme-mermaid'],

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/Bee-Flow/docs/edit/main/',
          showLastUpdateTime: true,
          beforeDefaultRemarkPlugins: [remarkScreenshots],
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          changefreq: 'weekly',
          priority: 0.5,
          ignorePatterns: ['/tags/**'],
          filename: 'sitemap.xml',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.png',
    colorMode: {
      defaultMode: 'light',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: false,
      },
    },
    navbar: {
      title: 'Bee Flow',
      logo: {
        alt: 'Bee Flow logo',
        src: 'img/logo.svg',
      },
      hideOnScroll: false,
      items: [
        {
          to: '/getting-started/',
          label: 'Getting started',
          position: 'left',
        },
        {
          to: '/connector/',
          label: 'Connector',
          position: 'left',
        },
        {
          to: '/self-hosting/',
          label: 'Self-host',
          position: 'left',
        },
        {
          to: '/features/',
          label: 'Features',
          position: 'left',
        },
        {
          to: '/integrations/',
          label: 'Integrations',
          position: 'left',
        },
        {
          to: '/studio/',
          label: 'Studio',
          position: 'left',
        },
        {
          to: '/api/',
          label: 'API',
          position: 'left',
        },
        {
          href: 'https://beeflow.nl/app',
          label: 'Open app',
          position: 'right',
          className: 'navbar-cta',
        },
        {
          href: 'https://github.com/Bee-Flow',
          'aria-label': 'GitHub',
          position: 'right',
          className: 'header-github-link',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Product',
          items: [
            {label: 'Getting started', to: '/getting-started/'},
            {label: 'Features', to: '/features/'},
            {label: 'Integrations', to: '/integrations/'},
            {label: 'Studio', to: '/studio/'},
          ],
        },
        {
          title: 'Deploy',
          items: [
            {label: 'On Nextcloud', to: '/getting-started/nextcloud'},
            {label: 'Self-host', to: '/self-hosting/'},
            {label: 'API reference', to: '/api/'},
          ],
        },
        {
          title: 'Company',
          items: [
            {label: 'GitHub', href: 'https://github.com/Bee-Flow'},
            {label: 'Bee Flow Cloud', href: 'https://beeflow.nl/app'},
            {label: 'Licensing', to: '/licensing/'},
            {label: 'Edit this site', to: '/contributing/editing'},
            {label: 'CMS admin', href: '/cms/'},
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Bee Flow B.V. — fair-code & AGPL-3.0.`,
    },
    prism: {
      theme: prismThemes.oneLight,
      darkTheme: prismThemes.oneDark,
      additionalLanguages: ['bash', 'json', 'yaml', 'docker', 'nginx', 'php'],
    },
    metadata: [
      {name: 'theme-color', content: '#f5b300'},
      {name: 'og:type', content: 'website'},
    ],
  } satisfies Preset.ThemeConfig,
};

export default config;
