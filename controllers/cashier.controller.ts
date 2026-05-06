import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import PackageModel, { PackageStatus } from "../models/package.model";
import PackageHistoryModel from "../models/package-history.model";
import CashierModel from "../models/cashier.model";
import FreelancerModel from "../models/freelancer.model";
import BranchModel from "../models/branch.model";
import userModel from "../models/user.model";
import PaymentModel from "../models/payment.model";

// ─────────────────────────────────────────────────────────────────────────────
// Helper — resolve & guard the acting cashier
// ─────────────────────────────────────────────────────────────────────────────

async function resolveCashier(
  userId: any,
  next: NextFunction,
  session?: mongoose.ClientSession,
) {
  if (!userId) {
    next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    return null;
  }

  const query = CashierModel.findOne({ userId, status: "active" });
  if (session) query.session(session);
  const cashier = await query.lean();

  if (!cashier) {
    next(new ErrorHandler("Active cashier profile not found.", 404));
    return null;
  }

  // Cashier must be checked in (have an active shift)
  if (
    !cashier.currentShift ||
    (cashier.currentShift as any).status !== "active"
  ) {
    next(
      new ErrorHandler(
        "You must be checked in to an active shift before performing operations.",
        403,
      ),
    );
    return null;
  }

  return cashier as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.  LOOK UP FREELANCER
//     GET /cashier/freelancer-lookup?q=<businessName|email|phone>
//
//     The cashier types the merchant's business name, email, or phone in the
//     search box. This returns their profile and pending packages so the cashier
//     can choose which ones the merchant is handing over today.
// ─────────────────────────────────────────────────────────────────────────────

export const lookupFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const cashierUserId = req.user?._id;

    const cashier = await resolveCashier(cashierUserId, next);
    if (!cashier) return;

    const { q } = req.query as { q?: string };

    if (!q || q.trim().length < 2) {
      return next(
        new ErrorHandler(
          "Query parameter 'q' is required and must be at least 2 characters.",
          400,
        ),
      );
    }

    const search = q.trim();

    // Search against the User collection (email, phone) and Freelancer (businessName)
    // We join them via a pipeline for a single atomic query.
    const results = await FreelancerModel.aggregate([
      // Match freelancer by businessName (case-insensitive)
      {
        $match: {
          status: "active",
          $or: [
            { businessName: { $regex: search, $options: "i" } },
          ],
        },
      },

      // Join user doc
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
          pipeline: [
            {
              $project: {
                firstName: 1, lastName: 1, email: 1, phone: 1, status: 1,
              },
            },
          ],
        },
      },
      { $unwind: "$user" },

      // Also match by email / phone on the user doc
      {
        $match: {
          $or: [
            { businessName: { $regex: search, $options: "i" } },
            { "user.email": { $regex: search, $options: "i" } },
            { "user.phone": { $regex: search, $options: "i" } },
          ],
        },
      },

      // Only return freelancers assigned to this cashier's branch
      {
        $match: {
          defaultOriginBranchId: cashier.assignedBranchId,
        },
      },

      {
        $project: {
          _id: 1,
          businessName: 1,
          businessType: 1,
          status: 1,
          userId: 1,
          "user.firstName": 1,
          "user.lastName": 1,
          "user.email": 1,
          "user.phone": 1,
        },
      },

      { $limit: 10 },
    ]);

    if (!results.length) {
      return res.status(200).json({
        success: true,
        message: "No active freelancers found matching your search.",
        data: [],
      });
    }

    // For each result, attach their pending packages (status = 'pending')
    const enriched = await Promise.all(
      results.map(async (f: any) => {
        const pendingPackages = await PackageModel.find({
          senderId: f.userId,
          senderType: "freelancer",
          originBranchId: cashier.assignedBranchId,
          status: "pending",            // only pre-registered, unclaimed packages
        })
          .select(
            "trackingNumber weight type isFragile totalPrice " +
            "deliveryType destination createdAt",
          )
          .sort({ createdAt: -1 })
          .lean();

        return {
          freelancerId: f._id,
          userId: f.userId,
          businessName: f.businessName ?? null,
          businessType: f.businessType ?? null,
          firstName: f.user.firstName,
          lastName: f.user.lastName,
          email: f.user.email,
          phone: f.user.phone,
          pendingPackages,
          pendingCount: pendingPackages.length,
        };
      }),
    );

    return res.status(200).json({
      success: true,
      data: enriched,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 2.  CLAIM PACKAGE (SCAN BARCODE)
//     POST /cashier/claim-package
//
//     The cashier scans the barcode on the bordereau. The system:
//       a) Validates the package belongs to this branch and is still 'pending'
//       b) Updates status → 'cashier_claimed'
//       c) Stamps the package with claimedByCashierId + claimedAt
//       d) Writes a PackageHistory record
//       e) Logs the action on the cashier's shift stats
//
//     This is intentionally a single-package operation — each barcode scan
//     is one atomic action.  The cashier scans all packages one by one.
// ─────────────────────────────────────────────────────────────────────────────

export const claimPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const cashierUserId = req.user?._id;
      const cashier = await resolveCashier(cashierUserId, next, session);
      if (!cashier) return;

      const { trackingNumber, notes } = req.body as {
        trackingNumber: string;
        notes?: string;
      };

      if (!trackingNumber?.trim()) {
        return next(new ErrorHandler("trackingNumber is required.", 400));
      }

      const now = new Date();

      // ── Find the package ───────────────────────────────────────────────────
      const packageDoc = await PackageModel.findOne({
        trackingNumber: trackingNumber.trim().toUpperCase(),
      }).session(session);

      if (!packageDoc) {
        return next(
          new ErrorHandler(
            `No package found with tracking number ${trackingNumber}.`,
            404,
          ),
        );
      }

      // ── Guard: must be at this cashier's branch ────────────────────────────
      if (
        packageDoc.originBranchId.toString() !==
        cashier.assignedBranchId.toString()
      ) {
        return next(
          new ErrorHandler(
            "This package belongs to a different branch and cannot be claimed here.",
            403,
          ),
        );
      }

      // ── Guard: must be 'pending' (not already claimed or further) ──────────
      if (packageDoc.status !== "pending") {
        return next(
          new ErrorHandler(
            `Package is already in status '${packageDoc.status}' and cannot be claimed again.`,
            400,
          ),
        );
      }

      const noteText =
        notes?.trim() ||
        `Package physically received at counter by cashier. Bordereau verified.`;

      // ── Update the package ─────────────────────────────────────────────────
      await PackageModel.findByIdAndUpdate(
        packageDoc._id,
        {
          $set: {
            status: "cashier_claimed" as PackageStatus,
            claimedByCashierId: cashier._id,
            claimedAt: now,
          },
          $push: {
            trackingHistory: {
              status: "cashier_claimed",
              branchId: cashier.assignedBranchId,
              userId: cashierUserId,
              notes: noteText,
              timestamp: now,
            },
          },
        },
        { session },
      );

      // ── PackageHistory record ──────────────────────────────────────────────
      await PackageHistoryModel.create(
        [
          {
            packageId: packageDoc._id,
            status: "cashier_claimed" as PackageStatus,
            branchId: cashier.assignedBranchId,
            handledBy: cashierUserId,
            handlerName: `${(req.user as any)?.firstName} ${(req.user as any)?.lastName}`,
            handlerRole: "cashier",
            notes: noteText,
            timestamp: now,
          },
        ],
        { session },
      );

      // ── Increment branch currentLoad (package is now physically at branch) ─
      await BranchModel.findByIdAndUpdate(
        cashier.assignedBranchId,
        { $inc: { currentLoad: 1 } },
        { session },
      );

      // ── Update cashier shift counters + recentScans ────────────────────────
      await CashierModel.findByIdAndUpdate(
        cashier._id,
        {
          $inc: {
            "currentShift.packagesClaimedCount": 1,
            "stats.totalPackagesClaimed": 1,
          },
          $set: {
            "stats.lastActiveAt": now,
          },
          $push: {
            recentScans: {
              $each: [
                {
                  action: "claim_package",
                  packageId: packageDoc._id,
                  trackingNumber: packageDoc.trackingNumber,
                  branchId: cashier.assignedBranchId,
                  timestamp: now,
                  notes: noteText,
                  success: true,
                },
              ],
              $slice: -200,   // keep last 200 scans (most recent at the end)
              $position: 0,
            },
          },
        },
        { session },
      );

      await session.commitTransaction();
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message: "Package claimed successfully.",
        data: {
          packageId: packageDoc._id,
          trackingNumber: packageDoc.trackingNumber,
          previousStatus: "pending",
          currentStatus: "cashier_claimed",
          claimedAt: now,
          package: {
            type: packageDoc.type,
            weight: packageDoc.weight,
            isFragile: packageDoc.isFragile,
            declaredValue: (packageDoc as any).declaredValue ?? null,
            deliveryType: packageDoc.deliveryType,
            totalPrice: (packageDoc as any).totalPrice,
            recipient: {
              name: packageDoc.destination.recipientName,
              phone: packageDoc.destination.recipientPhone,
              city: packageDoc.destination.city,
              state: packageDoc.destination.state,
            },
          },
        },
      });

    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400,
          ),
        );
      }
      return next(error);
    } finally {
      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => {});
      }
      await session.endSession();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 3.  ACCEPT PACKAGE (MOVE TO BRANCH STOCK)
