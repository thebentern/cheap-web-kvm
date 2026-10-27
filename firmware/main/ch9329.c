/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Byte-at-a-time state machine rather than a read-a-whole-frame loop, so a
 * truncated frame costs one frame of resync instead of desynchronising the
 * stream permanently.
 *
 * The parser knows nothing about where bytes come from. This file runs one on
 * UART0; kvm_ble.c runs another on Bluetooth LE. */

#include <string.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"

#include "driver/uart.h"
#include "esp_check.h"
#include "esp_log.h"
#include "soc/uart_pins.h"

#include "ch9329.h"
#include "kvm_ble.h"
#include "kvm_boot.h"
#include "kvm_hid.h"
#include "kvm_wifi.h"
#include "kvm_media.h"
#include "media_serial.h"
#include "esp_timer.h"

static const char *TAG = "ch9329";

#define CH9329_UART_NUM UART_NUM_0
#define CH9329_BAUD_RATE CONFIG_KVM_UART_BAUD
#define CH9329_RX_BUF_SIZE 10240
#define CH9329_TX_BUF_SIZE 512
#define CH9329_READ_CHUNK 128
#define CH9329_TASK_STACK 4096
#define CH9329_TASK_PRIO 5

/* Short, because the host is blocked waiting for our reply. */
#define CH9329_POST_TIMEOUT_MS 50

/* What a stock CH9329 reports, for third-party tooling. */
#define CH9329_FW_VERSION 0x30

typedef enum {
    ST_HDR0 = 0,
    ST_HDR1,
    ST_ADDR,
    ST_CMD,
    ST_LEN,
    ST_DATA,
    ST_SUM,
} parse_state_t;

uint8_t ch9329_checksum(const uint8_t *data, size_t len)
{
    uint32_t sum = 0;
    for (size_t i = 0; i < len; i++) {
        sum += data[i];
    }
    return (uint8_t)(sum & 0xFF);
}

static void send_frame(const ch9329_parser_t *p, uint8_t reply_cmd, const uint8_t *payload,
                       uint8_t len)
{
    uint8_t frame[5 + CH9329_MAX_PAYLOAD + 1];

    frame[0] = CH9329_HDR0;
    frame[1] = CH9329_HDR1;
    frame[2] = p->addr;
    frame[3] = reply_cmd;
    frame[4] = len;
    if (len > 0 && payload != NULL) {
        memcpy(&frame[5], payload, len);
    }
    frame[5 + len] = ch9329_checksum(frame, 5 + len);

    p->tx(frame, 5 + len + 1);
}

/* The payload byte is not optional: the UI's parser ignores anything shorter
 * than 7 bytes, so a zero-length reply would never be seen. */
static void reply_ok(const ch9329_parser_t *p)
{
    const uint8_t status = 0x00;
    send_frame(p, CH9329_REPLY_OK(p->cmd), &status, 1);
}

static void reply_err(const ch9329_parser_t *p, uint8_t code)
{
    send_frame(p, CH9329_REPLY_ERR(p->cmd), &code, 1);
}

static void handle_get_info(const ch9329_parser_t *p)
{
    uint8_t info[8] = {0};
    info[0] = CH9329_FW_VERSION;
    info[1] = kvm_hid_mounted() ? 0x01 : 0x00;
    info[2] = kvm_hid_leds();
    send_frame(p, CH9329_REPLY_OK(CH9329_CMD_GET_INFO), info, sizeof(info));
}

#if CONFIG_KVM_BLE_ENABLED
/* Over Bluetooth only a bonded host gets this far, and it already knows a
 * passkey; over UART the host is holding the cable. Either may read it. */
static void handle_get_ble_passkey(const ch9329_parser_t *p)
{
    const uint32_t key = kvm_ble_passkey();
    const uint8_t le[4] = {
        (uint8_t)key,
        (uint8_t)(key >> 8),
        (uint8_t)(key >> 16),
        (uint8_t)(key >> 24),
    };
    send_frame(p, CH9329_REPLY_OK(p->cmd), le, sizeof(le));
}

static void handle_set_ble_passkey(const ch9329_parser_t *p)
{
    if (p->len != 4) {
        reply_err(p, CH9329_ERR_PARAM);
        return;
    }
    const uint32_t key = (uint32_t)p->data[0] | ((uint32_t)p->data[1] << 8) |
                         ((uint32_t)p->data[2] << 16) | ((uint32_t)p->data[3] << 24);
    const esp_err_t err = kvm_ble_set_passkey(key);
    if (err == ESP_OK) {
        reply_ok(p);
    } else {
        reply_err(p, err == ESP_ERR_INVALID_ARG ? CH9329_ERR_PARAM : CH9329_ERR_OPERATE);
    }
}
#endif

