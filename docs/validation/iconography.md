# Iconography audit — 2026-10-26

Reviewed the visible Nuxt toolbar, compact Tools menu, panels, status messages,
firmware installer and documentation navigation, plus the Go helper’s bundled
legacy UI. Icons identify the feature/action; active state and accessible labels
communicate state. SVGs remain decorative to assistive technology.

## Corrected associations

| Usage | Icon choice |
|---|---|
| USB / Bluetooth / Wi-Fi control | Keep the transport symbol in both states; pressed state and label identify connection/disconnection |
| Live target video / display settings | Monitor |
| Screen recorder | Video camera; recording start/stop retain circle/square |
| Virtual media | Storage drive |
| Copy text through OCR | Scan text |
| Copy to clipboard / Paste | Overlapping documents / clipboard |
| Cut / Rename / Print | Scissors / pencil / printer |
| Undo / Redo | Matching curved arrows, distinct from refresh |
| Select all / Minimize / Hide window | Selection box / minus / slashed eye |
| Task Manager / Quit app | Activity / close-circle, avoiding Settings or system-power implications |
| Status LED legend | LED component, distinct from recording |
| Install firmware / ESP32 hardware | Processor chip |
| Documentation / Licence text | Open book / document |
| Release all keys / generic HID explanation | Keyboard, avoiding disconnect or USB-only imagery |

Recognizable existing choices remain: screenshot camera, fullscreen expand/restore,
folder navigation, shortcut bolt, settings cog, advanced wrench, information,
GitHub mark, warnings, errors, success, download/save and close. The wrench shape
was also corrected during visual review. Context labels accompany less universal
commands such as Toggle Dock; icons do not replace those labels.

## Verification

- 66 registered SVGs parsed as valid XML; 151 statically identifiable references,
  conditional branches and icon-table mappings resolve to registered names.
  The remaining computed transport/status mappings were reviewed in context.
- All 66 glyphs rendered at 16, 20 and 24 px on light and dark backgrounds; no missing
  glyphs or color-dependent invisibility found. Geometry for Undo/Redo and Wrench
  was corrected after rendering.
- The actual compact Tools menu was checked at a 390 px viewport. Its LED legend
  text was shortened to avoid collision with the adjacent firmware command;
  the full accessible name and tooltip are retained.
- Toolbar desktop and compact menu share the same action definitions. Connection
  toggles expose pressed state while retaining their transport identity.
- Legacy HTML aliases were checked against their CSS masks. New masks match the
  Vue SVGs, and the original minified stylesheet prefix was preserved.
- Vue type checking, static generation, legacy JavaScript syntax and diff checks
  pass. Hotkey IDs, handlers and keyboard sequences are unchanged.
