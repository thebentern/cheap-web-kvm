# Virtual media validation

Validated on 2026-10-26–27 using an ESP32-S3 rev 0.2 with 8 MiB flash,
2 MiB Quad PSRAM, a USB-UART bridge (`1a86:55d3`), Microsoft Edge on macOS,
and a Dell Wyse 3040. The final receive-fix build was `ddefbfa`.

## Hardware results

| Area | Observed result |
|---|---|
| Composite USB | Keyboard, boot-compatible mouse and SCSI BOT mass-storage interfaces enumerated. |
| USB virtual media | The browser served more than 1.5 MiB of sectors from a disposable 64 MiB FAT32 disk through the programming port. Target removal prevention was honored. |
| Wi-Fi configuration | Client association, DHCP, recovery hotspot, saved settings across reset, and bounded missing-SSID failure were exercised. |
| On-board console | The board served 62 bundled resources over verified HTTPS. macOS accepted the installed CA and 800-day server certificate; the browser loaded the console and paired successfully. |
| Authentication | Invalid tokens, plaintext pairing, cross-origin pairing, unauthenticated media and cross-origin media were rejected. |
| BIOS control | Relative mouse movement was confirmed on the Wyse BIOS screen. Boot-key repetition opened BIOS, and keyboard control selected boot options. |
| Wi-Fi OS boot | The browser-backed mPWRD/Armbian disk loaded its kernel and initrd, mounted a writable root filesystem, ran systemd, and reached first-run setup and a shell. |
| Internal boot | After a separate OS installation and virtual-media ejection, the Wyse booted from internal eMMC. Root was `/dev/mmcblk0p3`; EFI was `/dev/mmcblk0p2`. |

