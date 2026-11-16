import { describe, expect, it } from 'vitest';
import { TransferMeter } from '../src/lib/transfer-meter';
import { formatSpeed } from '../src/model';
function clock() {
  let time = 0;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
describe('measured transfer speed', () => {
  it('waits for a meaningful sample interval and measures byte deltas', () => {
    const c = clock(),
      meter = new TransferMeter(c.now);
    meter.record(0);
    expect(meter.rate()).toBeNull();
    c.advance(500);
    meter.record(1024);
    expect(meter.rate()).toBe(2048);
    c.advance(500);
    meter.record(2048);
    expect(meter.rate()).toBe(2048);
  });
  it('rolls forward when the connection rate changes', () => {
    const c = clock(),
      meter = new TransferMeter(c.now);
    for (let i = 0; i < 5; i++) {
      c.advance(500);
      meter.record((i + 1) * 1000);
    }
    expect(meter.rate()).toBe(2000);
    for (let i = 0; i < 4; i++) {
      c.advance(500);
      meter.record(5000 + (i + 1) * 2000);
    }
    expect(meter.rate()).toBe(4000);
  });
  it('decays to zero during a stalled transfer even without progress events', () => {
    const c = clock(),
      meter = new TransferMeter(c.now);
    c.advance(500);
    meter.record(1024);
    c.advance(500);
    expect(meter.rate()).toBe(1024);
    c.advance(1500);
    expect(meter.rate()).toBe(0);
  });
  it('does not produce invalid rates from duplicate, negative or reset byte counts', () => {
    const c = clock(),
      meter = new TransferMeter(c.now);
    meter.record(1000);
    expect(meter.rate()).toBeNull();
    meter.record(NaN);
    meter.record(-1);
    c.advance(500);
    meter.record(2000);
    expect(meter.rate()).toBe(2000);
    c.advance(500);
    meter.record(0);
    expect(meter.rate()).toBeNull();
  });
  it('keeps completed averages separate from the live rolling rate', () => {
    const c = clock(),
      meter = new TransferMeter(c.now);
    c.advance(1000);
    meter.record(4096);
    c.advance(3000);
    expect(meter.rate()).toBe(0);
    expect(meter.average(4096)).toBe(1024);
  });
  it('formats byte rates and handles not-yet-known rates', () => {
    expect(formatSpeed(null)).toBe('—');
    expect(formatSpeed(NaN)).toBe('—');
    expect(formatSpeed(0)).toBe('0 B/s');
    expect(formatSpeed(1024)).toBe('1.0 KB/s');
    expect(formatSpeed(1048576)).toBe('1.0 MB/s');
  });
});
