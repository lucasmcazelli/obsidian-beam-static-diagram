/**
 * The live renderer of one ```beam code block in a note.
 *
 * As a MarkdownRenderChild it is unloaded automatically when Obsidian
 * re-renders the block (the user edited it) or the note closes, and every
 * listener registered through this.register* is removed with it.
 */
import { MarkdownRenderChild, debounce, setIcon, type MarkdownPostProcessorContext } from 'obsidian';
import type { AnalysisOutput, UnitSystemId } from '../core/types';
import type BeamStaticsPlugin from '../main';
import { analyzeSafely, renderBeamOutput } from './beam-view';
import { BeamEditorModal } from './editor-modal';
import { replaceBlockSource } from './write-back';

/** Width used before the block is attached to the page and has a measurable size. */
const FALLBACK_WIDTH = 640;

/** Delay after the last resize before redrawing, so dragging a pane edge redraws once. */
const RESIZE_DELAY_MS = 100;

/** Renders a beam block, redraws it on resize and settings changes, and offers the editor. */
export class BeamBlockRenderChild extends MarkdownRenderChild {
	private readonly plugin: BeamStaticsPlugin;
	private readonly source: string;
	private readonly ctx: MarkdownPostProcessorContext;
	/**
	 * Path of the note this block is in. Starts as ctx.sourcePath, which is a
	 * snapshot from render time: renaming the note does not change the block's
	 * text, so the block is not re-rendered and ctx keeps the old path. The
	 * vault's rename event keeps this copy current for saving.
	 */
	private sourcePath: string;
	private outputEl: HTMLElement | null = null;
	/**
	 * Cached analysis (it does not depend on width) and the settings it was
	 * made with: the default units, and the decimals used in warning messages.
	 */
	private analysis: AnalysisOutput | null = null;
	private analysisUnits: UnitSystemId | null = null;
	private analysisDecimals: number | null = null;
	/** Width of the last render, 0 when it used the fallback because the block was not laid out yet. */
	private renderedWidth = 0;
	private observer: ResizeObserver | null = null;

	constructor(containerEl: HTMLElement, plugin: BeamStaticsPlugin, source: string, ctx: MarkdownPostProcessorContext) {
		super(containerEl);
		this.plugin = plugin;
		this.source = source;
		this.ctx = ctx;
		this.sourcePath = ctx.sourcePath;
	}

	onload(): void {
		this.containerEl.addClass('bsd-block');
		this.createToolbar();
		this.outputEl = this.containerEl.createDiv({ cls: 'bsd-output' });
		this.render();
		this.plugin.registerBlock(this);
		this.register(() => this.plugin.unregisterBlock(this));
		this.registerEvent(
			this.plugin.app.vault.on('rename', (file, oldPath) => {
				if (oldPath === this.sourcePath) this.sourcePath = file.path;
			}),
		);
		this.watchWidth();
	}

	/** Redraws after a settings change; render() re-analyses only when the default units or decimals changed. */
	refresh(): void {
		this.render();
	}

	/**
	 * Stops the block for good because the plugin is being unloaded (disabled
	 * or updated). The block belongs to the note's renderer, not to the
	 * plugin, so Obsidian does not unload it then: without this, its observers
	 * would keep redrawing with the old code and its edit button would keep
	 * writing to the vault through the old plugin instance. The drawing stays
	 * on screen until the note re-renders. Unloading again later (when the
	 * renderer does) is a no-op.
	 */
	retire(): void {
		this.unload();
		this.containerEl.querySelector('.bsd-toolbar')?.remove();
	}

	/** Draws the block at the output element's current width. */
	private render(): void {
		const el = this.outputEl;
		if (!el) return;
		const settings = this.plugin.settings;
		if (!this.analysis || this.analysisUnits !== settings.defaultUnits || this.analysisDecimals !== settings.decimals) {
			this.analysis = analyzeSafely(this.source, settings.defaultUnits, settings.decimals);
			this.analysisUnits = settings.defaultUnits;
			this.analysisDecimals = settings.decimals;
		}
		const width = el.clientWidth;
		this.renderedWidth = width;
		renderBeamOutput(el, this.analysis, settings, width > 0 ? width : FALLBACK_WIDTH, this.source);
	}