static void dispatch(const ch9329_parser_t *p)
{
    kvm_event_t evt;
    memset(&evt, 0, sizeof(evt));

    switch (p->cmd) {
    case KVM_CMD_WIFI_GET:
    case KVM_CMD_WIFI_STAGE:
    case KVM_CMD_WIFI_APPLY:
    case KVM_CMD_WIFI_STATUS: {
        uint8_t data[CH9329_MAX_PAYLOAD], len = 0;
        uint8_t error = kvm_wifi_command(p, p->cmd, p->data, p->len, data, &len);
        if (error)
            reply_err(p, error);
        else
            send_frame(p, CH9329_REPLY_OK(p->cmd), data, len);
        return;
    }
    case 0x32: /* Boot repetition: key + four little-endian millisecond values. */
        if (p->len != 17) {
            reply_err(p, CH9329_ERR_PARAM);
            return;
        }
        uint32_t t[4];
        for (int j = 0; j < 4; j++) {
            t[j] = 0;
            for (int i = 0; i < 4; i++)
                t[j] |= (uint32_t)p->data[1 + 4 * j + i] << (8 * i);
        }
        if (kvm_boot_arm(p->data[0], t[0], t[1], t[2], t[3]))
            reply_ok(p);
        else
            reply_err(p, CH9329_ERR_PARAM);
        return;
    case 0x33:
        kvm_boot_cancel();
        reply_ok(p);
        return;
    case 0x34: /* Integrity-checked round trip for UART throughput measurement. */
        send_frame(p, CH9329_REPLY_OK(p->cmd), p->data, p->len);
        return;
    case CH9329_CMD_GET_INFO:
        handle_get_info(p);
        return;

#if CONFIG_KVM_BLE_ENABLED
    case KVM_CMD_GET_BLE_PASSKEY:
        handle_get_ble_passkey(p);
        return;

    case KVM_CMD_SET_BLE_PASSKEY:
        handle_set_ble_passkey(p);
        return;
#endif

    case CH9329_CMD_KEYBOARD: /* [modifier, reserved, keycode x6] */
        if (p->len != CH9329_LEN_KEYBOARD) {
            reply_err(p, CH9329_ERR_PARAM);
            return;
        }
        evt.type = KVM_EVT_KEYBOARD;
        evt.kbd.modifier = p->data[0];
        memcpy(evt.kbd.keys, &p->data[2], sizeof(evt.kbd.keys));
        break;

    case CH9329_CMD_MOUSE_ABS: /* [0x02, buttons, xLSB, xMSB, yLSB, yMSB, wheel] */
        if (p->len != CH9329_LEN_MOUSE_ABS) {
            reply_err(p, CH9329_ERR_PARAM);
            return;
        }
        evt.type = KVM_EVT_MOUSE_ABS;
        evt.abs.buttons = p->data[1];
        evt.abs.x = (uint16_t)(p->data[2] | ((uint16_t)p->data[3] << 8));
        evt.abs.y = (uint16_t)(p->data[4] | ((uint16_t)p->data[5] << 8));
        evt.abs.wheel = (int8_t)p->data[6];
        break;

    case CH9329_CMD_MOUSE_REL: /* [0x01, buttons, dx, dy, wheel], signed in unsigned bytes */
        if (p->len != CH9329_LEN_MOUSE_REL) {
            reply_err(p, CH9329_ERR_PARAM);
            return;
        }
        evt.type = KVM_EVT_MOUSE_REL;
        evt.rel.buttons = p->data[1];
        evt.rel.dx = (int8_t)p->data[2];
        evt.rel.dy = (int8_t)p->data[3];
        evt.rel.wheel = (int8_t)p->data[4];
        break;

    case CH9329_CMD_RESET:
        evt.type = KVM_EVT_RESET;
        break;

    default:
        ESP_LOGW(TAG, "unsupported command 0x%02x", p->cmd);
        reply_err(p, CH9329_ERR_COMMAND);
        return;
    }

    /* Answer on acceptance, not on delivery: the UI blocks up to 300 ms per
     * command and sends up to four per pasted character.
     *
     * A dropped event is still ACKed OK. sendPasteText() in paste-box.js has no
     * try/catch, so an error reply escapes past its UI-restore code and leaves
     * the paste box permanently disabled - worse than losing a keystroke, and
     * inconsistent with the target-not-mounted path which also drops silently. */
    if (kvm_hid_post(&evt, CH9329_POST_TIMEOUT_MS) != ESP_OK) {
        ESP_LOGW(TAG, "HID queue full, dropping command 0x%02x", p->cmd);
    }
    reply_ok(p);
}

