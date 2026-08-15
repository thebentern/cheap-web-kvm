/* SPDX-License-Identifier: GPL-3.0-or-later */

#include <stdio.h>
#include <string.h>

#include "esp_mac.h"
#include "tusb.h"

#include "usb_descriptors.h"

#define KVM_USB_VID 0x303A
#define KVM_USB_PID 0x4004

#define KVM_EP_KEYBOARD_IN 0x81
#define KVM_EP_MOUSE_IN    0x82
#define KVM_EP_INTERVAL_MS 10

/* No report ID, so the report protocol format is byte-identical to the 8-byte
 * boot report. */
static const uint8_t s_kbd_report_desc[] = {
    HID_USAGE_PAGE(HID_USAGE_PAGE_DESKTOP),
    HID_USAGE(HID_USAGE_DESKTOP_KEYBOARD),
    HID_COLLECTION(HID_COLLECTION_APPLICATION),
        HID_USAGE_PAGE(HID_USAGE_PAGE_KEYBOARD),
        HID_USAGE_MIN(224),
        HID_USAGE_MAX(231),
        HID_LOGICAL_MIN(0),
        HID_LOGICAL_MAX(1),
        HID_REPORT_SIZE(1),
        HID_REPORT_COUNT(8),
        HID_INPUT(HID_DATA | HID_VARIABLE | HID_ABSOLUTE),

        HID_REPORT_SIZE(8),
        HID_REPORT_COUNT(1),
        HID_INPUT(HID_CONSTANT),

        HID_USAGE_PAGE(HID_USAGE_PAGE_LED),
        HID_USAGE_MIN(1),
        HID_USAGE_MAX(5),
        HID_REPORT_SIZE(1),
        HID_REPORT_COUNT(5),
        HID_OUTPUT(HID_DATA | HID_VARIABLE | HID_ABSOLUTE),
        HID_REPORT_SIZE(3),
        HID_REPORT_COUNT(1),
        HID_OUTPUT(HID_CONSTANT),

        HID_USAGE_PAGE(HID_USAGE_PAGE_KEYBOARD),
        HID_USAGE_MIN(0),
        HID_USAGE_MAX_N(255, 2),
        HID_LOGICAL_MIN(0),
        HID_LOGICAL_MAX_N(255, 2),
        HID_REPORT_SIZE(8),
        HID_REPORT_COUNT(6),
        HID_INPUT(HID_DATA | HID_ARRAY | HID_ABSOLUTE),
    HID_COLLECTION_END,
};

/* Both reports are needed at once: the UI sends scroll through the relative
 * command even while absolute mode is active. TinyUSB's stock
 * TUD_HID_REPORT_DESC_ABSMOUSE hardcodes a 0..32767 logical max, which would
 * confine the pointer to the top-left eighth of the screen, hence hand-rolling. */
static const uint8_t s_mouse_report_desc[] = {
    HID_USAGE_PAGE(HID_USAGE_PAGE_DESKTOP),
    HID_USAGE(HID_USAGE_DESKTOP_MOUSE),
    HID_COLLECTION(HID_COLLECTION_APPLICATION),
        HID_REPORT_ID(KVM_REPORT_ID_MOUSE_ABS)
        HID_USAGE(HID_USAGE_DESKTOP_POINTER),
        HID_COLLECTION(HID_COLLECTION_PHYSICAL),
            HID_USAGE_PAGE(HID_USAGE_PAGE_BUTTON),
            HID_USAGE_MIN(1),
            HID_USAGE_MAX(5),
            HID_LOGICAL_MIN(0),
            HID_LOGICAL_MAX(1),
            HID_REPORT_SIZE(1),
            HID_REPORT_COUNT(5),
            HID_INPUT(HID_DATA | HID_VARIABLE | HID_ABSOLUTE),
            HID_REPORT_SIZE(3),
            HID_REPORT_COUNT(1),
            HID_INPUT(HID_CONSTANT),

            HID_USAGE_PAGE(HID_USAGE_PAGE_DESKTOP),
            HID_USAGE(HID_USAGE_DESKTOP_X),
            HID_USAGE(HID_USAGE_DESKTOP_Y),
            HID_LOGICAL_MIN(0),
            HID_LOGICAL_MAX_N(KVM_ABS_LOGICAL_MAX, 2),
            HID_REPORT_SIZE(16),
            HID_REPORT_COUNT(2),
            HID_INPUT(HID_DATA | HID_VARIABLE | HID_ABSOLUTE),

            HID_USAGE(HID_USAGE_DESKTOP_WHEEL),
            HID_LOGICAL_MIN(0x81),
            HID_LOGICAL_MAX(0x7f),
            HID_REPORT_SIZE(8),
            HID_REPORT_COUNT(1),
            HID_INPUT(HID_DATA | HID_VARIABLE | HID_RELATIVE),
        HID_COLLECTION_END,
    HID_COLLECTION_END,

    HID_USAGE_PAGE(HID_USAGE_PAGE_DESKTOP),
    HID_USAGE(HID_USAGE_DESKTOP_MOUSE),
    HID_COLLECTION(HID_COLLECTION_APPLICATION),
        HID_REPORT_ID(KVM_REPORT_ID_MOUSE_REL)
        HID_USAGE(HID_USAGE_DESKTOP_POINTER),
        HID_COLLECTION(HID_COLLECTION_PHYSICAL),
            HID_USAGE_PAGE(HID_USAGE_PAGE_BUTTON),
            HID_USAGE_MIN(1),
            HID_USAGE_MAX(5),
            HID_LOGICAL_MIN(0),
            HID_LOGICAL_MAX(1),
            HID_REPORT_SIZE(1),
            HID_REPORT_COUNT(5),
            HID_INPUT(HID_DATA | HID_VARIABLE | HID_ABSOLUTE),
            HID_REPORT_SIZE(3),
            HID_REPORT_COUNT(1),
            HID_INPUT(HID_CONSTANT),

            HID_USAGE_PAGE(HID_USAGE_PAGE_DESKTOP),
            HID_USAGE(HID_USAGE_DESKTOP_X),
            HID_USAGE(HID_USAGE_DESKTOP_Y),
            HID_USAGE(HID_USAGE_DESKTOP_WHEEL),
            HID_LOGICAL_MIN(0x81),
            HID_LOGICAL_MAX(0x7f),
            HID_REPORT_SIZE(8),
            HID_REPORT_COUNT(3),
            HID_INPUT(HID_DATA | HID_VARIABLE | HID_RELATIVE),
        HID_COLLECTION_END,
    HID_COLLECTION_END,
};

