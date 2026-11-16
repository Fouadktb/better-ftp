/** Rolling throughput from measured byte counts and a monotonic clock. */
export class TransferMeter {
  private samples: { time: number; bytes: number }[] = [];
  private readonly started: number;
  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly windowMs = 2000,
  ) {
    this.started = this.now();
    this.samples = [{ time: this.started, bytes: 0 }];
  }
  record(bytes: number) {
    const time = this.now();
    const previous = this.samples[this.samples.length - 1];
    if (!Number.isFinite(bytes) || bytes < 0) return;
    if (bytes < previous.bytes) {
      this.samples = [{ time, bytes }];
      return;
    }
    if (time === previous.time) this.samples[this.samples.length - 1] = { time, bytes };
    else this.samples.push({ time, bytes });
    // Keep one sample before the rolling boundary to measure sparse events accurately.
    while (this.samples.length > 2 && this.samples[1].time <= time - this.windowMs)
      this.samples.shift();
  }
  rate(): number | null {
    const time = this.now(),
      latest = this.samples[this.samples.length - 1];
    if (time - latest.time >= this.windowMs) return 0;
    if (this.samples.length < 2) return null;
    const first = this.samples[0],
      elapsed = time - first.time;
    return elapsed > 0 ? Math.max(0, ((latest.bytes - first.bytes) * 1000) / elapsed) : null;
  }
  average(bytes: number) {
    const elapsed = this.now() - this.started;
    return elapsed > 0 ? Math.max(0, (bytes * 1000) / elapsed) : 0;
  }
}
