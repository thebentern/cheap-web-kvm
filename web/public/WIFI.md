# Configure Wi-Fi in the web UI

Open **Settings → Wi-Fi** in the full hosted/local app for initial setup.
Firmware with the Wi-Fi settings interface is required. The ordinary build now includes that
interface and starts with Wi-Fi **off** until configured. A build with explicit
bootstrap hotspot credentials uses them only until settings are saved on the
board. Updating firmware preserves saved network settings in NVS.

Connect through the board's **UART/programming USB port** using Serial, or pair
using Bluetooth, then choose **Load board settings**. The native USB port is the
target keyboard/mouse/disk connection, not a serial configuration port. Wi-Fi can
also carry configuration commands after an authenticated media connection exists,
but changing that network will disconnect it.

## Modes

- **Off:** stops the Wi-Fi radio and media endpoint; serial/Bluetooth HID and USB
  remain available.
- **Hotspot (access point):** the board creates its own WPA2-protected network.
  Enter its network name and password, save, and join it from the laptop/tablet.
  The default hotspot address is `192.168.4.1`.
- **Client:** the board joins your existing **2.4 GHz personal
  Wi-Fi network**. Enter its exact SSID and password. Open networks are not supported. The router supplies
  the board's address through DHCP; read it in the status panel. Enterprise Wi-Fi,
  static IP configuration, and nearby-network scanning are not provided.

These use normal Wi-Fi infrastructure modes, **not ad-hoc/IBSS**.

Client mode defaults to keeping a **recovery hotspot** available at the
same time (AP+STA). That hotspot has its own saved name/password and stays usable
if joining the router fails. The UI can show its saved password on request. If
you disable recovery, use Serial or Bluetooth to fix an incorrect router setting.
USB HID remains connected while the network changes. The recovery hotspot uses
`192.168.4.x`; if your router uses that same subnet and routing fails, disable
recovery and use Serial/Bluetooth for setup.

## Save, status, and recovery

Eject and synchronize virtual media before applying a network change. The firmware
also enforces this rule and reserves the disk-free interval while applying the
change. It validates a complete staged transaction, commits the settings to NVS,
acknowledges the save, then changes Wi-Fi after a short delay. A missing credential
fragment, invalid password or failed NVS commit does not apply a partial config.
Separate control connections cannot mix each other's credential uploads.

Names are at most 32 UTF-8 bytes. Passwords are 8–63 printable ASCII characters;
Client mode requires a saved or newly entered password. Blank password inputs
preserve saved passwords. The router's
saved password is never returned to the browser. New inputs and explicitly
revealed hotspot credentials/media access tokens stay in memory and are not saved to
browser settings or logs.

The panel reports off, hotspot active, joining, connected with DHCP IP, or failure,
plus pending changes, retries, disconnect reason and device errors. Router joining
stops retrying after five retries or a 45-second join/address timeout. The recovery
hotspot remains available. Choose **Save and apply** to retry. Check exact SSID,
password, signal and 2.4 GHz support if it fails.

Settings are stored on the device across restarts. They are not erased by normal
application/partition flashing; an explicit NVS erase or incompatible/corrupt
settings can reset them. Factory hotspot passwords and media access tokens are generated
with the hardware entropy source enabled before the radio starts.

## Open the board-hosted console

The ESP32 serves its own UI once Wi-Fi is active. Use the hotspot IP or Client
DHCP IP shown in the panel; a Go helper is no longer required for this workflow.

The board needs functioning PSRAM to run HTTPS with Wi-Fi and Bluetooth. Published
N8R8 firmware selects Octal RAM; boards with R2/2 MB RAM need a Quad build using
`firmware/sdkconfig.quad-psram` on a clean configuration. Select the actual mode
in **Component config → ESP PSRAM → SPI RAM config** when using menuconfig; there
is no runtime Quad/Octal auto-detection. A missing-RAM fallback preserves basic
USB/Bluetooth and HTTP setup bring-up, but HTTPS may lack the memory it needs.
[Build profiles](https://github.com/thebentern/cheap-web-kvm#match-the-psram-mode).

1. Open `http://BOARD_IP/` for the setup page. Download the board's public
   certificate authority from `/device/ca.crt` and compare its SHA-256 fingerprint
   with the value read independently over the programming USB port or paired
   Bluetooth. Do not use the fingerprint displayed over HTTP as the only check.
   `tools/device_certificate.py` can download the certificate and verify it
   against a USB readout; it leaves trust installation to you.
2. Manually install the verified authority as trusted on each client computer or
   tablet. This is a one-time platform trust step, not an instruction to bypass a
   browser warning. The setup page describes Keychain Access on macOS, Trusted
   Root Certification Authorities on Windows, and profile/full trust on iOS.
3. Open `https://BOARD_IP/`. Under **Virtual media → Wi-Fi**, enter the media
   access token from **Settings → Wi-Fi → Advanced → Show saved token** and
   connect. Read that token initially through USB/Bluetooth. It is separate from
   the network password and is used to pair this browser with the board.
4. Select **Use Wi-Fi for keyboard & mouse** if desired. The same authenticated
   connection carries media and HID. Native USB still connects to the target;
   the separate capture stick supplies video.

The board stores a unique certificate authority and its keys in NVS. The trust
identity survives restarts and DHCP changes; a changed IP renews the server
certificate with the current address. An NVS erase creates a new identity, which
requires checking and trusting its replacement. The server's device hostname is
included in its certificate; name resolution depends on your LAN configuration.

Pairing creates a Secure, HttpOnly, SameSite=Strict browser cookie. The app does
not save the access token in local settings. Pairing expires and is cleared by a
board restart or a network/token change; enter the token again if requested.
The firmware allows one media owner across USB and Wi-Fi and keeps its existing
removal/synchronization rules. Eject media before changing network settings.

The on-board UI includes the console, settings and virtual media. Its OCR control
is disabled because the language/engine assets exceed the 8 MB board's flash
budget; use the full hosted/local app for OCR. Firmware installation links to the
hosted installer. Disk files and changes remain in browser storage, bound to that
browser profile and exact origin. Opening a different IP/hostname or switching
from a local/hosted UI does not carry that storage into the new origin.

## Optional helper

The existing Go HTTPS helper still works with older firmware and the full UI.
Use the chosen board IP as its fixed upstream, for example
`-media http://192.168.4.1`, and set the saved media access token as
`KVM_MEDIA_TOKEN`. Open the helper's trusted HTTPS UI and leave the helper address
blank when connecting from that same UI. After token rotation, update/restart any
helper using the old token.

On-board hosting is implemented. Router compatibility, Bluetooth/Wi-Fi
coexistence, HTTPS resource use and usable OS-image streaming throughput require
hardware validation. See [virtual media](VIRTUAL_MEDIA.md) and
[the recorded test procedure](validation/virtual-media.md).
