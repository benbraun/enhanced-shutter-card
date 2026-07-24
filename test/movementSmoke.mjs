/**
 * Movement-overlay smoke test: the direction arrow shown while the cover is
 * opening/closing must paint ABOVE the shutter graphic, not be clipped by it.
 *
 * Regression guard for the bug where the overlay lived at z-index -1 (below the
 * slats, and below the TDBU clip/rails at z-index 0/1 and the window frame
 * image), so the arrow was occluded/clipped by the blind. The overlay must be
 * above those layers and pointer-events:none so it never blocks the picker.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
for (const key of [
  'window', 'document', 'customElements', 'HTMLElement', 'Element', 'Node',
  'CSSStyleSheet', 'ShadowRoot', 'navigator', 'CustomEvent', 'Event',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
  'MouseEvent', 'location', 'Document', 'DocumentFragment', 'HTMLCanvasElement',
  'HTMLIFrameElement', 'MutationObserver', 'HTMLTemplateElement', 'NodeFilter',
]) {
  try { Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true }); } catch { /* read-only */ }
}
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = globalThis.ResizeObserver = ResizeObserverStub;
window.HTMLCanvasElement.prototype.getContext = function () {
  return { font: '', measureText: (t) => ({ width: 8 * String(t).length, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 4 }) };
};
const RECT = { width: 153, height: 250, top: 0, left: 0, right: 153, bottom: 250, x: 0, y: 0 };
window.Element.prototype.getBoundingClientRect = function () { return { ...RECT, toJSON() { return this; } }; };

function makeHass(state, pos) {
  return {
    states: { 'cover.main': { entity_id: 'cover.main', state, attributes: { current_position: pos, friendly_name: 'Main blind', supported_features: 15 } } },
    services: { cover: { open_cover: {}, close_cover: {}, set_cover_position: {}, stop_cover: {} } },
    callService: () => {}, localize: () => '', language: 'en',
  };
}

const C = await import(new URL('../src/code/constants.js', import.meta.url).href);
await import(new URL('../dist/enhanced-shutter-card.js', import.meta.url).href);

const card = document.createElement('enhanced-shutter-card');
card.setConfig({ entities: [{ entity: 'cover.main' }] });
document.body.appendChild(card);
card.hass = makeHass('closing', 40);

const settle = () => new Promise((r) => setTimeout(r, 150));
await settle(); await card.updateComplete; await settle();

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failures++;
}

// 1. Constant invariant: overlay above the slats, the TDBU clip/rails (0/1)
//    and the window frame image, so the arrow is never occluded by the blind.
check('overlay z-index is above the slide', C.Z_INDEX_OVERLAY > C.Z_INDEX_SLIDE,
  `overlay=${C.Z_INDEX_OVERLAY} slide=${C.Z_INDEX_SLIDE}`);
check('overlay z-index is above the TDBU rails (1) and window frame image',
  C.Z_INDEX_OVERLAY > 1, `overlay=${C.Z_INDEX_OVERLAY}`);
check('overlay z-index is at/above the highest window layer (partial)',
  C.Z_INDEX_OVERLAY >= C.Z_INDEX_PARTIAL, `overlay=${C.Z_INDEX_OVERLAY} partial=${C.Z_INDEX_PARTIAL}`);

// 2. The rendered stylesheet applies that z-index and makes the overlay
//    non-interactive so it doesn't block the picker/grab handle during motion.
const shutter = card.shadowRoot?.querySelector('enhanced-shutter');
await shutter?.updateComplete;
const sr = shutter?.shadowRoot;
const cssText = [...(sr?.querySelectorAll('style') ?? [])].map((s) => s.textContent).join('\n');
const overlayRule = (cssText.match(/\.esc-shutter-movement-overlay\s*\{[^}]*\}/) || [''])[0];
check('movement-overlay rule is present', overlayRule.length > 0);
check('movement-overlay is pointer-events:none', /pointer-events:\s*none/.test(overlayRule), overlayRule);
check('movement-overlay z-index is the raised value', overlayRule.includes(`z-index: ${C.Z_INDEX_OVERLAY}`), overlayRule);

// 3. The arrow overlay actually renders while the cover is moving.
const overlayEl = sr?.querySelector('.esc-shutter-movement-overlay');
check('movement overlay element renders', !!overlayEl);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
