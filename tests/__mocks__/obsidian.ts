/**
 * Minimal runtime stub of the 'obsidian' module for vitest.
 *
 * The real 'obsidian' package only ships type definitions, so importing it
 * at runtime outside the app fails. Only add what a test actually needs:
 * code under src/core and src/render must never import 'obsidian' at all.
 *
 * The UI classes below (Modal, Setting and its components) build DOM with
 * Obsidian's element helpers (createDiv, createEl), exactly like the real
 * app, so they need a DOM environment where those helpers are installed:
 * tests/ui-smoke.test.ts polyfills them in happy-dom. The Node-only core
 * tests never touch these classes. Behaviour follows the documented API in
 * obsidian.d.ts closely enough for smoke tests, nothing more.
 */

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Lifecycle container: register() callbacks run on unload, like the real Component. */
export class Component {
	private cleanups: (() => void)[] = [];
	private children: Component[] = [];
	loaded = false;

	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		this.onload();
		for (const child of this.children) child.load();
	}

	onload(): void {}

	unload(): void {
		if (!this.loaded) return;
		this.loaded = false;
		for (const child of this.children) child.unload();
		for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
		this.onunload();
	}

	onunload(): void {}

	addChild<T extends Component>(child: T): T {
		this.children.push(child);
		if (this.loaded) child.load();
		return child;
	}

	register(cb: () => unknown): void {
		this.cleanups.push(() => {
			cb();
		});
	}

	registerDomEvent(el: EventTarget, type: string, callback: (evt: Event) => unknown, options?: boolean | AddEventListenerOptions): void {
		el.addEventListener(type, callback, options);
		this.register(() => el.removeEventListener(type, callback, options));
	}

	/** Keeps the event refs so tests can check what was registered; the real one detaches them on unload. */
	readonly eventRefs: unknown[] = [];
	registerEvent(ref: unknown): void {
		this.eventRefs.push(ref);
	}
}

export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) {
		super();
	}
}

export class Notice {
	constructor(public message: string) {}
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/** A debounced function with cancel() and run(), like Obsidian's Debouncer. */
export interface Debouncer<T extends unknown[], V> {
	(...args: [...T]): this;
	cancel(): this;
	run(): V | void;
}

/** Timer-based debounce with the same contract as Obsidian's. */
export function debounce<T extends unknown[], V>(cb: (...args: [...T]) => V, timeout = 0, resetTimer = false): Debouncer<T, V> {
	let timer: number | undefined;
	let pending: T | undefined;
	const fire = (): V | void => {
		timer = undefined;
		const args = pending;
		pending = undefined;
		return args ? cb(...args) : undefined;
	};
	const debounced = ((...args: T) => {
		pending = args;
		if (timer !== undefined && !resetTimer) return debounced;
		if (timer !== undefined) window.clearTimeout(timer);
		timer = window.setTimeout(fire, timeout);
		return debounced;
	}) as Debouncer<T, V>;
	debounced.cancel = () => {
		if (timer !== undefined) window.clearTimeout(timer);
		timer = undefined;
		pending = undefined;
		return debounced;
	};
	debounced.run = () => {
		if (timer === undefined) return undefined;
		window.clearTimeout(timer);
		return fire();
	};
	return debounced;
}

/** Records the icon name instead of drawing it. */
export function setIcon(el: HTMLElement, icon: string): void {
	el.setAttribute('data-icon', icon);
}

export function setTooltip(el: HTMLElement, tooltip: string): void {
	el.setAttribute('aria-label', tooltip);
}

// ---------------------------------------------------------------------------
// Workspace and vault
// ---------------------------------------------------------------------------

export class TFile {
	constructor(public path = '') {}
}

/** Stand-in for MarkdownView: tests assign `file` and `editor`. */
export class MarkdownView {
	file: TFile | null = null;
	editor: unknown = null;
	getMode(): 'source' | 'preview' {
		return 'source';
	}
}

// ---------------------------------------------------------------------------
// Plugin and settings
// ---------------------------------------------------------------------------

export class Plugin extends Component {
	commands: { id: string; name: string; hotkeys?: unknown[] }[] = [];
	codeBlockProcessors = new Map<string, (source: string, el: HTMLElement, ctx: unknown) => unknown>();
	settingTabs: unknown[] = [];
	data: unknown = null;

	constructor(
		public app: unknown,
		public manifest: unknown,
	) {
		super();
	}

	addCommand<C extends { id: string; name: string }>(command: C): C {
		this.commands.push(command);
		return command;
	}

	registerMarkdownCodeBlockProcessor(language: string, handler: (source: string, el: HTMLElement, ctx: unknown) => unknown): void {
		this.codeBlockProcessors.set(language, handler);
	}

	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}

	loadData(): Promise<unknown> {
		return Promise.resolve(this.data);
	}

	saveData(data: unknown): Promise<void> {
		this.data = JSON.parse(JSON.stringify(data)) as unknown;
		return Promise.resolve();
	}
}

/** Reads and writes `plugin.settings[key]` and persists, as documented for PluginSettingTab. */
export class PluginSettingTab {
	containerEl: HTMLElement | null = null;

