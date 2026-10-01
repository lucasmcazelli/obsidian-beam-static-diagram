/**
 * Builds the browser preview: preview/index.html, a single self-contained
 * page that runs the plugin's real renderer (src/ui/beam-view.ts) outside
 * Obsidian. Run it with `npm run preview`, then open the file in a browser.
 *
 * How it works:
 * - esbuild bundles scripts/preview/entry.ts (which imports the renderer)
 *   for the browser, replacing the 'obsidian' module with a tiny shim
 *   (obsidian-shim.ts) and installing Obsidian's DOM helpers (polyfill.ts);
 * - the page inlines styles.css (the plugin's real styles), theme.css
 *   (stand-ins for Obsidian's theme variables) and the bundle, so it opens
 *   straight from disk with no server.
 *
 * Development tool only: the plugin build (esbuild.config.mjs) never touches
 * these files, and the output folder preview/ is git-ignored.
 */
import esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const outFile = join(root, 'preview', 'index.html');

// Bundle the page script and everything it imports from src/ into one IIFE.
const result = await esbuild.build({
	absWorkingDir: root,
	entryPoints: [join(here, 'entry.ts')],
	bundle: true,
	format: 'iife',
	target: 'es2021',
	write: false,
	alias: { obsidian: join(here, 'obsidian-shim.ts') },
	logLevel: 'warning',
});
// An inline script ends at the first "</script", even inside a JS string.
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const css = [readFileSync(join(root, 'styles.css'), 'utf8'), readFileSync(join(here, 'theme.css'), 'utf8')].join('\n');

// Static page shell. entry.ts fills in the options, the drawings and the examples.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beam Statics preview</title>
<style>
${css}
</style>
</head>
<body>
<h1>Beam Statics preview</h1>
<p class="intro">The plugin's real renderer outside Obsidian, with stand-in theme colours. Rebuild with <code>npm run preview</code> after changing the code.</p>
<div class="controls">
	<label>Width <input id="width" type="number" min="280" max="1600" step="10"> px</label>
	<label>Default units <select id="units"></select></label>
	<label>Decimals <input id="decimals" type="number" min="0" max="6" step="1"></label>
	<label>Moment diagram
		<select id="moment">
			<option value="sagging-up">Sagging above the axis</option>
			<option value="tension-side">Tension side</option>
		</select>
	</label>
	<label><input id="deflection" type="checkbox"> Deflection</label>
	<label><input id="table" type="checkbox"> Results table</label>
	<label>Themes
		<select id="themes">
			<option value="both">Light and dark</option>
			<option value="light">Light</option>
			<option value="dark">Dark</option>
		</select>
	</label>
</div>
<h2>Try a block</h2>
<textarea id="source" rows="12" spellcheck="false" aria-label="Beam block text"></textarea>
<div id="playground" class="panels"></div>
<div id="examples"></div>
<script>
${js}
</script>
</body>
</html>
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.log(`Wrote ${relative(root, outFile)} (${Math.round(html.length / 1024)} KB). Open it in a browser.`);
