/**
 * Motion-transition smoke test: verifies that the shutter graphic gets a CSS
 * transition while the cover is opening/closing (so position updates glide),
 * and that the transition is disabled at rest and while the user is dragging
 * (direct manipulation must track the pointer without lag).
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
  try {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
  } catch { /* leave read-only globals as-is */ }
}

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = globalThis.ResizeObserver = ResizeObserverStub;

window.HTMLCanvasElement.prototype.getContext = function () {
  return {
    font: '',
    measureText: (text) => ({
      width: 8 * String(text).length,
      fontBoundingBoxAscent: 10,
      fontBoundingBoxDescent: 4,
    }),
  };
};

const RECT = { width: 153, height: 250, top: 0, left: 0, right: 153, bottom: 250, x: 0, y: 0 };
window.Element.prototype.getBoundingClientRect = function () {
  return { ...RECT, toJSON() { return this; } };
};

// ---- hass stub ----------------------------------------------------------
function makeHass(state, pos) {
  return {
    states: {
      'cover.main': {
        entity_id: 'cover.main',
        state,
        attributes: { current_position: pos, friendly_name: 'Main blind', supported_features: 15 },
      },
    },
    services: { cover: { open_cover: {}, close_cover: {}, set_cover_position: {}, stop_cover: {} } },
    callService: () => {},
    localize: () => '',
    language: 'en',
  };
}

await import(new URL('../dist/enhanced-shutter-card.js', import.meta.url).href);

const card = document.createElement('enhanced-shutter-card');
card.setConfig({ entities: [{ entity: 'cover.main' }] });
document.body.appendChild(card);
card.hass = makeHass('open', 30);

const settle = () => new Promise((r) => setTimeout(r, 150));
await settle();
await card.updateComplete;
await settle();

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failures++;
}

const shutter = card.shadowRoot?.querySelector('enhanced-shutter');
await shutter?.updateComplete;
const sr = shutter?.shadowRoot;
const styleOf = () => sr?.querySelector('[data-shutter="cover.main"]')?.getAttribute('style') ?? '';

// 1. At rest: no motion transition
check('at rest, transform transition var is none',
  /--esc-motion-transition-transform:\s*none/.test(styleOf()), `style="${styleOf().slice(0, 200)}"`);

// 2. While opening: transitions active
card.hass = makeHass('opening', 40);
await card.updateComplete; await settle(); await shutter?.updateComplete;
check('while opening, transform transition var is set',
  /--esc-motion-transition-transform:\s*transform 0\.3s linear/.test(styleOf()), `style="${styleOf().slice(0, 300)}"`);
check('while opening, geometry transition var is set',
  /--esc-motion-transition-geometry:\s*top 0\.3s linear, height 0\.3s linear/.test(styleOf()));

// 3. While the user drags, transitions must be off even if state is opening/closing
function fire(target, type, y) {
  const ev = new window.Event(type, { bubbles: true, cancelable: true, composed: true });
  ev.pageX = 10;
  ev.pageY = y;
  target.dispatchEvent(ev);
}
const picker = sr?.querySelector('.esc-shutter-selector-picker');
check('picker renders', !!picker);
fire(picker, 'mousedown', 100);
fire(shutter, 'mousemove', 130);
await shutter?.updateComplete;
check('during drag, transform transition var is none',
  /--esc-motion-transition-transform:\s*none/.test(styleOf()), `style="${styleOf().slice(0, 300)}"`);
fire(window, 'mouseup', 130);

// 4. The stylesheet actually consumes the vars
const cssText = [...(sr?.querySelectorAll('style') ?? [])].map((s) => s.textContent).join('\n');
check('CSS consumes transform transition var', cssText.includes('var(--esc-motion-transition-transform'));
check('CSS consumes geometry transition var', cssText.includes('var(--esc-motion-transition-geometry'));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
