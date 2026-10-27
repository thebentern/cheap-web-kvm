# CH9329 wire protocol, as actually spoken by the DezKVM-Go web UI

**Provenance.** Everything below was extracted by reading the byte-serialisation
code in the front-end, not from the CH9329 datasheet. The authoritative source is
the `HIDController` class in [`local-kvm.js`](local-kvm.js) (upstream:
`tobychui/DezKVM-Go`, `docs/local-kvm.js`). Where the datasheet and this document
disagree, this document wins — it describes what is on the wire.

The firmware parser in [`firmware/main/ch9329.c`](../firmware/main/ch9329.c) is
written against this document.

---

## 1. Transport

Default `921600 8N1`, no flow control. `CONFIG_KVM_UART_BAUD` selects the firmware
rate; the browser's USB baud setting must match it. The UI opens the port with
`navigator.serial.requestPort()` and `serialPort.open({ baudRate })`.

The reference CH9329 design ships at 9600 baud and needs initial reconfiguration.
This firmware instead starts directly at its compiled UART rate (default 921600).
The UI offers 115200, 460800, 921600 and 2000000 in USB connection settings and
Settings → Advanced. It remembers the selection in this browser and applies it
to the next serial connection; changes are blocked while the port is open.
Selecting a browser rate does not change the firmware's rate. For older firmware
configured at 115200, explicitly select 115200 in the browser before connecting.

### Bluetooth LE

A second transport for hosts with no Web Serial — an iPad, through a Web
Bluetooth browser such as Bluefy. It carries **the same frames, byte for byte**:
nothing below this section changes. This is not part of the CH9329; it is
specific to this firmware ([`kvm_ble.c`](../firmware/main/kvm_ble.c)).

| | UUID | Properties |
|---|---|---|
| Service | `a1340001-d6af-4060-9ae5-7254073b70b8` | advertised |
| RX (host → device) | `a1340002-d6af-4060-9ae5-7254073b70b8` | write, write without response |
| TX (device → host) | `a1340003-d6af-4060-9ae5-7254073b70b8` | notify |

* The board advertises the service UUID and puts its name,
  `cheap-web-kvm-XXXX` (the end of its Bluetooth address), in the scan response.
* RX is a byte pipe into its own parser, exactly like UART0. Frames may be split
  across writes or packed several to one; keep each write to whole frames
  anyway, because a write that does not fit the receive buffer is dropped whole.
* Replies arrive as TX notifications. Subscribe before the first write.
* **RX needs an authenticated, encrypted link.** Pairing is LE Secure
  Connections passkey entry against a six-digit passkey: `KVM_BLE_PASSKEY` from
  menuconfig (default `123456`) until a host sets another with the vendor
  command in §6, which the board keeps in NVS. The bond is stored, so pairing
  happens once per host. Legacy pairing is disabled.
* **The first write must be a write with response.** An unpaired write is
  refused with Insufficient Authentication, and that error is what makes iOS,
  iPadOS and macOS show the passkey prompt. A write without response on an
  unpaired link is dropped with no error at all. The UI's first write is
  `GET_INFO`, which also proves the far end is this firmware.
* One connection at a time. The board asks for a 15–30 ms connection interval,
  the shortest Apple's accessory guidelines allow.

## 2. Frame format

Requests and replies share one framing:

```
+------+------+------+------+------+---------------+----------+
| 0x57 | 0xAB | ADDR | CMD  | LEN  | PAYLOAD[LEN]  | CHECKSUM |
+------+------+------+------+------+---------------+----------+
   0      1      2      3      4      5 .. 5+LEN-1    5+LEN
```

* `ADDR` is always `0x00` from the UI, and the UI's reply parser **hardcodes a
  check for `0x00`** in the third byte. The firmware echoes the received address,
  which amounts to the same thing.
* `CHECKSUM` is the sum of every preceding byte in the frame, mod 256 —
  header bytes included.

```js
// local-kvm.js
calcChecksum(arr) {
    return arr.reduce((sum, b) => (sum + b) & 0xFF, 0);
}
```

