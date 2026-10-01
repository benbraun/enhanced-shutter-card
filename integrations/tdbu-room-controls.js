function position(entity) {
  if (!entity || ['unknown', 'unavailable'].includes(entity.state)) return null;
  const value = entity.attributes?.current_position;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function railTarget(topEntity, bottomEntity, rail, value) {
  const top = position(topEntity), bottom = position(bottomEntity);
  if (top === null || bottom === null || !['top', 'bottom'].includes(rail) ||
      typeof value !== 'number' || !Number.isFinite(value) ||
      [topEntity, bottomEntity].some(e => ['opening', 'closing'].includes(e.state))) return null;
  const target = rail === 'top' ? topEntity : bottomEntity;
  if (!(target.attributes.supported_features & 4)) return null;
  return Math.max(0, Math.min(Math.round(value), Math.floor(100 - (rail === 'top' ? bottom : top))));
}

function combinedTileState(topEntity, bottomEntity) {
  const top=position(topEntity), bottom=position(bottomEntity);
  const label=value => value === null ? '—' : `${Math.round(value)}%`;
  const moving=[topEntity,bottomEntity].find(e => ['opening','closing'].includes(e?.state));
  return {...bottomEntity,
    state: top === null || bottom === null ? 'unavailable' : moving?.state || (top + bottom === 0 ? 'closed' : 'open'),
    attributes: {...bottomEntity?.attributes, tdbu_summary:`Top ${label(top)} · Bottom ${label(bottom)}`}};
}

// Pure room-selection and batch-target helpers.


function groupPlan(members, states, rail, value) {
  if (!members.length || !['top','bottom'].includes(rail) || typeof value !== 'number' || !Number.isFinite(value)) return null;
  const targets = [];
  const ids = [];
  for (const member of members) {
    if (rail === 'top' && !member.top_entity) continue;
    const bottom = states[member.entity];
    const top = member.top_entity ? states[member.top_entity] : {state:'closed',attributes:{current_position:0,supported_features:0}};
    const target = railTarget(top, bottom, rail, value);
    if (target === null) return null;
    targets.push(target);
    ids.push(rail === 'top' ? member.top_entity : member.entity);
  }
  return ids.length ? {target:Math.min(...targets),ids:[...new Set(ids)]} : null;
}

function groupRange(members, states, rail) {
  const ids = members.map(m => rail === 'top' ? m.top_entity : m.entity).filter(Boolean);
  const values = ids.map(id => position(states[id]));
  if (!values.length || values.includes(null)) return null;
  return {min:Math.min(...values),max:Math.max(...values),count:ids.length};
}

function groupConfirmed(pending, states) {
  return Boolean(pending?.accepted && pending.ids.every(id => position(states[id]) === pending.target) &&
    pending.members.every(m => [m.top_entity,m.entity].filter(Boolean).every(id =>
      position(states[id]) !== null && !['opening','closing'].includes(states[id]?.state))));
}

// Experimental composition of Home Assistant's actual ha-control-slider.
// No core replacements, global styles, polling, or physical actions on load.
// Build prepends tdbu-logic.mjs to keep the resource self-contained.
class TdbuNativeCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: 'open'});
    this.demo = {top: 25, bottom: 20};
    this._railPreview = {};
  }

  setConfig(config) {
    if (!config.allowed_user) throw new Error('allowed_user is required for this experiment');
    if (!config.demo && (!/^cover\./.test(config.top_entity) || !/^cover\./.test(config.entity) || config.entity === config.top_entity)) {
      throw new Error('Two different cover entities are required');
    }
    this.config = {...config};
    this.setAttribute('variant', ['native-grips','soft-fill'].includes(config.variant) ? config.variant : 'combined');
    this.shadowRoot.replaceChildren();
    this.built = false;
    this.starting = false;
    if (this._hass) this.update();
  }

  set hass(hass) { this._hass = hass; this.update(); }
  getCardSize() { return 7; }
  getGridOptions() { return {columns: 12, rows: 7, min_columns: 6, min_rows: 7}; }
  connectedCallback() { if (this._hass) this.update(); }
  disconnectedCallback() { clearTimeout(this.timer); this.pending = null; this._railPreview = {}; }
  allowed() { return this._hass?.user?.id === this.config?.allowed_user; }
  entities() {
    if (this.config.demo) return ['top', 'bottom'].map(rail => ({state: 'open', attributes: {current_position: this.demo[rail], supported_features: 15}}));
    return [this._hass.states[this.config.top_entity], this._hass.states[this.config.entity]];
  }

  async start() {
    this.starting = true;
    try {
      // The native tile feature loads HA's slider lazily, including after a cold refresh.
      const helpers = await window.loadCardHelpers();
      const loader = helpers.createCardElement({type: 'tile', entity: this.config.entity, features: [{type: 'cover-position'}]});
      loader.hidden = true;
      loader.hass = this._hass;
      this.shadowRoot.append(loader);
      await Promise.race([customElements.whenDefined('ha-control-slider'), new Promise((_, reject) => setTimeout(() => reject(new Error('Native slider did not load. Refresh this dashboard.')), 15000))]);
      if (!customElements.get('tdbu-rail-slider')) {
        const NativeSlider=customElements.get('ha-control-slider');
        const gripStyle=new CSSStyleSheet();
        gripStyle.replaceSync(`
          .slider .slider-track-cursor {background:transparent;box-shadow:none;border-radius:0;}
          :host([vertical]) .slider .slider-track-cursor::after {background:var(--tdbu-grip-color,white);width:70%;height:4px;border-radius:4px;box-shadow:0 1px 2px #0002;}
        `);
        customElements.define('tdbu-rail-slider',class extends NativeSlider {
          static get styles() {return [super.styles,gripStyle];}
        });
      }
      loader.remove();
      if (!this.isConnected) { this.starting = false; return; }
      this.build();
      this.update();
    } catch (error) {
      this.shadowRoot.textContent = error.message;
      this.starting = false;
    }
  }

  build() {
    this.shadowRoot.innerHTML = `<style>
      :host {display:block; height:100%; --rail-color:var(--state-cover-open-color,var(--primary-color));}
      ha-card {height:100%; box-sizing:border-box; padding:18px 20px 16px; display:flex; flex-direction:column;}
      header {display:flex; gap:12px; align-items:center;}
      .icon {width:40px;height:40px;border-radius:50%;background:color-mix(in srgb,var(--rail-color) 14%,transparent);display:grid;place-items:center;color:var(--rail-color);}
      h2 {font-size:16px;font-weight:500;margin:0;line-height:24px;}
      .subtitle,.status {font-size:12px;line-height:18px;color:var(--secondary-text-color);}
      .control {display:grid;grid-template-columns:1fr 136px 1fr;align-items:center;gap:12px;margin:20px 0 16px;}
      .readout {display:flex;flex-direction:column;gap:6px;min-width:0;}
      .readout:last-child {text-align:right;}
      .readout span {font-size:12px;color:var(--secondary-text-color);}
      .readout strong {font-size:22px;font-weight:400;}
      .window {position:relative;height:240px;border-radius:36px;background:color-mix(in srgb,var(--rail-color) 14%,var(--card-background-color));}
      .fabric {position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none;}
      .shade {position:absolute;left:0;right:0;top:calc(var(--top, .25) * 100%);bottom:calc(var(--bottom, .20) * 100%);background:var(--rail-color);pointer-events:none;}
      .tracks {position:absolute;inset:8px 14px;display:flex;gap:8px;}
      ha-control-slider,tdbu-rail-slider {height:100%;flex:1;min-width:0;--control-slider-thickness:50px;--control-slider-background-opacity:0;--control-slider-border-radius:4px;--control-slider-color:var(--rail-color);--control-slider-tooltip-font-size:14px;}
      .legend {display:flex;justify-content:space-between;font-size:11px;color:var(--secondary-text-color);margin-top:8px;}
      .actions {display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:auto;}
      button {font:inherit;font-size:12px;border:0;border-radius:18px;padding:9px 10px;min-height:36px;color:var(--primary-text-color);background:var(--secondary-background-color);cursor:pointer;}
      button:focus-visible {outline:2px solid var(--primary-color);outline-offset:2px;}
      button:disabled {opacity:.45;cursor:default;}
      .status {min-height:18px;text-align:center;margin-top:10px;}
      .error {color:var(--error-color);}
      .unknown .shade {display:none;}
      :host([variant="native-grips"]) .window {background:color-mix(in srgb,var(--rail-color) 20%,var(--card-background-color));}
      :host([variant="soft-fill"]) .window {background:color-mix(in srgb,var(--rail-color) 7%,var(--card-background-color));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--rail-color) 16%,transparent);}
      :host([variant="soft-fill"]) .shade {background:color-mix(in srgb,var(--rail-color) 32%,var(--card-background-color));}
      :host([variant="soft-fill"]) tdbu-rail-slider {--tdbu-grip-color:var(--rail-color);}
      @media(max-width:380px) {ha-card{padding:16px 12px}.control{gap:8px}.readout strong{font-size:20px}}
    </style><ha-card>
      <header><div class="icon"><ha-icon icon="mdi:blinds-horizontal"></ha-icon></div><div><h2></h2><div class="subtitle"></div></div></header>
      <div class="control">
        <div class="readout"><span>Top opening</span><strong class="top-value"></strong></div>
        <div><div class="window"><div class="fabric"><div class="shade"></div></div><div class="tracks"></div></div><div class="legend"><span>Top rail</span><span>Bottom rail</span></div></div>
        <div class="readout"><span>Bottom opening</span><strong class="bottom-value"></strong></div>
      </div>
      <div class="actions"></div><div class="status" role="status" aria-live="polite"></div>
    </ha-card>`;
    this.shadowRoot.querySelector('h2').textContent = this.config.name || 'Top down / bottom up';
    this.shadowRoot.querySelector('.subtitle').textContent = this.config.demo ? 'Practice · no blind will move' : 'Live · drag a handle to adjust';
    this.sliders = {};
    const styledGrips = ['native-grips','soft-fill'].includes(this.config.variant);
    for (const rail of ['top', 'bottom']) {
      const slider = document.createElement(styledGrips ? 'tdbu-rail-slider' : 'ha-control-slider');
      Object.assign(slider, {vertical: true, inverted: rail === 'top', min: 0, max: 100, step: 1, mode: 'cursor', unit: '%', label: `${rail === 'top' ? 'Top' : 'Bottom'} opening`, tooltipPosition: rail === 'top' ? 'left' : 'right', touchAction: 'none'});
      slider.addEventListener('slider-moved', event => {
        event.stopPropagation();
        const value = event.detail?.value;
        if (value === undefined) { delete this._railPreview[rail]; return; }
        const target = this.target(rail, value);
        if (target === null) return;
        this._railPreview[rail] = target;
        slider.value = target;
        this.draw();
      });
      slider.addEventListener('value-changed', event => { event.stopPropagation(); this.commit(rail, event.detail?.value); });
      slider.addEventListener('pointercancel', () => { this._railPreview = {}; this.update(); });
      slider.addEventListener('focusout', () => { this._railPreview = {}; this.update(); });
      this.shadowRoot.querySelector('.tracks').append(slider);
      this.sliders[rail] = slider;
    }
    const actions = this.shadowRoot.querySelector('.actions');
    if (this.config.demo) {
      for (const [name, top, bottom] of [['Closed', 0, 0], ['Daylight', 35, 0], ['Middle', 25, 25]]) {
        const button = document.createElement('button'); button.textContent = name;
        button.onclick = () => { if (!this.allowed()) return; this.demo = {top, bottom}; this._railPreview = {}; this.update(); };
        actions.append(button);
      }
    } else {
      const stop = document.createElement('button'); stop.textContent = 'Stop both'; stop.className = 'stop';
      stop.onclick = () => this.stop(); actions.append(stop);
      for (const [label, entity] of [['Top details', this.config.top_entity], ['Bottom details', this.config.entity]]) {
        const button = document.createElement('button'); button.textContent = label;
        button.onclick = () => { if (this.allowed()) this.dispatchEvent(new CustomEvent('hass-more-info', {detail: {entityId: entity}, bubbles: true, composed: true})); };
        actions.append(button);
      }
    }
    this.built = true;
  }

  target(rail, value) {
    if (!this.allowed() || this.pending) return null;
    return railTarget(...this.entities(), rail, value);
  }

  async commit(rail, value) {
    const target = this.target(rail, value);
    this._railPreview = {};
    if (target === null) { this.update(); return; }
    if (this.config.demo) { this.demo[rail] = target; this.update(); return; }
    const [top, bottom] = this.entities();
    if (position(rail === 'top' ? top : bottom) === target) { this.update(); return; }
    this.error = '';
    const pending = {rail, target};
    this.pending = pending;
    this.update();
    try {
      await this._hass.callService('cover', 'set_cover_position', {entity_id: rail === 'top' ? this.config.top_entity : this.config.entity, position: target});
      pending.accepted = true;
      this.update();
      if (this.pending === pending) this.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null; this.error = 'Position not confirmed. Check the reported rail positions.'; this.update();
      }, 20000);
    } catch (error) {
      if (this.pending !== pending) return;
      this.pending = null;
      this.error = `Could not move blind: ${error.message || 'service failed'}`;
      this.update();
    }
  }

  async stop() {
    if (!this.allowed() || this.config.demo) return;
    const ids = [this.config.top_entity, this.config.entity].filter(id => {
      const state = this._hass.states[id];
      return state && !['unavailable','unknown'].includes(state.state) && (state.attributes.supported_features & 8);
    });
    if (!ids.length) return;
    try {
      await this._hass.callService('cover', 'stop_cover', {entity_id: ids});
      clearTimeout(this.timer); this.pending = null; this.error = ''; this._railPreview = {}; this.update();
    } catch (error) { this.error = `Could not stop blind: ${error.message || 'service failed'}`; this.update(); }
  }

  update() {
    if (!this.config || !this._hass) return;
    this.hidden = !this.allowed();
    if (!this.allowed()) { this.style.display = 'none'; return; }
    this.style.removeProperty('display');
    if (!this.built) { if (!this.starting && this.isConnected) this.start(); return; }
    const [top, bottom] = this.entities();
    const values = {top: position(top), bottom: position(bottom)};
    const moving = [top,bottom].some(e => ['opening','closing'].includes(e?.state));
    if (this.pending?.accepted && !moving && values[this.pending.rail] === this.pending.target) {
      clearTimeout(this.timer); this.pending = null;
    }
    for (const rail of ['top', 'bottom']) {
      this.sliders[rail].locale = this._hass.locale;
      this.sliders[rail].disabled = this.target(rail, values[rail]) === null;
      if (!(rail in this._railPreview)) this.sliders[rail].value = values[rail] ?? undefined;
    }
    const stop = this.shadowRoot.querySelector('.stop');
    if (stop) stop.disabled = ![top,bottom].some(e => e && !['unknown','unavailable'].includes(e.state) && (e.attributes.supported_features & 8));
    const status = this.shadowRoot.querySelector('.status');
    status.classList.toggle('error', Boolean(this.error));
    status.textContent = this.error || (values.top === null || values.bottom === null ? 'Rail position unavailable' : this.pending ? 'Waiting for blind…' : moving ? 'Blind moving…' : this.config.demo ? 'Try both handles · they stop at each other' : 'Positions follow the blind’s reported state');
    this.draw();
  }

  draw() {
    const [topEntity,bottomEntity] = this.entities();
    const top = this._railPreview.top ?? position(topEntity), bottom = this._railPreview.bottom ?? position(bottomEntity);
    const frame = this.shadowRoot.querySelector('.window');
    frame.classList.toggle('unknown', top === null || bottom === null);
    frame.style.setProperty('--top', (top ?? 0) / 100);
    frame.style.setProperty('--bottom', Math.min(bottom ?? 0, 100 - (top ?? 0)) / 100);
    this.shadowRoot.querySelector('.top-value').textContent = top === null ? '—' : `${Math.round(top)}%`;
    this.shadowRoot.querySelector('.bottom-value').textContent = bottom === null ? '—' : `${Math.round(bottom)}%`;
  }
}
if (!customElements.get('tdbu-native-card')) customElements.define('tdbu-native-card', TdbuNativeCard);

