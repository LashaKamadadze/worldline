import { describe, expect, it } from 'vitest';
import { runSimulation } from '../src/testing/simulation';

const SEEDS = Number(process.env.DST_SEEDS ?? 40);
const STEPS = Number(process.env.DST_STEPS ?? 150);

describe('deterministic simulation', () => {
  it('is deterministic for a given seed', async () => {
    const a = await runSimulation({ seed: 1234, steps: 80, faults: { appendTorn: 0.05 }, network: { dropAck: 0.1 } });
    const b = await runSimulation({ seed: 1234, steps: 80, faults: { appendTorn: 0.05 }, network: { dropAck: 0.1 } });
    expect(b).toEqual(a);
  });

  it(`holds the invariants across ${SEEDS} seeds with faults and a flaky network`, async () => {
    const failures: string[] = [];
    let totals = { calls: 0, acked: 0, failed: 0, cancelled: 0, crashes: 0, torn: 0, duplicates: 0, volatile: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = await runSimulation({
        seed,
        steps: STEPS,
        clients: 1 + (seed % 2),
        faults: { appendFail: 0.02, appendTorn: 0.03, writeFail: 0.02, writeTorn: 0.02 },
        network: { dropAck: 0.15, dropCall: 0.05, minLatencyMicros: 500n, maxLatencyMicros: 20_000n },
      });
      totals = {
        calls: totals.calls + r.calls,
        acked: totals.acked + r.acked,
        failed: totals.failed + r.failed,
        cancelled: totals.cancelled + r.cancelled,
        crashes: totals.crashes + r.crashes,
        torn: totals.torn + r.tornRecoveries,
        duplicates: totals.duplicates + r.serverDuplicates,
        volatile: totals.volatile + r.volatile,
      };
      if (r.violations.length) failures.push(`seed ${seed}: ${r.violations.slice(0, 5).join(' | ')}`);
    }
    // eslint-disable-next-line no-console
    console.log('DST totals', totals);
    expect(failures).toEqual([]);
    expect(totals.calls).toBeGreaterThan(0);
    expect(totals.duplicates).toBeGreaterThan(0); // the flaky network really exercised redelivery
    expect(totals.crashes).toBeGreaterThan(0);
  });
});
