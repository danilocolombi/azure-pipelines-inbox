import { getPollSeconds } from '../state/config';
import { LogPanel } from '../view/logPanel';
import { RunsTreeProvider } from '../view/runsTreeProvider';

/**
 * Drives the single polling interval. It runs while something is in progress — an active
 * run in the tree or an open, tailing log — and also while the Runs view is visible, so
 * runs started elsewhere show up on their own. It stops itself once everything is idle and
 * the view is hidden. Re-arm it via `ensureRunning()` whenever new activity might exist
 * (after a refresh, on tree expansion, or when a log opens).
 */
/**
 * If a tick stays "in progress" longer than this, treat it as wedged (a hung request that
 * never resolved nor rejected) and let the next tick proceed anyway, so the loop self-heals
 * instead of freezing for the rest of the session.
 */
const TICK_WATCHDOG_MS = 90000;

export class PollController {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private tickStartedAt = 0;
  private visible = false;

  constructor(
    private readonly provider: RunsTreeProvider,
    private readonly logPanel: LogPanel
  ) {}

  /** Track Runs-view visibility; while visible, keep polling to discover new runs. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.ensureRunning();
      void this.tick(); // refresh now, even if the timer was already ticking
    }
  }

  ensureRunning(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), getPollSeconds() * 1000);
    // Fire a tick immediately so the first update doesn't wait a full interval.
    void this.tick();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Apply a changed poll interval by restarting the timer if it's running. */
  restart(): void {
    if (!this.timer) return;
    this.stop();
    this.ensureRunning();
  }

  private async tick(): Promise<void> {
    // Skip if a tick is already running — unless it's been running implausibly long, which
    // means its awaited request hung (no resolve/reject). In that case the guard would freeze
    // the loop forever, so we let this tick proceed and re-arm the watchdog.
    if (this.ticking && Date.now() - this.tickStartedAt < TICK_WATCHDOG_MS) return;
    this.ticking = true;
    this.tickStartedAt = Date.now();
    try {
      if (this.visible) await this.provider.refreshRunList();
      const runsActive = await this.provider.pollActiveRuns();
      const logActive = await this.logPanel.pollAppend();
      if (!runsActive && !logActive && !this.visible) this.stop();
    } catch {
      // Swallow transient errors; keep the loop alive for the next tick.
    } finally {
      this.ticking = false;
    }
  }

  dispose(): void {
    this.stop();
  }
}