static void parser_reset(ch9329_parser_t *p)
{
    p->state = ST_HDR0;
    p->received = 0;
    p->sum = 0;
}

void ch9329_parser_init(ch9329_parser_t *p, ch9329_tx_fn_t tx)
{
    memset(p, 0, sizeof(*p));
    p->tx = tx;
    parser_reset(p);
}

void ch9329_parser_feed(ch9329_parser_t *p, uint8_t byte)
{
    switch (p->state) {
    case ST_HDR0:
        if (byte == CH9329_HDR0) {
            p->sum = byte;
            p->state = ST_HDR1;
        }
        break;

    case ST_HDR1:
        if (byte == CH9329_HDR1) {
            p->sum += byte;
            p->state = ST_ADDR;
        } else if (byte == CH9329_HDR0) {
            p->sum = byte;
        } else {
            parser_reset(p);
        }
        break;

    case ST_ADDR:
        p->addr = byte;
        p->sum += byte;
        p->state = ST_CMD;
        break;

    case ST_CMD:
        p->cmd = byte;
        p->sum += byte;
        p->state = ST_LEN;
        break;

    case ST_LEN:
        p->len = byte;
        p->sum += byte;
        if (p->len > CH9329_MAX_PAYLOAD) {
            ESP_LOGW(TAG, "payload length %u exceeds maximum, dropping frame", p->len);
            reply_err(p, CH9329_ERR_PARAM);
            parser_reset(p);
            break;
        }
        p->received = 0;
        p->state = (p->len == 0) ? ST_SUM : ST_DATA;
        break;

    case ST_DATA:
        p->data[p->received++] = byte;
        p->sum += byte;
        if (p->received == p->len) {
            p->state = ST_SUM;
        }
        break;

    case ST_SUM:
        if (byte == p->sum) {
            dispatch(p);
        } else {
            ESP_LOGW(TAG, "checksum mismatch on command 0x%02x (got 0x%02x, want 0x%02x)", p->cmd,
                     byte, p->sum);
            reply_err(p, CH9329_ERR_CHECKSUM);
        }
        parser_reset(p);
        break;

    default:
        parser_reset(p);
        break;
    }
}

/* RX never waits for a large disk response to drain the UART transmitter.
 * Separate bounded queues allow short HID ACKs between media frames. */
#define SERIAL_MEDIA_SLOTS 4
typedef struct {
    size_t len;
    uint8_t bytes[];
} serial_media_packet_t;
typedef struct {
    size_t len;
    uint8_t bytes[CH9329_MAX_PAYLOAD + 6];
} serial_hid_packet_t;
static QueueHandle_t serial_ready, serial_hid;
static media_serial_parser_t serial_parser;
static ch9329_parser_t serial_hid_parser;
static void uart_tx(const uint8_t *frame, size_t len)
{
    serial_hid_packet_t packet = {.len = len};
    if (len > sizeof(packet.bytes))
        return;
    memcpy(packet.bytes, frame, len);
    if (xQueueSend(serial_hid, &packet, 0) != pdTRUE)
        ESP_LOGW(TAG, "UART HID reply queue full");
}
static bool serial_queue_media(const uint8_t *data, size_t n)
{
    if (n > MEDIA_HEADER + MEDIA_SERIAL_MAX_IO)
        return false;
    serial_media_packet_t *packet = NULL;
    if (uxQueueSpacesAvailable(serial_ready))
        packet = malloc(sizeof(*packet) + MEDIA_SERIAL_HEADER + n);
    if (!packet)
        return false;
    memcpy(packet->bytes, "KVS1", 4);
    packet->bytes[4] = n;
    packet->bytes[5] = n >> 8;
    if (n)
        memcpy(packet->bytes + MEDIA_SERIAL_HEADER, data, n);
    packet->len = n + MEDIA_SERIAL_HEADER;
    if (xQueueSend(serial_ready, &packet, 0) != pdTRUE) {
        free(packet);
        return false;
    }
    return true;
}
static void serial_receive(bool media, const uint8_t *frame, size_t len)
{
    if (!media) {
        ch9329_parser_init(&serial_hid_parser, uart_tx);
        for (size_t i = 0; i < len; i++)
            ch9329_parser_feed(&serial_hid_parser, frame[i]);
        return;
    }
    if (!len) {
        kvm_media_disconnect_from(MEDIA_SOURCE_SERIAL);
        /* Discard queued responses for the released session. The TX task may
         * finish one packet already in flight before this release ACK. */
        serial_media_packet_t *old;
        while (xQueueReceive(serial_ready, &old, 0) == pdTRUE)
            free(old);
        serial_queue_media(NULL, 0);
        return;
    }
    /* The mux owns a full-size writable buffer. Reuse it for the reply, then
     * queue only the actual response size instead of reserving four 8 KiB slots. */
    size_t n = kvm_media_command_from(MEDIA_SOURCE_SERIAL, frame, len, serial_parser.data);
    if (n && !serial_queue_media(serial_parser.data, n))
        kvm_media_disconnect_from(MEDIA_SOURCE_SERIAL);
}
static void serial_tx_task(void *arg)
{
    (void)arg;
    static uint8_t disk[MEDIA_SERIAL_HEADER + MEDIA_HEADER + MEDIA_SERIAL_MAX_IO];
    for (;;) {
        serial_hid_packet_t hid;
        while (xQueueReceive(serial_hid, &hid, 0) == pdTRUE)
            uart_write_bytes(CH9329_UART_NUM, hid.bytes, hid.len);
        serial_media_packet_t *packet;
        if (xQueueReceive(serial_ready, &packet, 0) == pdTRUE) {
            uart_write_bytes(CH9329_UART_NUM, packet->bytes, packet->len);
            free(packet);
        }
        size_t n;
        if (kvm_media_poll_from(MEDIA_SOURCE_SERIAL, disk + MEDIA_SERIAL_HEADER, &n)) {
            memcpy(disk, "KVS1", 4);
            disk[4] = n;
            disk[5] = n >> 8;
            uart_write_bytes(CH9329_UART_NUM, disk, n + MEDIA_SERIAL_HEADER);
        }
        vTaskDelay(1);
    }
}

