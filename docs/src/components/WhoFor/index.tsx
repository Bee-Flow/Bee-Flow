import React from 'react';
import {motion} from 'framer-motion';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

const personas = [
  {role: 'Nextcloud admin', goal: 'Bring AI to the team', cta: 'Install on Nextcloud', href: '/getting-started/nextcloud'},
  {role: 'DevOps / SRE', goal: 'Self-host on Docker / k8s', cta: 'Self-hosting →', href: '/self-hosting/docker-compose'},
  {role: 'End-user', goal: 'Use Bee Flow in Nextcloud', cta: 'First-run wizard', href: '/getting-started/wizard'},
  {role: 'Org admin', goal: 'Configure access & policy', cta: 'Users & groups', href: '/admin/users-and-groups'},
  {role: 'Builder', goal: 'Create agents & automations', cta: 'Studio overview', href: '/studio/'},
  {role: 'DPO / Compliance', goal: 'Review the data flow', cta: 'Privacy & data flow', href: '/connector/privacy'},
];

export default function WhoFor(): JSX.Element {
  return (
    <section className={styles.section}>
      <div className={styles.heading}>
        <div className={styles.kicker}>Find your path</div>
        <h2 className={styles.title}>Who is this for?</h2>
      </div>

      <div className={styles.grid}>
        {personas.map((p, i) => (
          <motion.div
            key={p.role}
            initial={{opacity: 0, y: 14}}
            whileInView={{opacity: 1, y: 0}}
            viewport={{once: true, margin: '-60px'}}
            transition={{duration: 0.45, delay: 0.04 * i, ease: [0.22, 1, 0.36, 1]}}
          >
            <Link to={p.href} className={styles.card}>
              <div className={styles.role}>You are a {p.role}</div>
              <div className={styles.goal}>{p.goal}</div>
              <div className={styles.cta}>{p.cta} →</div>
            </Link>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