## 3. Commands the UI emits

These four are the complete set. Every UI feature — paste box, on-screen
keyboard, quick-access hotkeys and macros, stacked keys, mouse jiggler, both
mouse modes — is built on top of `HIDController`, and `HIDController` writes to
the serial port from exactly four places.

| CMD | Name | LEN | Payload |
|---|---|---|---|
| `0x02` | Keyboard general data | `0x08` | `[modifier, 0x00, keycode×6]` |
| `0x04` | Absolute mouse | `0x07` | `[0x02, buttons, xLSB, xMSB, yLSB, yMSB, wheel]` |
| `0x05` | Relative mouse | `0x05` | `[0x01, buttons, dx, dy, wheel]` |
| `0x0F` | Soft reset | `0x00` | — |

### 0x02 — Keyboard

Standard 8-byte HID boot report: a modifier bitmap, a reserved zero byte, and up
to six simultaneous keycodes. The UI maintains the pressed-key set itself and
resends the whole report on every change; there is no separate press/release
command.

Modifier bits are the usual HID assignment: `0x01` LCtrl, `0x02` LShift, `0x04`
LAlt, `0x08` LGUI, `0x10` RCtrl, `0x20` RShift, `0x40` RAlt, `0x80` RGUI.

### 0x04 — Absolute mouse

**X and Y are 12-bit, spanning `0..4095`**, sent little-endian in two bytes each:

```js
const absX = Math.round(offsetX * 4095);
await controller.MouseMoveAbsolute(absX & 0xFF, (absX >> 8) & 0xFF, ...);
```

This is the single most important number in this document. TinyUSB's stock
`TUD_HID_REPORT_DESC_ABSMOUSE` macro declares a logical maximum of `32767`; used
unmodified it would confine the pointer to the top-left eighth of the target's
screen. The firmware hand-rolls the report descriptor with
`LOGICAL_MAXIMUM = 4095` so the wire values map 1:1 with no rescaling.

`buttons` is a bitmap: `0x01` left, `0x02` right, `0x04` middle.

The leading `0x02` byte is the CH9329 sub-command selecting absolute reporting.

### 0x05 — Relative mouse

`dx`, `dy` and `wheel` are signed values carried in unsigned bytes; the UI
converts negatives with `256 + v`. It also deliberately avoids `0x80`:

```js
if (dx === 0x80) dx = 0x81;
if (dy === 0x80) dy = 0x81;
```

The leading `0x01` byte selects relative reporting.

**The relative command is used even when absolute mode is active.** Scroll wheel
events always go out as `0x05` with `dx = dy = 0`, and so does the mouse
jiggler:

```js
async MouseScroll(tilt) {
    ...
    await this.MouseMoveRelative(0, 0, wheel);
}
```

Absolute and relative reporting are therefore not build-time alternatives — the
device must offer both simultaneously. The firmware does this with two report
IDs on one pointer interface (`1` = absolute, `2` = relative).

The target USB pointer interface also advertises Boot Mouse compatibility.
When a BIOS selects Boot protocol, the firmware sends unnumbered three-byte
reports: the first three buttons, signed X movement and signed Y movement.
Wheel and absolute-position data are unavailable in this protocol. Enable
**Settings → Keyboard & mouse → Use relative mouse mode** for BIOS/UEFI use;
the CH9329 command framing above does not change. Operating systems using
Report protocol retain the absolute and relative report IDs and wheel data.

### 0x0F — Soft reset

Sent once, 100 ms after the port opens, and again from Settings → Reset HID.
Zero payload. The firmware treats it as "release every key and button".

## 4. Replies

```
0x57 0xAB ADDR (CMD | 0x80) LEN PAYLOAD CHECKSUM     success
0x57 0xAB ADDR (CMD | 0xC0) LEN ERRCODE  CHECKSUM     error
```

The worked example in the UI's own comments, for a reply to `0x04`:

```
57 AB 00 84 01 00 87
```

