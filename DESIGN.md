# Design

Flat base. Glass only where depth communicates hierarchy.

```yaml
base:            # light; dark derives (see index.html)
  primary: "#2563eb"
  surface: "#ffffff"
  surface-alt: "#f8fafc"
  text: "#0f172a"
  border: "#e2e8f0"
  effects: none
  shadows: none
  rounded: 6px
glass:
  primary: "#6366f1"
  surface: "rgba(255,255,255,0.7)"
  surface-solid: "#ffffff"   # fallback without backdrop-filter
  text: "#1e293b"
  border: "rgba(255,255,255,0.3)"
  effect: "backdrop-filter: blur(6px); border: 1px solid rgba(255,255,255,0.2)"
  shadow: "0 8px 32px rgba(0,0,0,0.1)"
  rounded: 16px
```

## Glass
- Card detail dialog (modal), over a dimmed backdrop.
- Header bar: translucent `--bar` fill with the shared blur.
- Board columns: translucent per-column tint (inbox slate, planned blue, todo amber, in-progress violet, verify rose, done green) with `blur(6px)` over the contour wallpaper. No shadow.
- Move popover (`#movePop`, native Popover API, anchored to the card's move button): glass border, 16px radius, shadow and blur, but the fill is 92% opaque (`--g-solid` mixed with transparent). No scrim sits behind it, so it needs near-solid contrast to stay readable over the cards. Its items are flat 44px rows; the current column is disabled and marked "Current".
- Any future floating toolbar or drag overlay.

## Flat
Everything else: cards, chips, inputs, forms, lists, buttons. No shadow, blur or effects.

## Card structure
- `article.card` is a plain, draggable container. It is not a button.
- The title is a real `button.card-open` (accessible name `Open card N: title`). It has `pointer-events: none`, so mouse presses reach the draggable article (a button inside a draggable element breaks drag in Firefox); keyboard Enter and Space still activate it. A click anywhere on the card that is not another button opens it.
- `.card-acts` holds the copy and Move buttons. They sit in `.meta-end`, the right end of the meta row, stacked in one grid cell with the age and never over the title or tags. Pointer devices swap the age for the buttons on hover and focus (28px; the cell reserves 56px). `hover: none` devices show the age and the buttons side by side at 44px.
- Focus ring: `:has(.card-open:focus-visible)` draws a 3px inset ring on the whole card, so it is never clipped by the scrolling column.
- The detail dialog is named by an `h2` ("Card #N: title"); the title input keeps its own label.

## Scale
- Type: 12 meta and chips, 13 labels and hints, 14 card titles and column controls, 15 body and fields, 20 board title.
- Radius: 4 chips, 6 controls and cards, 8 columns, header, toast, 16 dialogs.
- Space: 4, 8, 12, 16. Controls 44px high; the card copy button is 44x36 inside the card.
- Chip, flag and type-pill text pairs are all at least 7:1; muted text on cards and chips at least 4.9:1.
- `--link` (#1d4ed8 light, #93c5fd dark) for links in rendered markdown: the accent blue is 4.1:1 on the soft fill.
- Composer: title textarea, then a Type select (flat soft fill), Add card, cancel.

## Transparency
- The wallpaper is a `position: fixed` layer (`body::before`, `z-index: -1`), not `background-attachment: fixed`.
- `@media (prefers-reduced-transparency: reduce)` sets `--blur: 0px`, drops the wallpaper, and makes the header bar, column tints, dialog and popover opaque. `@supports not (backdrop-filter)` applies the same fills, so text never sits on an unblurred wallpaper.
- No claim is made about rendering cost. Measure on the real device.

## Notes
- Dark mode follows `prefers-color-scheme`; both token sets have dark values in `public/index.html`.
- Glass primary #6366f1 is 4.47:1 with white text, so it is used for focus ring and checkboxes only. The Save button uses flat primary.
- Inputs inside the dialog stay flat and solid.
- One blur for every glass surface: `--blur: 6px` in `public/index.html`. Change it there only.
