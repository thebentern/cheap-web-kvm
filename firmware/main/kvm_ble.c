/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Bluetooth LE transport, for hosts that cannot open a USB serial port (iPad).
 * The bytes are the same CH9329 frames UART0 carries: one write characteristic
 * in, one notify characteristic out, feeding a parser of their own. See
 * docs/PROTOCOL.md §1.
 *
 * Anyone in radio range could otherwise type into the target, so writes need an
 * authenticated, encrypted link: LE Secure Connections passkey pairing, bonded
 * so it happens once per host. The passkey is CONFIG_KVM_BLE_PASSKEY until a
 * host sets another (KVM_CMD_SET_BLE_PASSKEY), which is kept in NVS. */

#include "sdkconfig.h"

#if CONFIG_KVM_BLE_ENABLED

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"

#include "esp_check.h"
#include "esp_log.h"
#include "nvs.h"

#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "ch9329.h"
#include "kvm_ble.h"
#include "kvm_led.h"

static const char *TAG = "kvm_ble";

/* Writes arrive on the NimBLE host task. Parsing happens on our own task, so
 * kvm_hid_post() waiting on a full HID queue never stalls the host. */
#define KVM_BLE_RX_BUF_SIZE 512
#define KVM_BLE_MAX_WRITE   128
#define KVM_BLE_TASK_STACK  4096
#define KVM_BLE_TASK_PRIO   5

/* The shortest interval Apple's accessory guidelines allow (min 15 ms, max at
 * least min + 15 ms). Every acknowledged command costs about two intervals, so
 * this sets the input rate. Units are 1.25 ms; the timeout is 10 ms. */
static const struct ble_gap_upd_params KVM_BLE_CONN_PARAMS = {
    .itvl_min            = 12,
    .itvl_max            = 24,
    .latency             = 0,
    .supervision_timeout = 400,
};

/* a1340001-d6af-4060-9ae5-7254073b70b8 and siblings. The web UI holds the same
 * values in useBleLink.ts. */
static const ble_uuid128_t KVM_BLE_SVC_UUID = BLE_UUID128_INIT(
    0xb8, 0x70, 0x3b, 0x07, 0x54, 0x72, 0xe5, 0x9a,
    0x60, 0x40, 0xaf, 0xd6, 0x01, 0x00, 0x34, 0xa1);
static const ble_uuid128_t KVM_BLE_RX_UUID = BLE_UUID128_INIT(
    0xb8, 0x70, 0x3b, 0x07, 0x54, 0x72, 0xe5, 0x9a,
    0x60, 0x40, 0xaf, 0xd6, 0x02, 0x00, 0x34, 0xa1);
static const ble_uuid128_t KVM_BLE_TX_UUID = BLE_UUID128_INIT(
    0xb8, 0x70, 0x3b, 0x07, 0x54, 0x72, 0xe5, 0x9a,
    0x60, 0x40, 0xaf, 0xd6, 0x03, 0x00, 0x34, 0xa1);

/* Provided by NimBLE's store/config, with no header of its own. */
void ble_store_config_init(void);

#define KVM_BLE_PASSKEY_MAX 999999
#define KVM_NVS_NAMESPACE   "kvm"
#define KVM_NVS_PASSKEY_KEY "ble_passkey"

static StreamBufferHandle_t s_rx;
static uint16_t             s_tx_handle;
static uint8_t              s_own_addr_type;

/* Written on the host task, read on the parser task. One connection at most
 * (CONFIG_BT_NIMBLE_MAX_CONNECTIONS), so one handle is enough. */
static volatile uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static volatile bool     s_subscribed;

/* Set from the UART or Bluetooth parser task, read on the host task when a
 * pairing asks for it. One aligned word, so no lock. */
static volatile uint32_t s_passkey = CONFIG_KVM_BLE_PASSKEY;

static void advertise(void);

/* ------------------------------------------------------------------- GATT */

static int chr_access(uint16_t conn_handle, uint16_t attr_handle,
                      struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint8_t  buf[KVM_BLE_MAX_WRITE];
    uint16_t len = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &len) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    /* All or nothing. The UI writes whole frames, and dropping half of one
     * would cost the parser a resync on top of the lost command. */
    if (xStreamBufferSpacesAvailable(s_rx) < len) {
        ESP_LOGW(TAG, "receive buffer full, dropping %u bytes", len);
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    xStreamBufferSend(s_rx, buf, len, 0);
    return 0;
}

