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

`115200 8N1`, no flow control. The UI opens the port with
`navigator.serial.requestPort()` and `serialPort.open({ baudRate })`.

The reference CH9329 design ships defaulted to 9600 baud and must be
reconfigured before first use. This firmware comes up at 115200 directly, so
that step does not exist here. The UI still offers a 9600 option in Settings →
HID Baudrate; leave it on 115200.

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

UART baud remains 115200 by default. `CONFIG_KVM_UART_BAUD` permits build-time
candidates up to 2000000; benchmark the actual bridge using
`tools/benchmark_serial.py`. This is **not** a serial mass-storage transport.

## 11. Virtual media protocol v1

This is separate from the CH9329 byte stream. It uses one binary WebSocket
message per frame on the ESP32 `/media` endpoint. An opt-in WPA2 AP and the
`X-KVM-Token` header authenticate the local helper. The HTTPS helper requires a
same-origin HTTPS WebSocket request and injects that header; it never accepts an
arbitrary client-provided upstream. Do not expose this endpoint to the internet.
Wi-Fi is an unqualified experimental candidate until board measurement.

### Encoding

| Bytes | Field |
|---|---|
| 0..3 | ASCII `KVM1` |
| 4 | version `1` |
| 5 | opcode; bit 7 marks a response |
| 6..7 | flags on requests, status on responses (`u16` LE) |
| 8..11 | session (`u32` LE), generated by successful HELLO |
| 12..15 | nonzero request ID (`u32` LE), echoed in response |
| 16..23 | byte offset or inserted capacity (`u64` LE) |
| 24..27 | logical length (`u32` LE), at most 8192 |
| 28..31 | IEEE CRC-32 (`u32` LE) over header bytes 0..27 followed by payload |
| 32.. | payload, at most 8192 bytes |

CRC uses reflected polynomial `EDB88320`, initial/final XOR `FFFFFFFF`.
`123456789` yields `CBF43926`. Headers are encoded explicitly, without packed C
struct casts. The header length is the **IO length** on READ/WRITE requests and
responses; a WRITE success ACK therefore has a nonzero length but no payload.
For controls, request/reply length must match actual payload length. Corrupt,
truncated, unknown-version or excessive-length frames receive no ACK; deadlines
fail the operation. CRC is integrity checking, not cryptographic authentication.

| Op | Direction | Fields and result |
|---|---|---|
| `01` HELLO | browser → ESP | Empty, session ignored. Accepted only with no inserted medium or pending IO. Reply: new session and 8 bytes `[1,1,00,02,00,20,1,0]`: version, one-request IO window/durable-write contract, 512-byte blocks LE, 8192-byte transfer ceiling LE, Wi-Fi backend, reserved. |
| `02` INSERT | browser → ESP | Empty; offset=capacity bytes, flags bit 0=writable. Capacity must be a positive multiple of 512, up to `FFFFFFFF` sectors. Fails while inserted, pending, or removal-prevented. Creates a medium-change indication without USB/HID disconnect. |
| `03` EJECT | browser → ESP | Empty. Succeeds only with no pending IO and removal allowed. It is the browser's synchronization barrier; it does not flush the target OS cache. |
| `04` ECHO | browser → ESP | Up to 8192 bytes, echoed exactly for measurement. Measures aggregate round-trip transport, not durable storage or USB. |
| `05` HEARTBEAT / `06` STATUS | browser → ESP | Empty. Reply offset=capacity; one payload byte: writable `01`, present `04`, failed `08`, removal-prevented `10`, macro-active `20`. Refreshes the lease. |
| `07` HID | browser → ESP | One complete CH9329 frame, up to 70 bytes. Reply contains its full CH9329 reply; a fresh parser prevents truncated-frame state crossing requests. |
| `08` BOOT | browser → ESP | Same 17-byte payload as CH9329 `32`. |
| `09` CANCEL | browser → ESP | Empty; same effect as CH9329 `33`. |
| `10` READ | ESP → browser | offset=byte address, length=1..8192, empty payload. Reply `90`: same address/length/ID/session and exactly length bytes on success. |
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
queue. No Bluetooth or 115200-baud serial sector streaming is advertised.

TinyUSB READ10/WRITE10 callbacks enqueue bounded state and immediately return
`TUD_MSC_RET_ASYNC`. The HTTP task carries messages, while the browser worker
performs asynchronous File/IndexedDB operations. Completion is deferred to the USB
task, checks request ID and bus epoch, then touches the USB buffer and calls
`tud_msc_async_io_done`. Neither USB callbacks nor HID tasks wait on network or
browser storage. The read path fetches up to 8 KiB ahead and caches that range;
any write or medium change invalidates it. The browser uses an eight-page 64 KiB
LRU. No speculative data is returned after an error.

All target write ACKs follow a strict IndexedDB transaction covering modified
pages and revision metadata. There is no acknowledged volatile device cache.
SYNCHRONIZE CACHE (`35`) succeeds only with a usable medium and no pending IO;
otherwise it fails. Partial SCSI writes can have committed earlier chunks even
when a later chunk fails. The driver never promises rollback.

IO deadline is 3 s; heartbeat period 1 s, lease 5 s. On timeout/disconnect the
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
