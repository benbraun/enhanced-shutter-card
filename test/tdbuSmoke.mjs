/**
 * TDBU smoke test: loads the built dist bundle in jsdom, renders the card with
 * TDBU configs, and verifies rendering, geometry, drag behavior, clamping,
 * nearest-rail routing, the optional slider, and the vertical-only guard.
 *
 * Fixture: main cover at position 30 (bottom rail ~70% down the window),
 * top rail entity at position 30 (top rail ~30% down) — a valid TDBU state.
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
const serviceCalls = [];
function cover(id, pos, name) {
  return {
    entity_id: id,
    state: 'open',
    attributes: { current_position: pos, friendly_name: name, supported_features: 15 },
  };
}
function makeHass(mainPos, tdbuPos) {
  return {
    states: {
      'cover.main': cover('cover.main', mainPos, 'Main blind'),
      'cover.top_rail': cover('cover.top_rail', tdbuPos, 'Top rail'),
      'cover.plain': cover('cover.plain', 60, 'Plain blind'),
      'cover.sideways': cover('cover.sideways', 50, 'Sideways blind'),
    },
    localize: (key) => key,
    language: 'en',
    callService: (domain, service, data) => { serviceCalls.push({ domain, service, data }); },
    callWS: async () => [],
    services: {
      cover: {
        set_cover_position: {}, set_cover_tilt_position: {},
        open_cover: {}, close_cover: {}, stop_cover: {},
        open_cover_tilt: {}, close_cover_tilt: {},
      },
    },
  };
}

// ---- load bundle --------------------------------------------------------
await import(new URL('../dist/enhanced-shutter-card.js', import.meta.url).href);

const card = document.createElement('enhanced-shutter-card');
card.setConfig({
  entities: [
    { entity: 'cover.main', tdbu_entity: 'cover.top_rail', show_tdbu_slider: true },
    { entity: 'cover.plain' },
    { entity: 'cover.sideways', tdbu_entity: 'cover.top_rail', closing_direction: 'left' },
  ],
});
document.body.appendChild(card);
card.hass = makeHass(30, 30);

const settle = () => new Promise((r) => setTimeout(r, 150));
await settle();
await card.updateComplete;
await settle();

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failures++;
}

const shutters = card.shadowRoot?.querySelectorAll('enhanced-shutter') ?? [];
check('three enhanced-shutter elements render', shutters.length === 3, `got ${shutters.length}`);
const [tdbuShutter, plainShutter, sidewaysShutter] = shutters;
for (const s of shutters) await s?.updateComplete;

const sr = tdbuShutter?.shadowRoot;
const tdbuPicker = sr?.querySelector('.esc-shutter-selector-picker-tdbu');
const railTop = sr?.querySelector('.esc-shutter-selector-slide-tdbu-rail-top');
const railBottom = sr?.querySelector('.esc-shutter-selector-slide-tdbu-rail-bottom');
const clip = sr?.querySelector('.esc-shutter-selector-slide-tdbu-clip');
const slideInClip = clip?.querySelector('.esc-shutter-selector-slide');

check('TDBU picker renders', !!tdbuPicker);
check('TDBU top rail renders', !!railTop);
check('TDBU bottom rail renders', !!railBottom);
check('TDBU clip container renders with slide inside', !!clip && !!slideInClip);
check('grab handles render on both rails',
  sr?.querySelectorAll('.esc-shutter-selector-slide-tdbu-handle').length === 2);
check('TDBU slider renders (show_tdbu_slider)',
  !!sr?.querySelector('.esc-shutter-tilt-slider-class.tdbu'));

const styleOf = () => sr?.querySelector('[data-shutter="cover.main"]')?.getAttribute('style') ?? '';
const clipTopOf = (style) => parseFloat((style.match(/--esc-tdbu-clip-top:\s*([-\d.]+)px/) ?? [])[1]);
const clipHeightOf = (style) => parseFloat((style.match(/--esc-tdbu-clip-height:\s*([-\d.]+)px/) ?? [])[1]);

const styleAttr = styleOf();
check('clip-top CSS var present', styleAttr.includes('--esc-tdbu-clip-top:'));
check('picker-tdbu transform var present', styleAttr.includes('--esc-transform-picker-tdbu:'));
const clipTop0 = clipTopOf(styleAttr);
const clipHeight0 = clipHeightOf(styleAttr);
check('clip-top is a finite positive px value', Number.isFinite(clipTop0) && clipTop0 > 0, `got ${clipTop0}`);
check('clip-height positive (open gap between rails)', Number.isFinite(clipHeight0) && clipHeight0 > 0, `got ${clipHeight0}`);

const positionText = sr?.querySelector('.esc-shutter-position span')?.textContent ?? '';
check('position text contains Top: 30%', positionText.includes('Top: 30'), `text="${positionText}"`);

// regression: plain shutter unaffected
const srPlain = plainShutter?.shadowRoot;
check('plain shutter has classic slide edge inside slide',
  !!srPlain?.querySelector('.esc-shutter-selector-slide > .esc-shutter-selector-slide-edge'));
check('plain shutter has no TDBU nodes',
  !srPlain?.querySelector('.esc-shutter-selector-slide-tdbu-clip') &&
  !srPlain?.querySelector('.esc-shutter-selector-picker-tdbu'));
check('plain position text has no Top:',
  !(srPlain?.querySelector('.esc-shutter-position span')?.textContent ?? '').includes('Top:'));

// vertical-only guard: closing_direction left + tdbu -> plain rendering + warning
const srSideways = sidewaysShutter?.shadowRoot;
check('sideways shutter renders without TDBU nodes (guard)',
  !srSideways?.querySelector('.esc-shutter-selector-slide-tdbu-clip') &&
  !srSideways?.querySelector('.esc-shutter-selector-picker-tdbu'));
check('vertical-only warning registered', card.messageManager.countMessages() > 0,
  `count=${card.messageManager.countMessages()}`);

// ---- drag helpers -------------------------------------------------------
function fire(target, type, y) {
  const ev = new window.Event(type, { bubbles: true, cancelable: true, composed: true });
  ev.pageX = 10;
  ev.pageY = y;
  target.dispatchEvent(ev);
}
const topPct = (text) => parseFloat((text.match(/Top:\s*([\d.]+)%/) ?? [])[1]);
const posTextNow = () => sr?.querySelector('.esc-shutter-position span')?.textContent ?? '';

// ---- 1. normal top-rail drag: live text + send == shown -----------------
serviceCalls.length = 0;
fire(tdbuPicker, 'mousedown', 80); // near top rail (~75px), routes to top
fire(tdbuShutter, 'mousemove', 130); // +50px down
await tdbuShutter.updateComplete;
const dragPct = topPct(posTextNow());
check('live drag position text updates beyond device 30%', Number.isFinite(dragPct) && dragPct > 30, `text="${posTextNow()}"`);
fire(window, 'mouseup', 130);
let call = serviceCalls.find((c) => c.service === 'set_cover_position' && c.data.entity_id === 'cover.top_rail');
check('drag sends set_cover_position to tdbu entity', !!call, JSON.stringify(serviceCalls));
check('sent position matches displayed drag position', call?.data?.position === dragPct, `sent ${call?.data?.position}, shown ${dragPct}`);

// settle back to device state; positions must differ from the stored state to
// trigger the card's change detection (as a real device movement would)
card.hass = makeHass(31, 30);
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;

// ---- 2. crossing clamp: top rail cannot pass bottom rail ----------------
serviceCalls.length = 0;
fire(tdbuPicker, 'mousedown', 80);
fire(tdbuShutter, 'mousemove', 5000); // absurdly far down
await tdbuShutter.updateComplete;
fire(window, 'mouseup', 5000);
call = serviceCalls.find((c) => c.service === 'set_cover_position' && c.data.entity_id === 'cover.top_rail');
// bottom rail = main position 30 => its TDBU-scale equivalent is ~70%
check('overshoot drag clamps at bottom rail (~70%, never 100%)',
  !!call && call.data.position >= 65 && call.data.position <= 72, `sent ${call?.data?.position}`);
const styleClamped = styleOf();
check('clip-height never negative during overshoot', clipHeightOf(styleClamped) >= 0, `got ${clipHeightOf(styleClamped)}`);

card.hass = makeHass(30, 30); // differs from 31 -> re-render
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;

// ---- 3. main picker cannot cross top rail -------------------------------
serviceCalls.length = 0;
const mainPicker = sr?.querySelector('.esc-shutter-selector-picker');
fire(mainPicker, 'mousedown', 188); // near bottom rail (~188px), routes to bottom
fire(tdbuShutter, 'mousemove', -5000); // absurdly far up
await tdbuShutter.updateComplete;
fire(window, 'mouseup', -5000);
call = serviceCalls.find((c) => c.service === 'set_cover_position' && c.data.entity_id === 'cover.main');
// top rail at 30% from top => bottom rail can rise to 70% open at most
check('main drag clamps at top rail (~70%, never 100%)',
  !!call && call.data.position >= 65 && call.data.position <= 72, `sent ${call?.data?.position} calls=${JSON.stringify(serviceCalls)}`);

card.hass = makeHass(31, 30); // differs -> re-render
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;

// ---- 4. nearest-rail routing: press on TDBU band near bottom rail -------
serviceCalls.length = 0;
fire(tdbuPicker, 'mousedown', 240); // far below both rails; bottom rail (~188px) is nearest
fire(tdbuShutter, 'mousemove', 230);
await tdbuShutter.updateComplete;
fire(window, 'mouseup', 230);
call = serviceCalls.find((c) => c.service === 'set_cover_position');
check('press nearest bottom rail routes drag to main entity',
  !!call && call.data.entity_id === 'cover.main', JSON.stringify(serviceCalls));

card.hass = makeHass(30, 30); // differs -> re-render
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;

// ---- 5. TDBU slider sends to tdbu entity --------------------------------
serviceCalls.length = 0;
const tdbuSlider = sr?.querySelector('.esc-shutter-tilt-slider-class.tdbu');
if (tdbuSlider) {
  tdbuSlider.value = '55';
  fire(tdbuSlider, 'mousedown', 0);
  fire(tdbuShutter, 'mousemove', 0);
  await tdbuShutter.updateComplete;
  fire(window, 'mouseup', 0);
  call = serviceCalls.find((c) => c.service === 'set_cover_position' && c.data.entity_id === 'cover.top_rail');
  check('slider drag sends set_cover_position 55 to tdbu entity',
    !!call && call.data.position === 55, JSON.stringify(serviceCalls));
} else {
  check('slider drag sends set_cover_position 55 to tdbu entity', false, 'slider not found');
}

// ---- 6. hass update re-renders geometry ---------------------------------
card.hass = makeHass(30, 60);
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
const styleAfter = styleOf();
check('hass update (pos 30->60) moves clip-top down',
  clipTopOf(styleAfter) > clipTop0, `was ${clipTop0}, got ${clipTopOf(styleAfter)}`);
check('position text updates to Top: 60%', posTextNow().includes('Top: 60'), `text="${posTextNow()}"`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
