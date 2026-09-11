/** Cat-C artwork shared with the packaged app icon, sized for renderer use. */
const logoUrl = new URL('../../../assets/brand/cat-c.webp', import.meta.url).href;

type BrandLogoProps = { size?: 'small' | 'large'; decorative?: boolean };

export function BrandLogo({ size = 'small', decorative = false }: BrandLogoProps) {
  return <img className={`brand-logo brand-logo-${size}`} src={logoUrl} alt={decorative ? '' : 'Catbots'} draggable={false} />;
}

export function BrandWordmark() {
  return <span className="brand-wordmark" aria-label="Catbots"><BrandLogo decorative /><span aria-hidden="true">catbots</span></span>;
}
