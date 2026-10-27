# Iconography validation

Reviewed on 2026-10-26: Nuxt toolbar, compact Tools menu, panels, status messages,
firmware installer, documentation navigation and the Go helper's bundled UI.
Icons identify actions; labels and pressed state identify connection/activity
state. SVGs are decorative to assistive technology.

## Associations

| Usage | Icon |
|---|---|
| USB / Bluetooth / Wi-Fi control | Transport symbol with connection label and pressed state |
| Target video / display settings | Monitor |
| Screen recorder | Video camera; circle/square for start/stop |
| Virtual media | Storage drive |
| OCR | Scan text |
| Copy / Paste | Overlapping documents / clipboard |
| Cut / Rename / Print | Scissors / pencil / printer |
| Undo / Redo | Matching curved arrows |
| Select all / Minimize / Hide window | Selection box / minus / slashed eye |
| Task Manager / Quit app | Activity / close-circle |
| Status LED legend | LED component |
| Firmware installer / ESP32 hardware | Processor chip |
| Documentation / Licence text | Open book / document |
| Release all keys / HID | Keyboard |

Screenshot, fullscreen, navigation, shortcuts, settings, advanced options,
information, GitHub, status, download/save and close controls use their existing
camera, expand/restore, folder, bolt, cog, wrench, information, GitHub, status,
download/save and close symbols. Context-specific commands retain text labels.

## Checks

- 66 SVG definitions parsed as valid XML; 151 static references, conditional
  branches and table mappings resolved. Computed transport/status mappings were
  checked in context.
- All glyphs rendered at 16, 20 and 24 px on light and dark backgrounds.
- Compact Tools menu checked at 390 px; labels remained readable.
- Desktop and compact toolbar actions use shared definitions. Connection toggles
  retain transport icons and expose pressed state.
- Legacy HTML aliases match their CSS masks and corresponding Vue SVGs.
- Vue type checking, static generation, legacy JavaScript syntax and diff checks
  passed. Hotkey IDs, handlers and keyboard sequences were unchanged.
