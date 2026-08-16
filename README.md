# cheap-web-kvm

A USB KVM dongle built from **one ESP32-S3 dev board** and an off-the-shelf HDMI
capture stick. Control a headless server from a laptop browser — keyboard, mouse
and video — with no drivers and no software to install.

> ### Built on [tobychui/DezKVM-Go](https://github.com/tobychui/DezKVM-Go)
>
> This project exists because the DezKVM-Go reference design is good. The entire
> web UI here — the paste box, on-screen keyboard, hotkeys and macros, screen
> recorder, OCR copy box, stacked keys, mouse jiggler, the whole settings panel —
> is tobychui's work, used under the GPLv3 and modified only where the different
> hardware required it. See [NOTICE](NOTICE) for the change list.
>
> **This is a hardware substitution, not a replacement.** If you want the
> polished, purpose-built version, [build the real
> thing](https://github.com/tobychui/DezKVM-Go) — it has a proper PCB, a case,
> and costs under $20.

## What changed, and why

The reference design puts three fixed-function chips between the laptop and the
target: an SL2.1A hub, a CH340C USB-serial bridge, and a CH9329 serial-to-HID
chip. This replaces the CH340C + CH9329 pair with a single ESP32-S3 running
custom firmware that speaks the CH9329 serial protocol on one side and presents
a USB HID keyboard + absolute mouse on the other.

The point is not cost — it is that the CH9329 is a fixed-function part and an MCU
is not. An MCU in that slot can do USB mass storage (virtual media / ISO boot),
USB-Ethernet, on-device macros, and Wi-Fi transport. None of that is built yet;
see [Stretch goals](#stretch-goals).

Video is untouched: the capture stick is a standalone UVC device that plugs
straight into the laptop. No ESP32 can do HDMI capture and the firmware has
nothing to do with video.

## Hardware

| Item | Part | Notes |
|---|---|---|
| MCU board | ESP32-S3-DevKitC-1-N8R8 | 8 MB flash. Clone boards are fine. |
| Capture | MS2130 HDMI→USB dongle | 1080p60 and cleaner UVC descriptors than the MS2109. MS2109 still works. |
| Cables | 2× USB-C, 1× HDMI | |

```
  laptop ──USB-C──> [UART port: CP2102N/CH340] ─UART0─┐
                                                      ├── ESP32-S3
  target <──USB-C── [USB port: native OTG, GPIO19/20] ┘

  target ──HDMI──> MS2130 ──USB-A──> laptop     (independent, no firmware involvement)
```

### Check these before first bring-up

* **Port order is not guaranteed.** Official Espressif boards put the UART bridge
  on the left and native USB on the right; plenty of clones reverse it. On a
  blank board only the bridge port enumerates as a serial device — use that to
  tell them apart.
* **Leave the OTG solder jumper open.** Clone boards add a jumper shorting the
  series diode in the native port's VBUS line. That diode needs to stay intact:
  the target supplies VBUS on that port and the laptop supplies it on the other.
  Same for the IN-OUT jumper on the 5 V header pin.
* **Grounds are tied.** The laptop and target share ground through the board.
  Fine on a bench; think about isolation if the target is on rack power.
* **Verify the part matches the label** with `esptool.py flash_id`. These boards
  ship mislabelled between N8R8 / N16R8 / N8R2.

## Firmware

Needs [ESP-IDF v5.3 or
newer](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/get-started/)
(that is where the `esp_driver_uart` component split landed). Built and verified
against v5.4.

```bash
cd firmware && idf.py set-target esp32s3 && idf.py build
```

Flash over the **UART port** (esptool drives the ROM bootloader on UART0 before
any app code runs, so this works regardless of what the app does with the pins):

```bash
idf.py -p /dev/tty.usbserial-XXXX flash
```

### The console caveat

On the ESP32-S3, GPIO19/20 are muxed between the USB-OTG peripheral and the USB
Serial/JTAG controller, so **you cannot have native USB HID and a USB console at
the same time**. UART0 is taken by the host protocol. The console is therefore
routed to **UART1 on GPIO17 (TX) / GPIO18 (RX)** — attach an external USB-serial
adapter to read it. Set `CONFIG_ESP_CONSOLE_NONE` once you no longer need it.

## Web UI

Web Serial requires a secure context, so the UI has to be served over HTTPS or
from `localhost`.

* **Offline (works today):** `cd src && ./start.sh`, then visit
  `https://localhost:8443/` in Chrome, Edge, or another Chromium browser. It
  generates a self-signed certificate on first run.
* **Hosted:** Pages is enabled on `main` at folder `/`, so the UI is served from
  `<pages-url>/docs/` rather than the site root. Point Pages at `/docs` instead
  to move it to the root. Note that Web Serial needs a secure context — the
  hosted route only works over HTTPS.

Click the keyboard icon to pick the serial port, then click the video area. There
is **no baud-rate configuration step** — unlike a stock CH9329, which defaults to
9600 and has to be reconfigured before first use, this firmware comes up at
115200.

## Verifying it works

Neither of these needs the target machine connected.

```bash
# Validate the compiled USB descriptors straight out of the ELF:
# boot-protocol keyboard on interface 0, absolute axes with a 4095 logical max.
python3 tools/verify_descriptors.py

# Validate the protocol frame builder against golden vectors, no hardware:
python3 tools/ch9329_test.py --selftest
```

With the board attached, drive it directly without a browser:

```bash
python3 tools/ch9329_test.py -p /dev/tty.usbserial-XXXX --info
python3 tools/ch9329_test.py -p /dev/tty.usbserial-XXXX --type "hello world"
python3 tools/ch9329_test.py -p /dev/tty.usbserial-XXXX --mouse
python3 tools/ch9329_test.py -p /dev/tty.usbserial-XXXX --soak 2000
```

## Status

| | Milestone | State |
|---|---|---|
| M1 | Boot-protocol HID keyboard + absolute mouse enumerate on the target | Descriptors verified from the compiled binary, TinyUSB comes up on hardware; **enumeration on a target not yet confirmed** |
| M2 | CH9329 frames on UART0 drive HID reports | **Verified on hardware.** All four commands ACK; 1000/1000 reports in a soak with 0 timeouts and 0 errors |
| M3 | Forked web UI drives the target end to end | Implemented; **not yet confirmed** |
| M4 | Reconnect, power-cycle survival, sustained typing | Sustained typing verified (soak above); power-cycle survival **not yet confirmed** |

Flashed and exercised on an ESP32-S3-DevKitC-1-N8R8 (rev v0.2, 8 MB flash,
8 MB PSRAM). The protocol layer is confirmed end to end from host serial to the
HID event queue. What remains untested is the USB side against a real target:
the native port had nothing attached during these runs, so `--info` correctly
reports `USB enumerated: no`.

### Stretch goals

* **USB MSC virtual media** — expose an SD card or flash partition as mass
  storage so an ISO can be mounted and booted on a headless target. PiKVM-class,
  and flatly impossible with a CH9329. Watch UEFI behaviour when adding a third
  interface.
* **Wi-Fi transport** — SoftAP + LittleFS-hosted UI + WebSocket, for when the
  target is somewhere the laptop cable isn't. A second transport; Web Serial
  stays the zero-config default.
* **USB-Ethernet (RNDIS/ECM)** to the target.

### Not goals

Video capture in firmware (impossible), a custom PCB (dev board plus a dongle is
the point), and reimplementing [DezKVM](https://github.com/tobychui/DezKVM), which
is a separate IP-KVM project with a different architecture.

## Documentation

* [docs/PROTOCOL.md](docs/PROTOCOL.md) — the CH9329 wire protocol as the web UI
  actually speaks it, extracted from the JavaScript rather than from a datasheet.
  Read this before touching the parser.
* [NOTICE](NOTICE) — attribution and the list of modifications to upstream.

## License

GPLv3, matching upstream. See [LICENSE](LICENSE).

The upstream hardware assets (`PCB/`, `3D Models/`) are licensed CC BY-NC-ND —
no derivatives, non-commercial — and are **deliberately not included here**. This
project uses a stock dev board and an off-the-shelf capture dongle instead. If
you want the reference hardware, get it from
[upstream](https://github.com/tobychui/DezKVM-Go) under its own terms.