static void ch9329_task(void *arg)
{
    (void)arg;
    media_serial_init(&serial_parser, serial_receive);

    uint8_t chunk[CH9329_READ_CHUNK];

    ESP_LOGI(TAG, "listening on UART%d at %d 8N1", CH9329_UART_NUM, CH9329_BAUD_RATE);

    for (;;) {
        /* uart_read_bytes() keeps blocking until it has the full requested
         * count, so asking for a whole chunk would add the entire timeout to
         * every 11-13 byte frame. Read only what has already landed. */
        size_t avail = 0;
        if (uart_get_buffered_data_len(CH9329_UART_NUM, &avail) != ESP_OK || avail == 0) {
            vTaskDelay(1);
            continue;
        }
        if (avail > sizeof(chunk)) {
            avail = sizeof(chunk);
        }
        int n = uart_read_bytes(CH9329_UART_NUM, chunk, avail, 0);
        for (int i = 0; i < n; i++) {
            media_serial_feed(&serial_parser, chunk[i], esp_timer_get_time());
        }
    }
}

esp_err_t ch9329_start(void)
{
    const uart_config_t uart_cfg = {
        .baud_rate = CH9329_BAUD_RATE,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };

    ESP_RETURN_ON_ERROR(
        uart_driver_install(CH9329_UART_NUM, CH9329_RX_BUF_SIZE, CH9329_TX_BUF_SIZE, 0, NULL, 0),
        TAG, "uart_driver_install failed");
    ESP_RETURN_ON_ERROR(uart_param_config(CH9329_UART_NUM, &uart_cfg), TAG,
                        "uart_param_config failed");
    /* Set the pins explicitly rather than relying on UART_PIN_NO_CHANGE. When
     * the console lives on another UART, nothing in the app ever routes UART0,
     * and the ROM's routing does not survive to here - the port goes silent. */
    ESP_RETURN_ON_ERROR(uart_set_pin(CH9329_UART_NUM, U0TXD_GPIO_NUM, U0RXD_GPIO_NUM,
                                     UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE),
                        TAG, "uart_set_pin failed");

    serial_ready = xQueueCreate(SERIAL_MEDIA_SLOTS, sizeof(serial_media_packet_t *));
    serial_hid = xQueueCreate(16, sizeof(serial_hid_packet_t));
    if (!serial_ready || !serial_hid)
        return ESP_ERR_NO_MEM;
    if (xTaskCreate(serial_tx_task, "media_serial", 3072, NULL, 4, NULL) != pdPASS)
        return ESP_ERR_NO_MEM;
    if (xTaskCreate(ch9329_task, "ch9329", CH9329_TASK_STACK, NULL, CH9329_TASK_PRIO, NULL) !=
        pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
