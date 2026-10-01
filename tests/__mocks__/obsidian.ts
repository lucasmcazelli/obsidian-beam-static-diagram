/**
 * Minimal runtime stub of the 'obsidian' module for vitest.
 *
 * The real 'obsidian' package only ships type definitions, so importing it
 * at runtime outside the app fails. Only add what a test actually needs:
 * code under src/core and src/render must never import 'obsidian' at all.
 */
export class Component {
	load(): void {}
	onload(): void {}
	unload(): void {}
	onunload(): void {}
}

export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) {
		super();
	}
}

export class Notice {
	constructor(public message: string) {}
}
