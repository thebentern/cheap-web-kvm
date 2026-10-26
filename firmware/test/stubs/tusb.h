#pragma once
#include <stdbool.h>
#include <stdint.h>
#define TUD_MSC_RET_ERROR -1
#define TUD_MSC_RET_ASYNC -2
#define TUD_MSC_RET_BUSY 0
#define SCSI_SENSE_NOT_READY 2
#define SCSI_SENSE_UNIT_ATTENTION 6
#define SCSI_SENSE_ILLEGAL_REQUEST 5
#define CONTROL_STAGE_SETUP 0
typedef struct {
    uint8_t bmRequestType, bRequest;
    uint16_t wValue, wIndex, wLength;
} tusb_control_request_t;
bool tud_msc_set_sense(uint8_t, uint8_t, uint8_t, uint8_t);
bool tud_msc_async_io_done(int32_t, bool);
