/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
/* Retain Espressif's platform/RTOS settings but own the MSC application.
 * CONFIG_TINYUSB_MSC_ENABLED must stay off: it links Espressif's FatFs/SD
 * storage frontend and strong callbacks, which cannot serve a remote disk.
 */
#include "tusb_config.h"
#ifndef CONFIG_KVM_MSC_BUFSIZE
#define CONFIG_KVM_MSC_BUFSIZE 4096
#endif
#if CONFIG_KVM_MSC_BUFSIZE < 512 || CONFIG_KVM_MSC_BUFSIZE > 8192 || CONFIG_KVM_MSC_BUFSIZE % 512
#error "MSC buffer must be a multiple of 512 bytes, from 512 through 8192"
#endif
#undef CFG_TUD_MSC
#define CFG_TUD_MSC 1
#undef CFG_TUD_MSC_BUFSIZE
#define CFG_TUD_MSC_BUFSIZE CONFIG_KVM_MSC_BUFSIZE
#define CFG_TUD_MSC_EP_BUFSIZE CONFIG_KVM_MSC_BUFSIZE
