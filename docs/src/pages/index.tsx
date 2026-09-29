import React from 'react';
import Layout from '@theme/Layout';
import Hero from '@site/src/components/Hero';
import FeatureGrid from '@site/src/components/FeatureGrid';
import Pieces from '@site/src/components/Pieces';
import WhoFor from '@site/src/components/WhoFor';
import IntegrationsStrip from '@site/src/components/IntegrationsStrip';
import CallToAction from '@site/src/components/CallToAction';

export default function Home(): JSX.Element {
  return (
    <Layout
      title="Bee Flow — AI workspace for Nextcloud"
      description="AI-native workspace for Nextcloud. Chat with your Files, Mail, Calendar, Deck, Notes, Tasks, Contacts and Talk — without your data leaving your tenant boundary."
    >
      <main className="bf-home">
        <Hero />
        <IntegrationsStrip />
        <FeatureGrid />
        <Pieces />
        <WhoFor />
        <CallToAction />
      </main>
    </Layout>
  );
}
