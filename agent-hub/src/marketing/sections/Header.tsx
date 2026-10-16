import SiteChromeGuard from '../components/SiteChromeGuard';
import HeaderView from './HeaderView';
import type { HeaderProps } from './Header.types';

/** The public header; a setting that makes it throw hides the header, not the page. */
export default function Header(props: HeaderProps) {
    return (
        <SiteChromeGuard label="header" resetKey={props.data}>
            <HeaderView {...props} />
        </SiteChromeGuard>
    );
}