	/**
	 * Redraws when the available width changes, e.g. when a pane is resized
	 * or the block first gets laid out. Only a real change of at least 1 px
	 * (and a non-zero width, which a hidden tab reports) triggers a redraw;
	 * a redraw changes the height but not the width, so this cannot loop.
	 */
	private watchWidth(): void {
		/** Redraws if the width really changed since the last render. */
		const redrawIfResized = (): void => {
			const width = this.outputEl?.clientWidth ?? 0;
			if (width > 0 && Math.abs(width - this.renderedWidth) >= 1) this.render();
		};
		const onResize = debounce(redrawIfResized, RESIZE_DELAY_MS, true);
		this.register(() => onResize.cancel());

		// The first real size arrives when Obsidian inserts the block into the page. Waiting for the
		// debounce would show the fallback-width drawing for a moment, so redraw on the next frame.
		// (Not inside the observer callback itself: changing the observed element's size there
		// triggers a "ResizeObserver loop" warning.)
		let frame = 0;
		let frameWin: Window = window;
		const redrawNextFrame = (win: Window): void => {
			if (frame) return;
			frameWin = win;
			frame = win.requestAnimationFrame(() => {
				frame = 0;
				redrawIfResized();
			});
		};
		this.register(() => {
			if (frame) frameWin.cancelAnimationFrame(frame);
		});

		const observe = (): void => {
			this.observer?.disconnect();
			this.observer = null;
			// Use the ResizeObserver of the window the block lives in, so blocks in popout windows work.
			const win = this.containerEl.win ?? window;
			// Window's type does not list its constructors, hence the narrow cast.
			const Observer = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
			if (typeof Observer !== 'function') return;
			this.observer = new Observer(() => {
				if (this.renderedWidth === 0) redrawNextFrame(win);
				else onResize();
			});
			this.observer.observe(this.containerEl);
		};
		observe();
		this.register(() => {
			this.observer?.disconnect();
			this.observer = null;
		});
		// A note dragged into a popout window moves its elements to another window: observe from there.
		if (typeof this.containerEl.onWindowMigrated === 'function') {
			this.register(this.containerEl.onWindowMigrated(() => observe()));
		}
	}

	/** Edit button at the top left (Live Preview's own edit button sits at the top right). */
	private createToolbar(): void {
		const toolbar = this.containerEl.createDiv({ cls: 'bsd-toolbar' });
		const button = toolbar.createEl('button', {
			cls: ['bsd-toolbar-button', 'clickable-icon'],
			attr: { type: 'button', 'aria-label': 'Edit beam' },
		});
		setIcon(button, 'pencil');
		// In Live Preview a press inside a rendered block moves the cursor into its source;
		// stop the events so the button opens the editor instead.
		this.registerDomEvent(button, 'mousedown', (evt) => evt.stopPropagation());
		this.registerDomEvent(button, 'pointerdown', (evt) => evt.stopPropagation());
		this.registerDomEvent(button, 'click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.openEditor();
		});
	}

	/** Opens the editor on this block; saving writes the new text back into the note. */
	openEditor(): void {
		new BeamEditorModal(this.plugin.app, this.plugin, {
			initialSource: this.source,
			mode: 'update',
			onSubmit: async (text) => {
				// Nothing to write: succeed without touching the file (and its modified time). A block with
				// bare numbers is not "unchanged": the editor adds its units line (see withExplicitUnits).
				if (text === this.source) return true;
				return replaceBlockSource(this.plugin.app, this.ctx, this.containerEl, text, this.source, this.sourcePath);
			},
		}).open();
	}
}