`0x87` checks out: `0x57 + 0xAB + 0x00 + 0x84 + 0x01 + 0x00 = 0x187`, and
`0x187 & 0xFF = 0x87`.

> **A reply must be at least 7 bytes long, so `LEN` must be ≥ 1.** The UI's
> parser only begins scanning once `serialReadBuffer.length >= 7`, and iterates
> `for (let i = 0; i <= serialReadBuffer.length - 7; i++)`. A zero-payload reply
> is six bytes and would never be matched — the UI would stall for its full
> timeout on every command. The firmware always replies with a one-byte status
> payload of `0x00`.

Error codes follow the real part: `0xE1` timeout, `0xE2` header, `0xE3` unknown
command, `0xE4` checksum, `0xE5` bad parameter, `0xE6` operation failed.

## 5. Timing

`sendPacketAndWait()` blocks for **up to 300 ms per command**, polling every
5 ms, and clears its receive buffer before each send. On timeout it resolves
`{ success: false, timeout: true }` rather than throwing.

This has a sharp consequence for throughput. The paste box sends one character
as up to four separate commands — press Shift, press key, release key, release
Shift — each of which waits for its own reply, plus a fixed 30 ms sleep per
character:

```js
await new Promise(resolve => setTimeout(resolve, 30));
```

A firmware that never replies still *functions*, because of the graceful
timeout, but each pasted character would cost up to 1.2 s. **Replying promptly
is a correctness requirement in practice.** The firmware answers as soon as a
frame is parsed and queued, not after the HID report reaches the target.

In the other direction, keystroke injection toward the target is floored at one
report per 10 ms; targets drop characters from the paste box otherwise,
BIOS/UEFI especially.

Over Bluetooth every round trip is one or two connection intervals rather than a
millisecond, and GATT takes one write at a time. The UI therefore queues frames
and sends them one by one, and a pointer move still waiting in the queue is
merged with the next one instead of being sent late: absolute moves keep the
newer position, relative moves add their deltas, and scroll-only frames add
their wheel ticks when they scroll the same way. Nothing merges across a button
change, a scroll never merges with a move, and nothing merges into a frame that
changed the buttons, so a click arrives as a press and a release at the same
spot. Keyboard frames are never merged.

## 6. Commands beyond the four above

`0x01` (get info) replies with an 8-byte payload: firmware version `0x30`, USB
enumeration status (`0x01` when the target has enumerated us), the keyboard LED
bitmap the target last pushed over `SET_REPORT`, then reserved zeros. It exists
for compatibility with third-party CH9329 tooling. The UI sends it only over
Bluetooth, as the first write, to trigger pairing (§1).

Two **vendor extensions** set the Bluetooth pairing passkey. They are not part of
the CH9329 — a real one answers `0xE3` — and sit below `0x40` so that
`CMD | 0x80` and `CMD | 0xC0` still tell a reply from an error. A build without
Bluetooth also answers `0xE3`.

| CMD | Name | LEN | Payload | Reply payload |
|---|---|---|---|---|
| `0x30` | Get Bluetooth passkey | `0x00` | — | passkey, `uint32` little-endian |
| `0x31` | Set Bluetooth passkey | `0x04` | passkey, `uint32` little-endian | `0x00` status |

```
57 AB 00 31 04 F1 FB 09 00 2C      set 654321
```

The set command answers `0xE5` past `999999` and `0xE6` if NVS cannot be
written. Bonds made under the old passkey survive the change. Either transport
may send both: over UART the host holds the cable, and over Bluetooth only a
host already paired gets as far as a write.

## 7. Deliberate deviations from byte-faithful emulation

Two places where the firmware does **not** simply forward what the UI sent.

### Modifier usages are folded into the modifier byte

The UI puts modifier keys in the *keycode array*, not the modifier byte. The
paste box sends Shift as `SendKeyboardPress(16)`, and
`javaScriptKeycodeToHIDOpcode(16)` returns `0xE1`, which then occupies one of the
six keycode slots while the modifier byte stays `0x00`:

