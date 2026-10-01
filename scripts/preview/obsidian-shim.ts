/**
 * Stand-in for the 'obsidian' module in the browser preview.
 *
 * The real 'obsidian' npm package ships type definitions only, so a browser
 * bundle needs something to import at runtime. The renderer itself never
 * calls these: they only exist because modules on its import path declare
 * classes at load time (src/settings.ts defines a PluginSettingTab subclass).
 *
 * esbuild fails the preview build with "No matching export" if the renderer
 * starts importing something new from 'obsidian'. Add an empty stub here
 * when that happens, and never add behaviour: the preview must show what
 * the plugin draws, not what a stub pretends.
 *
 * Development tool only (npm run preview): never bundled into the plugin.
 */

export class Component {}
export class Plugin {}
export class PluginSettingTab {
	constructor(..._args: unknown[]) {}
}
export class Modal {}
export class Setting {}
export class ButtonComponent {}
export class MarkdownRenderChild {}
export class MarkdownView {}
export class Notice {}

/** No-op: icons are not part of the drawings. */
export function setIcon(): void {}

/** Runs immediately; the preview has no need to delay calls. */
export function debounce<T extends (...args: never[]) => void>(fn: T): T {
	return fn;
}
