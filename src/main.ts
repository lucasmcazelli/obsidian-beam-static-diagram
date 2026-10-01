/**
 * Beam Statics: draws beams from ```beam code blocks and computes support
 * reactions, shear force, bending moment and deflection, entirely offline.
 *
 * This file only wires the plugin into Obsidian. The analysis lives in
 * src/core, the drawings in src/render and the Obsidian UI in src/ui.
 */
import { Plugin, type Editor } from 'obsidian';
import { DEFAULT_BEAM_SOURCE } from './core/examples';
import { BeamStaticsSettingTab, DEFAULT_SETTINGS, normalizeSettings, type BeamStaticsSettings } from './settings';
import { BeamBlockRenderChild } from './ui/beam-block';
import { BeamEditorModal } from './ui/editor-modal';
import { fencedBlockInsertion } from './ui/write-back';

/** Inserts a fenced beam block with `body` at the cursor, replacing any selection. */
function insertBeamBlock(editor: Editor, body: string): void {
	const cursor = editor.getCursor('from');
	const before = editor.getRange({ line: cursor.line, ch: 0 }, cursor);
	editor.replaceSelection(fencedBlockInsertion(before, body));
}

/** The plugin entry point. */
export default class BeamStaticsPlugin extends Plugin {
	settings: BeamStaticsSettings = { ...DEFAULT_SETTINGS };
	/** Beam blocks currently on screen, redrawn when a setting changes. */
	private readonly blocks = new Set<BeamBlockRenderChild>();

	async onload(): Promise<void> {
		await this.loadSettings();

		// Each block gets its own render child, which Obsidian unloads when the block re-renders or the note closes.
		this.registerMarkdownCodeBlockProcessor('beam', (source, el, ctx) => {
			ctx.addChild(new BeamBlockRenderChild(el, this, source, ctx));
		});
		// Those render children belong to each note's renderer, not to the plugin, so Obsidian does
		// not unload them when the plugin is disabled or updated: stop their observers and edit
		// buttons here (each block unregisters itself as it unloads, hence the copy).
		this.register(() => {
			for (const block of [...this.blocks]) block.retire();
		});

		this.addSettingTab(new BeamStaticsSettingTab(this.app, this));

		this.addCommand({
			id: 'insert-beam',
			name: 'Insert beam diagram',
			editorCallback: (editor) => {
				new BeamEditorModal(this.app, this, {
					initialSource: DEFAULT_BEAM_SOURCE,
					mode: 'insert',
					onSubmit: (text) => {
						insertBeamBlock(editor, text);
						return true;
					},
				}).open();
			},
		});
		this.addCommand({
			id: 'insert-beam-template',
			name: 'Insert beam block template',
			editorCallback: (editor) => insertBeamBlock(editor, DEFAULT_BEAM_SOURCE),
		});
	}

	/** Loads data.json, filling in defaults and repairing invalid values. */
	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	/**
	 * data.json changed on disk (Obsidian Sync, another device or program):
	 * reload and redraw. Without this, open blocks would keep the old values,
	 * and the next change in the settings tab would save the stale object over
	 * the synced one. The settings tab reads `this.settings` on every render,
	 * so replacing the object is safe.
	 *
	 * (There is no saveSettings: the declarative settings tab persists values
	 * itself, see BeamStaticsSettingTab.setControlValue.)
	 */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		this.refreshBlocks();
	}

	/** Called by a block when it loads. */
	registerBlock(block: BeamBlockRenderChild): void {
		this.blocks.add(block);
	}

	/** Called by a block when it unloads. */
	unregisterBlock(block: BeamBlockRenderChild): void {
		this.blocks.delete(block);
	}

	/** Redraws every open beam block, e.g. after a settings change. */
	refreshBlocks(): void {
		// Copy first: a redraw never adds or removes blocks today, but iterating a snapshot keeps that safe.
		for (const block of [...this.blocks]) block.refresh();
	}
}
