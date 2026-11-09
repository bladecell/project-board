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
- Board columns: translucent per-column tint (inbox slate, planned blue, todo amber, in-progress violet, verify teal, done green) with `blur(6px)` over the contour wallpaper. No shadow.
- Any future popover, floating toolbar or drag overlay.

## Flat
Everything else: header, cards, chips, inputs, forms, lists, buttons. No shadow, blur or effects.

## Notes
- Dark mode follows `prefers-color-scheme`; both token sets have dark values in `public/index.html`.
- Glass primary #6366f1 is 4.47:1 with white text, so it is used for focus ring and checkboxes only. The Save button uses flat primary.
- Inputs inside the dialog stay flat and solid.
- One blur for every glass surface: `--blur: 6px` in `public/index.html`. Change it there only.
