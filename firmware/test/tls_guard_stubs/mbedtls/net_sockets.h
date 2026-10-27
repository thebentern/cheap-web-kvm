#pragma once
#include <stddef.h>
typedef struct { int fd; } mbedtls_net_context;
#define MBEDTLS_ERR_NET_RECV_FAILED -0x004C
#define MBEDTLS_ERR_NET_SEND_FAILED -0x004E
