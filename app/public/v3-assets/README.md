# v3 SVG assets

Native vector paths. No embedded raster images or new dependencies.

## Integration

`app/index.html` references `icons/symbols.svg` with `<use>`:

| Page | Tab glyph | In-page glyphs |
| --- | --- | --- |
| Folders | `st-folder-presets` | `st-folder-access` |
| Security Center | `st-security-center` | `st-access-key`, `st-activity-log` |
| Network | `st-network-devices` | `st-peer-pairing`, `st-storage-box` |

Individual SVGs remain available. All glyphs use a 24-unit grid, 1.6-unit rounded
strokes and `currentColor`. Use inline SVG or the symbol sheet for inherited
colour; an `<img>` does not inherit the page colour. Keep tab sizing in the
existing `.cabinet-tab svg` rule, not pixel sizes on individual icons.

Folders retains its real picker/list; presets are planned. Security and Network
are labelled placeholders, with no new backend actions or connection claims.

## Network illustration

`hero/cloud-two-laptops-base.svg` is shown in Network as a static concept.
`hero/cloud-two-laptops-flow.svg` is its transparent outbound stripe overlay;
`hero/cloud-two-laptops-animated.svg` combines them for preview. All share the
same 640 x 360 viewBox. Layer them in the same box without independent crops.
Only show motion once a future peer-transfer state justifies it; gateway
connectivity alone is not a paired-device state. Motion assets respect reduced
motion. Overview's original hero and animation are unchanged.

`preview.html` is the standalone asset gallery, not an application module.
Module purposes live in `For-AI/PROTOCOLS/v3-ui-modules.md`.
