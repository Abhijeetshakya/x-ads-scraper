import { Actor, log } from 'apify';
import type { Ad, Progress, Store } from './types.js';

export class Metering {
  private disabled = process.env.DISABLE_METERING === '1';
  constructor(private progress: Progress, private store: Store) {}
  capacity(): number {
    const manager = Actor.getChargingManager();
    if (this.disabled || !manager.getPricingInfo().isPayPerEvent) return Infinity;
    return manager.calculateMaxEventChargeCountWithinLimit('ad-result');
  }
  async saved(rows: Ad[]): Promise<boolean> {
    const manager = Actor.getChargingManager();
    if (this.disabled || !manager.getPricingInfo().isPayPerEvent) return false;
    const eligible: Ad[] = [];
    for (const ad of rows) {
      if (await this.store.getValue(`CHARGE-${ad.adKey}`)) continue;
      // At-most-once charge intent. An ambiguous crash can undercharge, never double-charge.
      await this.store.setValue(`CHARGE-${ad.adKey}`, { state: 'attempted_after_saved', at: new Date().toISOString() }); eligible.push(ad);
    }
    if (!eligible.length) return false;
    const result = await Actor.charge({ eventName: 'ad-result', count: eligible.length });
    this.progress.charged['ad-result'] = manager.getChargedEventCount('ad-result');
    log.info('Saved ads charged.', { requested: eligible.length, charged: result.chargedCount, eventChargeLimitReached: result.eventChargeLimitReached });
    // Optional creative-enriched is intentionally free/not charged by default, avoiding repeated tweet billing.
    return result.eventChargeLimitReached;
  }
}
