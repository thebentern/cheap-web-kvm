# cheap-web-kvm - ESP32-S3 USB KVM firmware
# SPDX-License-Identifier: GPL-3.0-or-later

cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(cheap-web-kvm)
idf_build_set_property(COMPILE_DEFINITIONS
    "CFG_TUSB_CONFIG_FILE=\"${CMAKE_CURRENT_SOURCE_DIR}/main/kvm_tusb_config.h\"" APPEND)
if(CONFIG_TINYUSB_MSC_ENABLED)
    message(FATAL_ERROR "Disable CONFIG_TINYUSB_MSC_ENABLED: kvm_media owns the MSC callbacks via kvm_tusb_config.h")
endif()