// A real HA tile, with a local presentation of both rails and a scoped dialog.
// Only this tile's more-info action is intercepted; other cover dialogs are untouched.
class TdbuNativeTile extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode:'open'});
    this.addEventListener('hass-more-info', event => {
      event.stopPropagation();
      if (this._hass?.user?.id !== this.config?.allowed_user) return;
      this.dispatchEvent(new CustomEvent('show-dialog', {bubbles:true,composed:true,detail:{
        dialogTag:'tdbu-native-dialog', dialogImport:() => Promise.resolve(),
        dialogParams:{...this.config, type:'custom:tdbu-native-card'},
      }}));
    });
  }
  setConfig(config) {
    if (!config.allowed_user || !/^cover\./.test(config.entity) || !/^cover\./.test(config.top_entity) || config.entity === config.top_entity) throw new Error('Two rail entities and allowed_user are required');
    this.config={...config};
    this.tile?.setConfig(this.tileConfig());
    this.update();
  }
  set hass(hass) {this._hass=hass;this.update();}
  getCardSize() {return 1;}
  getGridOptions() {return {columns:12,rows:1,min_columns:6,min_rows:1};}
  connectedCallback() {this.update();}
  tileConfig() {
    return {type:'tile',entity:this.config.entity,name:this.config.name || 'Paired blind',
      icon:'mdi:blinds-horizontal',state_content:['tdbu_summary'],
      tap_action:{action:'more-info'},icon_tap_action:{action:'more-info'},
      hold_action:{action:'none'},double_tap_action:{action:'none'},
      icon_hold_action:{action:'none'},icon_double_tap_action:{action:'none'}};
  }
  async update() {
    if (!this.config || !this._hass) return;
    this.style.display=this._hass.user?.id === this.config.allowed_user ? 'block' : 'none';
    if (this.style.display === 'none') return;
    if (!this.tile) {
      if (this.loading || !this.isConnected) return;
      this.loading=true;
      try {
        const helpers=await window.loadCardHelpers();
        this.tile=helpers.createCardElement(this.tileConfig());
        this.shadowRoot.innerHTML='<style>:host{display:block;height:100%}hui-tile-card{height:100%}</style>';
        this.shadowRoot.append(this.tile);
      } catch(error) {this.shadowRoot.textContent=error.message;return;}
      finally {this.loading=false;}
    }
    // A copied state only for this tile's text/icon; never write HA's real states.
    const entity=combinedTileState(this._hass.states[this.config.top_entity],this._hass.states[this.config.entity]);
    entity.entity_id=this.config.entity;
    this.tile.hass={...this._hass,states:{...this._hass.states,[this.config.entity]:entity}};
  }
}