	constructor(
		public app: unknown,
		protected readonly hostPlugin: Plugin & { settings?: unknown },
	) {}

	getControlValue(key: string): unknown {
		return (this.hostPlugin.settings as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.hostPlugin.settings as Record<string, unknown>)[key] = value;
		await this.hostPlugin.saveData(this.hostPlugin.settings);
	}
}

// ---------------------------------------------------------------------------
// Modal and Setting (DOM only, for happy-dom tests)
// ---------------------------------------------------------------------------

/** Keyboard scope: records registrations so tests can trigger them. */
export class Scope {
	handlers: { modifiers: string[] | null; key: string | null; func: (evt: KeyboardEvent) => unknown }[] = [];
	register(modifiers: string[] | null, key: string | null, func: (evt: KeyboardEvent) => unknown): void {
		this.handlers.push({ modifiers, key, func });
	}
}

export class Modal {
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	scope = new Scope();
	isOpen = false;

	constructor(public app: unknown) {
		this.containerEl = createDiv({ cls: 'modal-container' });
		this.modalEl = this.containerEl.createDiv({ cls: 'modal' });
		this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' });
		this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
	}

	open(): void {
		document.body.appendChild(this.containerEl);
		this.isOpen = true;
		void this.onOpen();
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.onClose();
		this.containerEl.remove();
	}

	onOpen(): void | Promise<void> {}
	onClose(): void {}

	setTitle(title: string): this {
		this.titleEl.textContent = title;
		return this;
	}
}

abstract class BaseComponent {
	disabled = false;
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
}

export class TextComponent extends BaseComponent {
	inputEl: HTMLInputElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.inputEl = containerEl.createEl('input', { type: 'text' });
	}
	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}
	getValue(): string {
		return this.inputEl.value;
	}
	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}
	onChange(callback: (value: string) => unknown): this {
		this.inputEl.addEventListener('input', () => callback(this.inputEl.value));
		return this;
	}
}

export class DropdownComponent extends BaseComponent {
	selectEl: HTMLSelectElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.selectEl = containerEl.createEl('select');
	}
	addOption(value: string, display: string): this {
		this.selectEl.createEl('option', { value, text: display });
		return this;
	}
	addOptions(options: Record<string, string>): this {
		for (const [value, display] of Object.entries(options)) this.addOption(value, display);
		return this;
	}
	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}
	getValue(): string {
		return this.selectEl.value;
	}
	onChange(callback: (value: string) => unknown): this {
		this.selectEl.addEventListener('change', () => callback(this.selectEl.value));
		return this;
	}
}

export class ButtonComponent extends BaseComponent {
	buttonEl: HTMLButtonElement;
	cta = false;
	destructive = false;
	constructor(containerEl: HTMLElement) {
		super();
		this.buttonEl = containerEl.createEl('button');
	}
	setButtonText(name: string): this {
		this.buttonEl.textContent = name;
		return this;
	}
	setCta(): this {
		this.cta = true;
		this.buttonEl.classList.add('mod-cta');
		return this;
	}
	setWarning(): this {
		return this.setDestructive();
	}
	setDestructive(): this {
		this.destructive = true;
		this.buttonEl.classList.add('mod-destructive');
		return this;
	}
	setIcon(icon: string): this {
		setIcon(this.buttonEl, icon);
		return this;
	}
	setTooltip(tooltip: string): this {
		this.buttonEl.setAttribute('aria-label', tooltip);
		return this;
	}
	override setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.buttonEl.disabled = disabled;
		return this;
	}
	onClick(callback: (evt: MouseEvent) => unknown): this {
		this.buttonEl.addEventListener('click', (evt) => {
			if (!this.buttonEl.disabled) callback(evt);
		});
		return this;
	}
}

export class ExtraButtonComponent extends BaseComponent {
	extraSettingsEl: HTMLElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.extraSettingsEl = containerEl.createDiv({ cls: 'clickable-icon extra-setting-button' });
	}
	setIcon(icon: string): this {
		setIcon(this.extraSettingsEl, icon);
		return this;
	}
	setTooltip(tooltip: string): this {
		this.extraSettingsEl.setAttribute('aria-label', tooltip);
		return this;
	}
	onClick(callback: () => unknown): this {
		this.extraSettingsEl.addEventListener('click', () => callback());
		return this;
	}
}

export class Setting {
	settingEl: HTMLElement;
	infoEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	components: BaseComponent[] = [];

	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
		this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
		this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
		this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
		this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
	}

	setName(name: string): this {
		this.nameEl.textContent = name;
		return this;
	}
	setDesc(desc: string): this {
		this.descEl.textContent = desc;
		return this;
	}
	setClass(cls: string): this {
		this.settingEl.classList.add(...cls.split(/\s+/).filter(Boolean));
		return this;
	}
	setHeading(): this {
		this.settingEl.classList.add('setting-item-heading');
		return this;
	}
	addText(cb: (component: TextComponent) => unknown): this {
		const component = new TextComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}
	addDropdown(cb: (component: DropdownComponent) => unknown): this {
		const component = new DropdownComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}
	addButton(cb: (component: ButtonComponent) => unknown): this {
		const component = new ButtonComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}
	addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
		const component = new ExtraButtonComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}
}
