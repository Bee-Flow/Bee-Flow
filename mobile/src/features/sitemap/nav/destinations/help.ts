/**
 * The Help group: support, the About screen and the documentation. Order here
 * is the order the map lists them in.
 */

import type { Destination } from '../types';

export const HELP: Destination[] = [
    {
        id: 'support',
        label: 'Help and support',
        hint: 'Ask a question and track the answer',
        icon: 'LifeBuoy',
        href: '/support',
        group: 'Help',
        keywords: ['ticket', 'contact', 'question', 'problem', 'bug'],
    },
    {
        id: 'about',
        label: 'About Bee Flow',
        hint: 'Version, licences and what changed',
        icon: 'Info',
        href: '/settings/about',
        group: 'Help',
        keywords: ['version', 'build', 'changelog', 'release notes', 'open source'],
    },
    {
        id: 'docs',
        label: 'Documentation',
        hint: 'Guides and reference, in your browser',
        icon: 'ExternalLink',
        href: 'https://docs.beeflow.ai/',
        group: 'Help',
        external: true,
        keywords: ['docs', 'manual', 'help', 'guide'],
    },
];