class TdbuNativeDialog extends HTMLElement {
  constructor() {super();this.attachShadow({mode:'open'});}
  set hass(hass) {
    this._hass=hass;
    if (this.config && hass.user?.id !== this.config.allowed_user) {this.closeDialog();return;}
    if (this.control) this.control.hass=hass;
  }
  showDialog(config) {
    if (this._hass?.user?.id !== config.allowed_user) return;
    this.config={...config};
    this.shadowRoot.innerHTML='<style>ha-dialog{--ha-dialog-width-md:420px;--dialog-content-padding:0 16px 16px}tdbu-native-card{display:block;height:440px;--ha-card-border-width:0;--ha-card-box-shadow:none}</style>';
    this.dialog=document.createElement('ha-dialog');
    this.dialog.headerTitle=config.name || 'Paired blind';
    this.dialog.headerSubtitle='Top down / bottom up';
    this.control=document.createElement('tdbu-native-card');
    this.control.setConfig(config);
    this.control.hass=this._hass;
    this.dialog.append(this.control);
    this.dialog.addEventListener('closed',event => {
      if (event.target !== this.dialog) return;
      this.finishClose();
    });
    this.shadowRoot.append(this.dialog);
    this.opened=true;
    this.dialog.open=true;
  }
  closeDialog() {
    if (this.dialog) this.dialog.open=false;
    this.finishClose();
    return true;
  }
  finishClose() {
    if (!this.opened) return;
    this.opened=false;
    this.control?.remove();
    this.control=null;
    this.dispatchEvent(new CustomEvent('dialog-closed',{bubbles:true,composed:true,detail:{dialog:this.localName}}));
  }
}
if (!customElements.get('tdbu-native-tile')) customElements.define('tdbu-native-tile',TdbuNativeTile);
if (!customElements.get('tdbu-native-dialog')) customElements.define('tdbu-native-dialog',TdbuNativeDialog);

