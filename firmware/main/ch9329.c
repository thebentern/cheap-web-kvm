/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Byte-at-a-time state machine rather than a read-a-whole-frame loop, so a
 * truncated frame costs one frame of resync instead of desynchronising the
 * stream permanently. */

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/uart.h"
#include "esp_check.h"
#include "esp_log.h"

#include "ch9329.h"
#include "kvm_hid.h"

static const char *TAG = "ch9329";

#define CH9329_UART_NUM    UART_NUM_0
#define CH9329_BAUD_RATE   115200
#define CH9329_RX_BUF_SIZE 1024
#define CH9329_TX_BUF_SIZE 512
#define CH9329_READ_CHUNK  128
#define CH9329_TASK_STACK  4096
#define CH9329_TASK_PRIO   5

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

typedef struct {
    parse_state_t state;
    uint8_t       addr;
    uint8_t       cmd;
    uint8_t       len;
    uint8_t       data[CH9329_MAX_PAYLOAD];
    uint8_t       received;
    uint8_t       sum;
} parser_t;

uint8_t ch9329_checksum(const uint8_t *data, size_t len)
{
    uint32_t sum = 0;
    for (size_t i = 0; i < len; i++) {
        sum += data[i];
    }
    return (uint8_t)(sum & 0xFF);
}

static void send_frame(uint8_t addr, uint8_t reply_cmd, const uint8_t *payload, uint8_t len)
{
    uint8_t frame[5 + CH9329_MAX_PAYLOAD + 1];

    frame[0] = CH9329_HDR0;
    frame[1] = CH9329_HDR1;
    frame[2] = addr;
    frame[3] = reply_cmd;
    frame[4] = len;
    if (len > 0 && payload != NULL) {
        memcpy(&frame[5], payload, len);
    }
    frame[5 + len] = ch9329_checksum(frame, 5 + len);

    uart_write_bytes(CH9329_UART_NUM, frame, 5 + len + 1);
}

/* The payload byte is not optional: the UI's parser ignores anything shorter
 * than 7 bytes, so a zero-length reply would never be seen. */
static void reply_ok(uint8_t addr, uint8_t cmd)
{
    const uint8_t status = 0x00;
    send_frame(addr, CH9329_REPLY_OK(cmd), &status, 1);
}

static void reply_err(uint8_t addr, uint8_t cmd, uint8_t code)
{
    send_frame(addr, CH9329_REPLY_ERR(cmd), &code, 1);
}

static void handle_get_info(uint8_t addr)
{
    uint8_t info[8] = {0};
    info[0] = CH9329_FW_VERSION;
    info[1] = kvm_hid_mounted() ? 0x01 : 0x00;
    info[2] = kvm_hid_leds();
    send_frame(addr, CH9329_REPLY_OK(CH9329_CMD_GET_INFO), info, sizeof(info));
}

static void dispatch(const parser_t *p)
{
    kvm_event_t evt;
    memset(&evt, 0, sizeof(evt));

    switch (p->cmd) {
    case CH9329_CMD_GET_INFO:
        handle_get_info(p->addr);
        return;

    case CH9329_CMD_KEYBOARD:  /* [modifier, reserved, keycode x6] */
        if (p->len != CH9329_LEN_KEYBOARD) {
            reply_err(p->addr, p->cmd, CH9329_ERR_PARAM);
            return;
        }
        evt.type         = KVM_EVT_KEYBOARD;
        evt.kbd.modifier = p->data[0];
        memcpy(evt.kbd.keys, &p->data[2], sizeof(evt.kbd.keys));
        break;

    case CH9329_CMD_MOUSE_ABS:  /* [0x02, buttons, xLSB, xMSB, yLSB, yMSB, wheel] */
        if (p->len != CH9329_LEN_MOUSE_ABS) {
            reply_err(p->addr, p->cmd, CH9329_ERR_PARAM);
            return;
        }
        evt.type        = KVM_EVT_MOUSE_ABS;
        evt.abs.buttons = p->data[1];
        evt.abs.x       = (uint16_t)(p->data[2] | ((uint16_t)p->data[3] << 8));
        evt.abs.y       = (uint16_t)(p->data[4] | ((uint16_t)p->data[5] << 8));
        evt.abs.wheel   = (int8_t)p->data[6];
        break;

    case CH9329_CMD_MOUSE_REL:  /* [0x01, buttons, dx, dy, wheel], signed in unsigned bytes */
        if (p->len != CH9329_LEN_MOUSE_REL) {
            reply_err(p->addr, p->cmd, CH9329_ERR_PARAM);
            return;
        }
        evt.type        = KVM_EVT_MOUSE_REL;
        evt.rel.buttons = p->data[1];
        evt.rel.dx      = (int8_t)p->data[2];
        evt.rel.dy      = (int8_t)p->data[3];
        evt.rel.wheel   = (int8_t)p->data[4];
        break;

    case CH9329_CMD_RESET:
        evt.type = KVM_EVT_RESET;
        break;

    default:
        ESP_LOGW(TAG, "unsupported command 0x%02x", p->cmd);
        reply_err(p->addr, p->cmd, CH9329_ERR_COMMAND);
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
    reply_ok(p->addr, p->cmd);
}

static void parser_reset(parser_t *p)
{
    p->state    = ST_HDR0;
    p->received = 0;
    p->sum      = 0;
}

static void parser_feed(parser_t *p, uint8_t byte)
{
    switch (p->state) {
    case ST_HDR0:
        if (byte == CH9329_HDR0) {
            p->sum   = byte;
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
            reply_err(p->addr, p->cmd, CH9329_ERR_PARAM);
            parser_reset(p);
            break;
        }
        p->received = 0;
        p->state    = (p->len == 0) ? ST_SUM : ST_DATA;
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
            ESP_LOGW(TAG, "checksum mismatch on command 0x%02x (got 0x%02x, want 0x%02x)",
                     p->cmd, byte, p->sum);
            reply_err(p->addr, p->cmd, CH9329_ERR_CHECKSUM);
        }
        parser_reset(p);
        break;

    default:
        parser_reset(p);
        break;
    }
}

static void ch9329_task(void *arg)
{
    (void)arg;
    parser_t p;
    parser_reset(&p);

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
            parser_feed(&p, chunk[i]);
        }
    }
}

esp_err_t ch9329_start(void)
{
    const uart_config_t uart_cfg = {
        .baud_rate  = CH9329_BAUD_RATE,
        .data_bits  = UART_DATA_8_BITS,
        .parity     = UART_PARITY_DISABLE,
        .stop_bits  = UART_STOP_BITS_1,
        .flow_ctrl  = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };

    ESP_RETURN_ON_ERROR(uart_driver_install(CH9329_UART_NUM, CH9329_RX_BUF_SIZE,
                                            CH9329_TX_BUF_SIZE, 0, NULL, 0),
                        TAG, "uart_driver_install failed");
    ESP_RETURN_ON_ERROR(uart_param_config(CH9329_UART_NUM, &uart_cfg),
                        TAG, "uart_param_config failed");
    /* ROM default pins keep the on-board USB-UART bridge wired to the laptop. */
    ESP_RETURN_ON_ERROR(uart_set_pin(CH9329_UART_NUM, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE,
                                     UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE),
                        TAG, "uart_set_pin failed");

    if (xTaskCreate(ch9329_task, "ch9329", CH9329_TASK_STACK, NULL,
                    CH9329_TASK_PRIO, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