The OS image was
`mPWRD-OS_26.05.0-trunk_Uefi-x86_trixie_current_6.18.38_minimal.img.xz`
from [mPWRD-OS v0.2.1](https://github.com/mPWRD-OS/mPWRD-OS/releases/tag/v0.2.1).
Its expanded size is 6,111,100,928 bytes. Virtual boot used the persistent
copy-on-write overlay; the saved source image was unchanged.

The virtual-media boot initially entered Armbian emergency mode. The offered
manual continuation reached first-run setup without a target reboot or media
reconnect. This establishes an interactive boot, not unattended-startup timing.
The initial emergency-mode cause was not isolated.

## Throughput and reliability

| Workload | Result | Scope |
|---|---|---|
| USB UART at 921,600 baud | 84,016.729 B/s aggregate payload; 154 verified 8 KiB round trips and 154 concurrent control replies in 30.031 s | Transport ECHO; worst media RTT 197.145 ms, worst control RTT 123.751 ms |
| Wi-Fi 8 KiB ECHO | 69,202 B/s median one-direction payload | Three interleaved five-second trials on build `bc3c4bd` |
| Wi-Fi 32 KiB ECHO | 119,870 B/s median one-direction payload; 1.732× the 8 KiB result | Same build, channel and radio policy; signal strength varied |
| Inserted-media Wi-Fi ECHO | 64 MiB each direction, 128 MiB total, 8,192 frames in 453.571 s | No CRC/content mismatch or connection loss; no target sector reads |
| Actual Armbian boot window | 198,154,240 remote-read bytes in 1,053.623 s: **183.662 KiB/s** | Browser worker, OPFS, Wi-Fi, ESP32 and USB MSC path; endpoint precedes the first emergency-mode observation |
| Manual boot-continuation window | 147,513,344 additional remote-read bytes in 850.605 s: **169.357 KiB/s** | Separate sampled window; cumulative session reads reached 399.072 MiB |

ECHO aggregate rates count payload in both directions. They are not disk read or
write rates. Remote-read counters include read-ahead and repeated reads; cache
hits are counted separately. The actual boot window had a mean request turnaround
of 125.609 ms and a maximum of 4,323.302 ms. No uninterrupted full-boot duration
or controlled old-versus-new boot speedup was measured.

During the actual boot and continuation windows, ownership and board uptime
remained continuous. Network closes, receive/send errors, invalid frames,
handshake/frame timeouts, disk IO/lease timeouts and backend failures had zero
new counts.

The installed firmware also passed these controlled wire checks:

- Unsplit frames and frames with a 20 ms pause splitting the mask or extended
  length completed successfully.
- A 2.5-second pause within a 32 KiB reply completed a validated ECHO and
  heartbeat in 2,864.978 ms.
- An eleven-second payload pause closed the connection at 10,097.231 ms,
  preserving the absolute ten-second frame deadline.
- An incomplete second TLS handshake closed after about 2.03 seconds while
  the established media connection remained usable.

921,600 baud is the default for firmware, browser connections and runtime tools.
2,000,000 baud timed out on the tested bridge. Bluetooth carries control only.
A sustained end-to-end HTTPS-helper disk benchmark and established Bluetooth
control latency under heavy Wi-Fi media load were not measured.

## Automated coverage

The release candidate passed 287 web tests, type checking, production generation,
native firmware harnesses, the Quad-PSRAM firmware build and compiled USB
descriptor checks. [Recorded CI run](https://github.com/thebentern/cheap-web-kvm/actions/runs/40502032156).

| Component | Coverage |
|---|---|
| Media protocol and backend | CRC/bounds, PSRAM allocation fallback, 8/32 KiB negotiation, asynchronous reads, durable-write acknowledgements, stale IDs, USB/BOT resets, ejection locks, deadlines and boot repetition |
| Browser storage | Random and unaligned IO, IndexedDB reopen/abort, immutable source preservation, exclusive locks, quota failures, strict write ordering and late replies |
| Saved-image reopen | Source existence and size checks with zero full-source reads; lazy sector access through the overlay |
| Compressed import | XZ structure and payload checks, expanded size, bounded decoding/writes, cancellation and failed-import cleanup |
| FAT32 | Geometry, Unicode/long names, nested directories, allocation chains, mirror errors, capacity limits, and simulated target file creation followed by synchronization/reopen/export |
| HID and control | Boot/report mouse formats, relative movement, key release/reset, shared Wi-Fi consumers, serial queueing and boot-repeat state |
| HTTPS and pairing | Certificate identity/renewal, origin/host checks, cookie expiry, authentication, bounded asset serving, split headers and handshake/receive deadlines |
| Go helper | Same-origin enforcement and token forwarding without browser cookies |

An independent FAT client and macOS `fsck_msdos -n` checked a generated disposable
64 MiB FAT32 fixture. Physical target-to-browser FAT32 file retrieval was not
separately measured. Automated tests do not establish compatibility with every
USB host, BIOS, browser or operating-system image.

## Reproduce software checks

```sh
npm --prefix web ci
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run generate
tools/test_media_firmware.sh
python3 tools/ch9329_test.py --selftest
python3 tools/test_build_device_web.py
python3 tools/test_package_firmware.py
(cd src && go test ./...)
```

ESP-IDF 5.4 build and descriptor checks:

```sh
cd firmware
idf.py -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.media-ci' build
python ../tools/verify_descriptors.py
CC=cc ../tools/test_device_tls.sh
CC=cc ../tools/test_device_web.sh
```

`sdkconfig.media-ci` supplies dummy credentials for build checks. Hardware builds
use the board's PSRAM configuration and owner-supplied network settings.

For independent FAT checking, generate a disposable partition fixture:

```sh
MEDIA_FAT_FIXTURE=/tmp/kvm-fat32-partition.img npm --prefix web test -- media.test.ts
/sbin/fsck_msdos -n /tmp/kvm-fat32-partition.img
```

On Linux, use `fsck.fat -n` on that fixture. These checks do not open saved user
images.

## Repeat hardware checks

Record firmware revision, board/bridge, browser/OS, target firmware, settings,
workload, elapsed time, remote bytes, cache bytes and error-counter deltas.

1. Confirm composite enumeration and ordinary keyboard/mouse control with no
   disk inserted.
2. Connect media, insert a disposable disk, and read it from the target while
   video and HID remain active. Use separate sequential and random workloads.
3. For a boot test, select a compatible OS image, enable its writable overlay
   when required, and verify kernel, userspace and shell access. Record manual
   interventions separately from boot timing.
4. For writable FAT32 tests, copy files from the target, flush and unmount there,
   then eject and synchronize in the browser. Compare exported disposable test
   data and reopen the overlay.
5. Exercise disconnects, browser suspension, target resets, removal prevention,
   quota failure and reconnects with disposable media. Check explicit errors,
   preserved committed writes, stale-response rejection and key release.

Eject/unmount or power off the target before changing media or recovering a
failed session. Reopening a saved image must not trigger a full-image scan.

## Evidence records

These files retain the measurements and scope of their original test runs;
older records may describe failures superseded by the installed fixes.

- [USB 921,600-baud benchmark](usb-baud-921600.json)
- [On-board HTTPS hosting and pairing](onboard-hosting.json)
- [USB MSC/Wi-Fi read baseline and radio policy](wifi-media-performance.json)
- [Split-header and sustained-transport checks](wifi-media-reliability.json)
- [8/32 KiB transport comparison](wifi-media-chunk-performance.json)
- [Receive deadline and actual boot measurements](wifi-media-frame-receive.json)
- [Initial published OS artifact layout inspection](mpwrd-v0.2.1.json)
