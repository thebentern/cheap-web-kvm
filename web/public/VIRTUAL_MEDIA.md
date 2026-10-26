# Virtual media and boot-key repetition

Virtual media is **experimental, with hardware acceptance still outstanding**.
The ESP32-S3 exposes a removable USB disk alongside the existing boot keyboard
(interface 0) and pointer (interface 1). The disk is interface 2, SCSI transparent
command set over Bulk-Only Transport, with 512-byte logical sectors. Serial and
Bluetooth HID remain compatible with older clients. Video still comes from the
HDMI capture stick.

The normal disk backend is a browser-selected image or a browser-created FAT32
volume. Only requested sectors, an 8 KiB read-ahead cache, and bounded transport
buffers live on the ESP32. The entire source never has to fit in ESP32 RAM or
flash. An explicitly selected, separate embedded-image build is available only
for USB bring-up.

## Connect over USB or Wi-Fi

The target always connects to the board's **native USB port**, which presents its
keyboard, mouse and virtual disk. Choose how this browser sends disk data to the
board in **Virtual media → USB / Wi-Fi**. Eject and synchronize before switching.

### USB

1. Install firmware supporting wired media. Connect the board's separate
   **USB programming/UART port** to this computer, and its native USB port to the
   target. A board without a USB-UART bridge needs an adapter on UART0.
2. Open the web UI in a browser with Web Serial support. Select **USB → Connect**
   and choose the programming port. An existing serial control connection is reused.
3. Choose a boot image or create/reopen a USB drive, then insert it into the target.

USB media and keyboard/mouse control share the programming cable. Ejecting or
disconnecting media leaves serial control available. Unplugging that cable while
a disk is inserted makes the medium unavailable; unmount/power off the target and
synchronize before recovery. Bluetooth remains a control link rather than a disk
transport. No Wi-Fi setup, access token or HTTPS media helper is needed for USB;
the UI still needs a secure context (hosted HTTPS or localhost).

The default firmware UART is **921600 baud**. Its one-way wire ceiling is
92,160 bytes/s before framing, and an 8 KiB message occupies roughly 0.09 s.
The tested board transferred about 84 KB/s aggregate in the transport benchmark;
OS boot and real disk performance depend on the workload. Input can wait behind
an in-flight media frame. To use another rate, build the board with matching
`CONFIG_KVM_UART_BAUD`, then select the same rate in **Virtual media → Connection
settings → USB baud rate** or **Settings → Advanced → USB baud rate**. Choices are
115200, 460800, 921600 and 2000000. The selection is remembered in this browser and
applies to both serial control and media on the next connection. Disconnect serial
before changing it. Choosing a browser rate does not reconfigure the board. Older
firmware built at 115200 requires that explicit browser setting. USB MSC on the
target is separate from this USB-UART link.

### Wi-Fi: open the board directly

The ESP32 hosts the console and its media connection. A separate computer running
the Go helper is optional.

