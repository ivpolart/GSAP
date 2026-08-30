# Vite Multipage Starter

A Vite build for landing pages and small multipage sites. Plain CSS (no
preprocessor), one JS file, HTML partials, and a `dist` you can open straight
from disk — no server required.

Requires Node `^20.19.0` or `>=22.12.0`.

## Commands

```bash
npm install
npm run dev             # dev server with HMR — http://localhost:5173
npm run build            # production build → /dist
npm run build-unMinify   # same build, but CSS/JS are left unminified (readable, multi-line)
npm run preview          # preview the built /dist locally
```

## Structure

```
src/
  index.html              ← page
  about.html               ← page
  partials/              ← base (page shell), header, footer, svg-sprite, content blocks
  css/
    base/                 ← variables (incl. @custom-media), fonts, reset, base, forms
    vendors/              ← third-party CSS (create when needed)
    layouts/              ← reusable blocks (buttons, header, footer, section overrides)
    pages/                ← styles unique to a single page
    main.css              ← entry point (@import); bundled into dist/css/main.css
  js/
    main.js                ← the only JS file — plain script, no import/export
  fonts/                 ← source .ttf/.otf — converted to .woff2 at build
  images/                ← source images — raster auto-converts to webp at build
vite.config.js            ← HASH_FILENAMES flag toggles content-hashed filenames (off by default)
```

Add a new page by dropping an `.html` file in `src/` — it's picked up
automatically, no config change needed.

## dist output

- Fully static — open `dist/index.html` directly via `file://`, no server needed.
- All paths are relative (`./…`), never absolute from root.
- No content hashes in filenames by default (toggle with `HASH_FILENAMES` in `vite.config.js`).
- No base64 — every image ships as a real file.

## Splitting a stylesheet out of the main bundle

Any `.css` file under `src/css/` whose name starts with `_` is a partial —
it only ships once `@import`ed into `main.css`, and ends up in the shared
`dist/css/main.css`.

Drop the `_` to make it build as its own file instead. It ships flat into
`dist/css/`, regardless of which subfolder it lives in under `src/css/`:

```
src/css/layouts/_header.css   → part of dist/css/main.css   (must be @imported in main.css)
src/css/pages/print.css       → its own dist/css/print.css
```

Standalone files get their own `<link rel="stylesheet">`, auto-injected into
every page's `<head>` — no manual wiring. Two mistakes are caught for you:
a `_partial.css` that's never `@imported` (warning), and two standalone
files that would both build to the same name (error, since one would
silently overwrite the other — rename one of them).

## Fonts

Drop a `.ttf`/`.otf` into `src/fonts/` and point `@font-face` at it directly —
real extension, matching `format()`:

```css
@font-face {
  font-family: 'Inter';
  src: url('../../fonts/Inter-Regular.ttf') format('truetype');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

The build converts it to `.woff2` and rewrites the CSS (`url()` and
`format()`) to match. The `.ttf` never reaches `dist/`.

## Images

Everything in `src/images/` ships to `dist/images/`, whether it's
referenced on a page or not. Raster formats (`.png`, `.jpg`, `.gif`, …)
convert to lossless `.webp`; `.svg` is optimized, not converted. Reference
images with their real source extension in `src/`:

```html
<img src="./images/photo.jpg" alt="" />
```

The build rewrites it to `./images/photo.webp` and emits the converted file.

Conversions (images and fonts) are cached on disk in
`node_modules/.cache/landing-build/`, keyed by source path + size + mtime —
an unchanged file is reused instead of re-encoded on the next build. Delete
that folder to force a full re-convert.

## Breakpoints (`@custom-media`)

Defined in `src/css/base/_variables.css`:

```css
@custom-media --phone-lg (width >= 576px);
@custom-media --tablet (width >= 768px);
@custom-media --tablet-lg (width >= 992px);
@custom-media --desktop (width >= 1200px);
@custom-media --desktop-lg (width >= 1440px);
```

Used as `@media (--tablet) { ... }` instead of raw pixels.

## HTML partials

Every page is a [Handlebars](https://handlebarsjs.com) template. Every file
under `src/partials/` is registered as a partial by name — `header.html`
becomes `{{> header}}`, a `sections/hero.html` would become `{{> sections/hero}}`.

`src/partials/base.html` is the whole page shell in one file — `<!DOCTYPE>`
through `</html>` — and renders the calling page's content via
`{{> @partial-block}}`. A page wraps itself in it and includes whatever
partials it needs:

```html
{{#> base title="Home"}}
  {{> header}}

  <main>
    <!-- page content -->
  </main>

  {{> footer}}
{{/base}}
```

### Partial patterns

**Static, no variation** (header, footer):
```html
{{> header}}
```

**Simple values differ** (text, a href, a modifier class):
```html
<!-- src/partials/button.html -->
<a class="button" href="{{href}}">{{text}}</a>
```
```html
{{> button href="/pricing" text="Learn more"}}
```

**Rich content differs, one slot** — a block partial, with the content going
between the tags instead of a quoted string (so real tags aren't escaped):
```html
<!-- src/partials/article.html -->
<section class="article{{#if bg_color}} article--{{bg_color}}{{/if}}">
  <span class="eyebrow">{{eyebrow}}</span>
  {{> content}}
</section>
```
```html
{{#> article eyebrow="A common question" bg_color="muted"}}
  {{#*inline "content"}}
    <h2>Title</h2>
    <p>Real paragraph with <strong>tags</strong>.</p>
  {{/inline}}
{{/article}}
```
(`{{#*inline "content"}}` names the slot; the partial calls it back with
`{{> content}}`. This scales to two or more independent slots — each just
needs its own name.)

**Conditional class** — `{{#if bg_color}}...{{/if}}` above renders nothing at
all (not even a stray space) when the value is missing, `false`, or `""`.

A missing `{{> name}}` fails the build with a clear error. A missing *block*
partial (`{{#> name}}...{{/name}}`) is a Handlebars feature, not a bug — it
silently falls back to rendering its own block content — so the build
separately warns you by name and file when that happens.

## Reusing a block across pages

- **CSS** — add it under `src/css/layouts/` (or `base/`) and `@import` it in
  `main.css`. Bundled into `main.css`, no runtime cost.
- **JS** — a function in `main.js`, guarded by a selector check so it only
  runs on pages that have that block.
- **HTML** — a partial in `src/partials/`; which pattern above to use depends
  on how much varies between uses.
