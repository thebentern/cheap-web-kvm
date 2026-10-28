# Virtual media and boot-key repetition

The ESP32-S3 presents a removable USB disk alongside its keyboard and mouse.
Select a boot image or create a FAT32 drive in the browser, then insert it into
the target. Disk data stays on the browser's computer; the board holds requested
sectors and bounded buffers. Video comes from a separate HDMI capture stick.

## Connections

Connect the board's **native USB port** to the target. In **Virtual media**, choose
**USB** or **Wi-Fi** for the browser-to-board connection. Eject and synchronize
before changing the connection or disk.

### USB

1. Connect the board's **programming/UART USB port** to this computer. Boards
   without a USB-UART bridge need an adapter on UART0.
2. Open the console over HTTPS or localhost in a browser supporting Web Serial.
3. Choose **Virtual media → USB → Connect** and select the programming port.
   An existing serial control connection is reused.

Media and keyboard/mouse control share the programming cable. Ejecting media
leaves serial control connected. The default is **921600 baud** in firmware and
browser, with a one-way wire ceiling of 92,160 bytes/s before protocol overhead.
The target's USB disk connection is separate from this UART link.

To change the rate, disconnect serial control, build firmware with matching
`CONFIG_KVM_UART_BAUD`, and select the same **USB baud rate** under **Connection
settings** or **Settings → Advanced**. Supported choices are 115200, 460800,
921600 and 2000000. The browser remembers its selection; it does not reconfigure
the board. Firmware built at 115200 needs that explicit browser setting.

### Wi-Fi

