// SPDX-License-Identifier: GPL-3.0-or-later
/** Sample a cumulative read counter, including quiet intervals and timer delays. */
export class MediaReadRate {
  private bytes = 0
  private at = 0
  reset(bytes: number, at: number) {
    this.bytes = bytes
    this.at = at
  }
  sample(bytes: number, at: number) {
    const elapsed = at - this.at,
      rate = elapsed > 0 ? (Math.max(0, bytes - this.bytes) * 1000) / elapsed : 0
    this.reset(bytes, at)
    return rate
  }
}