// The group reuses the single-blind window, native sliders and visual styling.
// Each release moves one rail across an explicit, room-scoped selection.
class TdbuGroupControl extends TdbuNativeCard {
  setConfig(config) {
    const members = config.members;
    if (!Array.isArray(members) || !members.length || members.some(m => !/^cover\./.test(m.entity) ||
      (m.top_entity && (!/^cover\./.test(m.top_entity) || m.top_entity === m.entity)))) throw new Error('Room shade entities are required');
    const ids = members.flatMap(m => [m.entity,m.top_entity].filter(Boolean));
    if (new Set(ids).size !== ids.length) throw new Error('Room shade entities must be unique');
    this.selected = new Set();
    super.setConfig({...config, demo:false, variant:'soft-fill', entity:members[0].entity,
      top_entity:members.find(m => m.top_entity)?.top_entity || 'cover.group_top_unused'});
  }
  members() {return this.config.members.filter(m => this.selected.has(m.entity));}
  setSelection(ids) {
    if (!this.allowed() || this.pending || this.stopping) return;
    const allowed = new Set(this.config.members.map(m => m.entity));
    this.selected = new Set(ids.filter(id => allowed.has(id)));
    this._railPreview = {}; this.error = ''; this.update();
  }
  entities() {
    return ['top','bottom'].map(rail => {
      const range = groupRange(this.members(),this._hass.states,rail);
      const value = range?.min ?? (rail === 'top' && this.members().length && !this.members().some(m => m.top_entity) ? 0 : null);
      return {state:value === null ? 'unavailable' : 'open',attributes:{current_position:value,supported_features:15}};
    });
  }
  target(rail,value) {
    if (!this.allowed() || this.pending || this.stopping) return null;
    return groupPlan(this.members(),this._hass.states,rail,value)?.target ?? null;
  }
  async commit(rail,value) {
    this._railPreview = {};
    if (!this.allowed() || this.pending || this.stopping) {this.update();return;}
    const members = this.members();
    const plan = groupPlan(members,this._hass.states,rail,value);
    if (!plan) {this.update();return;}
    const ids = plan.ids.filter(id => position(this._hass.states[id]) !== plan.target);
    if (!ids.length) {this.update();return;}
    this.error = '';
    const pending = {...plan,rail,members:members.filter(m => rail === 'bottom' || m.top_entity)};
    this.pending = pending;
    this.update();
    try {
      await this._hass.callService('cover','set_cover_position',{entity_id:ids,position:plan.target});
      if (this.pending !== pending) return;
      pending.accepted = true;
      this.update();
      if (this.pending === pending) this.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        pending.timedOut = true;
        this.error = 'Not all shades confirmed their position. Use Stop selected to cancel before adjusting again.';
        this.update();
      },20000);
    } catch (error) {
      if (this.pending !== pending) return;
      this.pending = null;
      this.error = `Could not move all selected shades. Some shades may have moved. ${error.message || ''}`;
      this.update();
    }
  }
  stopIds() {
    return this.members().flatMap(m => [m.entity,m.top_entity].filter(Boolean)).filter(id => {
      const state = this._hass.states[id];
      return state && !['unknown','unavailable'].includes(state.state) && (state.attributes?.supported_features & 8);
    });
  }
  async stop() {
    if (!this.allowed() || this.stopping) return;
    const ids = this.stopIds();
    if (!ids.length) return;
    this.stopping = true; this.update();
    try {
      await this._hass.callService('cover','stop_cover',{entity_id:ids});
      clearTimeout(this.timer);this.pending = null;this.error = '';this._railPreview = {};
    } catch (error) {
      this.error = `Could not stop all selected shades. ${error.message || ''}`;
    } finally {this.stopping = false;this.update();}
  }
  build() {
    super.build();
    const style = document.createElement('style');
    style.textContent = `
      ha-card{height:auto;padding:4px 4px 8px}header{display:none}
      .selection-bar{display:flex;align-items:center;gap:8px;margin-bottom:8px}
      .selection-count{flex:1;font-size:14px;font-weight:500}
      .choices{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .choice{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 8px;box-sizing:border-box;border:1px solid var(--divider-color);border-radius:12px;cursor:pointer}
      .choice:has(input:checked){border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 8%,transparent)}
      .choice input{width:18px;height:18px;flex:none;accent-color:var(--primary-color);margin:0}
      .choice input:focus-visible{outline:2px solid var(--primary-color);outline-offset:3px}
      .choice-text{min-width:0}.choice-name{font-size:14px}.choice-state{font-size:11px;color:var(--secondary-text-color);margin-top:2px}
      .scope-note{font-size:12px;line-height:18px;color:var(--secondary-text-color);margin:8px 0 0}
      .readout strong{font-size:18px}.readout small{font-size:11px;color:var(--secondary-text-color)}
      .control{grid-template-columns:minmax(0,1fr) 104px minmax(0,1fr);gap:8px;margin:12px 0 8px}
      :host([variant="soft-fill"]) .window{height:160px;border-radius:3px;background:linear-gradient(125deg,transparent 30%,#ffffff55 31%,#ffffff18 48%,transparent 49%),linear-gradient(#b8d8e8,#e6f0f3 65%,#d2dfd6);box-shadow:none}
      .window::after{content:'';position:absolute;inset:0;border:5px solid #e9edef;border-bottom:7px solid #f5f7f8;box-shadow:inset 0 0 0 1px #aab9c0,inset 0 0 8px #52606333;pointer-events:none}
      .fabric{inset:5px 5px 7px;border-radius:0}
      :host([variant="soft-fill"]) .shade{top:calc(var(--top,0) * (100% - 7px));bottom:calc(var(--bottom,0) * (100% - 7px));background:repeating-linear-gradient(to bottom,#fbfcfc 0px,#f1f3f3 2.4px,#dfe3e3 4.8px,#c8cece 5.4px,#fbfcfc 6px);box-shadow:inset 4px 0 6px #52606318,inset -4px 0 6px #52606318}
      .shade::before,.shade::after{content:'';position:absolute;left:0;right:0;height:7px;background:linear-gradient(#fcfdfd,#e0e5e5);box-shadow:inset 0 0 0 1px #bdc5c5}
      .shade::before{top:0}.shade::after{bottom:0}
      .tracks{inset:8.5px 10px 10.5px;gap:4px;z-index:1}
      :host([variant="soft-fill"]) tdbu-rail-slider{--tdbu-grip-color:#7e8989;--control-slider-thickness:38px}
      .legend{margin-top:4px}.readout{gap:3px}.readout strong{font-size:16px}
      .status{margin-top:6px;font-size:11px;line-height:16px}
      @media(max-width:380px){.choices{gap:6px}.choice{padding:8px}.control{gap:6px}.readout strong{font-size:16px}}
    `;
    this.shadowRoot.append(style);
    const chooser = document.createElement('div');
    chooser.innerHTML = '<div class="selection-bar"><span class="selection-count" aria-live="polite"></span><button class="select-all">Select all</button><button class="clear">Clear</button></div><div class="choices"></div><p class="scope-note"></p>';
    this.shadowRoot.querySelector('.control').before(chooser);
    this.shadowRoot.querySelector('.select-all').onclick = () => this.setSelection(this.config.members.map(m => m.entity));
    this.shadowRoot.querySelector('.clear').onclick = () => this.setSelection([]);
    this.choices = new Map();
    for (const member of this.config.members) {
      const label = document.createElement('label');label.className = 'choice';
      label.innerHTML = '<input type="checkbox"><div class="choice-text"><div class="choice-name"></div><div class="choice-state"></div></div>';
      label.querySelector('.choice-name').textContent = member.name || member.entity;
      const input = label.querySelector('input');
      input.setAttribute('aria-label',`Select ${member.name || member.entity}`);
      input.onchange = () => {
        const ids = new Set(this.selected);
        if (input.checked) ids.add(member.entity);else ids.delete(member.entity);
        this.setSelection([...ids]);
      };
      this.shadowRoot.querySelector('.choices').append(label);
      this.choices.set(member.entity,label);
    }
    for (const rail of ['top','bottom']) {
      const note = document.createElement('small');note.className = `${rail}-mixed`;
      this.shadowRoot.querySelector(`.${rail}-value`).after(note);
    }
    const actions = this.shadowRoot.querySelector('.actions');actions.replaceChildren();
    const stop = document.createElement('button');stop.className = 'stop';stop.textContent = 'Stop selected';stop.onclick = () => this.stop();actions.append(stop);
  }
  update() {
    if (!this.config || !this._hass) return;
    this.hidden = !this.allowed();
    if (!this.allowed()) {this.style.display = 'none';return;}
    this.style.removeProperty('display');
    if (!this.built) {if (!this.starting && this.isConnected) this.start();return;}
    if (groupConfirmed(this.pending,this._hass.states)) {
      clearTimeout(this.timer);if (this.pending.timedOut) this.error = '';this.pending = null;
    }
    const members = this.members();
    const locked = Boolean(this.pending || this.stopping);
    const label = value => value === null ? 'Unavailable' : `${Math.round(value)}%`;
    for (const member of this.config.members) {
      const row = this.choices.get(member.entity), input = row.querySelector('input');
      input.checked = this.selected.has(member.entity);input.disabled = locked;
      row.querySelector('.choice-state').textContent = member.top_entity ? `Top ${label(position(this._hass.states[member.top_entity]))} · Bottom ${label(position(this._hass.states[member.entity]))}` : `Single rail · ${label(position(this._hass.states[member.entity]))}`;
    }
    this.shadowRoot.querySelector('.selection-count').textContent = `${members.length} of ${this.config.members.length} selected`;
    this.shadowRoot.querySelector('.select-all').disabled = locked || members.length === this.config.members.length;
    this.shadowRoot.querySelector('.clear').disabled = locked || !members.length;
    const paired = members.filter(m => m.top_entity).length;
    this.shadowRoot.querySelector('.scope-note').textContent = !members.length ? 'Choose shades above. Selecting a shade does not move it.' :
      `${paired ? `Top handle: ${paired} TDBU ${paired === 1 ? 'shade' : 'shades'}. ` : 'Top handle unavailable for single-rail shades. '}Bottom handle: all ${members.length} selected. Release a handle to move that rail together.`;
    for (const rail of ['top','bottom']) {
      const range = groupRange(members,this._hass.states,rail);
      this.sliders[rail].locale = this._hass.locale;
      this.sliders[rail].disabled = this.target(rail,range?.min ?? 0) === null;
      if (!(rail in this._railPreview)) this.sliders[rail].value = range?.min ?? 0;
    }
    this.shadowRoot.querySelector('.stop').disabled = this.stopping || !this.stopIds().length;
    const status = this.shadowRoot.querySelector('.status');
    const blocked = members.length && ['top','bottom'].every(rail => this.target(rail,0) === null);
    status.classList.toggle('error',Boolean(this.error));
    status.textContent = this.error || (this.stopping ? 'Stopping selected shades…' : this.pending ? 'Waiting for selected shades…' : !members.length ? 'No shades selected' : blocked ? 'Selected shades are moving, unavailable, or do not support positioning.' : 'Each handle respects the rail limits of every selected shade.');
    this.draw();
  }
  draw() {
    super.draw();
    let mixed = false;
    for (const rail of ['top','bottom']) {
      const range = groupRange(this.members(),this._hass.states,rail);
      const differs = range && range.min !== range.max;
      mixed ||= Boolean(differs);
      if (!(rail in this._railPreview)) this.shadowRoot.querySelector(`.${rail}-value`).textContent = !range ? '—' : differs ? `${Math.round(range.min)}–${Math.round(range.max)}%` : `${Math.round(range.min)}%`;
      this.shadowRoot.querySelector(`.${rail}-mixed`).textContent = differs && !(rail in this._railPreview) ? 'Mixed positions' : '';
    }
    this.shadowRoot.querySelector('.window').classList.toggle('mixed',mixed && !Object.keys(this._railPreview).length);
  }
}

