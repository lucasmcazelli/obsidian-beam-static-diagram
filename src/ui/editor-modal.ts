/**
 * Interactive beam editor: a form and a raw text view of the same block, with
 * a live preview.
 *
 * Data flow:
 * - The form edits a BeamAst (raw strings, exactly what the user types), and
 *   every form change re-derives the block text with serializeBeamAst.
 * - The Text tab edits the block text directly. Switching back to the form
 *   re-parses it; if the text has syntax errors the editor stays on Text and
 *   lists them, because the form cannot represent a line it cannot read.
 * - The preview and the submit button always follow the text, which is what
 *   gets written to the note.
 *
 * The AST cannot hold comments, so re-serializing drops them; a note says so
 * whenever the block being edited has comments.
 *
 * Saving always writes an explicit `units` line (the plugin default when the
 * block has none), so a saved block reads the same on every device and after
 * a settings change.
 */
import { ButtonComponent, Modal, Setting, debounce, type App, type DropdownComponent, type Debouncer } from 'obsidian';
import { BEAM_EXAMPLES, type BeamExample } from '../core/examples';
import { findMaterial, MATERIAL_IDS, MATERIALS } from '../core/materials';
import { emptyAst, parseBeamSource, splitLines } from '../core/parser';
import { SECTION_SHAPES } from '../core/sections';
import { serializeBeamAst } from '../core/serializer';
import type {
	AstHinge,
	AstLoad,
	AstSection,
	AstSupport,
	BeamAst,
	Diagnostic,
	ForceDirection,
	MomentDirection,
	SectionShape,
	SupportKind,
	UnitSystemId,
} from '../core/types';
import { isUnitSystemId, splitQuantity, UNIT_SYSTEMS, unitSymbol } from '../core/units';
import type BeamStaticsPlugin from '../main';
import { UNIT_SYSTEM_IDS } from '../settings';
import { analyzeSafely, diagnosticText, renderBeamOutput } from './beam-view';

/** Shown in the editor when saving an edited block back to the note fails. */
export const WRITE_BACK_FAILED =
	'Could not find this block in the note safely (it changed, or the same beam appears more than once). Copy the text from the Text tab instead';

/** Shown when inserting fails (the insert callback returned false or threw). */
const INSERT_FAILED = 'Could not insert the beam. Copy the text from the Text tab and paste it into the note instead';

/** Preview width when the preview element has not been laid out yet. */
const PREVIEW_FALLBACK_WIDTH = 560;

/** How long the preview waits after the last keystroke before redrawing. */
const PREVIEW_DELAY_MS = 150;

/** Options for opening the editor. */
export interface BeamEditorOptions {
	/** Block text (without fences) to start from. */
	initialSource: string;
	/** 'insert' labels the main button "Insert", 'update' labels it "Update". */
	mode: 'insert' | 'update';
	/**
	 * Called with the final block text. The modal closes only when this
	 * returns (or resolves to) true; otherwise it stays open with an error.
	 */
	onSubmit: (source: string) => Promise<boolean> | boolean;
	/** Error shown when onSubmit returns false. Defaults to a message suited to `mode`. */
	failureMessage?: string;
}

/** The two views of the block. */
export type EditorTab = 'form' | 'text';

// ---------------------------------------------------------------------------
// Pure helpers (no DOM): the form's editing rules, unit tested on their own.
// ---------------------------------------------------------------------------

/** Result of reading block text for the form. */
export type FormParseResult = { ok: true; ast: BeamAst } | { ok: false; errors: Diagnostic[] };

/**
 * Parses block text for the form. Only syntax errors block the form; model
 * errors (a missing length, a position outside the beam) are fine to edit in
 * the form and show up in the preview instead.
 */
export function parseForForm(text: string): FormParseResult {
	const { ast, diagnostics } = parseBeamSource(text);
	const errors = diagnostics.filter((d) => d.severity === 'error');
	return errors.length > 0 ? { ok: false, errors } : { ok: true, ast };
}

