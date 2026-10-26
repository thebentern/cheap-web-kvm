# Virtual media validation — 2026-10-26

**Software checks do not satisfy the physical acceptance criteria.** No ESP32-S3
UART device or Wyse 3040 was attached during this work. This PR deliberately
leaves media networking opt-in and does not claim successful Wyse USB discovery,
F12 delivery, OS boot, target-to-client file transfer, or board throughput.

## Software evidence

- ESP-IDF 5.4 ESP32-S3 build with BLE, Wi-Fi and the custom HID+MSC configuration.
  Compiled descriptors verify interface 0 = boot keyboard with no report ID,
  interface 1 = non-boot pointer with absolute/relative reports, interface 2 =
  `08/06/50` SCSI BOT mass storage. Existing remote wakeup and report sizes pass.
- Native C harness exercises the actual media backend and protocol: CRC/bounds,
  async read completion, 8 KiB read-ahead, write ACK timing, stale IDs, USB bus/BOT
  resets, read-only rejection, busy/prevented ejection, timeout/lease failure,
  and bounded boot repetition. It substitutes platform services, not USB hardware.
- All 135 web tests pass. They exercise protocol integrity, random/unaligned cross-page IO,
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

| Transport | Board measurement | Current role |
|---|---|---|
| UART 115200 8N1 | Not available | Existing HID; theoretical one-way wire ceiling 11,520 B/s before framing |
| UART 460800 / 921600 / 2000000 | Not available | Build-time benchmark candidates; bridge support unverified |
| Wi-Fi through HTTPS helper | Not available | Experimental client-backed media + optional HID |
| Bluetooth | Not available | Control only; no media capability advertised |

No production media transport has been selected on unmeasured board assumptions.
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
fragments, wrong-owner/transaction rejection, expiry, and open-client passwords.
Browser tests cover 64-byte framing, long credential fragmentation, token paging,
IP/status decoding, serial reply serialization and minimum-MTU BLE reassembly.
Changing networks is blocked by both UI and firmware until media is ejected.

Hardware follow-up: load and save hotspot settings over UART/Bluetooth, power-cycle
and confirm NVS persistence, join a real 2.4 GHz router and read its DHCP address,
exercise bad-password/missing-SSID/DHCP-timeout cases with recovery AP retained,
turn Wi-Fi off/on while checking USB HID remains enumerated, and rotate the helper
token with the disk ejected. Router credentials must be entered by the owner;
software tests do not claim a successful join to their network.
