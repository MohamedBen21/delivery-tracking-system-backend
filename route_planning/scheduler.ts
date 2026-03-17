// ─────────────────────────────────────────────────────────────────────────────
//  scheduler.ts
//  Cron job that fires the nightly route planning run.
//  Also exposes a manual trigger for admin use and re-planning.
// ─────────────────────────────────────────────────────────────────────────────

import cron from "node-cron";
import { runDailyRoutePlanning } from "./orchestrator";
import { DailyPlanResult } from "./types.util";

// ─────────────────────────────────────────────────────────────────────────────
//  SCHEDULE
//
//  Algeria is UTC+1 (no DST).
//  We want to run at midnight Algeria time = 23:00 UTC the previous day.
//  Routes are built for "tomorrow" so workers have them ready at 06:00.
//
//  Cron expression: "0 23 * * *"
//    ┬ ┬  ┬ ┬ ┬
//    │ │  │ │ └─ day of week (any)
//    │ │  │ └─── month (any)
//    │ │  └───── day of month (any)
//    │ └──────── hour (23 UTC = midnight Algeria)
//    └────────── minute (0)
// ─────────────────────────────────────────────────────────────────────────────

let isRunning = false; // Guard against overlapping runs

export function startScheduler(): void {
  cron.schedule("0 23 * * *", async () => {
    if (isRunning) {
      console.warn("[scheduler] Previous run still in progress — skipping");
      return;
    }

    isRunning = true;
    console.log("[scheduler] Starting nightly route planning...");

    try {
      // Plan for tomorrow (the day routes will actually run)
      const tomorrow = nextDay(new Date());
      const result   = await runDailyRoutePlanning(tomorrow);
      logSummary(result);
    } catch (err) {
      console.error("[scheduler] Nightly run failed:", err);
    } finally {
      isRunning = false;
    }
  });

  console.log("[scheduler] Nightly route planning scheduled (23:00 UTC)");
}

// ─────────────────────────────────────────────────────────────────────────────
//  MANUAL TRIGGER
//  Called by the admin endpoint: POST /admin/routes/plan-now
//  Accepts an optional date string (YYYY-MM-DD); defaults to tomorrow.
// ─────────────────────────────────────────────────────────────────────────────

export async function triggerManualPlan(
  dateStr?: string,
): Promise<DailyPlanResult> {
  if (isRunning) {
    throw new Error("Route planning is already running — try again shortly");
  }

  isRunning = true;

  try {
    let targetDate: Date;

    if (dateStr) {
      targetDate = new Date(dateStr);
      if (isNaN(targetDate.getTime())) {
        throw new Error(`Invalid date: ${dateStr}. Expected format: YYYY-MM-DD`);
      }
    } else {
      targetDate = nextDay(new Date());
    }

    console.log(
      `[scheduler] Manual route planning triggered for ${targetDate.toISOString().slice(0, 10)}`,
    );

    const result = await runDailyRoutePlanning(targetDate);
    logSummary(result);
    return result;
  } finally {
    isRunning = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function nextDay(from: Date): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  d.setUTCHours(5, 0, 0, 0); // 06:00 Algeria
  return d;
}

function logSummary(result: DailyPlanResult): void {
  console.log(
    `[scheduler] Planning complete for ${result.date.toISOString().slice(0, 10)} | ` +
    `${result.totalRoutes} routes | ` +
    `${result.totalScheduled} scheduled | ` +
    `${result.totalUnscheduled} unscheduled | ` +
    `${result.totalDurationMs}ms`,
  );

  for (const b of result.branchResults) {
    if (b.errors.length > 0) {
      console.warn(
        `[scheduler] ${b.branchName}: ${b.errors.length} warning(s)`,
      );
      b.errors.forEach((e) => console.warn(`  • ${e}`));
    }
  }
}