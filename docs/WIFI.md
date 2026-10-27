# Wi-Fi configuration

Open **Settings → Wi-Fi** in the console. Wi-Fi starts **Off** until configured.
Saved network settings survive normal firmware updates and board restarts.

For initial setup, connect the board's **programming/UART USB port** and choose
**Connect USB**, or choose **Connect Bluetooth** and pair the board. Settings load
after connection; **Load settings** or **Reload** reads them again. The native
USB port connects keyboard, mouse and disk to the target.

An authenticated Wi-Fi media connection can also carry configuration commands.
Changing its network disconnects that connection.

## Network modes

| Mode | Behavior |
| --- | --- |
| **Off** | Stops Wi-Fi. USB and Bluetooth control remain available. |
| **Hotspot** | Creates a WPA2-protected network. Set its name/password, save, then join it from the client computer. The default board address is `192.168.4.1`. |
| **Client** | Joins an existing 2.4 GHz personal Wi-Fi network. Enter its exact name and password. Read the DHCP address in the status panel. |

Open networks, enterprise Wi-Fi, static IP configuration, nearby-network scanning
and ad-hoc/IBSS mode are unsupported.

Client mode defaults to keeping a **recovery hotspot** active. It has its own
saved name and password and stays available if joining the network fails. Expand
**Recovery hotspot settings** to change it. If disabled, use USB or Bluetooth to
recover incorrect network settings. USB HID stays connected through network
changes.

The hotspot uses `192.168.4.x`. If the Client network uses the same subnet and
connections fail, disable recovery and use USB/Bluetooth for setup.

## Saving and recovery

Eject and synchronize virtual media before choosing **Save and apply**. The
firmware rejects network changes while media is inserted. Settings are validated
and committed together before the network changes; invalid or incomplete
credentials do not apply a partial configuration.

Network names are limited to 32 UTF-8 bytes. Passwords must contain 8–63 printable
ASCII characters. Blank password inputs preserve saved passwords; Client mode
requires a saved or newly entered password. The Client network password is never
returned to the browser. **Show saved password** reveals the hotspot password.
Revealed credentials and tokens stay in memory and are not saved to browser
settings or logs.

The panel reports Off, hotspot active, joining, connected, or failure. **Advanced**
shows Client/hotspot IPs and failure codes. Joining stops after five retries or a
45-second join/address timeout. Check the network name, password, signal and
2.4 GHz support, then choose **Save and apply** to retry.

An explicit NVS erase or incompatible/corrupt settings can reset configuration.
A firmware build with bootstrap hotspot credentials uses them only until settings
are saved on the board.

## Board-hosted HTTPS console

The ESP32 hosts its own console and media endpoint. Use the address shown in
Wi-Fi status. A separate HTTPS helper is optional.

HTTPS with Wi-Fi and Bluetooth requires working PSRAM. Published N8R8 firmware
selects Octal PSRAM; R2/2 MiB boards need the Quad build configuration in
`firmware/sdkconfig.quad-psram`. The mode is selected at build time, not detected
automatically. Without PSRAM, basic USB/Bluetooth and HTTP setup can work while
HTTPS may lack sufficient memory. See [PSRAM build setup](https://github.com/thebentern/cheap-web-kvm#match-the-psram-mode).

1. Open `http://BOARD_IP/` for certificate setup. Download the public certificate
   authority from `/device/ca.crt`.
2. Read its fingerprint independently through USB or paired Bluetooth under
   **Settings → Wi-Fi → Advanced → Read certificate fingerprint**, then compare
   it with the downloaded certificate. The HTTP page alone does not establish
   the certificate's identity. `tools/device_certificate.py` downloads and checks
   the certificate against a USB readout.
3. Install the verified authority as trusted on each client computer/tablet.
   The setup page gives instructions for macOS, Windows and iOS. This is a manual
   trust step; do not bypass a browser certificate warning.
4. Open `https://BOARD_IP/`. In **Virtual media → Wi-Fi**, choose **Pair with USB**
   or **Pair with Bluetooth**. Pairing checks the board identity, reads its access
   token and connects automatically.
5. Wi-Fi supplies keyboard/mouse control when no USB/Bluetooth control link is
   active. To switch an existing control link, choose **Connection settings →
   Use Wi-Fi for keyboard & mouse** in Virtual media. Native USB stays connected
   to the target; the capture stick supplies video.

For manual pairing, expand **Enter token manually**. Read the token from an
established USB/Bluetooth connection under **Settings → Wi-Fi → Advanced → Show
saved token**. It is separate from the network password. These settings cannot
load without a control connection.

Pairing creates a Secure, HttpOnly, SameSite=Strict session cookie lasting up to
eight hours. The app does not save the access token in local settings. Pair again
after expiry, a board restart, or a network/token change. Only one media owner can
connect over USB or Wi-Fi at a time.

### Certificate lifecycle and storage

The board stores its certificate authority and keys in NVS. Its server certificate
lasts 800 days and renews after an IP change or with fewer than 30 days remaining.
Renewal retains the authority, so client trust remains valid. HTTPS restarts to
apply renewal only while media is ejected and idle. Erasing NVS creates a new
identity that must be verified and trusted again.

Firmware embeds its build timestamp as an initial offline clock. Client mode
attempts time synchronization through `pool.ntp.org`. An isolated hotspot has no
network time source; after prolonged offline use, an expired certificate may
require current firmware or a working time source. Hostname resolution depends
on the LAN; use the reported IP if its device hostname does not resolve.

The board-hosted console includes settings and virtual media. OCR requires the
full hosted/local app because its language/engine assets exceed the 8 MiB flash
budget. Firmware installation links to the hosted installer.

Disk files and overlays remain in browser storage, bound to the browser profile
and exact origin. Opening another IP/hostname or switching between board, hosted
and local consoles does not transfer that storage. Export changes before moving
origins. See [virtual media](VIRTUAL_MEDIA.md).

## Optional HTTPS helper

The Go helper supports the full UI and older firmware. Build and start it with
the board's fixed upstream address:

```sh
cd web
npm ci
NUXT_APP_BASE_URL=/ npm run generate
cd ../src
# Set KVM_MEDIA_TOKEN to the board's saved media access token.
go run . -www ../web/.output/public -media http://BOARD_IP
```

Open `https://localhost:8443/` using a trusted certificate. Choose **Virtual media
→ Wi-Fi → Connect** and leave **Helper address** blank when using its own UI.
For LAN clients, the helper certificate must include its LAN IP/hostname and be
trusted by each client. `-tls-hosts` affects newly generated certificates and does
not replace existing files. Update/restart the helper after changing the board's
access token. Keep the unencrypted helper-to-board connection on a trusted network.
