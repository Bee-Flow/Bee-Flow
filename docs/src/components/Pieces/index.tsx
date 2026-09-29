import React from 'react';
import {motion} from 'framer-motion';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

const pieces = [
  {
    repo: 'Bee-Flow/beeflow',
    name: 'Server',
    desc: 'Node.js + Express backend. Chat, agents, knowledge bases, integrations, automations, license gate. Self-host for free at the Community tier.',
    href: '/self-hosting/',
    chip: 'Self-hosted',
  },
  {
    repo: 'Bee-Flow/hive',
    name: 'Frontend',
    desc: 'React + Vite SPA. The UI for everything: chat, agents, admin panels. Embedded inside the Nextcloud connector as a static bundle.',
    href: '/studio/',
    chip: 'React + Vite',
  },
  {
    repo: 'Bee-Flow/connector',
    name: 'Connector',
    desc: 'The Nextcloud ExApp that bridges your Nextcloud to Bee Flow. Signed proxy, HMAC-authenticated, AGPL-3.0.',
    href: '/connector/',
    chip: 'AGPL-3.0',
  },
];

export default function Pieces(): JSX.Element {
  return (
    <section className={styles.section}>
      <div className={styles.heading}>
        <div className={styles.kicker}>How it fits together</div>
        <h2 className={styles.title}>Three pieces, one product.</h2>
        <p className={styles.lede}>Mix-and-match — run all three, or just the server with your own frontend.</p>
      </div>

      <div className={styles.grid}>
        {pieces.map((p, i) => (
          <motion.div
            key={p.name}
            className={styles.card}
            initial={{opacity: 0, y: 18}}
            whileInView={{opacity: 1, y: 0}}
            viewport={{once: true, margin: '-80px'}}
            transition={{duration: 0.55, delay: 0.07 * i, ease: [0.22, 1, 0.36, 1]}}
          >
            <div className={styles.head}>
              <code className={styles.repo}>{p.repo}</code>
              <span className={styles.chip}>{p.chip}</span>
            </div>
            <h3 className={styles.name}>{p.name}</h3>
            <p className={styles.desc}>{p.desc}</p>
            <Link to={p.href} className={styles.link}>Read the docs →</Link>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
