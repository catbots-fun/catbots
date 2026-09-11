/** Decorative artwork stays separate from real strategy graphs and status icons. */
const illustrationUrl = new URL('../../../assets/brand/curious-flow.webp', import.meta.url).href;

export function BrandIllustration() {
  return <img className="brand-illustration" src={illustrationUrl} width={768} height={512} alt="" aria-hidden="true" draggable={false} decoding="async" />;
}
