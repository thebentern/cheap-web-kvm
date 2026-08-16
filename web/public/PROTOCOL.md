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
command, `0xE4` checksum, `0xE5` bad parameter.

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

## 6. Commands the firmware implements but the UI never sends

`0x01` (get info) replies with an 8-byte payload: firmware version `0x30`, USB
enumeration status (`0x01` when the target has enumerated us), the keyboard LED
bitmap the target last pushed over `SET_REPORT`, then reserved zeros. It exists
for compatibility with third-party CH9329 tooling. Nothing in the web UI calls
it.

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