_Static_assert(CFG_TUD_HID_EP_BUFSIZE >= 8,
               "HID endpoint buffer too small for the 8-byte keyboard report");

static const tusb_desc_device_t s_device_desc = {
    .bLength            = sizeof(tusb_desc_device_t),
    .bDescriptorType    = TUSB_DESC_DEVICE,
    .bcdUSB             = 0x0200,
    .bDeviceClass       = 0x00,
    .bDeviceSubClass    = 0x00,
    .bDeviceProtocol    = 0x00,
    .bMaxPacketSize0    = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor           = KVM_USB_VID,
    .idProduct          = KVM_USB_PID,
    .bcdDevice          = 0x0100,
    .iManufacturer      = 0x01,
    .iProduct           = 0x02,
    .iSerialNumber      = 0x03,
    .bNumConfigurations = 0x01,
};

#define KVM_CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + 2 * TUD_HID_DESC_LEN)

static const uint8_t s_fs_config_desc[] = {
    TUD_CONFIG_DESCRIPTOR(1, KVM_HID_ITF_COUNT, 0, KVM_CONFIG_TOTAL_LEN, 0x00, 100),

    /* Boot subclass + Keyboard protocol on interface 0, or the keyboard works
     * under Linux and does nothing in BIOS/UEFI/GRUB. */
    TUD_HID_DESCRIPTOR(KVM_HID_ITF_KEYBOARD, 0, HID_ITF_PROTOCOL_KEYBOARD,
                       sizeof(s_kbd_report_desc), KVM_EP_KEYBOARD_IN,
                       CFG_TUD_HID_EP_BUFSIZE, KVM_EP_INTERVAL_MS),

    /* Deliberately not a boot mouse: that protocol is a fixed 3-byte relative
     * report and cannot carry absolute position. */
    TUD_HID_DESCRIPTOR(KVM_HID_ITF_MOUSE, 0, HID_ITF_PROTOCOL_NONE,
                       sizeof(s_mouse_report_desc), KVM_EP_MOUSE_IN,
                       CFG_TUD_HID_EP_BUFSIZE, KVM_EP_INTERVAL_MS),
};

static char s_serial_str[13] = "000000000000";

static const char *s_string_desc[] = {
    (const char[]){0x09, 0x04},
    "cheap-web-kvm",
    "ESP32-S3 USB KVM",
    s_serial_str,
};

void kvm_usb_descriptors_init(void)
{
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
        snprintf(s_serial_str, sizeof(s_serial_str), "%02X%02X%02X%02X%02X%02X",
                 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    }
}

const tusb_desc_device_t *kvm_usb_device_descriptor(void)
{
    return &s_device_desc;
}

const uint8_t *kvm_usb_config_descriptor(void)
{
    return s_fs_config_desc;
}

const char **kvm_usb_string_descriptors(int *count)
{
    *count = (int)(sizeof(s_string_desc) / sizeof(s_string_desc[0]));
    return s_string_desc;
}

const uint8_t *tud_hid_descriptor_report_cb(uint8_t instance)
{
    switch (instance) {
    case KVM_HID_ITF_KEYBOARD:
        return s_kbd_report_desc;
    case KVM_HID_ITF_MOUSE:
        return s_mouse_report_desc;
    default:
        return NULL;
    }
}
