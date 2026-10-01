/**
 * Browser polyfill for the DOM helpers Obsidian adds to every element
 * (createDiv, createEl, createSvg, setText, empty, addClass, ...).
 *
 * The renderer in src/ui/beam-view.ts builds its output only through these
 * helpers, so installing them on the prototypes is all a plain browser needs
 * to run the real renderer. Only the subset the renderer uses is covered, and
 * it follows Obsidian's documented behaviour (a string option is a class
 * name, `attr` sets attributes, `text` sets the text content). Elements are
 * always created with createElementNS and text is always set with
 * textContent: nothing is parsed as markup.
 *
 * Development tool only (npm run preview): never bundled into the plugin.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** The subset of Obsidian's DomElementInfo / SvgElementInfo the polyfill understands. */
interface ElementInfo {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, string | number | boolean | null>;
	title?: string;
	value?: string;
	type?: string;
	placeholder?: string;
	href?: string;
	prepend?: boolean;
}

/** Replaces the element's children with plain text (or a fragment), like Obsidian's setText. */
function setTextOf(el: Element, value: string | DocumentFragment): void {
	if (typeof value === 'string') el.textContent = value;
	else el.replaceChildren(value);
}

/** Applies createEl options the way Obsidian does (a string option is a class name). */
function applyInfo(el: Element, info: ElementInfo | string | undefined): void {
	const o: ElementInfo = typeof info === 'string' ? { cls: info } : (info ?? {});
	const classes = Array.isArray(o.cls) ? o.cls : (o.cls ?? '').split(/\s+/);
	for (const c of classes) if (c) el.classList.add(c);
	if (o.text !== undefined) setTextOf(el, o.text);
	for (const [name, value] of Object.entries(o.attr ?? {})) if (value !== null) el.setAttribute(name, String(value));
	if (o.title !== undefined) el.setAttribute('title', o.title);
	if (o.value !== undefined) el.setAttribute('value', o.value);
	if (o.type !== undefined) el.setAttribute('type', o.type);
	if (o.placeholder !== undefined) el.setAttribute('placeholder', o.placeholder);
	if (o.href !== undefined) el.setAttribute('href', o.href);
}

/** Creates `el` under `parent` honouring `prepend`, then applies the options and callback. */
function attach<T extends Element>(parent: Node, el: T, info: ElementInfo | string | undefined, cb?: (el: T) => void): T {
	applyInfo(el, info);
	if (typeof info === 'object' && info.prepend) parent.insertBefore(el, parent.firstChild);
	else parent.appendChild(el);
	cb?.(el);
	return el;
}

/** The document a node belongs to (the global document for detached nodes). */
function ownerDoc(node: Node): Document {
	return node.ownerDocument ?? document;
}

/** Installs the helpers on Node, Element, HTMLElement, SVGElement and window. */
function installObsidianDomHelpers(): void {
	const define = (target: object, name: string, value: unknown): void => {
		Object.defineProperty(target, name, { value, configurable: true, writable: true });
	};
	// The polyfill implements Obsidian's helpers, so it creates elements natively: HTML elements through
	// the XHTML namespace (same result as createElement in an HTML document).
	const html = (tag: string) =>
		function (this: Node, info?: ElementInfo | string, cb?: (el: Element) => void): Element {
			return attach(this, ownerDoc(this).createElementNS(XHTML_NS, tag), info, cb);
		};
	define(Node.prototype, 'createEl', function (this: Node, tag: string, info?: ElementInfo | string, cb?: (el: Element) => void) {
		return attach(this, ownerDoc(this).createElementNS(XHTML_NS, tag), info, cb);
	});
	define(Node.prototype, 'createDiv', html('div'));
	define(Node.prototype, 'createSpan', html('span'));
	define(Node.prototype, 'createSvg', function (this: Node, tag: string, info?: ElementInfo | string, cb?: (el: Element) => void) {
		return attach(this, ownerDoc(this).createElementNS(SVG_NS, tag), info, cb);
	});
	define(Node.prototype, 'empty', function (this: Node) {
		while (this.firstChild) this.removeChild(this.firstChild);
	});
	define(Node.prototype, 'detach', function (this: Node) {
		this.parentNode?.removeChild(this);
	});
	const detached = (create: () => Element) =>
		function (info?: ElementInfo | string, cb?: (el: Element) => void): Element {
			const el = create();
			applyInfo(el, info);
			cb?.(el);
			return el;
		};
	define(window, 'createEl', (tag: string, info?: ElementInfo | string, cb?: (el: Element) => void) =>
		detached(() => document.createElementNS(XHTML_NS, tag))(info, cb),
	);
	define(window, 'createDiv', detached(() => document.createElementNS(XHTML_NS, 'div')));
	define(window, 'createSpan', detached(() => document.createElementNS(XHTML_NS, 'span')));
	define(window, 'createSvg', (tag: string, info?: ElementInfo | string, cb?: (el: Element) => void) =>
		detached(() => document.createElementNS(SVG_NS, tag))(info, cb),
	);
	Object.defineProperty(Node.prototype, 'win', { get: () => window, configurable: true });
	Object.defineProperty(Node.prototype, 'doc', { get: () => document, configurable: true });

	define(Element.prototype, 'setText', function (this: Element, value: string | DocumentFragment) {
		setTextOf(this, value);
	});
	define(Element.prototype, 'getText', function (this: Element) {
		return this.textContent ?? '';
	});
	define(Element.prototype, 'addClass', function (this: Element, ...classes: string[]) {
		this.classList.add(...classes);
	});
	define(Element.prototype, 'removeClass', function (this: Element, ...classes: string[]) {
		this.classList.remove(...classes);
	});
	define(Element.prototype, 'toggleClass', function (this: Element, classes: string | string[], value: boolean) {
		for (const c of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(c, value);
	});
	define(Element.prototype, 'hasClass', function (this: Element, cls: string) {
		return this.classList.contains(cls);
	});
	define(Element.prototype, 'setAttr', function (this: Element, name: string, value: string | number | boolean | null) {
		if (value === null) this.removeAttribute(name);
		else this.setAttribute(name, String(value));
	});
	define(Element.prototype, 'setAttrs', function (this: Element, attrs: Record<string, string | number | boolean | null>) {
		for (const [name, value] of Object.entries(attrs)) {
			if (value === null) this.removeAttribute(name);
			else this.setAttribute(name, String(value));
		}
	});
	define(Element.prototype, 'getAttr', function (this: Element, name: string) {
		return this.getAttribute(name);
	});
	// Obsidian's toggle()/show()/hide() set display; the `hidden` attribute is an observable stand-in.
	define(HTMLElement.prototype, 'toggle', function (this: HTMLElement, show: boolean) {
		this.toggleAttribute('hidden', !show);
	});
	define(HTMLElement.prototype, 'show', function (this: HTMLElement) {
		this.removeAttribute('hidden');
	});
	define(HTMLElement.prototype, 'hide', function (this: HTMLElement) {
		this.setAttribute('hidden', '');
	});
	const setCssProps = function (this: HTMLElement | SVGElement, props: Record<string, string>) {
		for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
	};
	define(HTMLElement.prototype, 'setCssProps', setCssProps);
	define(SVGElement.prototype, 'setCssProps', setCssProps);
}

installObsidianDomHelpers();

// A module, not a global script: imported for its side effect only.
export {};