Direct HTTPS needs working PSRAM when Wi-Fi and Bluetooth coexist. The published
N8R8 build uses Octal PSRAM; an R2/2 MB module needs the Quad configuration in
`firmware/sdkconfig.quad-psram`. This mode is selected at build time, not detected
automatically. See [PSRAM build setup](https://github.com/thebentern/cheap-web-kvm#match-the-psram-mode). Missing
RAM is tolerated for USB/Bluetooth and HTTP setup bring-up, but HTTPS may not have
enough memory to start.

1. Use Serial through the programming port, or paired Bluetooth, to open
   **Settings → Wi-Fi** and load the board settings. Choose **Hotspot** or
   **Client**, save the network credentials, and read the IP in status. Client
   joins an existing 2.4 GHz network and can retain a recovery hotspot. Initial
   network setup still needs USB or Bluetooth.
2. Open `http://BOARD_IP/`. Port 80 serves a setup page and
   `/device/ca.crt`, the board's public trust certificate. Before installing it,
   verify its SHA-256 fingerprint using the value read independently through USB
   or paired Bluetooth. The HTTP page alone is not proof of the certificate's
   identity. `tools/device_certificate.py` downloads the certificate and checks
   it against the USB fingerprint; it does not install trust automatically.
3. Install that verified certificate as a trusted certificate authority on each
   computer/tablet that will open the board. This is a manual, one-time trust
   step. Follow the platform instructions in the setup page; proceeding through
   a browser warning is not the setup procedure.
4. Open `https://BOARD_IP/` on port 443. In **Virtual media → Wi-Fi**, enter the
   **Media access token** shown in **Settings → Wi-Fi → Advanced → Show saved
   token** over USB/Bluetooth, then connect. The token is separate from the Wi-Fi
   password. Pairing creates a Secure, HttpOnly, same-site browser session cookie;
   the app does not save the token in browser settings. Session expiry, a board
   restart, or a network/token change can require pairing again.
5. Choose **Use Wi-Fi for keyboard & mouse** if desired, then select a boot image
   or USB drive. The target still connects to native USB, and video still uses
   the separate HDMI capture stick. Tablets do not need Web Serial/Bluetooth for
   control once the board's Wi-Fi and certificate trust are configured.

The device keeps its own certificate authority and keys in NVS. Its server
certificate is issued with an 800-day lifetime, within the 825-day limit in
[Apple’s TLS server certificate requirements](https://support.apple.com/en-us/103769). The authority itself
has a separate 2020–2049 validity period. A DHCP address change, fewer than 30 days
remaining on the server certificate, or an old oversized server lifetime triggers
server-certificate renewal. Renewal keeps the same authority and keys, so it does
not require reinstalling client trust. The board waits until media is ejected and
idle before restarting HTTPS to apply a renewal.

A fresh firmware build supplies its build timestamp as an initial offline clock.
Client mode also attempts network time synchronization through `pool.ntp.org`;
that depends on reachable DNS/NTP and is not available in an isolated hotspot.
This is not a promise of indefinite offline renewal: after a long offline period,
an expired certificate and an old build-time clock need a current firmware build
or a usable current time source. Normal certificate verification remains enabled.

Use the current IP reported by the board; the certificate's device hostname does
not by itself guarantee that a router resolves that name. Erasing NVS removes
this identity and requires verifying/trusting the replacement certificate.

The on-board console embeds its compressed core assets in flash. OCR language
and engine data do not fit on this 8 MB board; its OCR control is disabled with a
link to the full app. Firmware installation opens the full hosted installer.
Disk images, including prepared `.img.xz` sources, still live in the browser,
not on the board. Browser storage belongs to the exact origin: changing from
localhost or the hosted site to `https://BOARD_IP/`, or to a different DHCP IP,
uses a separate storage bucket. Export needed changes before moving origins and
select/import the source in the new one.

### Optional HTTPS helper

The Go helper remains available for the full UI, older firmware or an existing
helper setup. It is not required by the board-hosted console:

```sh
cd web
npm ci
NUXT_APP_BASE_URL=/ npm run generate
cd ../src
# Set KVM_MEDIA_TOKEN to the saved media access token from Settings → Wi-Fi.
go run . -www ../web/.output/public -media http://BOARD_IP
```

Open `https://localhost:8443/` using a certificate trusted by that browser, then
choose **Virtual media → Wi-Fi → Connect**. Leave the helper address blank when
using its own UI. For another LAN client, the helper certificate must include
its computer's LAN IP/hostname and be trusted by that client. The helper's
`-tls-hosts` option affects newly generated certificates only; it preserves
existing certificate files. Hosted HTTPS cannot directly use the board's legacy
unencrypted socket. Keep the helper on a trusted local network.

Both transports require the custom MSC build (`CONFIG_TINYUSB_MSC_ENABLED` stays
disabled; `kvm_tusb_config.h` supplies MSC). The current 8 MB build uses a custom
factory partition at `0x10000..0x400000`; NVS at `0x9000..0xf000` and PHY data
at `0xf000..0x10000` remain in place. Only one transport owns media at a time.
A second connection cannot take over a live session; disconnect or let the failed
connection's lease expire first.

## Boot image

Select an `.img`, `.img.xz`, or **USB-bootable hybrid** `.iso`. An optical-only ISO
needs a separate CD/DVD emulation implementation; this device identifies as a
USB disk, not an optical drive.

The app prepares `.img.xz` automatically in the background. It streams the
decompressed image into the browser's private file storage (OPFS), checks the XZ
structure and integrity checks, and computes the raw image's SHA-256 before making
it available to insert. Progress and **Cancel import** appear during preparation;
failed or canceled imports remove their partial file. Closing the tab can leave a
partial file, which the next saved-disk refresh reclaims. The original compressed
file stays unchanged. Ordinary LZMA2 XZ images with CRC32 or CRC64 checks and a
dictionary up to 64 MiB are supported; unsupported compression options fail with
an error.

Preparation needs browser storage for the **full decompressed image**, plus space
for later changed sectors. Available quota is checked before import, and a full
storage error stops the import. The worker streams data with bounded memory; it
does not load the whole image into RAM. Compressed bytes are never presented as
raw disk sectors.

Selection computes a full streaming SHA-256 in the storage worker with bounded
memory. This can take time for a large image. The UI inspects MBR/GPT partitions
and FAT16/FAT32 ESPs for `\EFI\BOOT\BOOTX64.EFI` where supported. A filename alone
is not proof of a valid executable, Secure Boot trust, or target compatibility.
Unsupported partition/filesystem layouts are reported. Nothing patches the image.
The independent `tools/inspect_boot_image.py unpacked.img --sha256` also checks
GPT CRCs and the fallback executable's PE machine type.

Leave target writes disabled for compatible read-only/live environments. Ordinary
OS disk images often need writes (first-boot setup, root filesystem, swap, logs).
For those, grant persistent browser storage, enable **Allow target to write**, then
insert. All writes go to a persistent copy-on-write overlay. The selected source
File is read-only and stays unchanged. OS boot may fail if you choose read-only
for an image that requires a writable disk.

**Insert** gives the target exclusive ownership. **Eject and synchronize** removes
only the medium; it does not disconnect USB HID or require USB re-enumeration.
Switching sources/modes requires ejection first.

### mPWRD-OS example

The [generic x86_64 UEFI release](https://github.com/mPWRD-OS/mPWRD-OS/releases/tag/v0.2.1)
contains a compressed raw disk image, not necessarily a live image or installer:
`mPWRD-OS_26.05.0-trunk_Uefi-x86_trixie_current_6.18.38_minimal.img.xz`.
Select this `.img.xz` directly in **Boot image**. Its roughly 1.25 GiB download
requires about **5.69 GiB** of browser storage for the prepared image. Verify the
download's published checksum before use. The artifact inspected for this change
contains a FAT32 ESP and an x86_64 fallback loader; see
[the recorded results](validation/virtual-media.md).
Its boot and Secure Boot compatibility with the Wyse have **not** been proven.
Use a writable overlay for its normal OS-disk workflow.

Booting this disk runs the OS on the virtual disk. It does **not** install it to
internal eMMC. Follow the OS's installation instructions separately if desired,
carefully identify the destination disk, then eject virtual media and verify
internal bootloader discovery on another reboot. A successful boot from virtual
media does not prove that an eMMC installation has a discoverable bootloader.

## FAT32 thumb drive

Choose **USB drive**, a whole-MiB capacity from **64 MiB to 32 GiB**, and a
1–11 character ASCII label (letters, digits, spaces, hyphens or underscores).
Creation uses a sparse disk with an MBR, a FAT32 LBA partition starting at sector
2048, mirrored FATs, backup boot sector/FSInfo, and a volume-label root entry.
No target-side software is needed.

While ejected, add files, create folders, navigate, inspect the first 64 KiB of a
file as text, download files, and remove files or empty folders. UTF-16 VFAT long
names are supported. Names are limited to 255 UTF-16 code units; reserved device
names, forbidden characters, trailing dots/spaces, and case-insensitive duplicates
are rejected. Individual files cannot exceed **4 GiB minus one byte**. Capacity
errors and malformed/cyclic cluster chains produce explicit errors.

Client filesystem edits are disabled while inserted, even in read-only mode.
Read-only sharing lets the target read client-added files. Writable mode lets the
target add files normally. To retrieve them:

1. Finish target copies and unmount/eject the USB disk **inside the target OS**.
2. Confirm that in the media panel, then choose **Eject and synchronize**.
3. The browser waits behind all outstanding storage transactions, releases
   ownership, and reloads directory/FAT state. Download/inspect the returned files
   or export the updated disk image.

The target's PREVENT MEDIUM REMOVAL request is respected. Unmount there before
trying again. A target START STOP eject removes the medium, but client edits
remain locked until browser synchronization is complete. If the link was lost,
confirm the target is unmounted or powered off before offline recovery. Do not
force recovery while the target might still be using the disk.

## Persistence, exports, and failures

Pages and volume metadata live in IndexedDB under the **current browser origin**.
A storage worker serializes requests, caches at most eight 64 KiB pages, and
commits each target write and its revision in one strict-durability transaction.
Only transaction completion produces a successful write reply. SCSI writes larger
than one USB buffer can partially persist before a later chunk fails; the overall
command then fails. No acknowledged chunk is intentionally discarded.

Writable insertion requires persistent-storage permission and Web Locks. Web
Locks prevent two tabs from opening the same saved disk at once. Private browsing,
quota exhaustion, unsupported durability, revoked permission, storage corruption,
and user-cleared browser data cannot be hidden by a successful USB ACK. Browser
persistence is not an external backup and cannot protect against deleting browser
data or underlying storage failure.

For a directly selected `.img` or `.iso`, the source is retained as a selected
File object; after a reload, reopen the saved overlay and reselect the original.
Its size and full SHA-256 must match. For an imported `.img.xz`, the prepared raw
source remains in OPFS and its reference is saved with the volume metadata in
IndexedDB. Reopen that saved disk without selecting the compressed file again;
the app uses its saved source directly, with only presence and size checks rather
than another full-image checksum scan. Initial imports and newly selected
replacement files still establish or confirm the source fingerprint. If browser
data has removed the prepared source, select the original `.img.xz` again to restore it against the
saved overlay's fingerprint. Successful prepared sources are retained alongside
their saved volumes; unreferenced interrupted imports are reclaimed. All of this
storage belongs to the current browser profile and exact origin, including its
port.

The panel distinguishes browser-saved revisions from a confirmed external export.
Export writes a new `*-updated.img`. Save File capable browsers stream straight
to the selected destination; other browsers stage a bounded-memory OPFS file and
offer a download. Staged downloads consume browser storage and are not
conservatively deleted automatically. If quota is insufficient, use a browser
with Save File support or free unrelated storage. Confirm **I saved the downloaded
export** only after saving it outside this browser. Export and download require
ejection. No overlays are automatically pruned.

A client filesystem edit marks the volume as needing a check before changing
metadata. If it fails or the tab closes mid-edit, insertion and editing remain
locked. Export for external filesystem repair and re-import the repaired image;
this avoids presenting a partly updated FAT as a clean filesystem. Target-created
filesystem corruption is also reported when parsing detects it; an actual disk
checker remains advisable after an unclean target shutdown.

Media IO has a 3-second deadline. Heartbeats run every second with a 5-second
lease. A timeout, suspension, failed storage commit, or socket loss makes the
medium unavailable and fails pending requests; it never fabricates zeros or
reports a failed write as successful. Already committed writes remain saved.
A late response is rejected after session/request/bus-epoch changes. USB bus resets
and BOT resets cancel outstanding operations; an inserted source remains available
for fresh requests. Reinsertion after connectivity failure is explicit.

SYNCHRONIZE CACHE succeeds only while the medium is usable and no IO is pending;
there is no acknowledged volatile device write cache to drain. It cannot flush
data the target OS has not sent. A lost flush fails. A late browser transaction
may commit after USB timeout; this is an explicitly uncertain write outcome,
resolved by safe ejection and inspection, not silent rollback.

## Boot-key repetition

Connect a control link, select F12 (Wyse default), and configure initial delay,
press time, press-start interval, and total active duration. Defaults are
0 ms / 80 ms / 300 ms / 60 seconds. Arm **before** manually restarting the target.
There is no target power control without additional hardware.

Firmware sends distinct press/release reports, merges ordinary input while there
is room in the six-key boot report, and waits for USB keyboard readiness.
Reboot/re-enumeration does not extend the bounded duration. Press durations are
20–2000 ms, interval must allow at least a 10 ms release, delay is at most 120 s,
and active duration is at most 300 s. A full normal six-key report takes priority.
Cancellation bypasses queued input and releases at the next writable keyboard
opportunity. Physical key release cannot be delivered while USB is disconnected;
it is cleared on re-enumeration. The target is not power-cycled by this macro.

## Measure before relying on OS boot

The connected-board tests include real USB sector serving at 115200 and short
Wi-Fi echo measurements; see [recorded evidence](validation/virtual-media.md).
Faster UART rates depend on the actual bridge and cable. BLE stays a control link.
A wire benchmark is not an OS-boot or durable-write performance result.

For an actual board:

- Build/flash `CONFIG_KVM_UART_BAUD` at 115200, 460800, 921600, and 2000000 in turn.
  Close browser serial control, then run
  `python tools/benchmark_usb_media.py -p PORT --baud BAUD --seconds 30` for media
  echo with concurrent HID replies. `tools/benchmark_serial.py` measures only
  short HID round trips and does not qualify large media packets.
  Record USB-UART bridge model, cable, failures and maximum RTT. Set the same rate
  in the browser before connecting. Test media echo for at least 30 seconds at each
  candidate with control traffic active, then verify target sector reads. Use
  921600 in both firmware and browser to restore the standard configuration.
- With Wi-Fi firmware, choose **Measure link** while ejected. It verifies 8 KiB
  echoes and reports aggregate round-trip payload throughput and worst RTT.
  This measures the browser/board path (plus the helper if used), **not USB or durable write speed**.
- During sustained target reads/writes record the panel's actual transfer counts,
  average rate and storage errors. Test cold/random reads as well as sequential
  access. Record HID latency during both; Wi-Fi/BLE coexistence needs measurement.
- Follow [the hardware acceptance procedure](validation/virtual-media.md) before
  choosing a production transport or claiming Wyse boot compatibility.
