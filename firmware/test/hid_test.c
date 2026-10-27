/* SPDX-License-Identifier: GPL-3.0-or-later */
#include <assert.h>
#include <limits.h>
#include <setjmp.h>
#include <stdio.h>

/* Compile the actual driver, including its event loop and GET_REPORT callback.
 * Only RTOS/USB/platform boundaries are replaced by the stubs below. */
#include "../main/kvm_hid.c"

typedef struct {
    uint8_t instance, id;
    uint16_t length;
    uint8_t bytes[16];
} observed_report_t;
static observed_report_t observed[64];
static size_t observed_count;
static uint8_t protocols[KVM_HID_ITF_COUNT];
static int64_t clock_us;
static bool endpoint_ready, usb_suspended, wake_ok, accept_report;
static int protocol_after_delay;
static unsigned queue_resets;
static const kvm_event_t *script;
static size_t script_size, script_position;
static jmp_buf task_complete;

int64_t esp_timer_get_time(void) { return clock_us; }
TickType_t xTaskGetTickCount(void) { return (TickType_t)(clock_us / 1000); }
void vTaskDelay(TickType_t ticks)
{
    clock_us += (int64_t)ticks * 1000;
    if (protocol_after_delay >= 0) {
        protocols[KVM_HID_ITF_MOUSE] = (uint8_t)protocol_after_delay;
        protocol_after_delay = -1;
    }
}
QueueHandle_t xQueueCreate(UBaseType_t length, UBaseType_t item_size)
{
    assert(length == KVM_HID_QUEUE_DEPTH && item_size == sizeof(kvm_event_t));
    return (void *)1;
}
BaseType_t xQueueReceive(QueueHandle_t queue, void *item, TickType_t wait)
{
    assert(queue == (void *)1 && wait == pdMS_TO_TICKS(5));
    if (script_position == script_size) longjmp(task_complete, 1);
    memcpy(item, &script[script_position++], sizeof(kvm_event_t));
    return pdTRUE;
}
BaseType_t xQueueSend(QueueHandle_t queue, const void *item, TickType_t wait)
{
    (void)item;
    (void)wait;
    assert(queue == (void *)1);
    return pdTRUE;
}
BaseType_t xQueueReset(QueueHandle_t queue)
{
    assert(queue == (void *)1);
    queue_resets++;
    script_position = script_size;
    return pdPASS;
}
void vQueueDelete(QueueHandle_t queue) { assert(queue == (void *)1); }
BaseType_t xTaskCreate(TaskFunction_t task, const char *name, uint32_t stack,
                       void *arg, UBaseType_t priority, TaskHandle_t *handle)
{
    (void)name;
    (void)stack;
    (void)arg;
    (void)priority;
    (void)handle;
    assert(task == kvm_hid_task);
    return pdPASS;
}
const char *esp_err_to_name(esp_err_t err) { (void)err; return "mock error"; }
bool tud_mounted(void) { return s_mounted; }
bool tud_suspended(void) { return usb_suspended; }
bool tud_remote_wakeup(void) { return wake_ok; }
bool tud_hid_n_ready(uint8_t instance)
{
    assert(instance < KVM_HID_ITF_COUNT);
    return endpoint_ready;
}
uint8_t tud_hid_n_get_protocol(uint8_t instance)
{
    assert(instance < KVM_HID_ITF_COUNT);
    return protocols[instance];
}
bool tud_hid_n_report(uint8_t instance, uint8_t id, const void *report, uint16_t length)
{
    assert(observed_count < sizeof(observed) / sizeof(observed[0]));
    assert(length <= sizeof(observed[0].bytes));
    observed_report_t *out = &observed[observed_count++];
    *out = (observed_report_t){.instance = instance, .id = id, .length = length};
    memcpy(out->bytes, report, length);
    return accept_report;
}
void kvm_usb_descriptors_init(void) {}
const tusb_desc_device_t *kvm_usb_device_descriptor(void)
{
    static const tusb_desc_device_t descriptor = {0};
    return &descriptor;
}
const uint8_t *kvm_usb_config_descriptor(void)
{
    static const uint8_t descriptor[] = {0};
    return descriptor;
}
const char **kvm_usb_string_descriptors(int *count)
{
    static const char *strings[] = {"test"};
    *count = 1;
    return strings;
}
esp_err_t tinyusb_driver_install(const tinyusb_config_t *config)
{
    assert(config->event_cb == kvm_usb_event_cb);
    return ESP_OK;
}

