# Usage reference

For initial wiring and installation, see the [quick start](../README.md#quick-start).
For network setup and disks, see [Wi-Fi](WIFI.md) and [virtual media](VIRTUAL_MEDIA.md).

## Bluetooth PIN

Bluetooth only accepts input from a paired device. Pairing needs a six-digit
PIN, `123456` by default.

* Change it in the web UI under Settings → Advanced → Bluetooth PIN, over serial
  or Bluetooth.
* The PIN and pairings are stored in NVS. They survive power cycles and
  reflashing but not `idf.py erase-flash`. After an erase, remove the board
  from the host's Bluetooth settings and pair again.
* Devices already paired keep working. New pairings need the new PIN.
* The board logs a warning at boot while the PIN is `123456`.
* `idf.py menuconfig` → cheap-web-kvm sets the default PIN or turns Bluetooth
  off. A PIN saved from the UI overrides the default.
* Anyone in radio range who knows the PIN can pair and send keystrokes.

From the command line:

```bash
python3 tools/ch9329_test.py -p /dev/tty.usbserial-XXXX --set-passkey 654321
```

![Settings, Advanced tab](images/settings.png)

## RGB status LED

The onboard NeoPixel uses the **Quiet status** scheme. It stays dim during
normal use, with brief brighter pulses for input.

| State | Color | Pattern |
|---|---|---|
| Starting | White | One 700 ms fade. |
| Waiting for the USB target | Amber | Slow 3-second breath. |
| Target has enumerated the keyboard and mouse | Green | Dim, steady. |
| Bluetooth pairing | Blue | Two 120 ms pulses, 400 ms apart, every 2.4 seconds. |
| Keyboard or mouse input sent to USB | Green | One 80 ms brightness lift. Continuous input is coalesced. |
| Input dropped | Red | One 180 ms flash, then return to the current status. |

Pairing takes precedence over the target status; a dropped-input warning
briefly overrides both. After pairing ends, the light returns to the USB target
status. Green activity means the USB stack accepted an input report for
transmission; it cannot confirm the target processed it. The LED does not
indicate HDMI/video health or whether a browser has opened the serial port.

Open **Status LED legend** in the console toolbar or its **Tools** menu for the same
reference, including when disconnected.

`idf.py menuconfig` → **cheap-web-kvm** lets you disable the LED, select its
GPIO, and adjust its brightness cap. The default cap is 10%, with steady green
at half that level. The default GPIO is **48**, used by the original DevKitC-1
and many clones. Official **v1.1 boards use GPIO38**; check your board revision
and select the appropriate pin ([Espressif board guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html)).
Boards without an addressable LED can disable it. An LED initialization failure
is logged and leaves keyboard, mouse, and Bluetooth operation available.

## iPad

iPads have no Web Serial. After initial network and certificate setup, the
board-hosted HTTPS console can carry keyboard/mouse and media over Wi-Fi.
Bluetooth remains an alternative using a compatible browser:

1. Use a USB-C iPad on iPadOS 17 or later, which exposes USB cameras to
   `getUserMedia`. Connect the capture stick with a USB-C to USB-A adapter.
   Lightning iPads do not support external cameras.
2. Install [Bluefy](https://apps.apple.com/app/id1492822055) or another browser
   that adds Web Bluetooth. Safari and Chrome on iPad do not have it.
3. Open the hosted UI in that browser, press the Bluetooth button in the
   toolbar, pick `cheap-web-kvm-XXXX` and enter the PIN (`123456` by default).

![On-screen keyboard at iPad size](images/ipad.png)

A trackpad or mouse works as usual. Relative mouse mode is under Settings →
Keyboard & mouse. Use relative mode for BIOS/UEFI screens: click the video to
capture mouse movement and press Esc to release it. Desktop operating systems
can use the default absolute mode. Touch gestures:

| Gesture | Absolute mouse mode (default) | Relative mouse mode |
|---|---|---|
| Tap | Click where you tapped | Quick tap: click where the pointer is |
| One-finger drag | Drag with the left button held | Move the pointer, like a trackpad |
| Two-finger drag | Scroll under your fingers | Scroll |
| Two-finger tap | Right-click where you tapped | Right-click where the pointer is |

* Apple Pencil acts as a mouse in absolute mode (contact presses the left
  button, hover moves the pointer where supported) and as a finger in relative
  mode.
* A touch that starts in the black bars around the picture is ignored.
* A touch does not press a button until it is a tap or a drag, so the first
  finger of a two-finger scroll or a pinch does not click.
* Over Bluetooth, queued pointer moves and scroll ticks are merged
  ([PROTOCOL.md §5](PROTOCOL.md#5-timing)). The pointer updates less often
  than over a cable. Clicks and keystrokes are never merged.

If the video drops, the page reconnects on its own and Settings → Display →
Capture events shows why. Common causes on an iPad:

* The screen locked. The page keeps the screen on once you have tapped it, but
  Low Power Mode cuts auto-lock to 30 seconds.
* A call, Siri or an alarm interrupted audio, which also pauses the camera. If
  this keeps happening, turn off audio in Settings → Audio.
* Split View, Slide Over, Stage Manager, or another app using the camera.

If it does not come back, tap Restart video.

## Offline use

The full hosted/local app includes Tesseract, its worker, WASM core and English
OCR data in `web/public/vendor/tesseract`. The other 19 OCR languages download
when first selected and are marked **Downloaded on first use**.

The board-hosted console excludes OCR to fit in flash, and its firmware-install
action opens the hosted installer. Its core console, settings and virtual media
work offline after Wi-Fi and certificate trust are configured.

Disk images and overlays belong to the browser profile and exact origin; they do
not transfer automatically between hosted, local and board consoles. Export changes
before switching origins. See [storage and exports](VIRTUAL_MEDIA.md#saved-disks-and-exports)
and [certificate lifecycle](WIFI.md#certificate-lifecycle-and-storage).