```js
// paste-box.js
if (needsShift) {
    await controller.SendKeyboardPress(16);
}
```

Full-OS HID stacks generally cope with modifier usages appearing in the array.
Boot-protocol consumers do not — they read shift state from the modifier byte
only. Forwarding this verbatim would mean every uppercase letter and shifted
symbol pasted at a BIOS/UEFI prompt arrives unshifted, which defeats the point of
the device.

The firmware therefore folds any usage in `0xE0..0xE7` out of the keycode array
and into the corresponding modifier bit. Hosts that already handled the array
form see an equivalent report, so nothing regresses.

Note that upstream maps JS keycode 18 (Alt) to `0xE6`, which is Right Alt;
Left Alt is `0xE2`. The firmware folds whatever it is given rather than
second-guessing it, so Alt still arrives as Right Alt.

### Soft reset clears both pointer report IDs

`0x0F` releases the keyboard *and* both pointer reports. Report IDs 1 and 2 are
separate top-level Application collections, so hosts that instantiate one device
per collection — Windows and macOS do — track their button state independently,
and clearing only one would leave a button latched. The absolute release repeats
the last known position so that unsticking a button does not fling the cursor to
the corner.

## 8. Where this contradicts the project brief

Three assumptions in the original brief did not survive contact with the source:

1. **There is no handshake the UI requires.** The brief anticipated a device
   info/handshake probe that the UI might "refuse to proceed" without. It does
   not probe. It sends a soft reset (`0x0F`) shortly after connecting and carries
   on regardless of the answer.

2. **There is no Web Serial VID/PID filter to change.** The brief expected the
   fork to need a change to the device picker's filter. `requestSerialPort()`
   calls `navigator.serial.requestPort()` with no argument, so every serial
   device is offered and any USB-UART bridge works unmodified. No change needed.

3. **The capture-device VID/PID filter is the one that does need changing**, and
   the brief did not mention it. `startStream()` matches a hardcoded list of
   `534d:2109` / `345f:2109` (MS2109). The MS2130 enumerates as `534d:2130` and
   would not have been found. See [`local-kvm.js`](local-kvm.js).

## 9. Reference

The test harness at [`tools/ch9329_test.py`](../tools/ch9329_test.py) emits
byte-exact frames matching this document and validates the replies. Run it
against the board to verify the protocol layer without a browser.

## 10. Boot repetition vendor commands

These work on UART, bonded Bluetooth, and the Wi-Fi HID envelope. They do not
change CH9329 keyboard/mouse framing or require a mass-storage session.

| CMD | Payload | Successful reply |
|---|---|---|
| `0x32` | key usage `u8`, initial delay `u32`, press `u32`, press-start interval `u32`, active duration `u32` (all times ms, little endian; 17 bytes) | `00` |
| `0x33` | empty | `00` (cancel and release at next writable keyboard opportunity) |
| `0x34` | 0–64 echo bytes | same bytes; use nonempty data for existing reply parsers |

The key range is `04..73`; F12 is `45`. Delay ≤120000, press 20..2000,
interval ≥press+10 and ≤10000, active duration ≥press and ≤300000. Invalid
parameters return `E5`. The HID task owns repetition and timing; a mailbox
makes cancellation independent of the ordinary HID queue. Total time starts
after the delay and does not extend across reboots. Ordinary six-key input is
merged with the pulse when room exists. The macro neither controls target power
nor treats UART connection loss as a target power-cycle.

UART baud defaults to 921600. `CONFIG_KVM_UART_BAUD` permits build-time
candidates up to 2000000; benchmark the actual bridge using
`tools/benchmark_serial.py` for HID timing. The virtual-media panel has a separate
sector-transport echo benchmark.

## 11. Virtual media protocol v1