static void run_events(const kvm_event_t *events, size_t count)
{
    script = events;
    script_size = count;
    script_position = 0;
    if (!setjmp(task_complete)) kvm_hid_task(NULL);
}
static void clear_reports(void)
{
    memset(observed, 0, sizeof(observed));
    observed_count = 0;
}
static void reset_driver(uint8_t mouse_protocol)
{
    memset(&s_last_kbd, 0, sizeof(s_last_kbd));
    memset(&s_last_abs, 0, sizeof(s_last_abs));
    memset(&s_last_rel, 0, sizeof(s_last_rel));
    memset(&boot_state, 0, sizeof(boot_state));
    memset(&boot_command, 0, sizeof(boot_command));
    memset(s_last_report_us, 0, sizeof(s_last_report_us));
    boot_generation = boot_seen = 0;
    boot_pending = boot_report_down = false;
    atomic_store(&boot_running, false);
    atomic_store(&link_release, false);
    s_evt_queue = (void *)1;
    s_mounted = true;
    s_kbd_leds = 0;
    s_abs_valid = false;
    protocols[KVM_HID_ITF_KEYBOARD] = HID_PROTOCOL_REPORT;
    protocols[KVM_HID_ITF_MOUSE] = mouse_protocol;
    clock_us = 1000000;
    endpoint_ready = accept_report = wake_ok = true;
    usb_suspended = false;
    protocol_after_delay = -1;
    hid_release_all();
    queue_resets = 0;
    clear_reports();
}
static void expect_report(size_t index, uint8_t instance, uint8_t id,
                           const uint8_t *bytes, size_t length)
{
    assert(index < observed_count);
    assert(observed[index].instance == instance);
    assert(observed[index].id == id);
    assert(observed[index].length == length);
    assert(!memcmp(observed[index].bytes, bytes, length));
}

static void test_report_protocol_is_unchanged(void)
{
    reset_driver(HID_PROTOCOL_REPORT);
    const kvm_event_t events[] = {
        {.type = KVM_EVT_KEYBOARD, .kbd = {.modifier = 1, .keys = {0xe1, 4}}},
        {.type = KVM_EVT_MOUSE_ABS,
         .abs = {.buttons = 0x1f, .x = UINT16_MAX, .y = 0x234, .wheel = -1}},
        {.type = KVM_EVT_MOUSE_REL,
         .rel = {.buttons = 0x1f, .dx = INT8_MIN, .dy = 127, .wheel = INT8_MIN}},
    };
    run_events(events, sizeof(events) / sizeof(events[0]));
    assert(observed_count == 3);
    const uint8_t keyboard[] = {3, 0, 4, 0, 0, 0, 0, 0};
    const uint8_t absolute[] = {0x1f, 0xff, 0x0f, 0x34, 0x02, 0xff};
    const uint8_t relative[] = {0x1f, 0x80, 0x7f, 0x80};
    expect_report(0, KVM_HID_ITF_KEYBOARD, 0, keyboard, sizeof(keyboard));
    expect_report(1, KVM_HID_ITF_MOUSE, 1, absolute, sizeof(absolute));
    expect_report(2, KVM_HID_ITF_MOUSE, 2, relative, sizeof(relative));
    uint8_t buffer[8] = {0};
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 1, HID_REPORT_TYPE_INPUT,
                                 buffer, sizeof(buffer)) == sizeof(absolute));
    assert(!memcmp(buffer, absolute, sizeof(absolute)));
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 2, HID_REPORT_TYPE_INPUT,
                                 buffer, sizeof(buffer)) == sizeof(relative));
    assert(!memcmp(buffer, relative, sizeof(relative)));
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 0, HID_REPORT_TYPE_INPUT,
                                 buffer, sizeof(buffer)) == 0);
}

static void test_boot_wire_and_keyboard_independence(void)
{
    reset_driver(HID_PROTOCOL_BOOT);
    const kvm_event_t events[] = {
        {.type = KVM_EVT_KEYBOARD, .kbd = {.keys = {0x45}}},
        {.type = KVM_EVT_MOUSE_REL,
         .rel = {.buttons = 0xff, .dx = INT8_MIN, .dy = 127, .wheel = -11}},
        {.type = KVM_EVT_MOUSE_REL,
         .rel = {.buttons = 0x10, .dx = 1, .dy = INT8_MIN, .wheel = 127}},
    };
    run_events(events, sizeof(events) / sizeof(events[0]));
    assert(observed_count == 3);
    const uint8_t keyboard[] = {0, 0, 0x45, 0, 0, 0, 0, 0};
    const uint8_t first[] = {7, 0x81, 0x7f};
    const uint8_t second[] = {0, 1, 0x81};
    expect_report(0, KVM_HID_ITF_KEYBOARD, 0, keyboard, sizeof(keyboard));
    expect_report(1, KVM_HID_ITF_MOUSE, 0, first, sizeof(first));
    expect_report(2, KVM_HID_ITF_MOUSE, 0, second, sizeof(second));
}

