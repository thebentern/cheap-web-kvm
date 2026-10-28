# Development

Paths are relative to the repository root. Start each shell block there unless
a section specifies `firmware/`.

## Build and flash firmware

Requires [ESP-IDF 5.3 or newer](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/get-started/)
for the `esp_driver_uart` component. Tested with 5.4.

Build the root-based static UI before the firmware; CMake packs its core assets
into flash and fails if the generated site is missing or uses the Pages base URL.
The optional OCR resources and browser-flash binaries are not embedded.

```bash
cd web
npm ci
NUXT_APP_BASE_URL=/ npm run generate
cd ../firmware
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/tty.usbserial-XXXX flash
```

Flash over the UART port. esptool uses the ROM bootloader on UART0, so this
works whatever the app does with the pins.

`sdkconfig.defaults` only applies to a new config. When migrating an old build,
regenerate `firmware/sdkconfig` from the current defaults so it uses the custom
partition table and HTTPS options; retain any custom configuration separately.
Changing the app/partition images leaves NVS intact.

### Experimental performance profiles

Run the following configuration commands from `firmware/`.

For Wi-Fi virtual-media throughput experiments, `sdkconfig.wifi-rx` selects 16
static receive buffers, 64 dynamic receive buffers and a 32-frame receive
aggregation window. It follows [Espressif's ESP32-S3 iperf profile](https://github.com/espressif/esp-idf/blob/v5.4/examples/wifi/iperf/sdkconfig.defaults.esp32s3)
and can use approximately 60 KB more RAM at peak than the default receive settings. Use a
fresh, separate configuration and build directory so existing settings stay intact:

```bash
idf.py -B build/wifi-rx -D SDKCONFIG=build/wifi-rx.sdkconfig \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.wifi-rx" build
```

Include any board-specific or private configuration overlay before
`sdkconfig.wifi-rx`. Existing configuration values take precedence over overlays.
The profile is experimental: compare actual target read throughput, minimum free
internal RAM, and repeated boots before selecting it for normal use.

`sdkconfig.media-performance` enables overlapping sequential read-ahead, growing
from 32 KiB to 64 KiB and then 128 KiB, and an 8 KiB USB mass-storage buffer.
The two read buffers alternate while USB consumes one and Wi-Fi fills the other;
only one remote disk request is outstanding. Random seeks reset growth, and
writes, ejection and USB resets discard speculative data. The five transport/core
buffers use about 640 KiB of PSRAM at the 128 KiB ceiling, with an 8 KiB fallback
if allocation fails. The fallback pool is allocated internally only when PSRAM
is unavailable, saving about 40 KiB of internal RAM on PSRAM-equipped boards.
The larger USB buffer uses another 4 KiB of internal RAM.
The profile limits the TCP send queue to 32 KiB while keeping the existing
64 KiB receive window, reducing transmit queue pressure on internal memory.
Combine the experiments with:

```bash
idf.py -B build/media-performance -D SDKCONFIG=build/media-performance.sdkconfig \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.wifi-rx;sdkconfig.media-performance" build
```

The normal defaults remain 32 KiB read-ahead and a 4 KiB USB buffer. Updated
browsers negotiate 64/128 KiB with the experimental firmware and retry at 32 KiB
when older firmware rejects the larger ceiling. Older browsers retain their
existing ceilings. Large browser messages may span WebSocket continuation frames;
the firmware assembles them within one size and time limit. Outgoing messages
use 4 KiB TLS write batches to bound encryption scratch memory independently of
the negotiated disk request size. Browser echo measurements exercise this
transport; target boot and memory measurements are still needed to establish
boot-read throughput.

`sdkconfig.media-cpu` separately selects the 240 MHz CPU clock and `-O2`
compiler optimization. Append it to `SDKCONFIG_DEFAULTS` in a fresh configuration
to compare it with the 160 MHz debug build. Firmware uses the ROM CRC32 routine
on ESP targets, preserving the protocol's CRC seeds and header/payload chaining.
The native CRC differential test and on-device echo checks cover wire compatibility.

### Match the PSRAM mode

On-board HTTPS requires functioning PSRAM for TLS while Wi-Fi and Bluetooth are
active. `sdkconfig.defaults` enables Octal RAM for N8R8, lets larger general/mbedTLS
allocations use PSRAM, and ignores missing RAM so basic bring-up does not panic.
That fallback does not guarantee enough internal memory for HTTPS.

For an R2 module, first retain your old configuration separately and start with
no existing `firmware/sdkconfig`. After generating the root-based UI, build with
this checked-in overlay from `firmware/`:

```bash
idf.py -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.quad-psram" build
```

For a custom configuration, use **Component config → ESP PSRAM → SPI RAM config
→ Mode (QUAD/OCT) of SPI RAM chip in use** in `idf.py menuconfig`. Choose Quad for
R2 or Octal for R8 and verify successful RAM initialization in the boot log. The
build must match the actual chip; enabling PSRAM does not automatically distinguish
Quad from Octal wiring. Existing `sdkconfig` values take precedence over defaults.

### Package the web installer

To include a local build in the web installer, run this from the repository
root after `idf.py build`, before starting or generating the web app:

```bash
python3 tools/package_firmware.py
```

This validates `firmware/build/flasher_args.json` and the partition layout,
then creates `web/public/firmware/manifest.json` and the three binaries with
sizes and SHA-256 checksums. Generated firmware files are ignored by Git.

### Installer layout

The browser installer writes separate bootloader, partition-table and application
binaries. On the 8 MB board, the factory app area ends at `0x400000`; NVS at
`0x9000..0xf000` and PHY data at `0xf000..0x10000` remain in place. Normal updates
preserve Bluetooth pairings, Wi-Fi settings and the per-device HTTPS identity.

The published build defaults to LED GPIO48. For GPIO38 boards or other LED
settings, see [RGB status LED](USAGE.md#rgb-status-led).

## Firmware log console

The log console is on UART1: GPIO17 (TX), GPIO18 (RX). Read it with a separate
USB-serial adapter, or set `CONFIG_ESP_CONSOLE_NONE` to turn it off. UART0
carries the host protocol, and native USB cannot run a console alongside HID
because USB-OTG and USB Serial/JTAG share GPIO19/20.

## Web app

The statically generated app uses Nuxt 4, Vue 3, TypeScript and Tailwind CSS.
Web Serial and Web Bluetooth require HTTPS or `localhost`.

```bash
cd web
npm ci
npm run dev        # http://localhost:3000
npm run test       # protocol and touch gesture tests
npm run generate   # static build into web/.output/public
```

To run the full app with the optional Go HTTPS helper:

```bash
cd src
./sync_www.sh
./start.sh
```

This requires Node.js and Go 1.24 or newer. Open `https://localhost:8443/` using
[a trusted certificate](WIFI.md#optional-https-helper). Another LAN client needs
a certificate covering the helper's LAN IP or hostname.

[GitHub Actions](../.github/workflows/deploy-pages.yml) publishes matching web
and firmware artifacts when relevant changes land on `main`.

## Source layout

| Path | What |
|---|---|
| `web/app/utils/ch9329.ts` | Wire protocol. Pure functions, no browser APIs. |
| `web/app/utils/touchGestures.ts` | Touch gesture recognizer. Pure, no DOM. |
| `web/app/composables/` | Serial and Bluetooth transports, HID state, capture, settings, panels. |
| `web/app/components/` | One component per panel. |
| `web/app/pages/` | `index.vue` is the KVM, `docs/` is the documentation. |
| `web/test/` | Protocol golden-frame tests and gesture tests. |

`npm run test` checks `ch9329.ts` against the same golden frames as
`tools/ch9329_test.py`, which were verified against the firmware on hardware.
CI does not deploy if they fail. Do not edit the golden frames to make a test
pass.

## Testing

No hardware needed:

```bash
# USB descriptors in the built ELF: boot keyboard on interface 0,
# absolute axes with a 4095 logical maximum. Run after idf.py build, in the
# ESP-IDF environment (it uses xtensa-esp32s3-elf-nm and objdump).
python3 tools/verify_descriptors.py

# Frame builder against the golden frames.
python3 tools/ch9329_test.py --selftest

# LED colors, timing, brightness and status priority (needs a host C compiler).
python3 tools/test_led_pattern.py

# Firmware manifest, hashes, layout validation and NVS preservation bounds.
python3 tools/test_package_firmware.py

# Root-based UI assets, compression, routing and flash byte budget.
python3 tools/test_build_device_web.py
```

With the board on the UART port, no browser:

```bash
python3 tools/ch9329_test.py -p /dev/tty.usbserial-XXXX --info
python3 tools/ch9329_test.py -p /dev/tty.usbserial-XXXX --type "hello world"
python3 tools/ch9329_test.py -p /dev/tty.usbserial-XXXX --mouse
python3 tools/ch9329_test.py -p /dev/tty.usbserial-XXXX --soak 2000
python3 tools/ch9329_test.py -p /dev/tty.usbserial-XXXX --passkey
```
