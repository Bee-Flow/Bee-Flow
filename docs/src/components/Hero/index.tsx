import React from 'react';
import {motion} from 'framer-motion';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

const fadeUp = {
  hidden: {opacity: 0, y: 20},
  show: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: {duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: 0.05 * i},
  }),
};

export default function Hero(): JSX.Element {
  return (
    <section className={styles.hero}>
      <div className={styles.bgOrb} aria-hidden="true" />
      <div className={styles.bgGrid} aria-hidden="true" />

      <div className={styles.inner}>
        <motion.div
          className={styles.eyebrow}
          initial="hidden"
          animate="show"
          custom={0}
          variants={fadeUp}
        >
          <span className={styles.dot} />
          AI-native workspace for Nextcloud
        </motion.div>

        <motion.h1
          className={styles.title}
          initial="hidden"
          animate="show"
          custom={1}
          variants={fadeUp}
        >
          Your private AI <span className={styles.gradient}>workspace</span>,
          <br />
          built into Nextcloud.
        </motion.h1>

        <motion.p
          className={styles.subtitle}
          initial="hidden"
          animate="show"
          custom={2}
          variants={fadeUp}
        >
          Chat with your Files, Mail, Calendar, Deck, Notes, Tasks, Contacts and Talk —
          without your data ever leaving your tenant boundary.
        </motion.p>

        <motion.div
          className={styles.ctas}
          initial="hidden"
          animate="show"
          custom={3}
          variants={fadeUp}
        >
          <Link to="/getting-started/nextcloud" className="button button--primary button--lg">
            Install on Nextcloud →
          </Link>
          <Link to="/self-hosting/docker-compose" className="button button--secondary button--lg">
            Self-host the server
          </Link>
        </motion.div>

        <motion.div
          className={styles.signals}
          initial="hidden"
          animate="show"
          custom={4}
          variants={fadeUp}
        >
          <span><strong>Fair-code</strong> + AGPL-3.0</span>
          <span className={styles.sep} />
          <span><strong>~30</strong> integrations</span>
          <span className={styles.sep} />
          <span>Anthropic · OpenAI · Mistral · Ollama</span>
          <span className={styles.sep} />
          <span>EU data residency</span>
        </motion.div>
      </div>
    </section>
  );
}