static void test_boot_absolute_buttons_do_not_move(void)
{
    reset_driver(HID_PROTOCOL_BOOT);
    const kvm_event_t events[] = {
        {.type = KVM_EVT_MOUSE_REL, .rel = {.buttons = 5, .dx = 31, .dy = -19}},
        {.type = KVM_EVT_MOUSE_ABS,
         .abs = {.buttons = 0x1b, .x = 4000, .y = 3000, .wheel = 127}},
        {.type = KVM_EVT_MOUSE_ABS,
         .abs = {.buttons = 0, .x = 0, .y = 0, .wheel = -127}},
    };
    run_events(events, 2);
    const uint8_t button_only[] = {3, 0, 0}, released[] = {0, 0, 0};
    uint8_t state[3] = {0xff, 0xff, 0xff};
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 0, HID_REPORT_TYPE_INPUT,
                                 state, sizeof(state)) == sizeof(state));
    assert(!memcmp(state, button_only, sizeof(state)));
    run_events(&events[2], 1);
    assert(observed_count == 3);
    expect_report(1, KVM_HID_ITF_MOUSE, 0, button_only, sizeof(button_only));
    expect_report(2, KVM_HID_ITF_MOUSE, 0, released, sizeof(released));
}

static void test_boot_get_report_is_current_state_not_movement(void)
{
    reset_driver(HID_PROTOCOL_BOOT);
    const kvm_event_t event = {
        .type = KVM_EVT_MOUSE_REL,
        .rel = {.buttons = 0x1d, .dx = 65, .dy = -51, .wheel = -7},
    };
    run_events(&event, 1);
    uint8_t buffer[12];
    memset(buffer, 0xa5, sizeof(buffer));
    const uint8_t expected[] = {5, 0, 0};
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 0, HID_REPORT_TYPE_INPUT,
                                 buffer, 3) == 3);
    assert(!memcmp(buffer, expected, sizeof(expected)));
    for (size_t i = 3; i < sizeof(buffer); i++) assert(buffer[i] == 0xa5);
    memset(buffer, 0xa5, sizeof(buffer));
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 0, HID_REPORT_TYPE_INPUT,
                                 buffer, 2) == 0);
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 1, HID_REPORT_TYPE_INPUT,
                                 buffer, sizeof(buffer)) == 0);
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 2, HID_REPORT_TYPE_INPUT,
                                 buffer, sizeof(buffer)) == 0);
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 0, HID_REPORT_TYPE_OUTPUT,
                                 buffer, sizeof(buffer)) == 0);
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 0, HID_REPORT_TYPE_FEATURE,
                                 buffer, sizeof(buffer)) == 0);
    assert(tud_hid_get_report_cb(99, 0, HID_REPORT_TYPE_INPUT,
                                 buffer, sizeof(buffer)) == 0);
    for (size_t i = 0; i < sizeof(buffer); i++) assert(buffer[i] == 0xa5);
}

static void assert_boot_release_reports(void)
{
    unsigned mouse_reports = 0;
    for (size_t i = 0; i < observed_count; i++) {
        if (observed[i].instance == KVM_HID_ITF_MOUSE) {
            const uint8_t zero[] = {0, 0, 0};
            expect_report(i, KVM_HID_ITF_MOUSE, 0, zero, sizeof(zero));
            mouse_reports++;
        } else {
            const uint8_t zero[8] = {0};
            expect_report(i, KVM_HID_ITF_KEYBOARD, 0, zero, sizeof(zero));
        }
    }
    assert(mouse_reports >= 1);
    uint8_t state[3] = {0xff, 0xff, 0xff};
    assert(tud_hid_get_report_cb(KVM_HID_ITF_MOUSE, 0, HID_REPORT_TYPE_INPUT,
                                 state, sizeof(state)) == sizeof(state));
    assert(state[0] == 0 && state[1] == 0 && state[2] == 0);
}
static void test_boot_reset_and_link_release(void)
{
    for (unsigned link = 0; link < 2; link++) {
        reset_driver(HID_PROTOCOL_BOOT);
        const kvm_event_t held[] = {
            {.type = KVM_EVT_KEYBOARD, .kbd = {.modifier = 0xff, .keys = {4}}},
            {.type = KVM_EVT_MOUSE_REL, .rel = {.buttons = 7, .dx = 22, .dy = -33}},
            {.type = KVM_EVT_MOUSE_ABS, .abs = {.buttons = 7, .x = 1000, .y = 2000}},
        };
        run_events(held, sizeof(held) / sizeof(held[0]));
        clear_reports();
        if (link) {
            const kvm_event_t queued = {
                .type = KVM_EVT_MOUSE_REL, .rel = {.buttons = 7, .dx = 127, .dy = 127},
            };
            kvm_hid_release_link();
            run_events(&queued, 1);
            assert(queue_resets == 1);
        } else {
            const kvm_event_t reset = {.type = KVM_EVT_RESET};
            run_events(&reset, 1);
        }
        assert_boot_release_reports();
    }
}

