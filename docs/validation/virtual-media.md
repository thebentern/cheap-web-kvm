# Virtual media validation — 2026-10-26

**Software checks do not satisfy the physical acceptance criteria.** Follow-up
testing used a connected ESP32-S3 over UART and router Wi-Fi; see the board
checks below. A Wyse 3040 has discovered the virtual disk in its UEFI boot list
and read sectors over Wi-Fi media. Networking starts off on a fresh ordinary
install and is configurable in the UI. Wyse mouse compatibility, F12 delivery,
OS boot and target-to-client file transfer remain unverified.

## Software evidence

- ESP-IDF 5.4 ESP32-S3 build with BLE, Wi-Fi and the custom HID+MSC configuration.
  Compiled descriptors verify interface 0 = boot keyboard with no report ID,
  interface 1 = boot-compatible pointer with absolute/relative Report protocol, interface 2 =
  `08/06/50` SCSI BOT mass storage. Existing remote wakeup and report sizes pass.
- Native C harness exercises the actual media backend and protocol: CRC/bounds,
  async read completion, 8 KiB read-ahead, write ACK timing, stale IDs, USB bus/BOT
  resets, read-only rejection, busy/prevented ejection, timeout/lease failure,
  and bounded boot repetition. It substitutes platform services, not USB hardware.
- All 171 web tests pass. They exercise protocol integrity, random/unaligned cross-page IO,
  IndexedDB close/reopen, source preservation, transaction abort, exclusive locks,
  strict write ACK ordering, late replies after disconnect, bounded input flow,
  FAT32 geometry, LFN/unicode/nested directories, capacity/name limits, mirror and
  chain errors. An independent FAT client acts as the target, creates a file
  through sector writes, and the worker retrieves it after synchronization and
  after reopen. This is a simulated target, not a USB host.
- The system `fsck_msdos -n` completed all FAT/directory/orphan checks on a generated
  64 MiB disk's partition with a client-added file. No repair was requested;
  FSInfo counts match the allocation table. The tool labels its final summary
  line “Warning” even on this clean image.
- Go HTTPS proxy tests check same-origin enforcement and token forwarding without
  forwarding browser cookies. Web type checking and static generation pass.
- Real browser checks cover volume creation, file-management controls and saved
  state. Browser checks cannot prove device DMA scheduling, USB reset races,
  real host filesystem behavior, Wi-Fi/BLE coexistence, or target HID latency.

Reproduce the checks:

```sh
npm --prefix web ci
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run generate
tools/test_media_firmware.sh
python3 tools/ch9329_test.py --selftest
(cd src && go test ./...)
cd firmware
idf.py -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.media-ci' build
python ../tools/verify_descriptors.py
```

`sdkconfig.media-ci` contains **build-only dummy credentials**. Never deploy it.
Use menuconfig and your own credentials for hardware. To check the generated FAT
with an independent tool on macOS:

```sh
MEDIA_FAT_FIXTURE=/tmp/kvm-fat32-partition.img npm --prefix web test -- media.test.ts
/sbin/fsck_msdos -n /tmp/kvm-fat32-partition.img
```

On Linux use `fsck.fat -n` on the same partition fixture. Neither command writes
repairs in this procedure.

## Published mPWRD-OS artifact inspection

