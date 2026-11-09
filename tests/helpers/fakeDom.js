// A small fake DOM for unit-testing the DOM modules (hud.js, menus.js, packUI.js, itemIcons.js) under Node, without jsdom.
// It covers what those modules use: elements with ids, classes, attributes, dataset, style and text; tree edits;
// listeners with bubbling; a simple CSS selector engine (tag, #id, .class, [attr], [attr="v"], :not(...), descendant
// combinator, selector lists); focus; SVG elements; and canvases whose 2D context records the calls made on it.
// Every attribute or text change bumps `doc.writes`, so a test can tell whether an update touched the DOM at all.

/** @param {string} s */
function kebab(s) {
  return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}
/** @param {string} s */
function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

class FakeClassList {
  /** @param {FakeElement} el */
  constructor(el) {
    this.el = el;
  }
  _get() {
    return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }
  _set(list) {
    this.el.setAttribute('class', list.join(' '));
  }
  contains(c) {
    return this._get().includes(c);
  }
  add(...cs) {
    const l = this._get();
    let changed = false;
    for (const c of cs) if (!l.includes(c)) {
      l.push(c);
      changed = true;
    }
    if (changed) this._set(l);
  }
  remove(...cs) {
    const l = this._get();
    const next = l.filter((c) => !cs.includes(c));
    if (next.length !== l.length) this._set(next);
  }
  toggle(c, force) {
    const has = this.contains(c);
    const want = force === undefined ? !has : Boolean(force);
    if (want && !has) this.add(c);
    else if (!want && has) this.remove(c);
    return want;
  }
  get length() {
    return this._get().length;
  }
  toString() {
    return this._get().join(' ');
  }
}

/** A recording 2D context: every call is pushed to `calls` as [name, ...args]. */
export class FakeContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    /** @type {Array<[string, ...any[]]>} */
    this.calls = [];
    this.imageSmoothingEnabled = true;
    this.globalCompositeOperation = 'source-over';
    this.fillStyle = '#000';
  }
  _rec(name, args) {
    this.calls.push([name, ...args]);
  }
  createImageData(w, h) {
    this._rec('createImageData', [w, h]);
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData(img, x, y) {
    this._rec('putImageData', [img, x, y]);
    // keep the pixels so a test can read them back with getImageData
    this._pixels = this._pixels || new Map();
    this._pixels.set(`${x},${y}`, img.data.slice());
  }
}
for (const name of ['save', 'restore', 'setTransform', 'clearRect', 'drawImage', 'fillRect', 'beginPath', 'moveTo', 'lineTo',
  'closePath', 'clip', 'fill', 'stroke', 'scale', 'translate', 'rect', 'arc', 'fillText']) {
  FakeContext2D.prototype[name] = function (...args) {
    this._rec(name, args);
  };
}

export class FakeElement {
  /** @param {FakeDocument} doc @param {string} tag @param {string|null} [ns] */
  constructor(doc, tag, ns = null) {
    this.ownerDocument = doc;
    this.tagName = ns ? tag : tag.toUpperCase();
    this.namespaceURI = ns;
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {FakeElement|null} */
    this.parentNode = null;
    /** @type {Record<string, Array<(e: any) => void>>} */
    this.listeners = {};
    this._text = '';
    this.classList = new FakeClassList(this);
    const el = this;
    this.style = new Proxy({}, {
      set(target, prop, value) {
        if (target[prop] !== value) doc.writes++;
        target[prop] = value;
        return true;
      },
      get(target, prop) {
        if (prop === 'setProperty') return (k, v) => { target[camel(k)] = v; doc.writes++; };
        if (prop === 'removeProperty') return (k) => { delete target[camel(k)]; };
        return target[prop] ?? '';
      },
    });
    this.dataset = new Proxy({}, {
      set(_t, prop, value) {
        el.setAttribute('data-' + kebab(String(prop)), String(value));
        return true;
      },
      get(_t, prop) {
        const v = el.getAttribute('data-' + kebab(String(prop)));
        return v === null ? undefined : v;
      },
      deleteProperty(_t, prop) {
        el.removeAttribute('data-' + kebab(String(prop)));
        return true;
      },
      has(_t, prop) {
        return el.hasAttribute('data-' + kebab(String(prop)));
      },
    });
    if (this.tagName === 'CANVAS') {
      this.width = 300;
      this.height = 150;
    }
  }