//     POST /cashier/accept-package
//
//     After claiming, the cashier does a final check (weight verified, label
//     confirmed) and accepts the package into the branch stock.
//     Status → 'at_origin_branch'
//
//     This two-step claim → accept gives the cashier a chance to weigh/inspect
//     before committing. They can also reject here (see rejectPackage below).
// ─────────────────────────────────────────────────────────────────────────────

export const acceptPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const cashierUserId = req.user?._id;
      const cashier = await resolveCashier(cashierUserId, next, session);
      if (!cashier) return;

      const { trackingNumber, verifiedWeight, notes } = req.body as {
        trackingNumber: string;
        verifiedWeight?: number;  // actual weight measured on the counter scale
        notes?: string;
      };

      if (!trackingNumber?.trim()) {
        return next(new ErrorHandler("trackingNumber is required.", 400));
      }

      const now = new Date();

      const packageDoc = await PackageModel.findOne({
        trackingNumber: trackingNumber.trim().toUpperCase(),
        originBranchId: cashier.assignedBranchId,
      }).session(session);

      if (!packageDoc) {
        return next(
          new ErrorHandler(
            `Package ${trackingNumber} not found at your branch.`,
            404,
          ),
        );
      }

      if (packageDoc.status !== "cashier_claimed") {
        return next(
          new ErrorHandler(
            `Package must be in 'cashier_claimed' status to accept. Current status: '${packageDoc.status}'.`,
            400,
          ),
        );
      }

      const noteText =
        notes?.trim() ||
        `Package inspected and accepted into branch stock.${
          verifiedWeight ? ` Verified weight: ${verifiedWeight}kg.` : ""
        }`;

      const updateFields: Record<string, any> = {
        status: "at_origin_branch" as PackageStatus,
        currentBranchId: cashier.assignedBranchId,
      };

      // If the cashier weighed the package and it differs from declared, update it
      if (verifiedWeight && typeof verifiedWeight === "number" && verifiedWeight > 0) {
        updateFields.weight = verifiedWeight;
      }

      await PackageModel.findByIdAndUpdate(
        packageDoc._id,
        {
          $set: updateFields,
          $push: {
            trackingHistory: {
              status: "at_origin_branch",
              branchId: cashier.assignedBranchId,
              userId: cashierUserId,
              notes: noteText,
              timestamp: now,
            },
          },
        },
        { session },
      );

      await PackageHistoryModel.create(
        [
          {
            packageId: packageDoc._id,
            status: "at_origin_branch" as PackageStatus,
            branchId: cashier.assignedBranchId,
            handledBy: cashierUserId,
            handlerName: `${(req.user as any)?.firstName} ${(req.user as any)?.lastName}`,
            handlerRole: "cashier",
            notes: noteText,
            timestamp: now,
          },
        ],
        { session },
      );

      // Update cashier stats
      await CashierModel.findByIdAndUpdate(
        cashier._id,
        {
          $inc: { "stats.totalLabelsIssued": 1 },
          $set: { "stats.lastActiveAt": now },
          $push: {
            recentScans: {
              $each: [
                {
                  action: "print_label",
                  packageId: packageDoc._id,
                  trackingNumber: packageDoc.trackingNumber,
                  branchId: cashier.assignedBranchId,
                  timestamp: now,
                  notes: noteText,
                  success: true,
                },
              ],
              $slice: -200,
              $position: 0,
            },
          },
        },
        { session },
      );

      await session.commitTransaction();
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message: "Package accepted into branch stock.",
        data: {
          packageId: packageDoc._id,
          trackingNumber: packageDoc.trackingNumber,
          previousStatus: "cashier_claimed",
          currentStatus: "at_origin_branch",
          acceptedAt: now,
          verifiedWeight: verifiedWeight ?? null,
        },
      });

    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(", "),
            400,
          ),
        );
      }
      return next(error);
    } finally {
      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => {});
      }
      await session.endSession();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 4.  REJECT PACKAGE
