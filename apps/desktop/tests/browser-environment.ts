import { vi } from 'vitest';
// JSDOM does not implement layout/media APIs used by Kumo and ECharts.
if (typeof window !== 'undefined') {
  window.matchMedia ??= (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true });
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.getAnimations ??= () => [];
  HTMLElement.prototype.scrollIntoView ??= function () {};

}

// Keep canvas rendering out of JSDOM; unit tests exercise the accessible data table.
vi.mock('@cloudflare/kumo/components/chart', () => ({
  TimeseriesChart: () => null,
  ChartPalette: { categorical: () => 'currentColor' },
}));
