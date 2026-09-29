import React from 'react';
import {motion} from 'framer-motion';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

export default function CallToAction(): JSX.Element {
  return (
    <section className={styles.section}>
      <motion.div
        className={styles.panel}
        initial={{opacity: 0, y: 18}}
        whileInView={{opacity: 1, y: 0}}
        viewport={{once: true, margin: '-80px'}}
        transition={{duration: 0.6, ease: [0.22, 1, 0.36, 1]}}
      >
        <div className={styles.glow} aria-hidden="true" />
        <div className={styles.inner}>
          <h2 className={styles.title}>
            Ready to give your team
            <br />
            <span className={styles.gradient}>an AI workspace</span> that respects your data?
          </h2>
          <p className={styles.subtitle}>
            Free Community tier. No vendor lock-in. Open source server &amp; frontend.
          </p>
          <div className={styles.ctas}>
            <Link to="/getting-started/" className="button button--primary button--lg">
              Get started →
            </Link>
            <Link to="/licensing/tiers" className="button button--secondary button--lg">
              Compare tiers
            </Link>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
