# Catbots — Identity 02

Fresh visual direction, 11 September 2026. The approved Cat-C direction is now applied to the renderer and application icon. Previous orange concepts remain archived in the parent folder.

## The Cat-C

A curled cat forms the letter C. Two ears, two narrow eyes, and one sweeping tail create a compact silhouette. The symbol connects directly to the name and can be recognized without a wordmark. The slight tilt adds a curious, observant personality.

Use the same silhouette for the product avatar, app icon, social covers, and recurring visual motifs. Keep the counter of the C open and the eye cutouts clear. Test small-size and circular crops before publication.

## Identity

- Visual wordmark: **catbots**, lowercase, bold, rounded grotesk. In prose retain **Catbots**.
- Personality: curious, observant, clear, technically capable.
- Primary brand line: **See the logic.**
- Expressive campaign line: **See what your bot thinks.** This is a metaphor for inspecting strategy rules, not a claim to expose private AI reasoning.
- Supporting line: **One idea. Every rule visible.**
- Social cover: **Curious by design.**
- Product descriptor: **A local-first workbench for trading strategies you can inspect.**

## Palette

| Color | Hex | Use |
| --- | --- | --- |
| Cobalt | #2448FF | Signature backgrounds, symbol, and focal elements |
| Butter | #F4F0C8 | Warm light background and reversed symbol |
| Ink | #151515 | Main text and monochrome symbol |
| Paper | #FAFAF5 | Content surfaces and technical explanations |

Keep production artwork flat. Use solid fills and ample empty space. The raster concepts are visual references, not color-proof masters. For final vector artwork use the exact HEX values above, with no shading or texture.

## Typography and graphics

The wordmark uses broad circular counters and thick strokes that echo the Cat-C. A final custom wordmark would need vector construction. Use a restrained sans-serif for body copy and monospace only for technical labels. Keep one short headline per social asset.

The symbol may be repeated and cropped as a pattern in large covers, but keep a full recognizable symbol near the brand name. On diagrams, show actual strategy logic. The sample demo card is illustrative and does not document a released UI or performance result.

## Application

- Product X avatar: butter symbol on cobalt, with generous clear space for circular cropping.
- Personal founder avatar: keep the founder's portrait; use the Cat-C identity on the cover and demo cards.
- X cover: cobalt field, butter headline, cropped Cat-C pattern at the side. Keep key content away from the avatar overlap and preview on both desktop and mobile.
- Product demos: paper background, dark text, actual screenshot, small Cat-C signature, and one cobalt emphasis.
- Fee and risk explanations: literal language, visible numbers, and readable contrast. Avoid playful wording in approval or warning screens.

## Files

- `brand-board.png` — identity presentation and application concepts.
- `avatar.png` — standalone raster avatar concept.
- `curious-flow.png` — generated illustration used in onboarding and the empty Bots screen.
- `prompts.txt` — exact prompts used with built-in image generation.

These are raster design deliverables. No vector master or custom font file is included. Previous concepts remain preserved in the parent folder.

## UI implementation

- Shared palette and Kumo/React Flow aliases: `apps/desktop/src/renderer/design-system/tokens.css`.
- Brand layout: `apps/desktop/src/renderer/design-system/brand.css`.
- Shared `BrandLogo`, `BrandWordmark`, and `BrandIllustration` components; decorative artwork is hidden from assistive technology.
- Optimized renderer assets in `apps/desktop/assets/brand/`: Cat-C WebP (256px), curious-flow WebP (1008 × 672), favicon PNG (64px). Combined payload approximately 30 KB.
- Native `icon-source.png`, `icon.png`, and `icon.icns` now use the approved avatar. The existing system-template tray glyph remains unchanged.
- Light surfaces use butter/paper with cobalt emphasis; dark surfaces use navy with light text. The illustration retains its cream canvas in both modes. Node categories and trading status retain their semantic colors.
- Wordmark uses local rounded system fonts; no external font request or new runtime dependency.

Validation: workspace typecheck, design-system checks, renderer production build, 62 focused tests across Bots, Settings, Chat, theme, and release assets, and the simulated web workflow through Backtest/Paper/Live review. Visually inspected onboarding, empty Bots, and workbench in light/dark appearance; checked 390px layouts for horizontal overflow. Native packaging was not run for this visual change.