static const struct ble_gatt_svc_def s_services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &KVM_BLE_SVC_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                /* Host to device. An unpaired write is refused with
                 * Insufficient Authentication, which is what makes iOS, iPadOS
                 * and macOS raise their pairing prompt. A write without response
                 * gets no error to react to, so the first write must expect a
                 * response. */
                .uuid      = &KVM_BLE_RX_UUID.u,
                .access_cb = chr_access,
                .flags     = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP |
                             BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN,
            },
            {
                /* Device to host: replies, exactly as UART0 would send them. */
                .uuid       = &KVM_BLE_TX_UUID.u,
                .access_cb  = chr_access,
                .val_handle = &s_tx_handle,
                .flags      = BLE_GATT_CHR_F_NOTIFY,
            },
            { 0 },
        },
    },
    { 0 },
};

/* Replies are at most 14 bytes (GET_INFO), under the 20 a default MTU allows,
 * so a notification never truncates one. */
static void ble_tx(const uint8_t *frame, size_t len)
{
    const uint16_t conn = s_conn_handle;
    if (conn == BLE_HS_CONN_HANDLE_NONE || !s_subscribed) {
        return;
    }

    /* Replies now include Wi-Fi settings. Respect even the default ATT MTU;
     * the browser parser already accepts a frame split across notifications. */
    uint16_t mtu=ble_att_mtu(conn);
    size_t chunk=mtu>3?mtu-3:20;
    for(size_t at=0;at<len;at+=chunk) {
        size_t n=len-at;if(n>chunk)n=chunk;
        struct os_mbuf *om=ble_hs_mbuf_from_flat(frame+at,n);
        if(!om){ESP_LOGW(TAG,"out of mbufs, dropping reply");return;}
        int rc=ble_gatts_notify_custom(conn,s_tx_handle,om);
        if(rc){ESP_LOGW(TAG,"notify failed; rc=%d",rc);return;}
    }
}

static void ble_rx_task(void *arg)
{
    (void)arg;
    ch9329_parser_t p;
    ch9329_parser_init(&p, ble_tx);

    uint8_t chunk[64];
    for (;;) {
        const size_t n = xStreamBufferReceive(s_rx, chunk, sizeof(chunk), portMAX_DELAY);
        for (size_t i = 0; i < n; i++) {
            ch9329_parser_feed(&p, chunk[i]);
        }
    }
}

/* -------------------------------------------------------------------- GAP */

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    struct ble_gap_conn_desc desc;

    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        kvm_led_pairing(false);
        if (event->connect.status != 0) {
            advertise();
            return 0;
        }
        s_conn_handle = event->connect.conn_handle;
        ESP_LOGI(TAG, "connected");
        ble_gap_update_params(event->connect.conn_handle, &KVM_BLE_CONN_PARAMS);
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        kvm_led_pairing(false);
        ESP_LOGI(TAG, "disconnected; reason=0x%x", event->disconnect.reason);
        s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        s_subscribed  = false;
        advertise();
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        return 0;

    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle == s_tx_handle) {
            s_subscribed = event->subscribe.cur_notify;
        }
        return 0;

    case BLE_GAP_EVENT_ENC_CHANGE:
        /* Both success and failure end the passkey-entry indication. */
        kvm_led_pairing(false);
        if (ble_gap_conn_find(event->enc_change.conn_handle, &desc) == 0) {
            ESP_LOGI(TAG, "encryption change; status=%d authenticated=%d bonded=%d",
                     event->enc_change.status, desc.sec_state.authenticated,
                     desc.sec_state.bonded);
        }
        return 0;

    case BLE_GAP_EVENT_PASSKEY_ACTION:
        /* We advertise DisplayOnly, so the host types and we "display". With no
         * display, the passkey comes from NVS or the build instead. */
        if (event->passkey.params.action == BLE_SM_IOACT_DISP) {
            kvm_led_pairing(true);
            struct ble_sm_io io = {
                .action  = BLE_SM_IOACT_DISP,
                .passkey = s_passkey,
            };
            if (ble_sm_inject_io(event->passkey.conn_handle, &io) != 0) {
                kvm_led_pairing(false);
            }
        }
        return 0;

    case BLE_GAP_EVENT_REPEAT_PAIRING:
        /* The host forgot us and is pairing again. Drop the stale bond and let
         * it; it still has to know the passkey. */
        if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc) == 0) {
            ble_store_util_delete_peer(&desc.peer_id_addr);
        }
        return BLE_GAP_REPEAT_PAIRING_RETRY;

    default:
        return 0;
    }
}

/* The 128-bit UUID takes 18 of the 31 advertising bytes, so the name goes in
 * the scan response. Hosts filter on the UUID and show the name. */