//     POST /cashier/reject-package
//
//     Called when the package fails physical inspection after being claimed.
//     Status → 'cancelled'. BranchModel currentLoad is decremented because
//     the package never made it into stock.
// ─────────────────────────────────────────────────────────────────────────────

type RejectionReason =
  | "damaged_on_arrival"
  | "prohibited_item"
  | "wrong_dimensions"
  | "overweight"
  | "missing_documentation"
  | "payment_declined"
  | "address_unserviceable"
  | "duplicate_package"
  | "other";

const VALID_REJECTION_REASONS: RejectionReason[] = [
  "damaged_on_arrival", "prohibited_item", "wrong_dimensions",
  "overweight", "missing_documentation", "payment_declined",
  "address_unserviceable", "duplicate_package", "other",
];

export const rejectPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const cashierUserId = req.user?._id;
      const cashier = await resolveCashier(cashierUserId, next, session);
      if (!cashier) return;

      const { trackingNumber, rejectionReason, notes } = req.body as {
        trackingNumber: string;
        rejectionReason: RejectionReason;
        notes?: string;
      };

      if (!trackingNumber?.trim()) {
        return next(new ErrorHandler("trackingNumber is required.", 400));
      }

      if (!rejectionReason || !VALID_REJECTION_REASONS.includes(rejectionReason)) {
        return next(
          new ErrorHandler(
            `rejectionReason must be one of: ${VALID_REJECTION_REASONS.join(", ")}`,
            400,
          ),
        );
      }

      const now = new Date();

      const packageDoc = await PackageModel.findOne({
        trackingNumber: trackingNumber.trim().toUpperCase(),
        originBranchId: cashier.assignedBranchId,
      }).session(session);

      if (!packageDoc) {
        return next(
          new ErrorHandler(`Package ${trackingNumber} not found at your branch.`, 404),
        );
      }

      // Can only reject packages that are claimed but not yet accepted
      if (packageDoc.status !== "cashier_claimed") {
        return next(
          new ErrorHandler(
            `Only packages in 'cashier_claimed' status can be rejected. Current status: '${packageDoc.status}'.`,
            400,
          ),
        );
      }

      const noteText = `Rejected at counter. Reason: ${rejectionReason}.${
        notes?.trim() ? ` Notes: ${notes.trim()}` : ""
      }`;

      await Promise.all([

        PackageModel.findByIdAndUpdate(
          packageDoc._id,
          {
            $set: { status: "cancelled" as PackageStatus },
            $push: {
              trackingHistory: {
                status: "cancelled",
                branchId: cashier.assignedBranchId,
                userId: cashierUserId,
                notes: noteText,
                timestamp: now,
              },
            },
          },
          { session },
        ),

        PackageHistoryModel.create(
          [
            {
              packageId: packageDoc._id,
              status: "cancelled" as PackageStatus,
              branchId: cashier.assignedBranchId,
              handledBy: cashierUserId,
              handlerName: `${(req.user as any)?.firstName} ${(req.user as any)?.lastName}`,
              handlerRole: "cashier",
              notes: noteText,
              timestamp: now,
            },
          ],
          { session },
        ),

        // Decrement load — package was counted in when claimed, now it's leaving
        BranchModel.findByIdAndUpdate(
          cashier.assignedBranchId,
          { $inc: { currentLoad: -1 } },
          { session },
        ),

        PaymentModel.findOneAndUpdate(
          { packageId: packageDoc._id },
          { $set: { status: "cancelled" } },
          { session },
        ),

        CashierModel.findByIdAndUpdate(
          cashier._id,
          {
            $inc: {
              "currentShift.packagesRejectedCount": 1,
              "stats.totalPackagesRejected": 1,
            },
            $set: { "stats.lastActiveAt": now },
            $push: {
              recentScans: {
                $each: [
                  {
                    action: "reject_package",
                    packageId: packageDoc._id,
                    trackingNumber: packageDoc.trackingNumber,
                    branchId: cashier.assignedBranchId,
                    timestamp: now,
                    notes: noteText,
                    rejectionReason,
                    success: true,
                  },
                ],
                $slice: -200,
                $position: 0,
              },
            },
          },
          { session },
        ),
      ]);

      await session.commitTransaction();
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message: "Package rejected and cancelled.",
        data: {
          packageId: packageDoc._id,
          trackingNumber: packageDoc.trackingNumber,
          previousStatus: "cashier_claimed",
          currentStatus: "cancelled",
          rejectionReason,
          rejectedAt: now,
        },
      });

    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(", "),
            400,
          ),
        );
      }
      return next(error);
    } finally {
      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => {});
      }
      await session.endSession();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 5.  CHECK IN / CHECK OUT
