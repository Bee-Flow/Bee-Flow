import React from 'react';
import styles from './styles.module.css';

const integrations = [
  'Nextcloud',
  'Files',
  'Mail',
  'Calendar',
  'Talk',
  'Deck',
  'Notes',
  'Tasks',
  'Contacts',
  'Google Workspace',
  'Microsoft 365',
  'GitHub',
  'n8n',
  'YouTrack',
  'SignRequest',
  'Fireflies',
  'Gamma',
  'LinkedIn',
];

export default function IntegrationsStrip(): JSX.Element {
  return (
    <section className={styles.strip} aria-label="Supported integrations">
      <div className={styles.label}>Works with the apps you already use</div>
      <div className={styles.track}>
        <div className={styles.row}>
          {integrations.concat(integrations).map((name, i) => (
            <span className={styles.chip} key={`${name}-${i}`}>{name}</span>
          ))}
        </div>
      </div>
    </section>
  );
}
