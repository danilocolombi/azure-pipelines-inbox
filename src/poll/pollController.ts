import { getPollSeconds } from '../state/config';
import { LogPanel } from '../view/logPanel';
import { RunsTreeProvider } from '../view/runsTreeProvider';

/**
 * Drives the single polling interval. It runs only while something is in progress —
 * an active run in the tree or an open, tailing log — and stops itself once everything
 * is idle. Re-arm it via `ensureRunning()` whenever new activity might exist (after a
 * refresh, on tree expansion, or when a log opens).
 */
export class PollController {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly provider: RunsTreeProvider,
    private readonly logPanel: LogPanel
  ) {}

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
    if (this.ticking) return;
    this.ticking = true;
    try {
      const runsActive = await this.provider.pollActiveRuns();
      const logActive = await this.logPanel.pollAppend();
      if (!runsActive && !logActive) this.stop();
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
