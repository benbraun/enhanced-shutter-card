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
function cover(id, pos, name, state = 'open') {
  return {
    entity_id: id,
    state,
    attributes: { current_position: pos, friendly_name: name, supported_features: 15 },
  };
}
function makeHass(mainPos, tdbuPos, tdbuState = 'open', mainState = 'open') {
  return {
    states: {
      'cover.main': cover('cover.main', mainPos, 'Main blind', mainState),
      'cover.top_rail': cover('cover.top_rail', tdbuPos, 'Top rail', tdbuState),
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
    { entity: 'cover.main', tdbu_entity: 'cover.top_rail', show_tdbu_slider: true, show_open_close_slider: true },
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
  sr?.querySelectorAll('.esc-shutter-selector-slide-handle').length === 2);
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
check('plain shutter hosts its grab handle in the picker (above the frame), not the fabric edge',
  srPlain?.querySelectorAll('.esc-shutter-selector-picker .esc-shutter-selector-slide-handle').length === 1 &&
  srPlain?.querySelectorAll('.esc-shutter-selector-slide-edge .esc-shutter-selector-slide-handle').length === 0);
check('TDBU main picker has no duplicate handle (rails carry them)',
  sr?.querySelectorAll('.esc-shutter-selector-picker .esc-shutter-selector-slide-handle').length === 0);
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
function fire(target, type, y, options = {}) {
  type = ({ mousedown: 'pointerdown', mousemove: 'pointermove', mouseup: 'pointerup' })[type] ?? type;
  const ev = new window.Event(type, { bubbles: true, cancelable: true, composed: true });
  ev.pointerId = 1;
  ev.button = 0;
  ev.isPrimary = true;
  ev.pageX = 10;
  ev.pageY = y;
  Object.assign(ev, options);
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
const railTopPx = parseFloat(styleClamped.match(/--esc-tdbu-rail-top:\s*([-\d.]+)px/)?.[1]);
const railBottomPx = parseFloat(styleClamped.match(/--esc-tdbu-rail-bottom-top:\s*([-\d.]+)px/)?.[1]);
check('visible top rail never crosses below the bottom rail at collision', railTopPx <= railBottomPx);


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

// ---- 5b. fully open (rails overlap at top): direction decides the rail ---
// main=100 (bottom rail raised to top), tdbu=0 (top rail at top) -> bands overlap.
card.hass = makeHass(100, 0);
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;

// drag DOWN near the top: must grab the BOTTOM rail (main) to close it
serviceCalls.length = 0;
fire(tdbuPicker, 'mousedown', 5);
fire(tdbuShutter, 'mousemove', 60); // decisive downward move
fire(tdbuShutter, 'mousemove', 120);
await tdbuShutter.updateComplete;
fire(window, 'mouseup', 120);
call = serviceCalls.find((c) => c.service === 'set_cover_position');
check('fully-open + drag down grabs the bottom rail (main), not the top rail',
  !!call && call.data.entity_id === 'cover.main', JSON.stringify(serviceCalls));
check('fully-open downward drag closes the bottom rail (position < 100)',
  !!call && call.data.position < 100, `pos ${call?.data?.position}`);

// drag UP near the top: must grab the TOP rail (tdbu)
card.hass = makeHass(100, 0);
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
serviceCalls.length = 0;
fire(tdbuPicker, 'mousedown', 120);
fire(tdbuShutter, 'mousemove', 60); // decisive upward move
await tdbuShutter.updateComplete;
fire(window, 'mouseup', 60);
call = serviceCalls.find((c) => c.service === 'set_cover_position');
check('fully-open + drag up grabs the top rail (tdbu)',
  !!call && call.data.entity_id === 'cover.top_rail', JSON.stringify(serviceCalls));

// ---- 5c. top-rail buttons (default on) -----------------------------------
card.hass = makeHass(30, 30);
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
const railBtn = (label) => sr?.querySelector(`ha-icon-button[label="${label}"]`);
check('TDBU top-rail up/down buttons render',
  !!railBtn('Top rail up') && !!railBtn('Top rail down'));
check('TDBU top-rail STOP hidden while the rail is idle',
  !railBtn('Top rail stop'));
const mainStopBtn = () => sr?.querySelector('ha-icon-button[label="ui.card.cover.stop_cover"]');
check('main STOP hidden while the cover is idle (movement-only default)', !mainStopBtn());
check('plain shutter has no top-rail buttons',
  !srPlain?.querySelector('ha-icon-button[label="Top rail up"]'));

serviceCalls.length = 0;
railBtn('Top rail up')?.dispatchEvent(new window.Event('click', { bubbles: true }));
call = serviceCalls.at(-1);
check('Top rail up sends set_cover_position 0 to tdbu entity',
  !!call && call.service === 'set_cover_position' && call.data.entity_id === 'cover.top_rail' && call.data.position === 0,
  JSON.stringify(call));

serviceCalls.length = 0;
railBtn('Top rail down')?.dispatchEvent(new window.Event('click', { bubbles: true }));
call = serviceCalls.at(-1);
check('Top rail down sends set_cover_position to tdbu entity, capped at bottom rail (<=70)',
  !!call && call.service === 'set_cover_position' && call.data.entity_id === 'cover.top_rail' &&
  call.data.position > 0 && call.data.position <= 70, JSON.stringify(call));

// moving -> both STOP buttons appear
card.hass = makeHass(30, 30, 'opening', 'closing');
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
check('TDBU top-rail STOP appears while the rail is moving', !!railBtn('Top rail stop'));
check('main STOP appears while the cover is moving', !!mainStopBtn());
serviceCalls.length = 0;
railBtn('Top rail stop')?.dispatchEvent(new window.Event('click', { bubbles: true }));
call = serviceCalls.at(-1);
check('Top rail stop sends stop_cover to tdbu entity',
  !!call && call.service === 'stop_cover' && call.data.entity_id === 'cover.top_rail', JSON.stringify(call));

// A moving rail must not interrupt dragging the other rail. Device position
// updates arrive between pointer events, including while the pointer pauses.
for (const [rail, mainState, topState, startY, endY] of [
  ['top', 'closing', 'open', 80, 120],
  ['bottom', 'open', 'opening', 188, 220],
]) {
  card.hass = makeHass(30, 30, topState, mainState);
  await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
  check(`${rail} rail stays visually available during motion`,
    /--esc-movement-overlay-background:\s*transparent/.test(styleOf()));
  serviceCalls.length = 0;
  fire(rail === 'top' ? tdbuPicker : mainPicker, 'mousedown', startY);
  fire(tdbuShutter, 'mousemove', endY);
  await tdbuShutter.updateComplete;
  const target = rail === 'top' ? topPct(posTextNow()) : tdbuShutter.actualShutterPosition;
  card.hass = makeHass(rail === 'top' ? 29 : 30, rail === 'bottom' ? 31 : 30, topState, mainState);
  await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
  check(`${rail} drag survives the other rail's position update`,
    (rail === 'top' ? topPct(posTextNow()) : tdbuShutter.actualShutterPosition) === target);
  check(`${rail} drag stays free of transition lag after device updates`,
    /--esc-motion-transition-transform:\s*none/.test(styleOf()));
  fire(window, 'mouseup', endY);
  check(`${rail} drag sends its target while the other rail moves`,
    serviceCalls.some(c => c.service === 'set_cover_position' &&
      c.data.entity_id === (rail === 'top' ? 'cover.top_rail' : 'cover.main') && c.data.position === target),
    JSON.stringify(serviceCalls));
  card.hass = makeHass(28, 32, topState, mainState);
  await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
  check(`${rail} release resumes device positions`,
    topPct(posTextNow()) === 32 && tdbuShutter.actualShutterPosition === 28);
}

// ---- 6. hass update re-renders geometry ---------------------------------
card.hass = makeHass(30, 30); // establish a fresh baseline after the overlap tests
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
const clipTopBase = clipTopOf(styleOf());
card.hass = makeHass(30, 60);
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
const styleAfter = styleOf();
check('hass update (pos 30->60) moves clip-top down',
  clipTopOf(styleAfter) > clipTopBase, `was ${clipTopBase}, got ${clipTopOf(styleAfter)}`);
check('position text updates to Top: 60%', posTextNow().includes('Top: 60'), `text="${posTextNow()}"`);

// All bottom-rail commands must honor the top rail, including slider and buttons.
card.hass = makeHass(30, 30);
await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
serviceCalls.length = 0;
const bottomSlider = sr.querySelector('.esc-shutter-tilt-slider-class.openclose');
bottomSlider.value = '100';
fire(bottomSlider, 'mousedown', 0);
fire(tdbuShutter, 'mousemove', 0);
fire(window, 'mouseup', 0);
check('bottom slider cannot send a position above the top rail',
  serviceCalls.length === 1 && serviceCalls[0].data.position === 70, JSON.stringify(serviceCalls));
serviceCalls.length = 0;
tdbuShutter.doOnclick('open_cover');
check('bottom open button stops at the top rail',
  serviceCalls.length === 1 && serviceCalls[0].service === 'set_cover_position' && serviceCalls[0].data.position === 70,
  JSON.stringify(serviceCalls));
serviceCalls.length = 0;
tdbuShutter.doOnclick('set_cover_position', 95);
check('bottom preset cannot cross the top rail', serviceCalls[0]?.data.position === 70);

// Pointer cancellation and unmount must discard a gesture without sending it.
for (const cancel of ['pointercancel', 'blur', 'disconnect']) {
  card.hass = makeHass(31, 30);
  await card.updateComplete; await settle(); await tdbuShutter.updateComplete;
  serviceCalls.length = 0;
  fire(tdbuPicker, 'mousedown', 80);
  fire(tdbuShutter, 'mousemove', 120);
  await tdbuShutter.updateComplete;
  if (cancel === 'disconnect') card.remove();
  else fire(window, cancel, 120);
  fire(window, 'mouseup', 120);
  check(`${cancel} ends dragging without sending a command`, !tdbuShutter.isDragging && serviceCalls.length === 0,
    JSON.stringify(serviceCalls));
  if (cancel === 'disconnect') document.body.append(card);
}

// A single physical gesture can emit compatibility mouse events as well.
serviceCalls.length = 0;
fire(tdbuPicker, 'mousedown', 80);
fire(window, 'mousemove', 120); // continues outside the card
fire(window, 'mouseup', 120);
const pointerCall = serviceCalls[0];
tdbuPicker.dispatchEvent(new window.MouseEvent('mousedown', {bubbles:true, clientX:10, clientY:80}));
window.dispatchEvent(new window.MouseEvent('mouseup', {bubbles:true, clientX:10, clientY:120}));
check('pointer gesture outside card sends once; compatibility mouse events are ignored',
  serviceCalls.length === 1 && pointerCall?.data.position > 30, JSON.stringify(serviceCalls));

// A second touch or non-primary button must not hijack the active gesture.
for (const pointerType of ['touch', 'pen']) {
  serviceCalls.length = 0;
  fire(tdbuPicker, 'mousedown', 80, {pointerType});
  fire(mainPicker, 'mousedown', 188, {pointerId:2, isPrimary:false, pointerType});
  fire(window, 'mousemove', 240, {pointerId:2, pointerType});
  fire(window, 'mouseup', 240, {pointerId:2, pointerType});
  fire(window, 'pointercancel', 240, {pointerId:2, pointerType});
  check(`${pointerType}: another pointer cannot finish the active drag`, tdbuShutter.isDragging && serviceCalls.length === 0);
  fire(window, 'mousemove', 110, {pointerType});
  fire(window, 'mouseup', 110, {pointerType});
  check(`${pointerType}: active pointer sends exactly one top-rail command`,
    serviceCalls.length === 1 && serviceCalls[0].data.entity_id === 'cover.top_rail' && serviceCalls[0].data.position > 30);
}
serviceCalls.length = 0;
fire(tdbuPicker, 'mousedown', 80, {button:2});
fire(window, 'mouseup', 110, {button:2});
check('right click does not start a rail drag', !tdbuShutter.isDragging && serviceCalls.length === 0);

// Position inversion is applied once on the way back to the device.
for (const [options, mainPos, topPos, wanted] of [
  [{invert_percentage_cover:true}, 70, 30, 30],
  [{tdbu_invert_percentage:true}, 30, 70, 70],
]) {
  const variant = document.createElement('enhanced-shutter-card');
  variant.setConfig({entities:[{entity:'cover.main', tdbu_entity:'cover.top_rail', ...options}]});
  document.body.append(variant);
  variant.hass = makeHass(mainPos, topPos);
  await variant.updateComplete; await settle();
  const vs = variant.shadowRoot.querySelector('enhanced-shutter');
  await vs.updateComplete;
  serviceCalls.length = 0;
  vs.sendOpenClose(100);
  check(`rail clamp respects ${Object.keys(options)[0]}`, serviceCalls[0]?.data.position === wanted,
    JSON.stringify(serviceCalls));
  variant.remove();
}
serviceCalls.length = 0;
plainShutter.doOnclick('open_cover');
check('ordinary shutters retain open_cover commands', serviceCalls[0]?.service === 'open_cover');

// Appearance presets inherit globally, with an entity override for existing visuals.
const duette = document.createElement('enhanced-shutter-card');
duette.setConfig({shutter_preset: 'Duette', entities: [
  {entity: 'cover.main', tdbu_entity: 'cover.top_rail'},
  {entity: 'cover.plain'},
  {entity: 'cover.sideways', shutter_preset: 'roller-shutter'},
]});
document.body.append(duette);
duette.hass = makeHass(30, 30);
await duette.updateComplete; await settle();
const variants = [...duette.shadowRoot.querySelectorAll('enhanced-shutter')];
for (const v of variants) await v.updateComplete;
check('Duette appearance applies to TDBU and ordinary blinds only when selected',
  variants.map(v => !!v.shadowRoot.querySelector('.esc-shutter-selector-duette')).join(',') === 'true,true,false');
check('Duette top stop includes the frame and full rail thickness',
  variants[0].coverOpenedPx() === 5 + variants[0].shutterBottomSize().y());
check('Duette bottom stop stays inside the sill',
  variants[0].coverClosedPx() === variants[0].actualGlobalHeightPx() - 7);
check('Duette retains both TDBU rail handles',
  variants[0].shadowRoot.querySelectorAll('.esc-shutter-selector-slide-handle').length === 2);
check('Duette ordinary blind retains its centered picker handle',
  !!variants[1].shadowRoot.querySelector('.esc-shutter-selector-picker > .esc-shutter-selector-slide-handle'));
serviceCalls.length = 0;
variants[0].sendOpenClose(100);
check('Duette retains rail collision limits', serviceCalls[0]?.data.position === 70);
duette.remove();

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