Source: [mPWRD-OS v0.2.1](https://github.com/mPWRD-OS/mPWRD-OS/releases/tag/v0.2.1),
`mPWRD-OS_26.05.0-trunk_Uefi-x86_trixie_current_6.18.38_minimal.img.xz`.
The downloaded 1,339,317,660-byte artifact's SHA-256 matched the release API
`digest`: `18a0a3588b1638c258401baef654d263691034bc285fc8c83e920408c0abfebb`.
Decompression produced a **6,111,100,928-byte raw disk image**, SHA-256
`775dd413607a7f07366fc49087e86cd07eea317a449c06012685716170f32f1b`.

The read-only inspection verified GPT header/table CRCs and these partitions:

| Start LBA | Sectors | Type |
|---|---|---|
| 8192 | 8192 | BIOS boot |
| 16384 | 532480 | EFI System Partition |
| 548864 | 11384832 | Linux x86_64 root |

The FAT32 ESP contains `\EFI\BOOT\BOOTX64.EFI`, **147,456 bytes**, PE machine
`0x8664` (x86_64). Its PE security-directory certificate table size is zero.
There is no embedded Authenticode certificate in that loader. This is not a
firmware trust-policy assessment: a typical Secure Boot configuration may reject
it unless the firmware permits the loader by another trust mechanism. Do not
change Secure Boot or patch the image automatically. Select a compatible image
or explicitly configure the target's boot trust policy yourself.

[Machine-readable inspection](mpwrd-v0.2.1.json) records the result. Reproduce with:

```sh
xz -dk mPWRD-OS_26.05.0-trunk_Uefi-x86_trixie_current_6.18.38_minimal.img.xz
python3 tools/inspect_boot_image.py mPWRD-OS_26.05.0-trunk_Uefi-x86_trixie_current_6.18.38_minimal.img --sha256
```

No image bytes were changed. This proves layout/loader presence, not bootability,
read-only compatibility, installer/live behavior, Wi-Fi viability, or an internal
eMMC installation. Treat this as an OS disk needing a writable overlay until
actual boot behavior establishes otherwise.

## Transport measurements

| Transport | Recorded board measurement | Current role |
|---|---|---|
| USB UART 115200 | 11,136 B/s aggregate echo; about 10.9 KiB/s physical read-only sector serving | Supported older firmware |
| USB UART 921600 | 74,799–84,017 B/s aggregate echo with concurrent control replies | Default USB media/control |
| USB UART 460800 | Not qualified | Optional matching firmware rate |
| USB UART 2000000 | Sustained test timed out; rejected on the test bridge | Optional rate requiring separate qualification |
| Direct router Wi-Fi WebSocket | 62,341–119,962 B/s aggregate echo in short samples | Wi-Fi media/control transport |
| On-board HTTPS/WSS | 62,801–116,418 B/s aggregate echo samples, 20 verified 8 KiB round trips each | Direct browser hosting and media; see on-board hosting below |
| Wi-Fi through HTTPS helper | Complete helper/browser disk throughput not measured | Optional compatibility gateway |
| Bluetooth | No media benchmark | Control only; no media capability advertised |

Echo rates count payload in both directions and are not disk read/write rates.
The panel's verified 8 KiB echo benchmark measures aggregate round-trip payload
rate and worst RTT. Actual USB reads and strict durable writes may be much slower.
Its transfer counter reports real requested bytes separately. Collect board,
bridge, browser, helper host, Wi-Fi signal/coexistence, cold read, random read,
sustained write, and concurrent HID latency results before qualification.

## Reproducible hardware acceptance procedure

Record firmware commit, board/USB-UART bridge model, browser/OS versions, Wyse
firmware version, image hash, settings, logs and observed results at each stage.
Keep the client-facing UART powered independently if target USB power disappears.

1. **Composite enumeration.** Flash a normal build, attach native USB to a test
   host and inspect with `lsusb -v` (Linux) or the host USB inspector. Verify all
   three interfaces and the boot keyboard at interface 0. Check ordinary serial
   and bonded Bluetooth keyboard/mouse, modifiers, wheel and reboot behavior.
   Confirm no inserted medium is reported until requested.
2. **Local USB boot proof, separate from networking.** Supply a licensed, known
   x86_64 UEFI application small enough for a ≤512 KiB raw removable FAT image.
   Put it at `EFI/BOOT/BOOTX64.EFI`. With mtools, a FAT12 superfloppy can be made
   using a 512 KiB file, `mformat -i firmware/local-proof.img -t 32 -h 2 -s 16 ::`,
   `mmd` for the directories, and `mcopy` for the executable. Enable
   `CONFIG_KVM_MEDIA_LOCAL_PROOF`, leave Wi-Fi disabled, and build/flash. This
   explicit bring-up build reads only the embedded image, never writes it, and
   never substitutes for client streaming. Verify the Wyse discovers the disk
   and executes that application while keyboard control works. A build fixture
   or fake `.EFI` text file is not boot proof. Do not commit the image/binary.
3. **Boot repetition.** Use F12 / delay 0 / press 80 ms / interval 300 ms /
   duration 60 s. Arm, then manually reboot the Wyse. Verify distinct press and
   release reports and actual boot-menu appearance. Test cancellation during a
   pulse, normal input during pulses, a reboot/re-enumeration during the window,
   and a reboot after the deadline. Verify no stuck key on remount. Power control
   requires hardware beyond this project.
4. **Measure the real links.** Rebuild/flash UART baud candidates and run
   `tools/benchmark_serial.py` for each (see the guide). Restore the streaming
   Wi-Fi build with your credentials and run the panel benchmark. Record payload
   rate, worst RTT, errors and at least 10 minutes of sustained operation. Keep
   both video and HID active. Do not use the embedded backend for this step.
5. **Client raw-image boot.** Unpack and checksum the mPWRD-OS UEFI artifact.
   Confirm ESP/fallback findings, select it on the laptop or tablet, grant
   persistent storage and enable writes. Insert, arm F12, reboot, select the USB
   disk and verify the OS actually boots. Type at the boot menu and after login;
   move the pointer and retain video during disk transfers. Record bytes/rate,
   Wi-Fi/BLE coexistence and worst input latency. Secure Boot acceptance is a
   separate result. Do not report success merely because a disk name appears.
6. **Random IO and persistence.** From a disposable target environment, read
   random ranges and compare hashes with the original+overlay. Perform writes
   only to a disposable image, flush, unmount, eject and export; compare all
   changed ranges. Reload the browser, reselect the matching source and reopen
   the overlay. Verify acknowledged changes persist. Test quota/permission
   failure: the target must receive an error, not a successful discarded write.
7. **FAT32 ordinary file transfer.** Create a 64 MiB and a larger volume with
   different labels. Add nested/unicode/long-name files and compare hashes from
   the target, in read-only mode first. In writable mode copy a new file from
   target, run target `sync`, unmount/eject there, confirm and synchronize in the
   browser. Download it, compare its hash and inspect the exported image with
   an independent FAT checker. Reload and repeat retrieval. Test full capacity,
   empty files, invalid names and the 4 GiB boundary using disposable media.
8. **Failure/recovery matrix.** During reads and writes, unplug the client link,
   suspend/lock the browser, interrupt Wi-Fi, reboot the target, issue a USB BOT
   reset, and detach native USB. Verify explicit failures and no fabricated
   sectors, no stale completion into a new command, retained committed writes,
   and bounded key repetition. Recover only after unmount/power-off. Test target
   removal prevention, target eject, and switching boot/FAT32 sources while HID
   remains connected. Ensure filesystem controls stay locked throughout insertion.
9. **Internal bootloader discovery, if installation is attempted.** Installation
   to internal eMMC is a separate destructive OS procedure; virtual boot is not
   installation. After an explicitly chosen installation, safely eject virtual
   media and independently verify internal UEFI boot entry/fallback discovery.
   Do not infer this from successful virtual-media boot.

Acceptance remains **unverified** until stages 1, 3, 5 and 7 pass on the Wyse with
usable simultaneous HID, plus the failure/persistence tests. Record failures as
failures and keep the feature experimental until those results exist.


## Runtime Wi-Fi configuration follow-up

The settings UI now supports off, hotspot, and router-client/DHCP modes with an
optional separate recovery hotspot. Native settings tests cover bounds, partial
fragments, wrong-owner/transaction rejection, expiry, and rejection of open-client passwords.
Browser tests cover 64-byte framing, long credential fragmentation, token paging,
IP/status decoding, serial reply serialization and minimum-MTU BLE reassembly.
Changing networks is blocked by both UI and firmware until media is ejected.

Hardware follow-up: load and save hotspot settings over UART/Bluetooth, power-cycle
and confirm NVS persistence, join a real 2.4 GHz router and read its DHCP address,
exercise bad-password/missing-SSID/DHCP-timeout cases with recovery AP retained,
turn Wi-Fi off/on while checking USB HID remains enumerated, and rotate the helper
token with the disk ejected. Router credentials must be entered by the owner;
software tests do not claim a successful join to their network.


### Board checks for the Wi-Fi settings follow-up

On the connected ESP32-S3 rev 0.2 (8 MB flash, 2 MB embedded PSRAM; PSRAM remains
disabled), UART commands reported hotspot active at `192.168.4.1` with no platform
error. A deliberately incomplete client configuration was rejected without
changing the running hotspot. A recovery setting was saved, verified after a
hardware reset, then restored; the board returned to hotspot mode successfully.
This verifies the configuration control path, NVS persistence and apply lifecycle
on that board. It does not prove router association/DHCP against a real network,
Bluetooth pairing, wireless media speed, or Wyse boot. The expanded web suite has
142 passing tests in addition to the native media and Wi-Fi settings harnesses.


### Live router-client test

The owner entered router credentials through Settings → Wi-Fi using the connected
board's UART link. The UI reported successful router association and a DHCP
address, with the recovery hotspot still at `192.168.4.1`. Reloading board settings
in the UI succeeded. An intentionally nonexistent SSID had previously reached the
bounded connection-failure state (reason 201) while retaining the recovery hotspot.
The command-line reader and browser briefly overlapped on UART during that test;
its interrupted restore was superseded by the owner's successful router setup.

A direct authenticated WebSocket connection over router Wi-Fi completed HELLO and
20 round trips of 8,192-byte deterministic payloads with matching IDs, CRCs and
contents. Access without a token was closed before any media protocol response.
ESP-IDF 5.4 upgrades the socket before the URI handler authenticates it, so this
rejection appears as connection closure rather than a clean HTTP 403 handshake.
A hardware reset confirmed saved client credentials and recovery configuration
survived; the board rejoined the router and passed another 20 verified round trips.
Observed aggregate round-trip payload rates were 62,341 and 119,962 bytes/s, with
worst RTTs of 1,120.5 and 315.2 ms respectively in these short samples. This is an echo measurement, not USB disk,
durable-write, sustained-load, Bluetooth coexistence or boot throughput.


### Wired USB programming-port media test

A firmware build with UART media was flashed on the same ESP32-S3. At 115200 baud,
20 × 8 KiB round trips matched payloads/CRCs/request IDs, with 20 simultaneous CH9329
GET_INFO replies. The target's native USB was mounted throughout. The aggregate
bidirectional payload rate was 11,136 bytes/s and worst round-trip 1,485.2 ms; this is
wire echo throughput, not a USB disk benchmark or boot result.

A competing authenticated Wi-Fi HELLO was rejected while USB owned the session.
Closing that Wi-Fi socket left USB functional. Explicit USB release received its
zero-length acknowledgment; Wi-Fi could then acquire/release media, USB could
reconnect, and ordinary serial control still replied afterward. A bad CRC did not
desynchronize the next valid command. Wi-Fi association and recovery AP continued
to work with the wired transport enabled. New automated tests cover framing,
partial reads, ownership, disconnects, durable write ACKs and stale async callbacks.


The live browser reused its granted USB programming port, connected media, and
created a disposable 64 MiB FAT32 drive named USB TEST. In read-only mode the physical
target requested more than 1.5 MiB of sectors through the real browser storage
worker over USB, at about 10.9 KiB/s. There was no Wi-Fi media connection or helper.
The host asserted PREVENT MEDIUM REMOVAL; browser ejection correctly reported that
lock. This proves live USB sector serving, not target file-hash validation, target
writes, OS boot or long-duration performance. The expanded suite has 161 tests.


### Higher USB serial baud

The same board and USB bridge (`1a86:55d3`) were rebuilt with higher
`CONFIG_KVM_UART_BAUD` values. A sustained 2,000,000-baud test timed out while
waiting for an echo or concurrent HID reply, so that rate was rejected for this
setup. The board was then flashed at 921,600 and its browser selection matched.
At the time of that benchmark, ordinary firmware and a fresh browser defaulted
to 115,200. The default was subsequently raised as recorded below.

At 921,600, a 60-second test completed 218 verified 8 KiB round trips and 218 concurrent
CH9329 GET_INFO replies without corruption or timeouts. Aggregate echo payload
rate was 74,799 bytes/s; worst echo RTT 226.8 ms and worst HID reply 153.4 ms. Release,
reconnect, CRC-error recovery and Wi-Fi/USB ownership checks also passed.

The public `tools/benchmark_usb_media.py` then ran another 30 seconds: 154 verified
round trips and 154 HID replies, 84,016.729 bytes/s aggregate including heartbeats,
worst echo RTT 197.145 ms, worst HID reply 123.751 ms and acknowledged release.
[Machine-readable result](usb-baud-921600.json). The live browser connected at the
saved 921,600 setting and completed 11 verified echoes at approximately 0.08 MiB/s,
with 194.7 ms worst RTT. These are transport echo measurements, not a new target
write/OS-boot benchmark. The previous read-only test disk was synchronized after
the approved board restart and left ejected. The baud selector/persistence tests
bring the web suite to 169 passing tests.


### Standard baud default

Standard firmware, fresh browser connections, legacy bundled UI, and runtime CLI
helpers now default to 921,600 baud. A clean ESP-IDF configuration generated
`CONFIG_KVM_UART_BAUD=921600`; browser tests verify a fresh connection opens at
that rate and invalid saved values fall back to it. Explicit saved 115,200 choices
remain supported. ROM flashing and the separate UART debug console retain their
own 115,200 settings. The web suite now has 171 passing tests. The attached board
already runs the tested 921,600 profile, so no device restart was needed for this
default change.


### Native compressed image import

The web app accepts `.img.xz` directly. XZ header/footer/index checks establish
expanded size before storage allocation; streamed decoding checks the payload,
exact output size and SHA-256 while writing an immutable source to private
browser file storage. Metadata is published only after that file closes. Imports
use a 1 MiB write batch and a bounded decoder dictionary, rather than buffering
the complete image in memory. Target writes still use the IndexedDB overlay.

The web suite now has 187 passing tests. New tests cover decoded bytes and digest,
CRC/index/header/footer damage, truncated input, concatenation and stream padding,
size arithmetic above 4 GiB, unsupported checks, bounded batches, cancellation
(including pending source I/O), quota/commit failures, cached source reopening with
an overlay, and orphan cleanup without deleting active or referenced sources.
Type checking and static generation pass.

In the real browser at `http://127.0.0.1:5174/`, the existing 1,339,317,660-byte
mPWRD artifact was selected directly as `.img.xz`. The app completed preparation
and reported a 6,111,100,928-byte (5.69 GiB) boot image. Canceling a second import
completed cleanly and left that prepared disk selected. After a full page reload,
the saved disk reopened without a file picker or decompression. Its reverified
raw SHA-256 was
`775dd413607a7f07366fc49087e86cd07eea317a449c06012685716170f32f1b`,
exactly matching the independent raw-image inspection recorded in
[mpwrd-v0.2.1.json](mpwrd-v0.2.1.json). The browser detected GPT, the ESP at LBA
16384 and `\\EFI\\BOOT\\BOOTX64.EFI`. The prepared disk was left ejected. This
qualifies browser import/cache integrity above 4 GiB; it is not a new hardware
boot, write or transport-speed result. No board restart or firmware change was
needed.


### On-board HTTPS console

The ESP32 now bundles the core Nuxt console in flash. Port 80 serves certificate
setup and preserves the authenticated legacy helper endpoint; port 443 serves the
UI, pairing and same-origin media directly. A unique persisted P-256 CA signs the
server certificate. DHCP changes renew the leaf while preserving the trust CA.
USB/Bluetooth can read its fingerprint independently via Wi-Fi GET field `0x80`;
`tools/device_certificate.py` downloads the public CA and checks its DER SHA-256
against the USB value without installing trust. Browser trust remains a manual
step on each client. Access tokens are posted only over HTTPS, then replaced by
bounded expiring Secure/HttpOnly/SameSite=Strict cookies; the token never enters
a URL or browser storage.

The connected revision 0.2 board reports 8 MiB flash and 2 MiB AP_3v3 PSRAM. Its
private validation build uses the Quad/R2 overlay; published N8R8 defaults use
Octal RAM. Before PSRAM was enabled, TLS handshakes failed with only about
27–36 KiB of free internal memory. With working Quad PSRAM and default allocation
fallback, the direct HTTPS tests had more than 1.9 MiB free at the minimum. The
firmware exposes setup/basic control without repeated TLS allocations when RAM
is absent. The 4 MiB application partition preserves NVS and PHY offsets, so saved
Wi-Fi credentials, Bluetooth bonds and the generated trust identity remain intact.
OCR payloads and installer binaries are excluded from the small on-board asset
pack; the UI points users to the full hosted application for those functions.

All 205 web tests pass, as do type checking, static generation, five asset-pack
tests, eighteen firmware-packaging tests, native media/Wi-Fi/serial harnesses,
native TLS identity/renewal/persistence failure tests and the HTTP/session harness.
OpenSSL independently verifies the CA chain, client/AP IP SANs, hostname and exact
fingerprint. The HTTP harness covers strict JSON, escaped NUL rejection, exact
Origin/Host matching, cookie expiry/reset, rate limiting, gzip negotiation, bounded
asset chunks, MIME/cache/CSP headers, missing assets and route registration.
Compiled USB descriptors pass with the on-board build. Hardware checks cover
HTTPS resource integrity and authenticated transport, not OS boot or target writes.

The real board served all 62 included non-installer resources over verified HTTPS
with six concurrent clients; each decoded size and stored-byte SHA-256 matched
the generated asset manifest. Valid-token pairing set a secure cookie and returned
authenticated status. Plain HTTP pairing, wrong-token pairing, cross-origin pairing,
unauthenticated media and cross-origin media were rejected. Twenty 8 KiB media
round trips passed content/CRC/ID checks over direct WSS with no helper. The first
short sample reported 116,418 B/s aggregate echo payload; a later sample with an
extra heartbeat after every echo reported 62,801 B/s. These are different request
schedules, not disk throughput. Another twenty verified echoes completed alongside
872 USB serial vendor-echo frames in three seconds. Existing credentials survived
the firmware updates, and the downloaded CA matched its fingerprint read over USB.
[Machine-readable hardware checks](onboard-hosting.json) record the final sample.


### Server certificate lifetime and renewal

System trust validation exposed a separate failure after the initial direct TLS
resource checks: macOS rejected the original 2020–2049 server certificate with
`OtherTrustValidityPeriod`. Explicit-CA/OpenSSL chain verification alone did not
exercise that system lifetime policy. The server leaf now uses an 800-day
lifetime; the persistent CA retains its separate 2020–2049 validity. Apple's
[trusted TLS certificate requirements](https://support.apple.com/en-us/103769)
limit new server-certificate lifetimes to 825 days. This correction does not
change the board's CA, private keys or client trust installation.

The firmware renews a leaf with fewer than 30 days remaining, one with an oversized
old lifetime, or one needing updated IP SANs. Lifetime is checked even if the
address is unchanged; a renewal restarts HTTPS only once media is absent and idle.
A build-time epoch supports first offline setup, and Client mode attempts SNTP
through `pool.ntp.org`. Long offline use with an expired leaf and an old fallback
clock still requires a usable current time source or a fresh firmware build;
certificate checks remain enabled. Repeat system-trusted browser validation with
the corrected leaf before treating the earlier explicit-CA resource checks as
proof of browser/platform trust acceptance.

The final server leaf was independently fetched from the actual board after the
lifetime correction. macOS system trust evaluated it successfully for the board's
LAN IP using the installed CA (no explicit command-line anchor or browser warning
bypass). Its validity is 800 days and the CA fingerprint remains unchanged. The
on-board console loaded over trusted HTTPS in the real browser, initialized its
storage worker, paired with a secure cookie and reported media connected over
Wi-Fi. The test connection was then disconnected to leave ownership available to
the user's browser. A reported cold-start detection failure was also fixed: failed
metadata probes remain retryable, Wi-Fi selection and Connect recheck the board,
and missing authentication shows the token field before any WebSocket opens.
Three added regression tests bring the web suite to 205 passing tests.


### Reopen saved images without a full verification pass

Saved immutable OPFS sources now reopen directly from metadata. Opening a saved
image checks that its source exists and has the recorded size, then serves sectors
lazily through the existing overlay. It does not reread or hash the complete image.
Initial imports and newly selected replacement sources still validate identity.
The worker-level regression test counts source reads: two saved reopens read zero
bytes, overlay reads remain lazy, missing/truncated caches reject without scanning,
and a same-sized replacement file still hashes and fails its identity check.
All 208 web tests, type checking and production generation pass.

### Share Wi-Fi media with keyboard and mouse control

The HID link now adopts an available Wi-Fi media connection when no selected
USB or Bluetooth control connection is active, including after a page reload or
media reconnect. Existing active control links remain selected. An explicit
control pause releases HID without disconnecting or ejecting the virtual disk;
it remains paused for that media session. A canceled Bluetooth picker restores
the previous working control link. Connection settings no longer require a
separate Wi-Fi HID enable step, and the panel reports whether keyboard and mouse
share the connection. Paused control has a visible recovery action.

Eleven regression tests cover shared consumers, automatic adoption and fallback,
preserving active USB/Bluetooth, pause/resume, reconnects, canceled pickers and
deferred picker completion during reconnects. All 219 web tests, type checking,
production generation and the private quad-PSRAM board firmware build pass.
The running browser's control was re-enabled without reloading the inserted
disk. Applying the new bundled UI still requires a separately authorized board
restart; these tests do not claim physical key delivery or OS boot acceptance.

### BIOS boot-mouse compatibility

The mouse interface now advertises HID Boot subclass and Mouse protocol while
retaining both absolute and relative Report-protocol collections. USB device
revision `0x0201` identifies this descriptor change. When the target selects
Boot protocol, relative input becomes an unnumbered three-byte packet containing
three buttons and signed X/Y motion; wheel data is omitted and `-128` deltas are
clamped to the declared `-127` minimum. Absolute input supplies buttons without
motion, so BIOS users select relative mouse mode in the web UI.

The native HID harness compiles the actual driver and exercises both protocol
formats, protocol changes during endpoint waits, GET_REPORT bounds and zero
idle deltas, button release/reset, keyboard independence and endpoint failures.
The full native media/Wi-Fi/serial/HID harness passes, as do web type checking,
production generation, the private quad-PSRAM board build and compiled USB
descriptor checks. Physical Wyse mouse movement still requires confirmation.

### Boot repetition action state

The boot-key panel now presents one Start/Stop action, with the badge and status
using the same activity state. Shared local acknowledgments survive panel
closure for Serial/Bluetooth-only use, expire after the configured delay and
duration, and hand completion to board status when available. Pending actions
keep stable labels; a failed Stop retains the active state. Ten fake-timer
regressions cover these transitions. All 229 web tests and type checking pass.