class TdbuRoomTile extends HTMLElement {
  constructor() {super();this.attachShadow({mode:'open'});}
  setConfig(config) {
    if (!config.allowed_user || !Array.isArray(config.members) || config.members.length < 2) throw new Error('A room with multiple shades and allowed_user is required');
    this.config = {...config};this.update();
  }
  set hass(hass) {this._hass = hass;this.update();}
  getCardSize() {return 1;}
  getGridOptions() {return {columns:12,rows:1,min_columns:6};}
  update() {
    if (!this.config || !this._hass) return;
    this.style.display = this._hass.user?.id === this.config.allowed_user ? 'block' : 'none';
    if (this.style.display === 'none' || this.built) return;
    this.shadowRoot.innerHTML = `<style>:host{display:block;height:100%}ha-card{height:100%}button{display:flex;align-items:center;gap:12px;width:100%;height:100%;min-height:56px;text-align:left;padding:10px 12px;border:0;border-radius:var(--ha-card-border-radius,12px);background:transparent;color:var(--primary-text-color);cursor:pointer;font:inherit}button:focus-visible{outline:2px solid var(--primary-color);outline-offset:-2px}ha-icon{color:var(--primary-color);padding:8px;border-radius:50%;background:color-mix(in srgb,var(--primary-color) 12%,transparent)}strong{display:block;font-size:14px;font-weight:500;line-height:20px}small{font-size:12px;color:var(--secondary-text-color)}</style><ha-card><button><ha-icon icon="mdi:select-multiple"></ha-icon><span><strong>Control multiple shades</strong><small></small></span></button></ha-card>`;
    this.shadowRoot.querySelector('small').textContent = `Choose from ${this.config.members.length} shades`;
    const button = this.shadowRoot.querySelector('button');
    button.setAttribute('aria-label',`Control multiple shades in ${this.config.name}`);
    button.onclick = () => {
      if (this._hass.user?.id !== this.config.allowed_user) return;
      this.dispatchEvent(new CustomEvent('show-dialog',{bubbles:true,composed:true,detail:{dialogTag:'tdbu-room-dialog',dialogImport:() => Promise.resolve(),dialogParams:this.config}}));
    };
    this.built = true;
  }
}

