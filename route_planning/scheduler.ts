// ─────────────────────────────────────────────────────────────────────────────
//  scheduler.ts
//  Cron job that fires the route planning run.
//  Also exposes a manual trigger for admin use and re-planning.
// ─────────────────────────────────────────────────────────────────────────────

import cron from "node-cron";
import { runDailyRoutePlanning } from "./orchestrator_v2";
import { DailyPlanResult, BranchPlanResult } from "./types.util";

// ─────────────────────────────────────────────────────────────────────────────
//  SCHEDULE
//
//  Algeria is UTC+1 (no DST).
//  TEMPORARY: Running at 12:40 Algeria time for TODAY's testing.
//  Routes are built for TODAY so testing happens immediately.
//
//  Cron expression: "40 11 * * *"
//    ┬ ┬  ┬ ┬ ┬
//    │ │  │ │ └─ day of week (any)
//    │ │  │ └─── month (any)
//    │ │  └───── day of month (any)
//    │ └──────── hour (11 UTC = 12:40 Algeria)
//    └────────── minute (40)
// ─────────────────────────────────────────────────────────────────────────────

let isRunning = false; // Guard against overlapping runs

export function startScheduler(): void {
  // ─────────────────────────────────────────────────────────────────────────
  // DEBUG: Check server timezone and current time
  // ─────────────────────────────────────────────────────────────────────────
  const now = new Date();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("📍 SERVER TIME DEBUG");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`Current UTC time:     ${now.toUTCString()}`);
  console.log(`Current local time:   ${now.toString()}`);
  console.log(`Timezone offset:      ${-now.getTimezoneOffset() / 60} hours from UTC`);
  console.log(`ISO string:           ${now.toISOString()}`);
  console.log(`Hours (UTC):          ${now.getUTCHours()}:${now.getUTCMinutes()}:${now.getUTCSeconds()}`);
  console.log(`Hours (local):        ${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // Test cron that runs every minute to verify node-cron is working
  cron.schedule("* * * * *", () => {
    const cronNow = new Date();
    console.log(`[CRON TEST] Cron is alive! Time: ${cronNow.toLocaleString()} (${cronNow.getHours()}:${cronNow.getMinutes()}:${cronNow.getSeconds()})`);
  });

  // Your actual schedule
  cron.schedule("31 13 * * *", async () => {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("🎯 CRON TRIGGERED AT:", new Date().toLocaleString());
    console.log("═══════════════════════════════════════════════════════════════");
    
    if (isRunning) {
      console.warn("[scheduler] Previous run still in progress — skipping");
      return;
    }

    isRunning = true;
    console.log("[scheduler] Starting route planning for TODAY (test run)...");

    try {
      const today = new Date();
      const result = await runDailyRoutePlanning(today);
      logSummary(result);
    } catch (err) {
      console.error("[scheduler] Test run failed:", err);
    } finally {
      isRunning = false;
    }
  });

  console.log("[scheduler] Route planning scheduled for 12:50 Algeria time (TEST MODE - planning for TODAY)");
  console.log("[scheduler] ⚠️  Expect cron to run when local time matches: 12:50");
  console.log("═══════════════════════════════════════════════════════════════");
}
// ─────────────────────────────────────────────────────────────────────────────
//  MANUAL TRIGGER
//  Called by the admin endpoint: POST /admin/routes/plan-now
//  Accepts an optional date string (YYYY-MM-DD); defaults to TODAY for testing.
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
      // Default to TODAY for testing
      targetDate = new Date();
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
  // Aggregate manifest totals across all branches
  const totalManifestsScheduled   = result.branchResults.reduce(
    (s, b) => s + (b.manifestsScheduled   ?? 0), 0,
  );
  const totalManifestsUnscheduled = result.branchResults.reduce(
    (s, b) => s + (b.manifestsUnscheduled ?? 0), 0,
  );

  console.log(
    `[scheduler] Planning complete for ${result.date.toISOString().slice(0, 10)} | ` +
    `${result.totalRoutes} routes | ` +
    `pkg: ${result.totalScheduled} scheduled / ${result.totalUnscheduled} unscheduled | ` +
    `manifests: ${totalManifestsScheduled} scheduled / ${totalManifestsUnscheduled} unscheduled | ` +
    `${result.totalDurationMs}ms`,
  );

  for (const b of result.branchResults) {
    if (b.errors.length > 0) {
      console.warn(
        `[scheduler] ${b.branchName}: ${b.errors.length} warning(s)`,
      );
      b.errors.forEach((e) => console.warn(`  • ${e}`));
    }

    // Extra detail line for hub branches that handled manifests
    const mSched   = b.manifestsScheduled   ?? 0;
    const mUnsched = b.manifestsUnscheduled ?? 0;
    if (mSched + mUnsched > 0) {
      console.log(
        `[scheduler]   ${b.branchName} | ` +
        `${b.transporterRoutes} transporter route(s) | ` +
        `manifests: ${mSched} scheduled / ${mUnsched} unscheduled`,
      );
    }
  }
}