static void test_protocol_change_while_waiting(void)
{
    reset_driver(HID_PROTOCOL_REPORT);
    s_last_report_us[KVM_HID_ITF_MOUSE] = clock_us;
    protocol_after_delay = HID_PROTOCOL_BOOT;
    const kvm_event_t event = {
        .type = KVM_EVT_MOUSE_REL,
        .rel = {.buttons = 0x1f, .dx = INT8_MIN, .dy = 63, .wheel = 7},
    };
    run_events(&event, 1);
    assert(protocol_after_delay == -1);
    const uint8_t boot[] = {7, 0x81, 63};
    assert(observed_count == 1);
    expect_report(0, KVM_HID_ITF_MOUSE, 0, boot, sizeof(boot));
    clear_reports();
    s_last_report_us[KVM_HID_ITF_MOUSE] = clock_us;
    protocol_after_delay = HID_PROTOCOL_REPORT;
    run_events(&event, 1);
    assert(protocol_after_delay == -1);
    const uint8_t report[] = {0x1f, 0x80, 63, 7};
    expect_report(0, KVM_HID_ITF_MOUSE, 2, report, sizeof(report));
}

static void test_report_reset_preserves_absolute_position(void)
{
    reset_driver(HID_PROTOCOL_REPORT);
    const kvm_event_t held[] = {
        {.type = KVM_EVT_KEYBOARD, .kbd = {.modifier = 0xff, .keys = {4}}},
        {.type = KVM_EVT_MOUSE_ABS,
         .abs = {.buttons = 1, .x = 1000, .y = 2000, .wheel = 5}},
        {.type = KVM_EVT_MOUSE_REL,
         .rel = {.buttons = 2, .dx = 11, .dy = 13, .wheel = 7}},
    };
    run_events(held, sizeof(held) / sizeof(held[0]));
    clear_reports();
    const kvm_event_t reset = {.type = KVM_EVT_RESET};
    run_events(&reset, 1);
    assert(observed_count == 3);
    const uint8_t keyboard[8] = {0};
    const uint8_t absolute[] = {0, 0xe8, 0x03, 0xd0, 0x07, 0};
    const uint8_t relative[4] = {0};
    expect_report(0, KVM_HID_ITF_KEYBOARD, 0, keyboard, sizeof(keyboard));
    expect_report(1, KVM_HID_ITF_MOUSE, 1, absolute, sizeof(absolute));
    expect_report(2, KVM_HID_ITF_MOUSE, 2, relative, sizeof(relative));
}

static void test_unmounted_and_unready_do_not_send(void)
{
    reset_driver(HID_PROTOCOL_BOOT);
    s_mounted = false;
    const kvm_mouse_rel_report_t report = {.buttons = 7, .dx = 20, .dy = -20};
    assert(!hid_send(KVM_HID_ITF_MOUSE, 2, &report, sizeof(report)));
    assert(observed_count == 0);
    s_mounted = true;
    endpoint_ready = false;
    assert(!hid_send(KVM_HID_ITF_MOUSE, 2, &report, sizeof(report)));
    assert(observed_count == 0);
    assert(clock_us >= 1040000);
}

int main(void)
{
    test_report_protocol_is_unchanged();
    test_boot_wire_and_keyboard_independence();
    test_boot_absolute_buttons_do_not_move();
    test_boot_get_report_is_current_state_not_movement();
    test_boot_reset_and_link_release();
    test_protocol_change_while_waiting();
    test_report_reset_preserves_absolute_position();
    test_unmounted_and_unready_do_not_send();
    puts("PASS: actual HID driver report/boot wire formats, protocol transitions, "
         "GET_REPORT bounds and idle deltas, release/reset, endpoint failure");
    return 0;
}
