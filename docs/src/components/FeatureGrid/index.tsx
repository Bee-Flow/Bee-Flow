import React from 'react';
import {motion} from 'framer-motion';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

type Feature = {
  title: string;
  body: string;
  href: string;
  icon: JSX.Element;
};

const Icon = {
  Chat: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.6" stroke="currentColor">
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 4Z" strokeLinejoin="round" />
      <path d="M8 11h8M8 15h5" strokeLinecap="round" />
    </svg>
  ),
  Plug: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.6" stroke="currentColor">
      <path d="M9 4v5M15 4v5" strokeLinecap="round" />
      <rect x="6" y="9" width="12" height="6" rx="2" />
      <path d="M12 15v3a3 3 0 0 1-3 3H8" strokeLinecap="round" />
    </svg>
  ),
  Tools: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.6" stroke="currentColor">
      <path d="M14.7 6.3a4 4 0 0 1 5 5l-3 1-3-3 1-3Z" strokeLinejoin="round" />
      <path d="m13.7 9.3-9 9a2.1 2.1 0 1 0 3 3l9-9" strokeLinejoin="round" />
    </svg>
  ),
  Shield: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.6" stroke="currentColor">
      <path d="M12 3 4 6v6c0 4.5 3.4 8.5 8 9 4.6-.5 8-4.5 8-9V6l-8-3Z" strokeLinejoin="round" />
      <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Cog: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.6" stroke="currentColor">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1A2 2 0 1 1 19.7 7l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" strokeLinejoin="round" />
    </svg>
  ),
  Code: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.6" stroke="currentColor">
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

const features: Feature[] = [
  {
    title: 'Chat with your apps',
    body: 'Talk to your Files, Mail, Calendar, Deck, Notes, Tasks and Talk in one place — Bee Flow does the work in the apps you already use.',
    href: '/features/chat',
    icon: Icon.Chat,
  },
  {
    title: '~30 integrations',
    body: 'Nextcloud, Google Workspace, Microsoft 365, GitHub, n8n, YouTrack, SignRequest, Fireflies, Gamma, LinkedIn, Maps and more.',
    href: '/integrations/',
    icon: Icon.Plug,
  },
  {
    title: 'Build agents & automations',
    body: 'Agent Designer, wizard, knowledge bases, skills, scheduled and event-driven flows — without leaving the workspace.',
    href: '/studio/',
    icon: Icon.Tools,
  },
  {
    title: 'Privacy by default',
    body: 'Privacy Shield, DLP, audit logs, GDPR archive, SAML SSO. Your data never leaves your tenant boundary.',
    href: '/connector/privacy',
    icon: Icon.Shield,
  },
  {
    title: 'Admin operations',
    body: 'User sync, group-based integration access, license & usage, beta feature toggles, organisation settings.',
    href: '/admin/',
    icon: Icon.Cog,
  },
  {
    title: 'Open source & open API',
    body: 'Fair-code server + frontend, AGPL-3.0 connector. REST + SSE API to embed Bee Flow into your own product.',
    href: '/api/',
    icon: Icon.Code,
  },
];

export default function FeatureGrid(): JSX.Element {
  return (
    <section className={styles.section}>
      <div className={styles.heading}>
        <div className={styles.kicker}>What you get</div>
        <h2 className={styles.title}>Everything you need to bring AI into your team — safely.</h2>
      </div>

      <div className={styles.grid}>
        {features.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{opacity: 0, y: 16}}
            whileInView={{opacity: 1, y: 0}}
            viewport={{once: true, margin: '-60px'}}
            transition={{duration: 0.5, delay: 0.05 * i, ease: [0.22, 1, 0.36, 1]}}
          >
            <Link to={f.href} className={styles.card}>
              <div className={styles.iconWrap} aria-hidden="true">{f.icon}</div>
              <h3 className={styles.cardTitle}>{f.title}</h3>
              <p className={styles.cardBody}>{f.body}</p>
              <span className={styles.cardLink}>Learn more →</span>
            </Link>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
