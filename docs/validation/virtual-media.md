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

### Wi-Fi read latency preparation

The Wyse loaded the kernel and progressed to the initial ramdisk through the
browser-backed mPWRD disk. Its reported session-average read rate was roughly
29–35 KiB/s; the user reported a roughly 40-minute ramdisk load. Full OS boot
remains unconfirmed. No saved-image verification scan was used during this
investigation.

Inspection of the installed ESP-IDF 5.4 WebSocket implementation found separate
header and payload writes without `TCP_NODELAY` on the media socket. Each READ
request has only a 32-byte protocol payload. The prepared firmware disables Nagle
for authenticated HTTP/WSS media sockets and explicitly disables Wi-Fi modem
power saving. The browser already caches eight 64 KiB pages; changing image
storage was not identified as the primary fix.

Successful matching IO replies now renew the owner lease in addition to explicit
heartbeats. The per-request deadline and idle lease remain three and five seconds.
A native test sustains reads for eight seconds without a heartbeat, then confirms
idle expiry. A later screenshot showed the kernel running, then a read-only fsck
failure, the disk becoming unavailable and a kernel panic. That confirms an actual
boot failure, but does not independently identify the connection-loss cause.

New diagnostics count only successful matching read replies, remote/cache bytes
and request-to-reply timings. Native regressions check stale/duplicate exclusion,
read-ahead versus cache bytes, write/timeout exclusion and session reset. Browser
response timings and a recent read-rate display support comparison without
scanning disk contents. These changes still require deployment and measured
target read traffic before claiming a speedup. The existing boot was left running
while preparing the update; it subsequently failed before any deployment.

All 235 web tests, type checking, root-based production generation, native
media/Wi-Fi/serial/HID tests, the private quad-PSRAM firmware build, compiled USB
descriptor checks and native device-web authentication tests pass. Reopening the
panel preserves a disconnect error, including across visibility warnings.

The automatic programming-mode attempt failed with no serial data before any
flash write began. Manual BOOT/Reset entry is required before deployment and
physical throughput measurement can continue.

### Native USB deployment and real read baseline

The programming bridge continued returning no data in download mode. Native USB
ROM programming (`303A:1001`, MAC `58:E6:C5:45:7D:A0`) successfully wrote the
`6960150` application at `0x10000`, with the flasher verifying its data. NVS and
the trusted CA were preserved. An esptool watchdog reset started the application;
runtime USB enumerated as `303A:4004`, serial `58E6C5457DA0`, revision `0x0201`.
HTTPS diagnostics subsequently returned over the saved LAN connection.

A disposable 64 MiB FAT32 disk with a 32 MiB known-pattern payload was served
read-only by a Node WSS client. Its USB ancestry and size identified the Mac disk
before access. Reading 2 MiB through the Mac's FAT32 mount, with `F_NOCACHE`
enabled, took **33.962 s (61,750 B/s)**. This is real target USB MSC traffic and
Wi-Fi sector serving, but uses a Node source rather than browser OPFS. Source
response handoff averaged below 1 ms; board request turnaround averaged roughly
125 ms. No saved image was scanned. The USB disk later disappeared from the Mac;
the old disk number must not be reused for cleanup or another measurement.

A filtered packet trace found variable gaps between separate TLS header/payload
records even after the Mac had sent its TCP acknowledgment. It did not establish
Nagle or delayed ACK as the general cause. A prepared follow-up sends each whole
WebSocket binary frame through the existing HTTP/TLS transport in one call,
backfilling its header into four reserved bytes without copying the payload.
Short writes resume at the exact byte; zero, negative and impossible results
fail the link. The 8 KiB protocol limit, single outstanding disk request and
durable-write rules are unchanged. Native wire/partial-send/error tests and the
private board build pass. A measured comparison still requires deployment.

The coalesced build `614f504` was subsequently flashed through the programming
bridge with both USB ports attached through a hub, with flash data verification.
The same 2 MiB cached-disabled read took **38.817 s (54,026 B/s)**. Board mean
request turnaround was 140.58 ms, while Node response handoff averaged below
1 ms. These individual runs do **not** demonstrate a coalescing speedup; the USB
topology also changed from direct to hub. The test disk was ejected through the
host, then the media protocol, before the source process closed.
[Machine-readable measurements](wifi-media-performance.json) retain the scope
and limits. Radio scheduling is the next controlled experiment.