Media frames use a separate format from CH9329 commands. Over USB UART they are
multiplexed using the envelope in section 13. Over Wi-Fi, one binary WebSocket
message carries each frame on the ESP32 `/media` endpoint. Runtime Wi-Fi settings
select Hotspot or Client. The board-hosted HTTPS console uses a paired,
same-origin browser session. The optional HTTPS helper authenticates to the
legacy HTTP endpoint with `X-KVM-Token`; it requires a same-origin HTTPS browser
request and never accepts an arbitrary client-provided upstream. Transport echo
measurements do not qualify OS boot or sustained disk throughput.

### Device HTTPS and browser pairing

With `CONFIG_KVM_DEVICE_WEB`, HTTP port 80 serves a setup page and the public
per-device certificate authority at `GET /device/ca.crt`. Verify that authority's
DER SHA-256 fingerprint independently over UART/bonded BLE before manually
trusting it on a client. The HTTP page's own fingerprint is not an independent
identity check. The authority and private server key are stored in NVS. The
server leaf has an 800-day lifetime, below the 825-day ceiling documented in
[Apple’s TLS server certificate requirements](https://support.apple.com/en-us/103769); the authority's
2020–2049 validity is separate. `device_tls_needs_renewal()` detects fewer than
30 days remaining or an oversized old leaf lifetime. The network maintenance path
also renews after IP changes and checks lifetime even when IPs are unchanged.
Renewal preserves the CA and keys. HTTPS is restarted for the new leaf only while
media is absent and idle, keeping an inserted source's ownership intact.

CMake supplies `KVM_BUILD_TIME` as a firmware-build epoch for the initial offline
clock. Client mode attempts SNTP using `pool.ntp.org`. This fallback does not
provide a current clock indefinitely without network time: an expired leaf with
an old offline clock needs a fresh build or a usable current time source. It does
not justify disabling client certificate checks. `tools/device_certificate.py`
verifies a downloaded authority against its USB readout and does not install trust.

HTTPS port 443 serves the compressed static console, `GET /device/info`,
`POST /device/session`, and `/media`. Pairing posts `{"token":"…"}` using the
saved 16–80 character media access token. It requires an exact same-origin HTTPS
Origin/Host match and returns a Secure, HttpOnly, SameSite=Strict session cookie.
The token is not embedded in static assets or cookie values. Sessions are bounded,
expire after eight hours, and are cleared on board/server restart or a
network/token change.
Bad pairing attempts are rate limited. Browser WebSocket upgrades require both a
valid session and the same-origin check. A helper may continue authenticating with
its configured header. Only one connection owns the medium across HTTP, HTTPS and
USB UART; the HTTPS server's seven-socket limit does not expand that ownership.

Static assets are const flash-backed data, sent in bounded chunks with MIME,
Content-Encoding and ETag headers. Unknown assets return 404. `/flash` redirects
to the full hosted installer. Firmware binaries and the oversized OCR engine/data
are excluded from the device image. Browser storage remains bound to the exact
HTTPS origin, including IP/hostname and port.

### Encoding

| Bytes | Field |
|---|---|
| 0..3 | ASCII `KVM1` |
| 4 | version `1` |
| 5 | opcode; bit 7 marks a response |
| 6..7 | flags on requests, status on responses (`u16` LE) |
| 8..11 | session (`u32` LE), generated by successful HELLO |
| 12..15 | nonzero request ID (`u32` LE), echoed in response |
| 16..23 | byte offset, inserted capacity, or HELLO transfer ceiling (`u64` LE) |
| 24..27 | logical length (`u32` LE), at most the negotiated ceiling (absolute maximum 32768) |
| 28..31 | IEEE CRC-32 (`u32` LE) over header bytes 0..27 followed by payload |
| 32.. | payload, at most the negotiated ceiling (absolute maximum 32768 bytes) |

CRC uses reflected polynomial `EDB88320`, initial/final XOR `FFFFFFFF`.
`123456789` yields `CBF43926`. Headers are encoded explicitly, without packed C
struct casts. The header length is the **IO length** on READ/WRITE requests and
responses; a WRITE success ACK therefore has a nonzero length but no payload.
For controls, request/reply length must match actual payload length. Corrupt,
truncated, unknown-version or excessive-length frames receive no ACK; deadlines
fail the operation. CRC is integrity checking, not cryptographic authentication.

| Op | Direction | Fields and result |
|---|---|---|
| `01` HELLO | browser → ESP | Empty, session ignored. Offset requests a block-aligned transfer ceiling from 8192 to 32768; zero selects the legacy 8192 limit. Accepted only with no inserted medium or pending IO. Reply: new session and 8 capability bytes: version `1`, one-request IO window/durable-write contract `1`, 512-byte blocks LE, selected transfer ceiling LE, media capability `1`, transport hint (0=Wi-Fi, 1=USB UART). Wi-Fi can select up to 32768 when its optional PSRAM buffers are available; UART always selects 8192. Older firmware ignores the requested offset and replies with 8192. |
| `02` INSERT | browser → ESP | Empty; offset=capacity bytes, flags bit 0=writable. Capacity must be a positive multiple of 512, up to `FFFFFFFF` sectors. Fails while inserted, pending, or removal-prevented. Creates a medium-change indication without USB/HID disconnect. |
| `03` EJECT | browser → ESP | Empty. Succeeds only with no pending IO and removal allowed. It is the browser's synchronization barrier; it does not flush the target OS cache. |
| `04` ECHO | browser → ESP | Up to the negotiated ceiling, echoed exactly for measurement. Measures aggregate round-trip transport, not durable storage or USB. |
| `05` HEARTBEAT / `06` STATUS | browser → ESP | Empty. Reply offset=capacity; one payload byte: writable `01`, present `04`, failed `08`, removal-prevented `10`, macro-active `20`. Refreshes the lease. |
| `07` HID | browser → ESP | One complete CH9329 frame, up to 70 bytes. Reply contains its full CH9329 reply; a fresh parser prevents truncated-frame state crossing requests. |
| `08` BOOT | browser → ESP | Same 17-byte payload as CH9329 `32`. |
| `09` CANCEL | browser → ESP | Empty; same effect as CH9329 `33`. |
| `10` READ | ESP → browser | offset=byte address, length=1..negotiated ceiling, empty payload. Reply `90`: same address/length/ID/session and exactly length bytes on success. |
| `11` WRITE | ESP → browser | offset=byte address, payload exactly length bytes. Reply `91`: same address/length/ID/session, **empty payload**, success only after strict storage transaction commits. |

Control response statuses: `0` success, `1` invalid, `2` busy, `3` stale session,
`4` IO/storage failure, `5` read-only, `6` offline, `7` removal prohibited. A disk
response with nonzero status fails the operation and invalidates the medium.
Mismatched session, request ID, opcode, address, length, or USB bus epoch cannot
complete the pending operation. Nonzero status READ responses contain no data.
Browser disk operations validate bounds before touching storage. The source image
is never written.

### Scheduling, durability and reset rules

Only one disk IO request is in flight. The browser has at most four control
requests outstanding; HID has a separate bounded 64-item queue and coalesces
motion without crossing button edges. Boot cancellation bypasses that input
queue. Bluetooth remains control-only. Wired media uses the UART framing below and shares
the programming cable with CH9329 control.

TinyUSB READ10/WRITE10 callbacks enqueue bounded state and immediately return
`TUD_MSC_RET_ASYNC`. The selected HTTP or UART transport carries messages, while the browser worker
performs asynchronous File/IndexedDB operations. Completion is deferred to the USB
task, checks request ID and bus epoch, then touches the USB buffer and calls
`tud_msc_async_io_done`. Neither USB callbacks nor HID tasks wait on network or
browser storage. The read path fetches up to the negotiated ceiling ahead and caches that range
(up to 32 KiB on Wi-Fi; 8 KiB for legacy clients or UART);
any write or medium change invalidates it. The browser uses an eight-page 64 KiB
LRU. No speculative data is returned after an error.

All target write ACKs follow a strict IndexedDB transaction covering modified
pages and revision metadata. There is no acknowledged volatile device cache.
SYNCHRONIZE CACHE (`35`) succeeds only with a usable medium and no pending IO;
otherwise it fails. Partial SCSI writes can have committed earlier chunks even
when a later chunk fails. The driver never promises rollback.

IO deadline is 10 s. The idle lease remains 5 s; unfinished IO retains its full
deadline, and matching successful replies renew the lease. The browser schedules
heartbeats every second with at most one in flight and a 12 s reply deadline;
other controls retain 4 s. The HTTPS server bounds new handshakes through a 2 s
total budget checked at TLS BIO calls and SDK return, preserving certificate
verification and existing-session timeouts. On timeout/disconnect the
medium becomes unavailable and pending IO fails. A transaction already in the
browser may still finish after a timeout; its data stays persisted, but its stale
ACK cannot revive the medium. User recovery requires target unmount/power-off,
then a worker FIFO barrier before edits. Reinsertion is explicit.

USB bus reset/unplug increments an atomic epoch. A small linker wrapper around
TinyUSB 0.21's `mscd_control_xfer_cb` does the same for a valid MSC BOT reset
(`21 FF`, interface 2, zero value/length), delegating the request to TinyUSB.
Old buffer references and outstanding requests are discarded. Fresh requests can
use the still-inserted medium. Reset also clears stale removal-prevention/cache
state. This integration is checked against the pinned TinyUSB API.

TEST UNIT READY reports medium-change unit attention (`06/28/00`) once per
insertion/change, and missing media as `02/3A/00`. Write protection is advertised
through `tud_msc_is_writable_cb`. PREVENT/ALLOW removal and target START STOP eject
are respected. TinyUSB 0.21 maps read/write callback errors to medium-not-present;
custom detailed failure text remains in the browser. Unknown SCSI commands fail
with illegal request. HID interface 0 remains boot-compatible and has no report ID.

See [Virtual media](VIRTUAL_MEDIA.md) for FAT32 ownership, persistent overlays,
export semantics, local proof mode, limitations, and hardware acceptance steps.

## 12. Runtime Wi-Fi settings (version 1)

The web UI configures Wi-Fi through the existing UART/bonded BLE CH9329 link, or
through its authenticated Wi-Fi HID envelope. New commands remain below `40`.
Passwords are stored in a separate `kvm_wifi/settings` NVS blob, not browser
settings. A fresh build includes the interface and starts Wi-Fi off; explicit
build-time hotspot credentials are bootstrap values only. Saved settings win on
later boots. Disabling `CONFIG_KVM_MEDIA_WIFI` makes these commands return `E3`.

Modes: `0` off, `1` WPA2 hotspot, `2` router client with DHCP. Client mode can keep
an independently configured recovery hotspot (AP+STA). No IBSS/ad-hoc networking,
enterprise authentication, static IP UI or network scanning is advertised.

Fields: `1` mode (one byte), `2` hotspot SSID (≤32 bytes), `3` hotspot password
(8–63 printable ASCII), `4` router SSID (≤32 bytes), `5` router password (8–63
printable ASCII; required in Client mode), `6` media access token
(16–80 printable non-space ASCII), `7` recovery hotspot (one byte, 0/1).
SSIDs are UTF-8 in the browser. Password fields omitted from a transaction retain
their saved values. All messages fit the existing 64-byte payload ceiling.

| CMD | Request | Reply |
|---|---|---|
| `35` metadata | Empty | `[version=1, supported=1, mode, recovery, ap_password_set, router_password_set, token_set, apply_pending]` |
| `35` field read | `[1, field, offset]` | `[1, field, total_bytes, offset, up_to_60_data_bytes]`; readable fields 2/4, plus 3/6 only when explicitly requested, and read-only certificate fingerprint field `0x80`. Router password field 5 is never returned. |
| `36` begin | `[1, 0]` | `[1, transaction_id_u32_LE]`; snapshot of current settings, bound to the parser/control owner, with a 30 s expiry. Another owner cannot replace an active transaction. |
| `36` field fragment | `[1, field, transaction_id_u32_LE, offset, total_bytes, up_to_56_data_bytes]` | `00` on acceptance. Fragments must be contiguous, within bounds, and contain no embedded NUL. Offset 0 starts/restarts that field. Empty total/data explicitly clears a string field. |
| `37` commit/apply | `[1, transaction_id_u32_LE]` | `00` only after full validation and NVS commit. Missing/expired/wrong-owner fragments fail. Requires ejected, idle media; insertion is reserved/blocked until applying completes. |
| `38` status | Empty | 19 bytes: `[1, mode, state, apply_pending, hotspot_ipv4×4, router_ipv4×4, retries, disconnect_reason_u16_LE, esp_error_u32_LE]` |

Field `0x80` is reserved for the on-board trust authority's SHA-256 fingerprint.
Read it with CMD `0x35`, payload `[1,0x80,offset]`; its reply uses the same field
fragment schema as other reads. Once the TLS identity is ready, it contains 64
lowercase ASCII hex characters over the DER certificate, not its PEM text. Read
offsets 0 and 60 for all characters. It is read-only and is not accepted by the
`0x36` settings write transaction. This allows a certificate downloaded over HTTP
to be verified independently using the programming cable or bonded Bluetooth.

State values: `0` off, `1` hotspot active, `2` joining/waiting for address, `3`
router connected with DHCP address, `4` failure. All-zero IPv4 means unavailable.
Client retries are bounded to five retries and a 45 s joining/address deadline.
Recovery AP remains available on failure; a new apply retries. Status never
contains a password or token.

Invalid requests/settings return `E5`; busy media, another transaction owner,
apply already pending, NVS or platform failures return `E6`; mutex timeout `E1`.
A failed NVS commit leaves the running config unchanged. Applying waits 500 ms
after acknowledgement before stopping/restarting Wi-Fi and its HTTP/HTTPS endpoints.
USB HID and BLE are not restarted. Changing Wi-Fi/token can disconnect a Wi-Fi
control session; Serial or Bluetooth remains the recovery route.

The media lock is released before dispatching Wi-Fi HID envelopes, so a settings
commit can safely reserve the media-change gate without recursive locking. The
HTTP pump stops queueing work before server shutdown and is joined before token
replacement/restart. Serial transactions are serialized so status/configuration
replies cannot clear a concurrent HID reply. BLE writes use 20-byte fragments
and notifications respect the negotiated ATT MTU; both parsers reassemble the
same complete CH9329 frame. The first BLE write still uses an authenticated
write-with-response to trigger pairing.


## 13. USB programming-port media transport

Wired media uses the existing USB-UART programming connection at the firmware's
configured UART0 baud (default 921600). The native USB port remains the target's
HID/MSC device. Media packets keep the version-1 `KVM1` payload and CRC, wrapped as:

| Bytes | Meaning |
|---|---|
| 0–3 | ASCII `KVS1` |
| 4–5 | Little-endian payload size, at most 8224 bytes |
| 6 onward | One complete `KVM1` media packet |

A zero-size envelope releases the UART media session without closing serial HID.
The board returns a zero-size envelope after prior TX drains; the browser waits
for this acknowledgment before rebinding media or closing the physical port.
The stream parser distinguishes complete CH9329 and media frames, retaining
partial reads and never scanning for new magic inside a valid frame. Truncated,
oversized or CRC-invalid frames fail without completing disk IO. Both send paths
serialize complete wire frames so HID replies and disk packets cannot interleave.

The media session belongs to one transport. Only its owner can send commands,
receive queued target IO or release it; unrelated Wi-Fi connection closure cannot
disconnect wired media. Lease, epoch, strict write-commit and ejection rules are
shared across transports. Physical UART disconnect fails media and pending controls.
A browser media disconnect sends the release envelope and leaves the serial port
available for keyboard/mouse control.

At 115200 8N1 an 8224-byte packet takes about 0.72 s on the wire. Serial HID reply
waits allow for a media frame ahead of them. This is a bandwidth/latency limitation
of the programming bridge, not the target's USB bulk interface.