  // ---- attributes
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  setAttribute(name, value) {
    const v = String(value);
    if (this.attributes.get(name) !== v) this.ownerDocument.writes++;
    this.attributes.set(name, v);
  }
  removeAttribute(name) {
    if (this.attributes.delete(name)) this.ownerDocument.writes++;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }
  get className() {
    return this.getAttribute('class') || '';
  }
  set className(v) {
    this.setAttribute('class', v);
  }
  get disabled() {
    return this.hasAttribute('disabled');
  }
  set disabled(v) {
    if (v) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }
  get hidden() {
    return this.hasAttribute('hidden');
  }
  set hidden(v) {
    if (v) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  // ---- text
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    const s = v == null ? '' : String(v);
    if (this._text !== s || this.children.length) this.ownerDocument.writes++;
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = s;
  }

  // ---- tree
  get firstChild() {
    return this.children[0] || null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }
  get childNodes() {
    return this.children;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.documentElement;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    this.ownerDocument.writes++;
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n);
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = this.children.indexOf(ref);
    child.parentNode = this;
    this.children.splice(i < 0 ? this.children.length : i, 0, child);
    this.ownerDocument.writes++;
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parentNode = null;
      this.ownerDocument.writes++;
    }
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceChildren(...nodes) {
    while (this.children.length) this.removeChild(this.children[0]);
    this._text = '';
    this.append(...nodes);
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  /** @returns {FakeElement[]} every descendant, depth-first */
  _descendants() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    return this._descendants().filter((e) => matches(e, sel, this));
  }
  querySelector(sel) {
    return this._descendants().find((e) => matches(e, sel, this)) || null;
  }
  matches(sel) {
    return matches(this, sel, null);
  }
  closest(sel) {
    for (let n = this; n && n instanceof FakeElement; n = n.parentNode) if (matches(n, sel, null)) return n;
    return null;
  }

  // ---- events
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  listenerCount(type) {
    return (this.listeners[type] || []).length;
  }
  dispatchEvent(ev) {
    ev.target ??= this;
    let stopped = false;
    ev.stopPropagation = () => { stopped = true; };
    ev.defaultPrevented ??= false;
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    for (let n = this; n && !stopped; n = n.parentNode) {
      ev.currentTarget = n;
      for (const fn of [...(n.listeners[ev.type] || [])]) fn.call(n, ev);
      if (ev.bubbles === false) break;
    }
    if (!stopped && ev.bubbles !== false && this.isConnected) {
      for (const fn of [...(this.ownerDocument.listeners[ev.type] || [])]) fn.call(this.ownerDocument, ev);
    }
    return !ev.defaultPrevented;
  }
  click() {
    this.dispatchEvent({ type: 'click', button: 0 });
  }

  // ---- focus / layout
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  select() {}
  getBoundingClientRect() {
    const r = this._rect || { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }
  get offsetWidth() {
    return this._rect ? this._rect.width : 0;
  }

  // ---- canvas
  getContext(kind) {
    if (this.tagName !== 'CANVAS' || kind !== '2d') return null;
    this._ctx ||= new FakeContext2D(this);
    return this._ctx;
  }
}

// ---- selectors ------------------------------------------------------------------------------------------------

/**
 * Split a selector list on top-level commas.
 * @param {string} sel
 */
function splitList(sel) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(sel.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(sel.slice(start).trim());
  return out;
}

/** Split a complex selector into compound parts on whitespace (descendant combinator only). */
function splitCompound(sel) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel.trim()) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** @param {FakeElement} el @param {string} compound e.g. `button.mc-button[data-action="x"]:not([disabled])` */
function matchCompound(el, compound) {
  let s = compound;
  const tag = /^[a-zA-Z][\w-]*|^\*/.exec(s);
  if (tag) {
    if (tag[0] !== '*' && el.tagName.toUpperCase() !== tag[0].toUpperCase()) return false;
    s = s.slice(tag[0].length);
  }
  while (s.length) {
    let m;
    if ((m = /^#([\w-]+)/.exec(s))) {
      if (el.id !== m[1]) return false;
    } else if ((m = /^\.([\w-]+)/.exec(s))) {
      if (!el.classList.contains(m[1])) return false;
    } else if ((m = /^\[([\w-]+)(?:([~^$*]?=)"?([^"\]]*)"?)?\]/.exec(s))) {
      const v = el.getAttribute(m[1]);
      if (v === null) return false;
      if (m[2] === '=' && v !== m[3]) return false;
      if (m[2] === '~=' && !v.split(/\s+/).includes(m[3])) return false;
    } else if ((m = /^:not\(([^)]*\)?)\)/.exec(s))) {
      if (matchCompound(el, m[1])) return false;
    } else {
      throw new Error(`fakeDom: unsupported selector part "${s}" in "${compound}"`);
    }
    s = s.slice(m[0].length);
  }
  return true;
}