USB inventory checks must recursively traverse hubs and include `ioreg -l` to
read descendant properties. Earlier checks only inspected top-level device
matches, and a later query omitted non-matching IOMedia properties. Those checks
could incorrectly report an absent USB device or disk. Corrected checks confirm
the exact board identity and its storage ancestry behind the hub. The programming
bridge now flashes automatically; the earlier failures do not establish that the
bridge is defective.

### Give inserted Wi-Fi media priority over Bluetooth discovery

The board now pauses advertising only while an HTTP/WSS-owned disk is present.
Existing BLE connections are not terminated. Successful client/target ejection,
disconnect or media failure restores discovery; rejected or protected ejection
keeps the policy in place. Serial media does not pause discovery. An atomic
setter only notifies a policy task; that task queues work on the NimBLE host.
This keeps potentially blocking NPL/HCI operations outside USB callbacks and
the media mutex. Advertising restart runs in a separate host event.

Native tests cover these ownership/ejection/failure transitions, and a build
without Bluetooth checks the stubs. The private board build passes. Runtime
diagnostics confirm actual advertising rather than only the requested state:
true while idle, false during insertion, true after ejection. Actual Wi-Fi
power saving is disabled (`0`), operating mode is AP+STA (`3`), and successful
tests used channel 1 with roughly -60 dBm signal. No network names, passwords or
access tokens appear in diagnostics.

Two more 2 MiB, host-cache-disabled reads through real USB MSC and the same Node
WSS source took **14.118 s (148,540 B/s)** and **14.492 s (144,712 B/s)**.
Each required exactly 2 MiB of new remote replies. Compared with the preceding
hub run at 54,026 B/s, these are **2.68–2.75 times faster**. Mean remote request
turnaround fell from 140.58 ms to 44.31/45.84 ms. Both test disks were ejected
by the host and then synchronized through the media protocol; advertising
restored afterward. These tests use a controlled Node source, not browser OPFS,
and do not prove full Wyse boot timing or simultaneous established BLE HID
performance. Saved user images were not scanned.

The Mac was kept unlocked and awake for the successful runs. Some earlier mount
attempts failed and their sessions expired; fresh sessions and native USB
re-enumeration allowed testing to continue. An earlier exclusive-open log named
Edge, but subsequent inspection found no current Edge claim, so that log does
not establish the mount failure's cause. Edge remained open during the successful
measurements.

### Direct browser pairing and connection rejection

Build `5fb3e72` was installed on the connected board with application-flash
verification, preserving NVS. In the actual Edge console, **Pair with USB**
reused the previously granted programming port, read the physical certificate
identity, paired the browser without manual token entry, and connected Wi-Fi
media. The physical connection remained open. **Use Wi-Fi for keyboard & mouse**
then switched control successfully, and the console showed control linked and
live video while the target began reading its boot image. Board diagnostics
recorded 239 successful remote reads / 1,942,528 bytes at one observation.
No saved image was scanned, and this is not evidence of a completed OS boot.

Two additional authenticated clients (same-origin cookie and helper-token
authentication) received a valid WebSocket CLOSE `4009` while the browser owned
media. Diagnostics retained one accepted owner and counted two rejections; the
active browser continued serving the target. This checks that rejected clients
do not replace or disconnect the owner. The earlier generic browser failure did
not preserve enough evidence to establish which rejection or transport failure
triggered it.

The server previously emitted HTTP error bytes after IDF had already upgraded
the connection. Rejections now use WebSocket CLOSE frames (`4001` authorization,
`4009` existing owner). The client preserves the original failure through pending
HELLO/control requests and displays fixed safe descriptions; arbitrary server
reason text is not shown. Public diagnostics contain only counters and numeric
rejection codes, never credentials.