/** Trimmed text, or undefined when empty (optional statements are omitted from the block). */
export function optionalText(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

/** Dropdown labels for the load types. */
export const LOAD_KIND_LABELS: Record<AstLoad['kind'], string> = {
	point: 'Point force',
	moment: 'Point moment',
	udl: 'Uniform load',
	linear: 'Linear load',
};

/** Dropdown labels for the support types. */
const SUPPORT_KIND_LABELS: Record<SupportKind, string> = { pin: 'Pin', roller: 'Roller', fixed: 'Fixed' };

/** Dropdown labels for force and couple directions. */
const FORCE_DIRECTION_LABELS: Record<ForceDirection, string> = { down: 'Down', up: 'Up' };
const MOMENT_DIRECTION_LABELS: Record<MomentDirection, string> = { cw: 'Clockwise', ccw: 'Counter-clockwise' };

/** What a load's magnitude measures; units only carry over between loads of the same kind of quantity. */
function magnitudeKind(kind: AstLoad['kind']): 'force' | 'moment' | 'distributed' {
	return kind === 'point' ? 'force' : kind === 'moment' ? 'moment' : 'distributed';
}

/** The number in a raw quantity without its unit ("10 kN" -> "10"); unparseable text is kept as is. */
function numberPart(raw: string): string {
	const parts = splitQuantity(raw);
	return parts.ok ? parts.number : raw;
}

/**
 * Converts a load to another type, keeping what still makes sense:
 * - the magnitude, with its unit only when it measures the same quantity
 *   (udl <-> linear keep "4 kN/m"; point -> udl keeps just "10", since
 *   "10 kN" would be an error for a distributed load);
 * - the direction for forces (couples default to clockwise, shown in the form);
 * - the position: a point keeps its "at", a distributed load turning into a
 *   point goes to its start (or mid-span when it covered the whole beam);
 *   a point turning into a distributed load covers the whole beam.
 */
export function changeLoadKind(load: AstLoad, kind: AstLoad['kind']): AstLoad {
	if (load.kind === kind) return load;
	const raw = load.kind === 'linear' ? load.start : load.magnitude;
	const magnitude = magnitudeKind(load.kind) === magnitudeKind(kind) ? raw : numberPart(raw);
	const at = load.kind === 'point' || load.kind === 'moment' ? load.at : (load.from ?? 'mid');
	const direction: ForceDirection = load.kind === 'moment' ? 'down' : load.direction;
	const span = load.kind === 'udl' || load.kind === 'linear' ? { from: load.from, to: load.to } : {};
	switch (kind) {
		case 'point':
			return { kind, magnitude, direction, at };
		case 'moment':
			return { kind, magnitude, direction: 'cw', at };
		case 'udl':
			return { kind, magnitude, direction, ...span };
		case 'linear':
			return { kind, start: magnitude, end: magnitude, direction, ...span };
	}
}

/** A sensible next support: a pin at the start, then a roller at the end, then rollers at mid-span. */
export function newSupport(ast: BeamAst): AstSupport {
	if (ast.supports.length === 0) return { kind: 'pin', at: '0' };
	if (ast.supports.length === 1) return { kind: 'roller', at: 'end' };
	return { kind: 'roller', at: 'mid' };
}

/** A new hinge at mid-span. */
export function newHinge(): AstHinge {
	return { at: 'mid' };
}

/** A new 10 (default force unit) downward point load at mid-span. */
export function newLoad(): AstLoad {
	return { kind: 'point', magnitude: '10', direction: 'down', at: 'mid' };
}

/**
 * Section dimensions as they must be written so the text means what the form
 * shows. In the form, a bare dimension is in the default section unit (the
 * placeholder of the Dimension unit field says so). Two cases need the unit
 * written out:
 *
 * - A unit after only the LAST dimension applies to all of them in the text,
 *   so form dims ["100", "200 cm"] written as "100 x 200 cm" would read back
 *   as 100 cm x 200 cm. The bare dimensions get the default unit written out
 *   ("100 mm x 200 cm").
 * - In kN-m and kip-ft blocks bare section numbers are an error (the length
 *   unit is m or ft, the section unit mm or in, so "0.1 x 0.2" is ambiguous).
 *   A blank Dimension unit field then writes the default section unit as the
 *   shared unit ("100 x 200 mm").
 *
 * Returns `section` itself when nothing needs changing (N-mm and lb-in keep
 * bare numbers, which mean the same in the text).
 */
export function sectionForText(section: AstSection, units: UnitSystemId): AstSection {
	if (section.unit !== undefined) return section;
	const withUnit = (raw: string): boolean => {
		const parts = splitQuantity(raw);
		return parts.ok && parts.unit !== '';
	};
	const bare = section.dims.filter((d) => d.trim() !== '' && !withUnit(d));
	if (bare.length === 0) return section;
	const unit = unitSymbol('sectionLength', units);
	const last = section.dims[section.dims.length - 1] ?? '';
	if (withUnit(last)) {
		return { ...section, dims: section.dims.map((d) => (d.trim() === '' || withUnit(d) ? d : `${d.trim()} ${unit}`)) };
	}
	return unit !== unitSymbol('length', units) ? { ...section, unit } : section;
}

/**
 * Block text with an explicit `units` line. Bare numbers follow the plugin's
 * default units, so a saved block without a units line would be re-read in
 * other units on a device with another setting. Text that already has a
 * units line, or does not parse, is returned unchanged.
 *
 * The line is inserted, not re-serialized, so comments and layout survive:
 * before the first statement other than the title (the serializer's order).
 */
export function withExplicitUnits(text: string, units: UnitSystemId): string {
	const { ast, diagnostics } = parseBeamSource(text);
	if (ast.units !== undefined || diagnostics.some((d) => d.severity === 'error')) return text;
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = splitLines(text);
	const isStatement = (line: string): boolean => {
		const trimmed = line.trim();
		return trimmed !== '' && !trimmed.startsWith('#') && !trimmed.startsWith('//') && !/^title(?=[\s:=]|$)/i.test(trimmed);
	};
	const index = lines.findIndex(isStatement);
	lines.splice(index < 0 ? lines.length : index, 0, `units ${UNIT_SYSTEMS[units].keyword}`);
	return lines.join(eol);
}

/** Example dimensions of a shape as numbers ("100 x 200 mm" -> ["100", "200"]). */
function exampleDims(shape: SectionShape): string[] {
	return SECTION_SHAPES[shape].example
		.replace(/\s*[a-z]+\s*$/i, '')
		.split(/\s*x\s*/)
		.map((d) => d.trim());
}

/**
 * Switches the section to `shape` (undefined removes it). Dimensions typed so
 * far are kept by position; missing ones are filled from the shape's example
 * so the preview works straight away. A new section uses millimetres.
 */
export function changeSectionShape(section: AstSection | undefined, shape: SectionShape | undefined): AstSection | undefined {
	if (!shape) return undefined;
	const examples = exampleDims(shape);
	const dims = SECTION_SHAPES[shape].dims.map((_, i) => section?.dims[i] ?? examples[i] ?? '');
	return { shape, dims, unit: section ? section.unit : 'mm' };
}

/** Example E and I per unit system, used as placeholders. */
const E_PLACEHOLDER: Record<UnitSystemId, string> = {
	'kN-m': '200 GPa',
	'N-mm': '200000 MPa',
	'kip-ft': '29000 ksi',
	'lb-in': '29000000 psi',
};
const I_PLACEHOLDER: Record<UnitSystemId, string> = {
	'kN-m': '8000 cm^4',
	'N-mm': '80000000 mm^4',
	'kip-ft': '510 in^4',
	'lb-in': '510 in^4',
};

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

/** Modal with a form, a text view and a live preview of one beam block. */
export class BeamEditorModal extends Modal {
	private readonly plugin: BeamStaticsPlugin;
	private readonly options: BeamEditorOptions;
	/** What the form shows. Only meaningful while the text parses. */
	private ast: BeamAst = emptyAst();
	/** The block text: the single source of truth for preview and submit. */
	private text: string;
	/** Text the user started from (initial block or last example), to tell whether they changed anything. */
	private baseline: string;
	private exampleId = '';
	private tab: EditorTab = 'form';
	/** Comment lines in the last parsed text; they are lost once the form re-serializes. */
	private commentCount = 0;
	private hasErrors = true;
	private submitting = false;
	/** Set once closing must not ask any more (saved, or the user chose to discard). */
	private closeConfirmed = false;
	/** CSS selector of the element to focus after the form is rebuilt (keeps keyboard users in place). */
	private pendingFocus: string | null = null;
	private readonly schedulePreview: Debouncer<[], void>;

	// Elements, created in onOpen.
	private exampleDropdown!: DropdownComponent;
	private confirmEl!: HTMLElement;
	private tabButtons!: Record<EditorTab, HTMLButtonElement>;
	private commentNoteEl!: HTMLElement;
	private parseErrorsEl!: HTMLElement;
	private formEl!: HTMLElement;
	private textPanelEl!: HTMLElement;
	private textAreaEl!: HTMLTextAreaElement;
	private previewEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private submitErrorEl!: HTMLElement;
	private submitButton!: ButtonComponent;

	constructor(app: App, plugin: BeamStaticsPlugin, options: BeamEditorOptions) {
		super(app);
		this.plugin = plugin;
		this.options = options;
		this.text = options.initialSource;
		this.baseline = options.initialSource;
		// Drawing the preview is the expensive part; wait until typing pauses.
		this.schedulePreview = debounce(() => this.updatePreview(), PREVIEW_DELAY_MS, true);
	}

	/** The current block text (what Insert / Update would write). */
	getSource(): string {
		return this.text;
	}

	/** The tab currently shown. */
	getTab(): EditorTab {
		return this.tab;
	}

	/** Unit system that bare numbers in the block use, for placeholders. */
	private get units(): UnitSystemId {
		return this.ast.units ?? this.plugin.settings.defaultUnits;
	}

	onOpen(): void {
		this.setTitle('Beam editor');
		this.modalEl.addClass('bsd-modal');
		const { contentEl } = this;
		contentEl.empty();

		this.buildExamplePicker(contentEl);
		this.confirmEl = contentEl.createDiv({ cls: 'bsd-modal-confirm' });
		this.confirmEl.toggle(false);
		this.buildTabs(contentEl);
		this.commentNoteEl = contentEl.createDiv({
			cls: 'bsd-modal-note',
			text: 'Comments in this block will be removed when you edit with the form',
		});
		this.parseErrorsEl = contentEl.createDiv({ cls: 'bsd-error bsd-modal-parse-errors', attr: { role: 'alert' } });
		this.parseErrorsEl.toggle(false);

		// The ids match the tab buttons' aria-controls ("bsd-modal-form", "bsd-modal-text"),
		// and each panel is named by its tab button.
		this.formEl = contentEl.createDiv({ attr: { role: 'tabpanel', id: 'bsd-modal-form', 'aria-labelledby': 'bsd-modal-tab-form' } });
		this.textPanelEl = contentEl.createDiv({ attr: { role: 'tabpanel', id: 'bsd-modal-text', 'aria-labelledby': 'bsd-modal-tab-text' } });
		this.buildTextPanel(this.textPanelEl);

		new Setting(contentEl).setName('Preview').setHeading();
		const previewFrame = contentEl.createDiv({ cls: 'bsd-modal-preview' });
		this.previewEl = previewFrame.createDiv({ cls: 'bsd-block' });

		this.buildFooter(contentEl);

		// Start on the form when the text can be read, otherwise on the text so the problem is visible.
		const parsed = parseForForm(this.text);
		if (parsed.ok) {
			this.ast = parsed.ast;
			this.commentCount = parsed.ast.commentCount;
			this.showTab('form');
		} else {
			this.showTab('text');
		}
		this.updatePreview();

		// Mod+Enter submits from anywhere in the modal, including the textarea.
		this.scope.register(['Mod'], 'Enter', (evt: KeyboardEvent) => {
			evt.preventDefault();
			void this.submit();
			return false;
		});
	}

	/**
	 * Escape, a click on the backdrop, the close button, Cancel and the mobile
	 * back gesture all end up here. With unsaved changes, ask first instead of
	 * silently throwing away a beam that may have taken a while to build.
	 */
	override close(): void {
		if (!this.closeConfirmed && !this.submitting && this.text !== this.baseline) {
			this.askToDiscard();
			return;
		}
		super.close();
	}

	onClose(): void {
		this.schedulePreview.cancel();
		this.contentEl.empty();
	}

	// --- Layout ------------------------------------------------------------

	/** "Start from example" dropdown. */
	private buildExamplePicker(parent: HTMLElement): void {
		new Setting(parent)
			.setName('Start from example')
			.setDesc('Replaces the current beam with a ready-made one')
			.addDropdown((dropdown) => {
				this.exampleDropdown = dropdown;
				// Setting does not link its name to the control, so name the control itself.
				dropdown.selectEl.setAttr('aria-label', 'Start from example');
				dropdown.addOption('', 'Choose an example');
				for (const example of BEAM_EXAMPLES) dropdown.addOption(example.id, example.name);
				dropdown.onChange((id) => {
					const example = BEAM_EXAMPLES.find((e) => e.id === id);
					if (!example) return;
					// Only ask when something would actually be lost.
					if (this.text.trim() !== '' && this.text !== this.baseline) this.askToReplace(example);
					else this.loadExample(example);
				});
			});
	}

	/**
	 * Inline confirmation (window.confirm is blocked on mobile and looks foreign
	 * in Obsidian): `question`, a destructive `action` button and "Keep editing".
	 * The box is a labelled group and focus moves to "Keep editing", so keyboard
	 * and screen reader users learn that a decision is pending and the safe
	 * choice is one key press away.
	 */
	private confirm(question: string, action: string, onAction: () => void, onKeep: () => void): void {
		const el = this.confirmEl;
		el.empty();
		el.setAttrs({ role: 'group', 'aria-labelledby': 'bsd-modal-confirm-question' });
		el.createSpan({ text: question, attr: { id: 'bsd-modal-confirm-question' } });
		const buttons = el.createDiv({ cls: 'bsd-modal-confirm-buttons' });
		new ButtonComponent(buttons)
			.setButtonText(action)
			.setDestructive()
			.onClick(() => {
				el.toggle(false);
				onAction();
			});
		const keep = new ButtonComponent(buttons).setButtonText('Keep editing').onClick(() => {
			el.toggle(false);
			onKeep();
		});
		el.toggle(true);
		keep.buttonEl.focus();
	}

	/** Asks before an example replaces edits. */
	private askToReplace(example: BeamExample): void {
		this.confirm(
			`Replace your changes with the "${example.name}" example?`,
			'Replace',
			() => this.loadExample(example),
			() => {
				this.exampleDropdown.setValue(this.exampleId);
			},
		);
	}

	/** Asks before closing throws away unsaved changes. */
	private askToDiscard(): void {
		this.confirm(
			'Discard your changes?',
			'Discard',
			() => {
				this.closeConfirmed = true;
				this.close();
			},
			() => undefined,
		);
	}

	/** Replaces everything with an example (examples always parse). */
	private loadExample(example: BeamExample): void {
		this.exampleId = example.id;
		this.text = example.source;
		this.baseline = example.source;
		const parsed = parseForForm(example.source);
		if (parsed.ok) {
			this.ast = parsed.ast;
			this.commentCount = parsed.ast.commentCount;
		}
		this.parseErrorsEl.toggle(false);
		this.showTab(parsed.ok ? this.tab : 'text');
		this.hideSubmitError();
		this.updatePreview();
	}

	/**
	 * The Form / Text tab buttons, following the WAI-ARIA tabs pattern: only
	 * the active tab is in the Tab order (roving tabindex, set in showTab), and
	 * the arrow keys, Home and End move between tabs.
	 */
	private buildTabs(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: 'bsd-modal-tabs', attr: { role: 'tablist', 'aria-label': 'Editor view' } });
		const make = (tab: EditorTab, label: string): HTMLButtonElement => {
			const button = bar.createEl('button', {
				cls: 'bsd-modal-tab',
				text: label,
				attr: { type: 'button', role: 'tab', id: `bsd-modal-tab-${tab}`, 'aria-controls': `bsd-modal-${tab}`, 'aria-selected': 'false' },
			});
			button.addEventListener('click', () => this.switchTab(tab));
			return button;
		};
		this.tabButtons = { form: make('form', 'Form'), text: make('text', 'Text') };
		bar.addEventListener('keydown', (evt: KeyboardEvent) => {
			// Two tabs: Left/Right toggle, Home/End go to the first/last.
			let target: EditorTab | null = null;
			if (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight') target = this.tab === 'form' ? 'text' : 'form';
			else if (evt.key === 'Home') target = 'form';
			else if (evt.key === 'End') target = 'text';
			if (!target) return;
			evt.preventDefault();
			this.switchTab(target);
			// Focus the tab actually shown: switching to the form is refused while the text has errors.
			this.tabButtons[this.tab].focus();
		});
	}

	/** The raw text editor. */
	private buildTextPanel(parent: HTMLElement): void {
		this.textAreaEl = parent.createEl('textarea', {
			cls: 'bsd-modal-textarea',
			// No spelling, capitalisation or autocorrect: mobile keyboards would "correct" udl, kN or cm^4.
			attr: {
				'aria-label': 'Beam block text',
				spellcheck: 'false',
				autocapitalize: 'off',
				autocorrect: 'off',
				autocomplete: 'off',
				rows: 14,
			},
		});
		this.textAreaEl.addEventListener('input', () => {
			this.text = this.textAreaEl.value;
			this.hideSubmitError();
			this.schedulePreview();
		});
		parent.createDiv({
			cls: 'bsd-modal-hint',
			text: 'One statement per line, for example: point 10 kN down at 2 m. # or // starts a comment (except in a title).',
		});
	}

	/** Status line, submit error and the Cancel / Insert buttons. */
	private buildFooter(parent: HTMLElement): void {
		const footer = parent.createDiv({ cls: 'bsd-modal-footer' });
		this.submitErrorEl = footer.createDiv({ cls: 'bsd-modal-submit-error', attr: { role: 'alert' } });
		this.submitErrorEl.toggle(false);
		// The one polite live region of the editor: the preview's error box is rebuilt on every
		// typing pause, so it is not live (see renderErrors), and this line speaks for it.
		this.statusEl = footer.createDiv({ cls: 'bsd-modal-status', attr: { role: 'status' } });
		const buttons = footer.createDiv({ cls: 'modal-button-container' });
		new ButtonComponent(buttons).setButtonText('Cancel').onClick(() => this.close());
		this.submitButton = new ButtonComponent(buttons)
			.setButtonText(this.options.mode === 'insert' ? 'Insert' : 'Update')
			.setCta()
			.onClick(() => {
				void this.submit();
			});
	}

	// --- Tabs --------------------------------------------------------------

	/**
	 * Switches tabs. Going to the form re-parses the text; if it has syntax
	 * errors the editor stays on Text and lists them.
	 */
	switchTab(tab: EditorTab): void {
		if (tab === this.tab) return;
		if (tab === 'form') {
			const parsed = parseForForm(this.text);
			if (!parsed.ok) {
				this.showParseErrors(parsed.errors);
				return;
			}
			this.ast = parsed.ast;
			this.commentCount = parsed.ast.commentCount;
		}
		this.parseErrorsEl.toggle(false);
		this.showTab(tab);
	}

	/** Shows `tab` and refreshes its content from the current state. */
	private showTab(tab: EditorTab): void {
		this.tab = tab;
		for (const key of ['form', 'text'] as const) {
			const active = key === tab;
			this.tabButtons[key].toggleClass('is-active', active);
			this.tabButtons[key].setAttrs({ 'aria-selected': active ? 'true' : 'false', tabindex: active ? '0' : '-1' });
		}
		this.formEl.toggle(tab === 'form');
		this.textPanelEl.toggle(tab === 'text');
		this.commentNoteEl.toggle(tab === 'form' && this.commentCount > 0);
		if (tab === 'form') this.renderForm();
		else this.textAreaEl.value = this.text;
	}

	/** Lists syntax errors that keep the text from opening in the form. */
	private showParseErrors(errors: Diagnostic[]): void {
		const el = this.parseErrorsEl;
		el.empty();
		el.createDiv({ cls: 'bsd-error-heading', text: 'Fix these lines before switching to the form:' });
		const list = el.createEl('ul', { cls: 'bsd-error-list' });
		for (const error of errors) list.createEl('li', { text: diagnosticText(error) });
		el.toggle(true);
	}

	// --- Form --------------------------------------------------------------

	/**
	 * Called after every form edit: re-derives the text from the AST and
	 * schedules a preview. `rebuild` redraws the form, needed when rows are
	 * added or removed or a row changes shape (load type, section shape).
	 */
	private formChanged(rebuild = false): void {
		const section = this.ast.section;
		this.text = serializeBeamAst(section ? { ...this.ast, section: sectionForText(section, this.units) } : this.ast);
		this.hideSubmitError();
		if (rebuild) this.renderForm();
		this.schedulePreview();
	}

	/** Rebuilds the whole form from the AST. */
	private renderForm(): void {
		const el = this.formEl;
		el.empty();
		const ast = this.ast;

		// Setting does not link its name to the control, so every control below without an
		// aria-label of its own gets one: otherwise a screen reader announces only the placeholder.
		new Setting(el).setName('Title').addText((text) => {
			text
				.setPlaceholder('My beam')
				.setValue(ast.title ?? '')
				.onChange((value) => {
					ast.title = optionalText(value);
					this.formChanged();
				});
			text.inputEl.setAttr('aria-label', 'Title');
		});
		new Setting(el)
			.setName('Units')
			.setDesc('Units of numbers typed without a unit, and of the results')
			.addDropdown((dropdown) => {
				dropdown.addOption('', `Plugin default (${UNIT_SYSTEMS[this.plugin.settings.defaultUnits].label})`);
				for (const id of UNIT_SYSTEM_IDS) dropdown.addOption(id, UNIT_SYSTEMS[id].label);
				dropdown.setValue(ast.units ?? '').onChange((value) => {
					ast.units = isUnitSystemId(value) ? value : undefined;
					// Placeholders show units, so redraw (and keep the focus on this dropdown).
					this.pendingFocus = '[data-bsd-focus="units"]';
					this.formChanged(true);
				});
				dropdown.selectEl.setAttrs({ 'data-bsd-focus': 'units', 'aria-label': 'Units' });
			});
		new Setting(el).setName('Length').addText((text) => {
			text
				.setPlaceholder(`6 ${unitSymbol('length', this.units)}`)
				.setValue(ast.length ?? '')
				.onChange((value) => {
					ast.length = optionalText(value);
					this.formChanged();
				});
			text.inputEl.setAttr('aria-label', 'Length');
		});

		this.renderSupports(el);
		this.renderHinges(el);
		this.renderLoads(el);
		this.renderStiffness(el);

		if (this.pendingFocus) {
			el.querySelector<HTMLElement>(this.pendingFocus)?.focus();
			this.pendingFocus = null;
		}
	}

	/** Small text between controls of a row ("at", "from", "to"). */
	private inlineLabel(setting: Setting, text: string): void {
		setting.controlEl.createSpan({ cls: 'bsd-modal-inline-label', text });
	}

	/** Trash button that removes row `index` of `list`. */
	private removeButton(setting: Setting, list: unknown[], index: number, tooltip: string, addKey: string): void {
		setting.addExtraButton((button) =>
			button
				.setIcon('trash-2')
				.setTooltip(tooltip)
				.onClick(() => {
					list.splice(index, 1);
					this.pendingFocus = `[data-bsd-add="${addKey}"]`;
					this.formChanged(true);
				}),
		);
	}

	/** "Add ..." button below a list. */
	private addButton(parent: HTMLElement, label: string, key: string, add: () => number): void {
		new Setting(parent).setClass('bsd-modal-add').addButton((button) => {
			button.setButtonText(label).onClick(() => {
				const index = add();
				this.pendingFocus = `[data-bsd-row="${key}-${index}"]`;
				this.formChanged(true);
			});
			button.buttonEl.setAttr('data-bsd-add', key);
		});
	}

	private renderSupports(el: HTMLElement): void {
		new Setting(el).setName('Supports').setHeading();
		this.ast.supports.forEach((support, index) => {
			const label = `support ${index + 1}`;
			const row = new Setting(el).setName(`Support ${index + 1}`).setClass('bsd-modal-row');
			row.addDropdown((dropdown) => {
				dropdown
					.addOptions(SUPPORT_KIND_LABELS)
					.setValue(support.kind)
					.onChange((value) => {
						support.kind = value === 'fixed' || value === 'roller' ? value : 'pin';
						this.formChanged();
					});
				dropdown.selectEl.setAttrs({ 'aria-label': `Type of ${label}`, 'data-bsd-row': `supports-${index}` });
			});
			this.inlineLabel(row, 'at');
			row.addText((text) => {
				text
					.setPlaceholder('0, mid or end')
					.setValue(support.at)
					.onChange((value) => {
						support.at = value.trim();
						this.formChanged();
					});
				text.inputEl.setAttr('aria-label', `Position of ${label}`);
			});
			this.removeButton(row, this.ast.supports, index, 'Remove support', 'supports');
		});
		this.addButton(el, 'Add support', 'supports', () => this.ast.supports.push(newSupport(this.ast)) - 1);
	}

	private renderHinges(el: HTMLElement): void {
		new Setting(el).setName('Hinges').setHeading().setDesc('An internal hinge carries no bending moment');
		this.ast.hinges.forEach((hinge, index) => {
			const row = new Setting(el).setName(`Hinge ${index + 1}`).setClass('bsd-modal-row');
			this.inlineLabel(row, 'at');
			row.addText((text) => {
				text
					.setPlaceholder('4, mid')
					.setValue(hinge.at)
					.onChange((value) => {
						hinge.at = value.trim();
						this.formChanged();
					});
				text.inputEl.setAttrs({ 'aria-label': `Position of hinge ${index + 1}`, 'data-bsd-row': `hinges-${index}` });
			});
			this.removeButton(row, this.ast.hinges, index, 'Remove hinge', 'hinges');
		});
		this.addButton(el, 'Add hinge', 'hinges', () => this.ast.hinges.push(newHinge()) - 1);
	}

	private renderLoads(el: HTMLElement): void {
		new Setting(el).setName('Loads').setHeading();
		const units = this.units;
		this.ast.loads.forEach((load, index) => {
			const label = `load ${index + 1}`;
			const row = new Setting(el).setName(`Load ${index + 1}`).setClass('bsd-modal-row');

			row.addDropdown((dropdown) => {
				dropdown
					.addOptions(LOAD_KIND_LABELS)
					.setValue(load.kind)
					.onChange((value) => {
						const kind = Object.prototype.hasOwnProperty.call(LOAD_KIND_LABELS, value) ? (value as AstLoad['kind']) : 'point';
						this.ast.loads[index] = changeLoadKind(load, kind);
						this.pendingFocus = `[data-bsd-row="loads-${index}"]`;
						this.formChanged(true);
					});
				dropdown.selectEl.setAttrs({ 'aria-label': `Type of ${label}`, 'data-bsd-row': `loads-${index}` });
			});

			// Magnitude (start and end values for a linear load).
			if (load.kind === 'linear') {
				const unit = unitSymbol('distributed', units);
				row.addText((text) => {
					text
						.setPlaceholder(`0 ${unit}`)
						.setValue(load.start)
						.onChange((value) => {
							load.start = value.trim();
							this.formChanged();
						});
					text.inputEl.setAttr('aria-label', `Start value of ${label}`);
				});
				this.inlineLabel(row, 'to');
				row.addText((text) => {
					text
						.setPlaceholder(`6 ${unit}`)
						.setValue(load.end)
						.onChange((value) => {
							load.end = value.trim();
							this.formChanged();
						});
					text.inputEl.setAttr('aria-label', `End value of ${label}`);
				});
			} else {
				const example = load.kind === 'point' ? `10 ${unitSymbol('force', units)}` : load.kind === 'moment' ? `5 ${unitSymbol('moment', units)}` : `4 ${unitSymbol('distributed', units)}`;
				row.addText((text) => {
					text
						.setPlaceholder(example)
						.setValue(load.magnitude)
						.onChange((value) => {
							load.magnitude = value.trim();
							this.formChanged();
						});
					text.inputEl.setAttr('aria-label', `Magnitude of ${label}`);
				});
			}

			// Direction: down / up for forces, clockwise / counter-clockwise for couples.
			row.addDropdown((dropdown) => {
				if (load.kind === 'moment') {
					dropdown
						.addOptions(MOMENT_DIRECTION_LABELS)
						.setValue(load.direction)
						.onChange((value) => {
							load.direction = value === 'ccw' ? 'ccw' : 'cw';
							this.formChanged();
						});
				} else {
					dropdown
						.addOptions(FORCE_DIRECTION_LABELS)
						.setValue(load.direction)
						.onChange((value) => {
							load.direction = value === 'up' ? 'up' : 'down';
							this.formChanged();
						});
				}
				dropdown.selectEl.setAttr('aria-label', `Direction of ${label}`);
			});

			// Position: one point, or an extent (empty "from" and "to" mean the whole beam).
			if (load.kind === 'point' || load.kind === 'moment') {
				this.inlineLabel(row, 'at');
				row.addText((text) => {
					text
						.setPlaceholder('2, mid or end')
						.setValue(load.at)
						.onChange((value) => {
							load.at = value.trim();
							this.formChanged();
						});
					text.inputEl.setAttr('aria-label', `Position of ${label}`);
				});
			} else {
				this.inlineLabel(row, 'from');
				row.addText((text) => {
					text
						.setPlaceholder('Beam start')
						.setValue(load.from ?? '')
						.onChange((value) => {
							load.from = optionalText(value);
							this.formChanged();
						});
					text.inputEl.setAttr('aria-label', `Start position of ${label} (empty for the whole beam)`);
				});
				this.inlineLabel(row, 'to');
				row.addText((text) => {
					text
						.setPlaceholder('Beam end')
						.setValue(load.to ?? '')
						.onChange((value) => {
							load.to = optionalText(value);
							this.formChanged();
						});
					text.inputEl.setAttr('aria-label', `End position of ${label} (empty for the whole beam)`);
				});
			}
			this.removeButton(row, this.ast.loads, index, 'Remove load', 'loads');
		});
		this.addButton(el, 'Add load', 'loads', () => this.ast.loads.push(newLoad()) - 1);
	}

	/** Material / E and section / I, which together enable the deflection diagram. */
	private renderStiffness(el: HTMLElement): void {
		const ast = this.ast;
		const units = this.units;
		new Setting(el)
			.setName('Deflection (optional)')
			.setHeading()
			.setDesc('Set a material or the elastic modulus, and a section or the second moment of area, to draw the deflected shape');

		new Setting(el).setName('Material').addDropdown((dropdown) => {
			dropdown.addOption('', 'None');
			for (const id of MATERIAL_IDS) dropdown.addOption(id, MATERIALS[id].label);
			const known = ast.material === undefined ? undefined : findMaterial(ast.material);
			// Keep an unrecognised name selectable so opening the form never silently changes it.
			if (ast.material !== undefined && !known) dropdown.addOption(ast.material, `${ast.material} (unknown)`);
			dropdown.setValue(known ? known.id : (ast.material ?? '')).onChange((value) => {
				ast.material = optionalText(value);
				this.formChanged();
			});
			dropdown.selectEl.setAttr('aria-label', 'Material');
		});
		new Setting(el)
			.setName('E')
			.setDesc('Elastic modulus; overrides the material')
			.addText((text) => {
				text
					.setPlaceholder(E_PLACEHOLDER[units])
					.setValue(ast.E ?? '')
					.onChange((value) => {
						ast.E = optionalText(value);
						this.formChanged();
					});
				text.inputEl.setAttr('aria-label', 'E (elastic modulus)');
			});

		new Setting(el).setName('Section').addDropdown((dropdown) => {
			dropdown.addOption('', 'None');
			for (const info of Object.values(SECTION_SHAPES)) dropdown.addOption(info.shape, info.label);
			dropdown.setValue(ast.section?.shape ?? '').onChange((value) => {
				const shape = Object.prototype.hasOwnProperty.call(SECTION_SHAPES, value) ? (value as SectionShape) : undefined;
				ast.section = changeSectionShape(ast.section, shape);
				this.pendingFocus = '[data-bsd-focus="section"]';
				this.formChanged(true);
			});
			dropdown.selectEl.setAttrs({ 'data-bsd-focus': 'section', 'aria-label': 'Section' });
		});
		const section = ast.section;
		if (section) {
			const info = SECTION_SHAPES[section.shape];
			const examples = exampleDims(section.shape);
			info.dimLabels.forEach((dimLabel, i) => {
				new Setting(el)
					.setName(dimLabel)
					.setClass('bsd-modal-dim')
					.addText((text) => {
						text
							.setPlaceholder(examples[i] ?? '')
							.setValue(section.dims[i] ?? '')
							.onChange((value) => {
								section.dims[i] = value.trim();
								this.formChanged();
							});
						text.inputEl.setAttr('aria-label', dimLabel);
					});
			});
			new Setting(el)
				.setName('Dimension unit')
				.setClass('bsd-modal-dim')
				.setDesc(`Applies to every dimension above without a unit of its own; blank means ${unitSymbol('sectionLength', units)}`)
				.addText((text) => {
					text
						.setPlaceholder(unitSymbol('sectionLength', units))
						.setValue(section.unit ?? '')
						.onChange((value) => {
							section.unit = optionalText(value);
							this.formChanged();
						});
					text.inputEl.setAttr('aria-label', 'Dimension unit');
				});
		}
		new Setting(el)
			.setName('I')
			.setDesc('Second moment of area; overrides the section (stress still uses the section depth)')
			.addText((text) => {
				text
					.setPlaceholder(I_PLACEHOLDER[units])
					.setValue(ast.I ?? '')
					.onChange((value) => {
						ast.I = optionalText(value);
						this.formChanged();
					});
				text.inputEl.setAttr('aria-label', 'I (second moment of area)');
			});
	}

	// --- Preview and submit ------------------------------------------------

	/** Analyses the current text, redraws the preview and enables or disables the submit button. */
	private updatePreview(): void {
		const settings = this.plugin.settings;
		const analysis = analyzeSafely(this.text, settings.defaultUnits, settings.decimals);
		this.hasErrors = !analysis.results || analysis.diagnostics.some((d) => d.severity === 'error');
		this.submitButton.setDisabled(this.hasErrors || this.submitting);
		// The status line is a live region: rewriting the same text on every typing pause would
		// make some screen readers repeat it, so only a real change touches it.
		const status = this.hasErrors ? 'Fix the problems shown in the preview to continue' : '';
		if (this.statusEl.getText() !== status) this.statusEl.setText(status);
		this.statusEl.toggle(this.hasErrors);
		const width = this.previewEl.clientWidth > 0 ? this.previewEl.clientWidth : PREVIEW_FALLBACK_WIDTH;
		renderBeamOutput(this.previewEl, analysis, settings, width, this.text);
	}

	private hideSubmitError(): void {
		this.submitErrorEl.toggle(false);
	}

	/**
	 * Submits the current text if it analyses without errors, with an explicit
	 * units line added when it has none (see withExplicitUnits). The modal
	 * closes only when onSubmit succeeds; otherwise an inline error explains
	 * what to do and the text stays available.
	 */
	async submit(): Promise<void> {
		if (this.submitting) return;
		// Analyse the latest text now rather than trusting a preview that may still be pending.
		this.schedulePreview.cancel();
		this.updatePreview();
		if (this.hasErrors) return;

		this.submitting = true;
		this.submitButton.setDisabled(true);
		this.hideSubmitError();
		let ok = false;
		try {
			ok = await this.options.onSubmit(withExplicitUnits(this.text, this.plugin.settings.defaultUnits));
		} catch {
			ok = false;
		}
		this.submitting = false;
		if (ok) {
			// Saved: nothing is lost by closing, so do not ask.
			this.closeConfirmed = true;
			this.close();
			return;
		}
		this.submitErrorEl.setText(this.options.failureMessage ?? (this.options.mode === 'update' ? WRITE_BACK_FAILED : INSERT_FAILED));
		this.submitErrorEl.toggle(true);
		this.submitButton.setDisabled(this.hasErrors);
	}
}