/** @param {FakeElement} el @param {string} sel @param {FakeElement|null} scope */
function matches(el, sel, scope) {
  return splitList(sel).some((one) => {
    const parts = splitCompound(one);
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let node = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (node && node instanceof FakeElement && !matchCompound(node, parts[i])) {
        if (node === scope) return false;
        node = node.parentNode;
      }
      if (!node || !(node instanceof FakeElement)) return false;
      node = node.parentNode;
    }
    return true;
  });
}

// ---- document ---------------------------------------------------------------------------------------------------

export class FakeDocument {
  constructor() {
    this.writes = 0;
    /** @type {Record<string, Array<(e: any) => void>>} */
    this.listeners = {};
    this.documentElement = new FakeElement(this, 'html');
    this.body = new FakeElement(this, 'body');
    this.documentElement.appendChild(this.body);
    /** @type {FakeElement} */
    this.activeElement = this.body;
    this.defaultView = { innerWidth: 1280, innerHeight: 720 };
  }
  createElement(tag) {
    return new FakeElement(this, tag);
  }
  createElementNS(ns, tag) {
    return new FakeElement(this, tag, ns);
  }
  createTextNode(text) {
    const t = new FakeElement(this, '#text');
    t._text = String(text);
    return t;
  }
  getElementById(id) {
    return this.documentElement._descendants().find((e) => e.id === id) || null;
  }
  querySelector(sel) {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  listenerCount(type) {
    return (this.listeners[type] || []).length;
  }
  /** Dispatch on the document itself (e.g. a keydown with no focused element). */
  dispatch(ev) {
    ev.target ??= this.body;
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    ev.stopPropagation = () => {};
    for (const fn of [...(this.listeners[ev.type] || [])]) fn.call(this, ev);
    return !ev.defaultPrevented;
  }
}

/**
 * Build a document from a tiny markup description: `add(parent, 'div#id.class1.class2', attrs?)` helpers are clumsy, so
 * this accepts a real (simple) HTML string: elements, attributes with double-quoted values, text and comments. Enough for
 * index.html's body.
 * @param {string} html
 * @returns {FakeDocument}
 */
export function documentFromHTML(html) {
  const doc = new FakeDocument();
  const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source', 'polygon', 'path', 'line', 'rect', 'circle', 'stop', 'ellipse']);
  const stack = [doc.body];
  const re = /<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w:-]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let svgDepth = 0;
  for (let m; (m = re.exec(html)); ) {
    if (m[0].startsWith('<!--')) continue;
    const top = stack[stack.length - 1];
    if (m[1]) {
      const tag = m[1].toLowerCase();
      // pop to the matching element
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === tag) {
          stack.length = i;
          break;
        }
      }
      if (tag === 'svg') svgDepth = Math.max(0, svgDepth - 1);
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (tag === 'svg') svgDepth++;
      const el = svgDepth ? doc.createElementNS('http://www.w3.org/2000/svg', tag) : doc.createElement(tag);
      for (const a of m[3].matchAll(/([\w:-]+)(?:\s*=\s*"([^"]*)")?/g)) el.setAttribute(a[1], decode(a[2] ?? ''));
      top.appendChild(el);
      if (!m[4] && !VOID.has(tag)) stack.push(el);
      else if (tag === 'svg') svgDepth--;
    } else if (m[5] && m[5].trim()) {
      top._text += decode(m[5].replace(/\s+/g, ' '));
    }
  }
  doc.writes = 0;
  return doc;
}

/** @param {string} s */
function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
}

/** Fire a bubbling event on an element. @param {FakeElement} el @param {string} type @param {object} [props] */
export function fire(el, type, props = {}) {
  return el.dispatchEvent({ type, bubbles: true, ...props });
}