All 265 web tests, type checking, static generation, native media/HID tests,
the private Quad-PSRAM build and compiled descriptor checks pass.
[CI for the installed code](https://github.com/thebentern/cheap-web-kvm/actions/runs/40427074041)
also passes. New tests cover physical identity checks before/after token reads,
canceled/unsupported pairing, cookie failures, media locks, exact CLOSE bytes,
partial sends and preservation of the original connection failure.

### Split-header receive fix and sustained transfer qualification

The subsequent browser failure reported WebSocket `1006` after 52.8 MiB of
remote reads (55,394,304 bytes / 6,762 replies). Pairing and owner-rejection
handling alone did not fix this failure. The maximum successful READ turnaround
was 950,511 microseconds; that does not include the failed request.

ESP-IDF 5.4's WebSocket parser requests its two-byte extended length and four-byte
mask with individual receive calls, accepting any positive result as a complete
field. A TLS read can legitimately return fewer bytes. The resulting incomplete
header can misalign the stream. A controlled trusted-TLS test reproduced this on
the installed board: an ordinary message passed, but the same valid message
failed when either its mask or extended length crossed a TLS-record boundary
with a 20 ms gap. No image or disk was involved in this fault test.

Build `f39f980` adds a scoped receive wrapper that fills two/four/eight-byte
WebSocket fields through IDF's original receiver, preserving TLS and pending
bytes. It retains the original total receive-time budget for each field, restores
the socket timeout, and rejects EOF/error without reporting an incomplete field
as success. HTTP and pending-only reads remain unchanged. The compiled parser's
calls were checked to reach the wrapper. All 138 positive split combinations,
timeout/error exits and pass-through cases pass native tests. Both previously
failing wire tests pass on the flashed board.

TCP send/receive windows increased from 5,760 to 16,384 bytes, and the TLS output
record limit increased from 4,096 to 16,384 bytes, allowing a complete 8 KiB media
frame to fit. The browser worker also transfers its freshly allocated read buffer
instead of copying it. Ownership tests check sender detachment, exact ranges,
preserved cache pages and transfer-error recovery. No saved-image hash scan was
introduced.

Three five-second 8 KiB ECHO runs before and after the update, with Bluetooth
discovery active and no disk inserted, gave median one-direction payload rates
of **29,466 → 55,544 B/s** (bidirectional aggregate **58,932 → 111,087 B/s**), a
**1.885×** increase. These are transport round trips, not USB disk throughput or
boot-time measurements, and they exclude the browser worker optimization.

A separate disposable read-only fixture was then inserted to exercise the radio
policy used by real media. **8,192 validated 8 KiB echoes** transferred **64 MiB
in each direction / 128 MiB total** over **453.571 seconds**, with no connection
loss or content/CRC mismatch. Mean RTT was 55.365 ms; maximum RTT was 1,389.071 ms.
Loading another HTTPS console during the run briefly reduced throughput without
dropping the media connection. Media receive/send/invalid-frame error counters
stayed zero. The test disk was normally ejected and the source closed; discovery
resumed. The target did not read the fixture, so this run qualifies the media
transport and radio policy rather than USB MSC reads or a complete Wyse boot.

All 266 web tests, type checking, production generation, native media/HID tests,
the private Quad-PSRAM build and compiled USB descriptor checks pass.
[CI for the installed code](https://github.com/thebentern/cheap-web-kvm/actions/runs/40430703184)
passes. [Machine-readable reliability evidence](wifi-media-reliability.json)
records the scopes and measurements. Actual Wyse boot validation follows the
transport qualification.

### Userspace boot: heartbeat congestion and TLS accept stalls

The real Wyse boot subsequently loaded Linux and its initrd, reaching
118,007,808 successful remote-read bytes. It then lost the virtual medium during
userspace startup. The browser's exact error was **Too many pending controls**;
the network receive/send/invalid-frame counters remained zero. Its green control
indicator used USB, so it did not establish that Wi-Fi media was still connected.
The maximum successful READ turnaround reached 2.603 seconds, close to the old
three-second IO cutoff. This later failure means the first framing correction
and transport-only stress test were insufficient to establish a complete OS boot.

A second controlled fault test opened an authenticated, disk-free WSS connection,
then held one additional TCP connection to HTTPS without sending a ClientHello.
That new connection blocked the HTTP server task for six seconds. An existing
valid ECHO waited 6,007 ms and returned stale-session status `3`; the periodic
heartbeat also returned stale. IDF 5.4's synchronous server handshake retries
`WANT_READ`/`WANT_WRITE` without a total limit, so the per-receive socket timeout
does not bound the whole handshake. The old client also scheduled new heartbeats
while previous ones remained pending, eventually closing its own connection when
the four-control window filled.

The follow-up permits only one pending heartbeat, with a 12-second
heartbeat-only reply deadline and unchanged four-second ordinary controls. Disk
IO receives a bounded ten-second window; unfinished IO retains that window rather
than being canceled by the five-second idle lease. Post-deadline replies are
rejected even if polling was delayed. First-cause counters distinguish an IO
timeout, idle expiry, backend error and disconnect before cleanup obscures them.

A scoped server-session/BIO wrapper adds a two-second total handshake budget,
checked at network IO and SDK return. It preserves certificate/configuration
handling in the real SDK, isolates state by task and descriptor, and restores
the accepted socket's original timeouts. It does not close descriptors or alter
already-established TLS streams. Native tests cover retry/progress loops,
restoration/error paths and task/socket isolation; delayed READ/WRITE tests keep
their original stale-ID, reset and strict-commit guards. All 270 web tests and the
private board build/descriptor checks pass.
[CI for the follow-up](https://github.com/thebentern/cheap-web-kvm/actions/runs/40438444302)
also passes. The initial deployment attempt wrote nothing because the programming
port was absent. Once programming USB became available, build `d3ebb6c` was
installed at application offset `0x10000`; the flasher verified its data hash.
This application-only write preserved the NVS/PHY regions.

The same incomplete-handshake fault was repeated on the installed follow-up.
Although the test client intended to hold the new TCP connection for six seconds,
the board closed that incomplete peer after about 2.03 seconds. The existing
8 KiB ECHO completed in **1,906.579 ms** with status `0`, rather than the previous
6,007.323 ms/status `3`. The pending heartbeat also returned status `0`, and the
post-probe heartbeat completed in **135.857 ms** with status `0`. The established
WSS session remained healthy. The diagnostic snapshot recorded one deliberate
handshake timeout and zero media IO/lease/backend failures; these disk-free
checks issued no target READs and did not open an image.

The unsplit control, 20 ms split-mask and 20 ms split-extended-length wire checks
also all passed again on `d3ebb6c`. These results verify the controlled transport
fault and its framing regression on the installed firmware. A complete writable
Wyse OS boot, including sustained real USB MSC reads, remains unverified; the
previous 118,007,808-byte userspace-boot failure remains part of the evidence.

The OS also reports a write-protected disk. Its filesystem check exits with
operational-error status `8`, which does not itself prove filesystem corruption.
A normal writable OS-disk boot should use the browser's copy-on-write overlay;
the original cached image remains unchanged. This setting is separate from the
transport fixes and requires safe target shutdown/ejection before changing it.

### 2026-10-27: Negotiated 32 KiB Wi-Fi reads

Build `bc3c4bd` is installed with an application-only flash; the device CA is
unchanged. New clients request up to 32 KiB of Wi-Fi read-ahead. Legacy clients,
serial media and failed PSRAM allocation retain the 8 KiB ceiling. A single
163,944-byte PSRAM pool holds the larger buffers, with 48 bytes of additional
static BSS. TCP send/receive windows are 65,535 bytes with 48 receive-mailbox
entries; TLS output records remain limited to 16 KiB. The one-request disk window,
stale/reset guards and durable-write acknowledgements are preserved.

Three interleaved five-second ECHO trials per size on this same build produced
median one-direction payload rates of **69,202 B/s at 8 KiB** and **119,870 B/s at
32 KiB**, a **1.732×** ratio. Bluetooth discovery remained active, Wi-Fi power
saving disabled, AP+STA mode and channel 1 unchanged; sampled RSSI ranged from
-56 to -50 dBm. The earlier firmware's 8 KiB median was 78,632 B/s at -47 to
-45 dBm. That signal difference prevents a causal old-versus-new rate comparison.
Every reply passed CRC, returned-offset and deterministic byte-pattern checks.

The installed candidate also passed the incomplete-TLS-handshake regression with
a 32 KiB ECHO: the incomplete peer closed after about 2.03 seconds, the active
ECHO completed in **2,195.184 ms/status `0`**, and the post-probe heartbeat in
**65.196 ms/status `0`**. The established session stayed healthy. Unsplit,
20 ms split-mask and split-extended-length checks all passed. All 287 web tests,
type checking, production generation, native PSRAM/allocation-failure modes,
media/HID/TLS tests, the private board build and descriptor checks pass.
[Both CI jobs for the installed candidate](https://github.com/thebentern/cheap-web-kvm/actions/runs/40496524211)
also pass. Final diagnostics retain more than 1.79 MB of minimum free heap,
with zero receive, send, invalid-frame, IO-timeout, lease-timeout or backend-error
counts. The single handshake timeout is the deliberate test; disconnect counters
include closing the test's own disk-free connections.

These are disk-free synthetic transport measurements. They exclude USB MSC,
browser workers, OPFS and boot throughput; no image was opened or scanned.
Full writable Wyse boot and sustained target reads with the larger read-ahead
remain unverified. [Machine-readable chunk evidence](wifi-media-chunk-performance.json)
retains every trial, radio snapshot and completed regression result.
