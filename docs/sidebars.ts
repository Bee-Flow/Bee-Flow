import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  main: [
    {
      type: 'category',
      label: 'Getting started',
      link: {type: 'doc', id: 'getting-started/index'},
      items: [
        {
          type: 'category',
          label: 'Install',
          items: [
            'getting-started/nextcloud',
            'getting-started/wizard',
            'getting-started/local-development',
            'getting-started/desktop',
            'getting-started/android',
          ],
        },
        'getting-started/tiers',
      ],
    },
    {
      type: 'category',
      label: 'Nextcloud connector',
      link: {type: 'doc', id: 'connector/index'},
      items: [
        {
          type: 'category',
          label: 'About',
          items: [
            'connector/architecture',
            'connector/permissions',
            'connector/privacy',
          ],
        },
        {
          type: 'category',
          label: 'Operations',
          items: [
            'connector/setup-picker',
            'connector/troubleshooting',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Self-hosting',
      link: {type: 'doc', id: 'self-hosting/index'},
      items: [
        {
          type: 'category',
          label: 'Deploy',
          items: [
            'self-hosting/docker-compose',
            'self-hosting/docker-hub',
            'self-hosting/kubernetes',
          ],
        },
        {
          type: 'category',
          label: 'Operations',
          items: [
            'self-hosting/env',
            'self-hosting/upgrades',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Features',
      link: {type: 'doc', id: 'features/index'},
      items: [
        {
          type: 'category',
          label: 'Workspace',
          items: [
            'features/chat',
            'features/knowledge',
            'features/automations',
            'features/voice',
            'features/meeting-notes-voiceprints',
          ],
        },
        {
          type: 'category',
          label: 'Privacy & safety',
          items: [
            'features/privacy-shield',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Studio',
      link: {type: 'doc', id: 'studio/index'},
      items: [
        {
          type: 'category',
          label: 'Agents',
          items: [
            'studio/agent-designer',
            'studio/agent-wizard',
            'studio/templates',
          ],
        },
        {
          type: 'category',
          label: 'Building blocks',
          items: [
            'studio/apps',
            'studio/approvals',
            'studio/apps-mcp',
            'studio/automations-mcp',
            'studio/components',
            'studio/datatables',
            'studio/forms',
            'studio/knowledge-bases',
            'studio/skills',
            'studio/webpages',
            'studio/documents',
          ],
        },
        {
          type: 'category',
          label: 'Ship & operate',
          items: [
            'studio/solutions',
            'studio/runs',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Integrations',
      link: {type: 'doc', id: 'integrations/index'},
      items: [
        {
          type: 'category',
          label: 'Nextcloud',
          items: [
            'integrations/nextcloud',
            'integrations/nextcloud-mail',
            'integrations/nextcloud-calendar',
            'integrations/nextcloud-contacts',
            'integrations/nextcloud-deck',
            'integrations/nextcloud-talk',
            'integrations/nextcloud-notes',
            'integrations/nextcloud-tasks',
            'integrations/nextcloud-tables',
            'integrations/spreadsheet-datatables',
            'integrations/nextcloud-activity',
            'integrations/nextcloud-notifications',
            'integrations/nextcloud-status',
          ],
        },
        {
          type: 'category',
          label: 'Productivity suites',
          items: [
            'integrations/google',
            'integrations/microsoft',
          ],
        },
        {
          type: 'category',
          label: 'DevOps & collaboration',
          items: [
            'integrations/github',
            'integrations/youtrack',
            'integrations/signrequest',
            'integrations/fireflies',
            'integrations/gamma',
          ],
        },
        {
          type: 'category',
          label: 'Business systems',
          items: [
            'integrations/vplan',
          ],
        },
        {
          type: 'category',
          label: 'Social & messaging',
          items: [
            'integrations/linkedin',
          ],
        },
        {
          type: 'category',
          label: 'Search & maps',
          items: [
            'integrations/web-search',
            'integrations/maps',
          ],
        },
        'integrations/mcp-library',
        'integrations/ai-modules',
      ],
    },
    {
      type: 'category',
      label: 'Admin',
      link: {type: 'doc', id: 'admin/index'},
      items: [
        {
          type: 'category',
          label: 'People',
          items: [
            'admin/users-and-groups',
            'admin/nc-integrations',
          ],
        },
        {
          type: 'category',
          label: 'Settings',
          items: [
            'admin/organisation-settings',
            'admin/local-models',
            'admin/scaleway-models',
            'admin/limits-and-self-host',
            'admin/beta-features',
          ],
        },
        {
          type: 'category',
          label: 'Compliance',
          items: [
            'admin/audit-and-compliance',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Licensing',
      link: {type: 'doc', id: 'licensing/index'},
      items: [
        'licensing/tiers',
        'licensing/apply',
        'licensing/faq',
      ],
    },
    {
      type: 'category',
      label: 'API',
      link: {type: 'doc', id: 'api/index'},
      items: [
        'api/auth',
        'api/rest',
        'api/sse',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/architecture',
        'reference/telemetry',
        'reference/user-research',
        'reference/glossary',
      ],
    },
    {
      type: 'category',
      label: 'Contributing',
      items: [
        'contributing/editing',
      ],
    },
  ],
};

export default sidebars;