static void advertise(void)
{
    struct ble_hs_adv_fields fields;
    memset(&fields, 0, sizeof(fields));
    fields.flags                = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128             = &KVM_BLE_SVC_UUID;
    fields.num_uuids128         = 1;
    fields.uuids128_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "setting advertising data failed; rc=%d", rc);
        return;
    }

    struct ble_hs_adv_fields rsp;
    memset(&rsp, 0, sizeof(rsp));
    const char *name     = ble_svc_gap_device_name();
    rsp.name             = (const uint8_t *)name;
    rsp.name_len         = strlen(name);
    rsp.name_is_complete = 1;

    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGE(TAG, "setting scan response failed; rc=%d", rc);
        return;
    }

    struct ble_gap_adv_params params;
    memset(&params, 0, sizeof(params));
    params.conn_mode = BLE_GAP_CONN_MODE_UND;
    params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        ESP_LOGE(TAG, "starting advertising failed; rc=%d", rc);
    }
}

static void on_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    if (rc == 0) {
        rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    }
    if (rc != 0) {
        ESP_LOGE(TAG, "no usable address; rc=%d", rc);
        return;
    }

    /* Suffix the name with the end of the address so two boards in one room
     * can be told apart in the picker. */
    uint8_t addr[6] = {0};
    ble_hs_id_copy_addr(s_own_addr_type, addr, NULL);
    char name[24];
    snprintf(name, sizeof(name), "cheap-web-kvm-%02X%02X", addr[1], addr[0]);
    ble_svc_gap_device_name_set(name);

    ESP_LOGI(TAG, "advertising as %s", name);
    if (s_passkey == 123456) {
        ESP_LOGW(TAG, "using the default passkey 123456; change it in the web UI's settings");
    }
    advertise();
}

static void on_reset(int reason)
{
    kvm_led_pairing(false);
    ESP_LOGW(TAG, "host reset; reason=%d", reason);
}

uint32_t kvm_ble_passkey(void)
{
    return s_passkey;
}

esp_err_t kvm_ble_set_passkey(uint32_t passkey)
{
    if (passkey > KVM_BLE_PASSKEY_MAX) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t nvs;
    ESP_RETURN_ON_ERROR(nvs_open(KVM_NVS_NAMESPACE, NVS_READWRITE, &nvs), TAG, "nvs_open failed");
    esp_err_t err = nvs_set_u32(nvs, KVM_NVS_PASSKEY_KEY, passkey);
    if (err == ESP_OK) {
        err = nvs_commit(nvs);
    }
    nvs_close(nvs);
    ESP_RETURN_ON_ERROR(err, TAG, "saving the passkey failed");

    s_passkey = passkey;
    ESP_LOGI(TAG, "passkey changed; hosts already paired keep working");
    return ESP_OK;
}

/* A stored passkey outranks the build's, so changing it from the UI survives
 * a reflash of the same partition layout. */
static void load_passkey(void)
{
    nvs_handle_t nvs;
    uint32_t     stored = 0;
    if (nvs_open(KVM_NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;  /* Never written: the namespace does not exist yet. */
    }
    if (nvs_get_u32(nvs, KVM_NVS_PASSKEY_KEY, &stored) == ESP_OK &&
        stored <= KVM_BLE_PASSKEY_MAX) {
        s_passkey = stored;
    }
    nvs_close(nvs);
}

static void host_task(void *arg)
{
    (void)arg;
    nimble_port_run();  /* Returns only after nimble_port_stop(). */
    nimble_port_freertos_deinit();
}

esp_err_t kvm_ble_start(void)
{
    s_rx = xStreamBufferCreate(KVM_BLE_RX_BUF_SIZE, 1);
    if (s_rx == NULL) {
        return ESP_ERR_NO_MEM;
    }
    load_passkey();

    ESP_RETURN_ON_ERROR(nimble_port_init(), TAG, "nimble_port_init failed");

    ble_hs_cfg.sync_cb         = on_sync;
    ble_hs_cfg.reset_cb        = on_reset;
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;

    /* Passkey entry over LE Secure Connections. Legacy pairing is compiled out
     * in sdkconfig.defaults: its passkey falls to a passive sniffer. The ID
     * keys let a bond survive the host rotating its private address. */
    ble_hs_cfg.sm_io_cap         = BLE_SM_IO_CAP_DISP_ONLY;
    ble_hs_cfg.sm_bonding        = 1;
    ble_hs_cfg.sm_mitm           = 1;
    ble_hs_cfg.sm_sc             = 1;
    ble_hs_cfg.sm_our_key_dist   = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;

    ble_svc_gap_init();
    ble_svc_gatt_init();

    int rc = ble_gatts_count_cfg(s_services);
    if (rc == 0) {
        rc = ble_gatts_add_svcs(s_services);
    }
    if (rc != 0) {
        ESP_LOGE(TAG, "registering the GATT service failed; rc=%d", rc);
        return ESP_FAIL;
    }

    ble_store_config_init();

    if (xTaskCreate(ble_rx_task, "kvm_ble", KVM_BLE_TASK_STACK, NULL,
                    KVM_BLE_TASK_PRIO, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    nimble_port_freertos_init(host_task);
    return ESP_OK;
}

#endif /* CONFIG_KVM_BLE_ENABLED */