//     POST /cashier/check-in
//     POST /cashier/check-out
// ─────────────────────────────────────────────────────────────────────────────

export const checkIn = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const cashierUserId = req.user?._id;

    if (!cashierUserId) {
      return next(new ErrorHandler("Unauthorized.", 401));
    }

    const cashier = await CashierModel.findOne({
      userId: cashierUserId,
      status: "active",
    });

    if (!cashier) {
      return next(new ErrorHandler("Active cashier profile not found.", 404));
    }

    if (cashier.currentShift && (cashier.currentShift as any).status === "active") {
      return next(new ErrorHandler("You already have an active shift.", 400));
    }

    await cashier.checkIn(cashier.assignedBranchId);

    return res.status(200).json({
      success: true,
      message: "Shift started. You are now checked in.",
      data: {
        branchId: cashier.assignedBranchId,
        shiftStartedAt: (cashier.currentShift as any)?.startedAt ?? new Date(),
      },
    });
  },
);

export const checkOut = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const cashierUserId = req.user?._id;

    if (!cashierUserId) {
      return next(new ErrorHandler("Unauthorized.", 401));
    }

    const { notes } = req.body as { notes?: string };

    const cashier = await CashierModel.findOne({
      userId: cashierUserId,
      status: "active",
    });

    if (!cashier) {
      return next(new ErrorHandler("Active cashier profile not found.", 404));
    }

    if (!cashier.currentShift || (cashier.currentShift as any).status !== "active") {
      return next(new ErrorHandler("No active shift to end.", 400));
    }

    const shiftSnapshot = { ...cashier.currentShift } as any;

    await cashier.checkOut(notes);

    return res.status(200).json({
      success: true,
      message: "Shift ended. You are now checked out.",
      data: {
        shiftSummary: {
          startedAt: shiftSnapshot.startedAt,
          endedAt: new Date(),
          packagesClaimedCount: shiftSnapshot.packagesClaimedCount,
          packagesRejectedCount: shiftSnapshot.packagesRejectedCount,
          labelsIssuedCount: shiftSnapshot.labelsIssuedCount,
          paymentsCollectedCount: shiftSnapshot.paymentsCollectedCount,
          totalAmountCollected: shiftSnapshot.totalAmountCollected,
        },
      },
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 6.  MY SHIFT DASHBOARD
//     GET /cashier/my-shift
//
//     Returns the cashier's current shift stats and the last 20 scan actions,
//     so the mobile app can show a live counter view.
// ─────────────────────────────────────────────────────────────────────────────

export const getMyShift = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const cashierUserId = req.user?._id;

    if (!cashierUserId) {
      return next(new ErrorHandler("Unauthorized.", 401));
    }

    const cashier = await CashierModel.findOne({
      userId: cashierUserId,
      status: "active",
    })
      .populate("assignedBranchId", "name code address")
      .lean();

    if (!cashier) {
      return next(new ErrorHandler("Active cashier profile not found.", 404));
    }

    const isCheckedIn =
      !!cashier.currentShift &&
      (cashier.currentShift as any).status === "active";

    const durationMinutes = isCheckedIn
      ? Math.round(
          (Date.now() -
            new Date((cashier.currentShift as any).startedAt).getTime()) /
            60000,
        )
      : null;

    return res.status(200).json({
      success: true,
      data: {
        isCheckedIn,
        branch: cashier.assignedBranchId,
        currentShift: isCheckedIn
          ? {
              ...(cashier.currentShift as any),
              durationMinutes,
            }
          : null,
        recentScans: (cashier.recentScans as any[]).slice(0, 20),
        stats: cashier.stats,
      },
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 7.  GET PENDING PACKAGES AT MY BRANCH
//     GET /cashier/pending-packages
//
//     All 'pending' packages registered for this branch but not yet claimed.
//     Useful for the cashier to see what's expected today before merchants arrive.
// ─────────────────────────────────────────────────────────────────────────────

export const getPendingPackages = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const cashierUserId = req.user?._id;

    const cashier = await resolveCashier(cashierUserId, next);
    if (!cashier) return;

    const { page, limit } = req.query as Record<string, string | undefined>;
    const pageNum  = Math.max(1, parseInt(page  ?? "1",  10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? "20", 10)));
    const skip = (pageNum - 1) * limitNum;

    const [packages, total] = await Promise.all([
      PackageModel.find({
        originBranchId: cashier.assignedBranchId,
        status: "pending",
      })
        .select(
          "trackingNumber weight type isFragile totalPrice deliveryType " +
          "destination senderId createdAt",
        )
        .populate("senderId", "firstName lastName phone")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),

      PackageModel.countDocuments({
        originBranchId: cashier.assignedBranchId,
        status: "pending",
      }),
    ]);

    const totalPages = Math.ceil(total / limitNum);

    return res.status(200).json({
      success: true,
      data: packages,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
    });
  },
);