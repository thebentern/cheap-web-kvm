/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "tinyusb.h"
#define TINYUSB_DEFAULT_CONFIG(callback, arg) \
    ((tinyusb_config_t){.event_cb = (callback), .event_arg = (arg)})
