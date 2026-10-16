import Button from '../components/Button';
import EditableText from '../components/EditableText';
import GithubStarButton from '../components/GithubStarButton';
import { inlineTextStyle } from './textStyle';
import type { HeaderCta } from './Header.types';

/** The header's action buttons: link buttons, and the GitHub button with the cached star count. */
export default function HeaderCtas({ ctas }: { ctas?: HeaderCta[] }) {
    return (
        <>
            {(ctas || []).map((cta, i) => {
                // Per-button label styling. The Button component
                // owns the variant background / border / radius;
                // typography overrides ride on an inner span so
                // they don't fight the variant's color rules.
                const labelStyle = inlineTextStyle({
                    fontFamily: cta.labelFont,
                    fontSize:   cta.labelSize,
                    color:      cta.labelColor,
                });
                if (cta.kind === 'github') {
                    return (
                        <GithubStarButton
                            key={cta.id || i}
                            repoUrl={cta.repoUrl}
                            label={cta.label}
                            starsFallback={cta.starsFallback}
                            starsText={cta.starsText}
                            newTabText={cta.newTabText}
                        />
                    );
                }
                return (
                <Button
                    key={cta.id || i}
                    variant={cta.style || 'primary'}
                    href={cta.href || '/app'}
                    target={cta.target}
                    rel={cta.rel}
                >
                    <span style={labelStyle}>
                        <EditableText path={`header.ctas.${i}.label`} placeholder="Button">
                            {cta.label || ''}
                        </EditableText>
                    </span>
                </Button>
                );
            })}
        </>
    );
}
