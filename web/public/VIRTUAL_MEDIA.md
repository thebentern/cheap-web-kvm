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

## Setup

1. Install firmware containing the runtime Wi-Fi settings interface. The normal
   build includes it and starts Wi-Fi off until configured. In **Settings → Wi-Fi**
   (also available in Virtual media), connect Serial through the UART/programming
   port or use paired Bluetooth and load board settings.
2. Choose **Hotspot** to create a separate Wi-Fi network, or **Router client** to
   join an existing 2.4 GHz network. Router-client mode can keep a separate recovery
   hotspot available. Save/apply; settings persist on the board. Read the hotspot
   or DHCP client IP from status. See [Wi-Fi setup](WIFI.md) for passwords, recovery,
   and helper-token controls. Existing build-time credentials are bootstrap values
   only and are superseded by saved settings.
3. Keep Espressif's `CONFIG_TINYUSB_MSC_ENABLED` disabled: the project enables MSC
   via `kvm_tusb_config.h` without the SD/flash frontend. Existing configurations
   may need the 1500 KiB factory app slot. Join the chosen network from the client
   and helper host; UART/Bluetooth control still works independently.
4. Generate the Nuxt UI with the root base URL and start the existing Go HTTPS
   helper with the fixed ESP32 upstream:

   ```sh
   cd web
   npm ci
   NUXT_APP_BASE_URL=/ npm run generate
   cd ../src
   # Set KVM_MEDIA_TOKEN in this shell to the token configured above.
   go run . -www ../web/.output/public -media http://192.168.4.1
   ```

   Open `https://localhost:8443/` and trust **your own** helper's certificate.
   For a tablet, also join the ESP32 network and open the laptop's AP-assigned IP
   on port 8443. Generate a certificate including that laptop IP with
   `-tls-hosts localhost,127.0.0.1,LAPTOP_IP` on first run. Existing certificate
   files are preserved; back them up and regenerate deliberately if hostnames
   change. The certificate must be trusted on the tablet as well. Keep the helper
   on your trusted local network; it is not an internet-facing service.
5. Open **Virtual media → Connect media**. The default endpoint is the same-origin
   `wss://.../media`. The helper validates the browser Origin and injects the
   token into the ESP32 request. It proxies bounded network streams; files and
   persistent disk state stay in the browser, including when the browser is on
   a tablet. The helper does not need access to those local files.
6. Select Serial/Bluetooth for control, or press **Use Wi-Fi HID**. Wi-Fi input
   has its own bounded/coalescing queue and does not wait on disk persistence.
   A tablet can use Wi-Fi input even without Web Serial or Web Bluetooth.

The hosted HTTPS Pages app cannot directly use the ESP32's unencrypted socket.
Use the local HTTPS helper for this workflow. Do not disable browser security to
work around mixed-content errors. A laptop helper is currently required, also
for tablet use. Wi-Fi is an experimental media candidate, not a measured
production default.

## Boot image

Select an unpacked `.img` or **USB-bootable hybrid** `.iso`. An optical-only ISO
needs a separate CD/DVD emulation implementation; this device identifies as a
USB disk, not an optical drive. `.img.xz` is rejected with an unpacking instruction:
compressed offsets cannot be treated as raw disk sectors.

Selection computes a full streaming SHA-256 in the storage worker with bounded
memory. This can take time for a large image. The UI inspects MBR/GPT partitions
and FAT16/FAT32 ESPs for `\EFI\BOOT\BOOTX64.EFI` where supported. A filename alone
is not proof of a valid executable, Secure Boot trust, or target compatibility.
Unsupported partition/filesystem layouts are reported. Nothing patches the image.
The independent `tools/inspect_boot_image.py unpacked.img --sha256` also checks
GPT CRCs and the fallback executable's PE machine type.

Leave target writes disabled for compatible read-only/live environments. Ordinary
OS disk images often need writes (first-boot setup, root filesystem, swap, logs).
For those, grant persistent browser storage, enable **Allow target writes**, then
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
Unpack with `xz -dk IMAGE.img.xz`, verify its checksum, and inspect the resulting
`.img`. The artifact inspected for this change contains a FAT32 ESP and an
x86_64 fallback loader; see [the recorded results](validation/virtual-media.md).
Its boot and Secure Boot compatibility with the Wyse have **not** been proven.
Use a writable overlay for its normal OS-disk workflow.

Booting this disk runs the OS on the virtual disk. It does **not** install it to
internal eMMC. Follow the OS's installation instructions separately if desired,
carefully identify the destination disk, then eject virtual media and verify
internal bootloader discovery on another reboot. A successful boot from virtual
media does not prove that an eMMC installation has a discoverable bootloader.

## FAT32 thumb drive

Choose **FAT32 thumb drive**, a whole-MiB capacity from **64 MiB to 32 GiB**, and a
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
data or underlying storage failure. Source images are retained only as selected
File objects; after a reload, reopen the saved overlay and reselect the original.
The full SHA-256 must match.

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

There is no board connected during the recorded software validation. No measured
ESP32 UART, Wi-Fi, or USB disk throughput is claimed. At 115200 baud, 8N1 alone
limits one-way traffic to 11,520 bytes/s before framing; serial image streaming is
not implemented as a production backend. BLE stays a control link.

For an actual board:

- Build/flash `CONFIG_KVM_UART_BAUD` at 115200, 460800, 921600, and 2000000 in turn.
  Run `python tools/benchmark_serial.py -p PORT --baud BAUD --seconds 10` for each.
  Record USB-UART bridge model, cable, failures and maximum RTT. Higher settings
  are candidates, not claims that every bridge supports them. Rebuild at 115200
  to return to the existing browser serial default.
- With Wi-Fi firmware, choose **Measure link** while ejected. It verifies 8 KiB
  echoes and reports aggregate round-trip payload throughput and worst RTT.
  This measures the browser/helper/board path, **not USB or durable write speed**.
- During sustained target reads/writes record the panel's actual transfer counts,
  average rate and storage errors. Test cold/random reads as well as sequential
  access. Record HID latency during both; Wi-Fi/BLE coexistence needs measurement.
- Follow [the hardware acceptance procedure](validation/virtual-media.md) before
  choosing a production transport or claiming Wyse boot compatibility.
