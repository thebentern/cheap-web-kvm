# Configure Wi-Fi in the web UI

Open **Settings → Wi-Fi**, or **Virtual media → Wi-Fi setup**. Firmware with the
Wi-Fi settings interface is required. The ordinary build now includes that
interface and starts with Wi-Fi **off** until configured. A build with explicit
bootstrap hotspot credentials uses them only until settings are saved on the
board. Updating firmware preserves saved network settings in NVS.

Connect through the board's **UART/programming USB port** using Serial, or pair
using Bluetooth, then choose **Load board settings**. The native USB port is the
target keyboard/mouse/disk connection, not a serial configuration port. Wi-Fi can
also carry configuration commands after an authenticated media connection exists,
but changing that network will disconnect it.

## Modes

- **Off:** stops the Wi-Fi radio and media endpoint; serial/Bluetooth HID and USB
  remain available.
- **Hotspot (access point):** the board creates its own WPA2-protected network.
  Enter its network name and password, save, and join it from the laptop/tablet.
  The default hotspot address is `192.168.4.1`.
- **Client:** the board joins your existing **2.4 GHz personal
  Wi-Fi network**. Enter its exact SSID and password. Choose “open network” only
  for a network intentionally configured without a password. The router supplies
  the board's address through DHCP; read it in the status panel. Enterprise Wi-Fi,
  static IP configuration, and nearby-network scanning are not provided.

These use normal Wi-Fi infrastructure modes, **not ad-hoc/IBSS**.

Client mode defaults to keeping a **recovery hotspot** available at the
same time (AP+STA). That hotspot has its own saved name/password and stays usable
if joining the router fails. The UI can show its saved password on request. If
you disable recovery, use Serial or Bluetooth to fix an incorrect router setting.
USB HID remains connected while the network changes. The recovery hotspot uses
`192.168.4.x`; if your router uses that same subnet and routing fails, disable
recovery and use Serial/Bluetooth for setup.

## Save, status, and recovery

Eject and synchronize virtual media before applying a network change. The firmware
also enforces this rule and reserves the disk-free interval while applying the
change. It validates a complete staged transaction, commits the settings to NVS,
acknowledges the save, then changes Wi-Fi after a short delay. A missing credential
fragment, invalid password or failed NVS commit does not apply a partial config.
Separate control connections cannot mix each other's credential uploads.

Names are at most 32 UTF-8 bytes. Passwords are 8–63 printable ASCII characters;
an empty client password is allowed only when explicitly configuring an open
network. Blank password inputs otherwise preserve saved passwords. The router's
saved password is never returned to the browser. New inputs and explicitly
revealed hotspot credentials/helper tokens stay in memory and are not saved to
browser settings or logs.

The panel reports off, hotspot active, joining, connected with DHCP IP, or failure,
plus pending changes, retries, disconnect reason and device errors. Router joining
stops retrying after five retries or a 45-second join/address timeout. The recovery
hotspot remains available. Choose **Save and apply** to retry. Check exact SSID,
password, signal and 2.4 GHz support if it fails.

Settings are stored on the device across restarts. They are not erased by normal
application/partition flashing; an explicit NVS erase or incompatible/corrupt
settings can reset them. Factory hotspot passwords and helper tokens are generated
with the hardware entropy source enabled before the radio starts.

## Connect virtual media afterward

Network configuration does not remove the current HTTPS-helper requirement:

1. Use the hotspot IP or router-client IP shown in the panel as the helper's
   fixed upstream, for example `-media http://192.168.4.1` or `-media http://10.0.0.25`.
2. Choose **Show saved helper token** and set that value as `KVM_MEDIA_TOKEN` for
   the local helper. It is separate from the Wi-Fi password. The UI can generate
   and save a replacement token; update/restart the helper after rotating it.
3. Start/open the helper's HTTPS web UI, connect media, and select Wi-Fi HID if
   desired. Both client and helper must be able to reach the board's chosen IP.

The UI is not hosted on the ESP32. Network configuration is implemented; successful
joining of a particular router, Bluetooth/Wi-Fi coexistence and usable OS-image
streaming throughput require hardware validation. See [virtual media](VIRTUAL_MEDIA.md)
and [the test procedure](validation/virtual-media.md).