class TdbuRoomDialog extends TdbuNativeDialog {
  showDialog(config) {
    if (this._hass?.user?.id !== config.allowed_user) return;
    this.config = {...config};
    this.shadowRoot.innerHTML = '<style>ha-dialog{--ha-dialog-width-md:440px;--dialog-content-padding:0 12px 12px}tdbu-group-control{display:block;--ha-card-border-width:0;--ha-card-box-shadow:none}</style>';
    this.dialog = document.createElement('ha-dialog');
    this.dialog.headerTitle = config.name;
    this.dialog.headerSubtitle = 'Control multiple shades';
    this.control = document.createElement('tdbu-group-control');
    this.control.setConfig(config);this.control.hass = this._hass;
    this.dialog.append(this.control);
    this.dialog.addEventListener('closed',event => {if (event.target === this.dialog) this.finishClose();});
    this.shadowRoot.append(this.dialog);this.opened = true;this.dialog.open = true;
  }
}
if (!customElements.get('tdbu-group-control')) customElements.define('tdbu-group-control',TdbuGroupControl);
if (!customElements.get('tdbu-room-tile')) customElements.define('tdbu-room-tile',TdbuRoomTile);
if (!customElements.get('tdbu-room-dialog')) customElements.define('tdbu-room-dialog',TdbuRoomDialog);

