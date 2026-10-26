/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
/* Retain Espressif's platform/RTOS settings but own the MSC application.
 * CONFIG_TINYUSB_MSC_ENABLED must stay off: it links Espressif's FatFs/SD
 * storage frontend and strong callbacks, which cannot serve a remote disk.
 */
#include "tusb_config.h"
#undef CFG_TUD_MSC
#define CFG_TUD_MSC 1
#undef CFG_TUD_MSC_BUFSIZE
#define CFG_TUD_MSC_BUFSIZE 4096
#define CFG_TUD_MSC_EP_BUFSIZE 4096
