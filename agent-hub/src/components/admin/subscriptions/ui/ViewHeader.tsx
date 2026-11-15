import { useContext } from 'react';
import type { ComponentProps } from 'react';
import SectionHeader from '@/components/shared/SectionHeader';
import { SubscriptionsTitledContext } from './titledContext';

/** A view's header: its title only where no frame above draws the heading; description and actions always. */
export default function ViewHeader({ title, ...rest }: ComponentProps<typeof SectionHeader>) {
    const titled = useContext(SubscriptionsTitledContext);
    return <SectionHeader {...rest} title={titled ? title : undefined} />;
}
