# SPDX-License-Identifier: GPL-3.0-or-later

set(device_web_sources "")
set(device_web_includes ".")
if(CONFIG_KVM_DEVICE_WEB)
    set(KVM_DEVICE_WEB_DIR "${PROJECT_DIR}/../web/.output/public" CACHE PATH "Root-based generated device web UI")
    set(device_web_dir "${CMAKE_BINARY_DIR}/device_web")
    file(GLOB_RECURSE device_web_inputs CONFIGURE_DEPENDS "${KVM_DEVICE_WEB_DIR}/*")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        ${device_web_inputs} "${PROJECT_DIR}/../tools/build_device_web.py")
    execute_process(COMMAND "${PYTHON}" "${PROJECT_DIR}/../tools/build_device_web.py"
        --input "${KVM_DEVICE_WEB_DIR}" --output "${device_web_dir}"
        RESULT_VARIABLE web_result OUTPUT_VARIABLE web_output ERROR_VARIABLE web_error)
    if(NOT web_result EQUAL 0)
        message(FATAL_ERROR "Generate the root-based web UI first (NUXT_APP_BASE_URL=/ npm --prefix web run generate). ${web_error}")
    endif()
    message(STATUS "${web_output}")
    set(device_web_sources "device_web.c" "device_tls.c" "${device_web_dir}/kvm_web_assets.c")
    list(APPEND device_web_includes "${device_web_dir}")
endif()

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
        ${device_web_sources}
    INCLUDE_DIRS
        ${device_web_includes}
    REQUIRES
        bt
        esp_driver_uart
        esp_timer
        nvs_flash
        esp_wifi
        bootloader_support
        esp_http_server
        esp_https_server
        mbedtls
        json
        esp_netif
)

# A fresh offline build can issue a standards-compliant short-lived TLS leaf
# before network time is available. Reproducible builds may set SOURCE_DATE_EPOCH.
string(TIMESTAMP kvm_build_time "%s" UTC)
target_compile_definitions(${COMPONENT_LIB} PRIVATE KVM_BUILD_TIME=${kvm_build_time})

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
