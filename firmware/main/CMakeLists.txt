# SPDX-License-Identifier: GPL-3.0-or-later

idf_component_register(
    SRCS
        "main.c"
        "kvm_hid.c"
        "ch9329.c"
        "usb_descriptors.c"
    INCLUDE_DIRS
        "."
    REQUIRES
        esp_driver_uart
        esp_timer
)