1. [Configure Wi-Fi and trust the board's HTTPS certificate](WIFI.md).
2. Open `https://BOARD_IP/` and choose **Virtual media → Wi-Fi**.
3. Choose **Pair with USB** or **Pair with Bluetooth**. Pairing checks the physical
   board's identity and reads its access token automatically. **Enter token
   manually** is available for browsers without those APIs.
4. Connect media. Keyboard and mouse use Wi-Fi automatically when no USB or
   Bluetooth control link is active. To switch an active control link, choose
   **Connection settings → Use Wi-Fi for keyboard & mouse**.

Pairing leaves the physical control connection open. The programming cable is
optional after switching control to Wi-Fi. Bluetooth carries control commands,
not disk data.

The board pauses Bluetooth discovery while a Wi-Fi disk is inserted. Existing
Bluetooth connections stay active and can reduce Wi-Fi throughput. Eject before
starting or reconnecting Bluetooth; discovery resumes after ejection or media-link
failure. USB media does not pause discovery.

Only one USB or Wi-Fi media connection can own the board at a time. A second
connection cannot take over an active session.

## Boot images

Choose an `.img`, `.img.xz`, or **USB-bootable hybrid** `.iso`. Optical-only ISOs
are unsupported: the device presents a USB disk, not a CD/DVD drive.

The app prepares `.img.xz` files automatically. A worker streams the decompressed
image into Origin Private File System storage (OPFS), validates the XZ structure
and checksums, and records the raw image's SHA-256. It supports ordinary LZMA2 XZ
images with CRC32 or CRC64 checks and dictionaries up to 64 MiB. Preparation needs
space for the **full decompressed image**, plus later changed sectors. Quota or
unsupported-format errors stop the import. **Cancel import** removes partial
output; interrupted imports are reclaimed on the next saved-disk refresh.

Newly selected raw images are hashed in a worker. The app inspects supported
MBR/GPT layouts and FAT16/FAT32 EFI system partitions for
`\EFI\BOOT\BOOTX64.EFI`. These checks do not establish Secure Boot trust or
compatibility with every target, and do not modify the source.

Leave **Allow target to write** disabled for read-only/live images. Full OS disks
such as Armbian need [target writes enabled](#enable-target-writes) for first-boot
setup and ordinary root-filesystem changes.

Choose **Insert into target** to give the target exclusive disk access. Browser
filesystem edits and exports are locked until ejection and synchronization.
Booting an OS image runs it from virtual media; installation onto an internal
drive is a separate operation.

## Enable target writes

If the disk is already inserted, unmount it on the target or power the target
off, then **Eject and synchronize** before changing write mode.

1. Connect media and select the boot image or saved FAT32 drive.
2. Enable **Allow target to write**.
3. Choose **Allow persistent storage** if prompted. The browser decides whether
   to grant it; some browsers do not show a permission dialog.
4. Expand **Disk details & download** and confirm **Persistent browser storage
   enabled.** Writable insertion stays disabled until this permission is granted.
5. Choose **Insert into target**, then boot or use the disk on the target.

Target writes commit to a persistent copy-on-write overlay. The original image
stays unchanged. Keep the console open and the computer awake during use; unmount
on the target before **Eject and synchronize** to flush its cached writes.

### If persistent storage is not granted

Use a regular browser profile and the trusted HTTPS console. If Edge keeps
refusing the request:

1. Eject and synchronize any inserted disk, then disconnect media.
2. At the same console URL, choose **Settings and more (…) → More tools → Apps →
   Install this site as an app**. [Edge instructions](https://support.microsoft.com/en-us/edge/install-manage-or-uninstall-apps-in-microsoft-edge).
3. Close the original console tab and open the installed app using the same Edge
   profile and exact HTTPS address. Saved disks remain in that profile/origin.
4. Reopen the saved disk, enable writes and request persistent storage again.
   Confirm **Persistent browser storage enabled.** before inserting.

App installation can help Edge grant persistence; it does not guarantee a grant.
If storage remains unprotected, use read-only media. Certificate trust alone does
not grant persistent storage. See [certificate setup](WIFI.md#trust-the-certificate)
if the page reports that browser storage is unavailable.

## FAT32 USB drives

Choose **USB drive**, a capacity from **64 MiB to 32 GiB** in whole MiB, and a
1–11 character ASCII label using letters, digits, spaces, hyphens or underscores.
The drive uses an MBR and FAT32 LBA partition starting at sector 2048.

While ejected, you can add files, create folders, navigate directories, preview
the first 64 KiB of a file as text, download files, and remove files or empty
folders. UTF-16 VFAT long names are supported, with a 255 UTF-16 code-unit limit.
Reserved device names, forbidden characters, trailing dots/spaces, and
case-insensitive duplicates are rejected. Each file is limited to **4 GiB minus
one byte**.

Read-only insertion lets the target read browser-added files. Writable insertion
also lets the target create or change files. To retrieve target changes:

1. Finish copies and unmount/eject the USB disk **inside the target OS**.
2. Confirm **The disk is unmounted on the target, or the target is off**.
3. Choose **Eject and synchronize**. The browser finishes storage transactions
   and reloads the directory state.
4. Download individual files or the updated disk image.

The board respects the target's removal lock. If ejection is refused, eject the
USB device in the target OS first. A target-initiated eject also requires browser
synchronization before editing.

## Saved disks and exports

Disk pages, overlays and metadata use IndexedDB. Prepared `.img.xz` sources use
OPFS. Both belong to the **browser profile and exact origin**, including its port.
Changing from localhost or a hosted site to the board's HTTPS page, or opening a
different board IP, uses separate storage. Export needed changes before moving
origins.

- **Prepared `.img.xz`:** reopen it from the saved-disk list without selecting the
  compressed file again. Reopening checks source presence and size; it does not
  rescan the saved image's checksum. If the prepared source is missing, select
  the original `.img.xz` to restore it against the overlay's fingerprint.
- **Directly selected `.img` or `.iso`:** after a reload, select the saved overlay
  and reselect the original file. Its size and SHA-256 must match.
- **Created FAT32 drive:** reopen it directly from the saved-disk list.

Writable insertion requires persistent-storage permission and Web Locks, which
prevent concurrent access to the same saved disk from multiple tabs. Clearing
browser data removes saved disks and changes. Persistence does not replace an
external backup or protect against storage failure.

**Disk details & download → Download disk image** exports a new `*-updated.img`.
Browsers with Save File support stream directly to the selected destination;
other browsers stage the export in OPFS and offer a download. Staged exports
consume browser storage and are not automatically deleted. Choose **Confirm
download saved** only after saving the file outside the browser. Exports require
ejection; overlays are not automatically pruned.

## Failures and recovery

Keep the tab visible and the computer awake while a disk is inserted. Browser
suspension, cable removal, a failed storage transaction or a lost media connection
can make the disk unavailable to the target. Committed writes remain saved.

After a failure, unmount/eject the disk on the target or power the target off,
confirm that state in the panel, then choose **Eject and synchronize**. Reconnect
and insert the disk explicitly. Do not recover while the target is using it.
Ejection removes the medium without disconnecting keyboard and mouse.

Each successful target-write reply follows a strict-durability IndexedDB commit.
A large SCSI write can partially commit before a later chunk fails. A transaction
can also finish after a USB timeout, leaving an uncertain write outcome. Safe
ejection and inspection are required; failed requests do not return fabricated
zeroes or successful write acknowledgments.

If a browser filesystem edit is interrupted, the saved disk is marked as needing
a check and cannot be inserted or edited. Export it for external filesystem
repair, then re-import the repaired image. Target-created corruption is reported
when the browser detects it while parsing the filesystem.

A USB bus reset cancels outstanding operations while keeping an inserted source
available for fresh requests. SCSI cache synchronization succeeds only when the
medium is usable and no request is pending; it cannot flush data still cached by
the target OS. Timing and session details are in the [protocol](PROTOCOL.md).

## Boot-key repetition

Connect Serial, Bluetooth or Wi-Fi control. Under **Boot key**, select a key and
choose **Start repeating** before manually restarting the target. F12 is the
Wyse boot-menu default. The board does not control target power.

Defaults are 0 ms delay, 80 ms press, 300 ms press-start interval and 60 seconds
active duration. Press time can be 20–2000 ms, the interval must include at least
10 ms of release time, delay is limited to 120 seconds, and active duration to
300 seconds. The panel shows **Stop and release key** while repetition is active.

Repetition sends distinct press/release reports and waits for USB keyboard
readiness. Re-enumeration does not extend its duration. Ordinary input takes
priority if all six boot-keyboard slots are occupied. Stop releases the repeated
key at the next writable keyboard opportunity; a disconnected target receives
the cleared report on re-enumeration.

## Performance and diagnostics

Standard firmware negotiates Wi-Fi read-ahead up to **32 KiB** with PSRAM; USB
UART and the no-PSRAM fallback use **8 KiB**. The experimental
`sdkconfig.media-performance` build overlaps Wi-Fi reads with USB delivery,
grows sequential read-ahead from **32 → 64 → 128 KiB**, and uses an **8 KiB USB
transfer buffer** instead of 4 KiB. Random seeks reset growth. A sent speculative
read drains before another remote operation; a matching USB demand can wait on
that same request. Writes and USB resets discard speculative data. The browser
and firmware negotiate the ceiling; older firmware receives a 32 KiB HELLO retry.
Writes still wait for browser storage commits, only one remote disk request is
outstanding, and writes or media changes invalidate the read-ahead cache.

**Connection settings → Test connection speed** measures echo throughput between
the browser and board, including a helper if used. It does not measure target
USB reads or durable writes. During target use, the panel reports read/write
counts and current read speed; idle speed falls to zero. **Disk details &
download** shows browser response timing, excluding network transit and target
USB completion.

`GET /device/diagnostics` exposes media counters without acquiring a media session
or reading image contents. Counters reset after a successful media connection:

| Counter | Meaning |
| --- | --- |
| `reads`, `readBytes` | Successful matching remote read replies, including read-ahead bytes |
| `readTimeUs`, `readMaxUs` | Total and maximum request-to-validated-reply time |
| `cacheBytes` | Target bytes served from the board's read-ahead cache |

Compare `readBytes` across two snapshots and divide by elapsed time for remote
throughput. Cache bytes are separate and must not be added as unique disk data.
For hardware results, including Armbian boot on the Dell Wyse 3040, see
[validation](validation/virtual-media.md).
