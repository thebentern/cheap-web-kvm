# SPDX-License-Identifier: GPL-3.0-or-later

idf_component_register(
    SRCS
        "main.c"
        "kvm_hid.c"
        "kvm_media.c"
        "kvm_media_net.c"
        "kvm_wifi.c"
        "wifi_settings.c"
        "media_protocol.c"
        "media_serial.c"
        "boot_repeat.c"
        "ch9329.c"
        "kvm_ble.c"
        "kvm_led.c"
        "kvm_led_pattern.c"
        "usb_descriptors.c"
    INCLUDE_DIRS
        "."
    REQUIRES
        bt
        esp_driver_uart
        esp_timer
        nvs_flash
        esp_wifi
        bootloader_support
        esp_http_server
        esp_netif
)

# Cancel application I/O on a Bulk-Only Transport reset before buffer reuse.
target_link_options(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=mscd_control_xfer_cb")

if(CONFIG_KVM_MEDIA_LOCAL_PROOF)
    set(proof "${PROJECT_DIR}/local-proof.img")
    if(NOT EXISTS "${proof}")
        message(FATAL_ERROR "Supply firmware/local-proof.img for the explicit local boot proof build")
    endif()
    file(SIZE "${proof}" proof_size)
    math(EXPR proof_remainder "${proof_size} % 512")
    if(proof_size LESS 512 OR proof_size GREATER 524288 OR NOT proof_remainder EQUAL 0)
        message(FATAL_ERROR "local-proof.img must be sector-aligned and 512 bytes..512 KiB")
    endif()
    target_add_binary_data(${COMPONENT_LIB} "${proof}" BINARY)
endif()
