# Network purpose artwork

Three clean vector equivalents of the approved toggle designs, now **integrated**
as the Network tab's "Connection purpose" control. They replaced
`select#network-mode`; there is no dropdown left behind them.

| File | Visible label | Existing backend value |
| --- | --- | --- |
| `temporary-peer.svg` | Temporary peer / 24 hours | `temporary` |
| `persistent-peer.svg` | Persistent peer / Until revoked | `dependent` |
| `portable-settings.svg` | Copy portable / settings | `profile` |

All three have the same `viewBox="0 0 180 96"`, transparent backgrounds,
1.6-unit rounded icon strokes, and editable SVG text. No embedded PNGs, scripts,
remote resources or font files. The standalone colours match the v3 interface;
`currentColor` has a pale-indigo fallback. Inline use may override `color`.
The outline is included; do not add a second idle border around the image.
Selection, focus, disabled state and behaviour belong to the HTML control.

## How they are integrated

`app/index.html` — `fieldset#network-mode` holds a `<legend>` and three native
radios in one `name="network-purpose"` group, each inside a `<label>` wrapping
its own `<img src="/v3-assets/network-modes/<file>.svg" alt="">`. The caption is
already in the SVG, so the picture is decorative and the accessible name is the
radio's `aria-label`. `temporary` carries `checked`, which is the default the
dropdown had.

`app/src/styles.css` — `#network-mode` and `.mode-option` rules, placed after the
panel-wide rules they have to beat. The panel sizes text fields with
`width: 100%; height: 30px`, and that matches `[type="radio"]`, so the radios are
reset id-scoped instead. They are clipped to 1x1 rather than `display: none`, so
they keep their place in the tab order. The control owns only the state the
artwork does not draw: a restrained selected fill with a small corner mark,
hover, a focus outline via `:has(input:focus-visible)`, and a dimmed disabled
state. Options are `flex: 1 1 0`, so the artwork scales with the panel and
carries no width of its own.

`app/src/network.ts` — `selectedMode()` reads whichever radio is checked and is
the only source of truth; there is no hidden select and no parallel state. The
existing `change` handler still calls `showMode()`, which is still the one place
that updates the conditional fields, the explanation and the outgoing invitation
box. `act()` sets `mode.disabled` for the duration of an explicit action, so an
in-flight operation cannot be relabelled as another mode.

Selecting a mode calls no backend action. Creating and redeeming invitations,
joining, importing settings, granting and revoking all stay behind their own
buttons and confirmations, unchanged.

`app/scripts/smoke-ui-contract.mjs` asserts the three values, the single shared
group, exactly one `checked`, the three artwork paths, the decorative images and
named radios, that the radios are not `display: none`, that `showMode()` makes no
backend call, that both explicit actions read `selectedMode()`, and that the
choice is locked while an action runs.

Preserved meanings: temporary is 24 hours **after joining**, not the 15-minute
invitation lifetime. Persistent still needs its gateway online. Portable settings
are not whole-PC cloning or shared-URL failover, and the GitHub-grant opt-in and
import confirmation are untouched.

The window is still a fixed 636 x 704 with no new scrolling; every mode fits with
room to spare, measured in the packaged app.

## Handing the invitation over

Two opt-in ways, added alongside the purpose selector; neither weakens the wire.

**Encrypted invitation file.** `network-file-password` plus Save file / Open file.
The invitation is sealed in the webview with WebCrypto - PBKDF2-SHA256 at 600k
iterations, AES-256-GCM, the header authenticated as additional data so the salt
and iteration count cannot be lowered in transit. The native side only runs the
file dialog and moves bytes; it never sees the password. Opening a file fills the
invitation box and nothing else - joining stays behind Receive / join. An eight
character floor is enforced, because the file is only as strong as its password.

**Short code, `network-short` toggle.** `stn5:<share>-<16 base32 chars>` - about
29 characters against 141 for the link. The eighty-bit seed is not the key: HKDF
derives the usual 128-bit id and 256-bit channel key from it, so the gateway
stores what it always stored. Eighty bits is safe here only because a guess can
be tested one network round trip at a time against a single-use invitation that
expires in five minutes, so the core refuses `short` at any other expiry.

## Known unrelated failure

The Network panel still reports "Network service unavailable" in the packaged
app: the bundled `dist/network-service.js` is present and current, and starts
correctly under the bundled Node when given its environment, but the app's
companion process is not coming up and no `network-runtime.json` descriptor is
written. That is a networking defect, not an artwork or selector one, and the
panel shows it rather than hiding it.
