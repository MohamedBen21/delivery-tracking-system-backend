import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import LoaderModel, { ILoader, LoaderScanAction } from "../models/loader.model";
import { ManifestModel, ManifestEventModel, ManifestStatus, IManifestPackageEntry } from "../models/manifest.model";
import PackageModel, { PackageStatus } from "../models/package.model";
import PackageHistoryModel from "../models/package-history.model";
import BranchModel from "../models/branch.model";
import VehicleModel from "../models/vehicle.model";
import userModel from "../models/user.model";




async function resolveLoader(
  userId: any,
  next: NextFunction,
  requireShift = true,
  session?: mongoose.ClientSession,
) {
  if (!userId) {
    next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    return null;
  }

  const q = LoaderModel.findOne({ userId, status: "active" });
  if (session) q.session(session);
  const loader = await q;

  if (!loader) {
    next(new ErrorHandler("Active loader profile not found.", 404));
    return null;
  }

  if (requireShift) {
    const shift = loader.currentShift as any;
    if (!shift || shift.status !== "active") {
      next(
        new ErrorHandler(
          "You must be checked in to an active shift before performing this operation.",
          403,
        ),
      );
      return null;
    }
  }

  return loader;
}


function loaderName(req: Request): string {
  const u = req.user as any;
  return u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "Loader";
}

/**
 * Push a scan entry to the loader document using a $push with $slice
 * so we never exceed 200 entries without loading the full array.
 * We call this via findByIdAndUpdate to avoid a second full-document save.
 */
async function pushLoaderScan(
  loaderId: mongoose.Types.ObjectId,
  entry: Record<string, unknown>,
  session: mongoose.ClientSession,
) {
  await LoaderModel.findByIdAndUpdate(
    loaderId,
    {
      $set: { "stats.lastActiveAt": new Date() },
      $push: {
        recentScans: {
          $each: [entry],
          $position: 0,
          $slice: 200,
        },
      },
    },
    { session },
  );
}



export const checkIn = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const loaderUserId = req.user?._id;

    if (!loaderUserId) return next(new ErrorHandler("Unauthorized.", 401));


    const loader = await resolveLoader(loaderUserId, next, false);
    if (!loader) return;

    const shift = loader.currentShift as any;
    if (shift && shift.status === "active") {
      return next(new ErrorHandler("You already have an active shift.", 400));
    }

    // Loaders can temporarily work at a different branch
    // If branchId is supplied in the body, use it; otherwise default to home branch
    const { branchId } = req.body as { branchId?: string };

    let activeBranchId: mongoose.Types.ObjectId;

    if (branchId) {
      if (!mongoose.Types.ObjectId.isValid(branchId)) {
        return next(new ErrorHandler("Invalid branchId.", 400));
      }
      const branch = await BranchModel.findById(branchId).lean();
      if (!branch || branch.status !== "active") {
        return next(new ErrorHandler("Branch not found or not active.", 404));
      }
      activeBranchId = new mongoose.Types.ObjectId(branchId);


      if (activeBranchId.toString() !== loader.assignedBranchId.toString()) {
        loader.temporaryBranchId = activeBranchId;
      }
    } else {
      activeBranchId = loader.assignedBranchId;
    }

    await loader.checkIn(activeBranchId);

    return res.status(200).json({
      success: true,
      message: "Shift started. You are now checked in.",
      data: {
        branchId: activeBranchId,
        shiftStartedAt: (loader.currentShift as any)?.startedAt ?? new Date(),
      },
    });
  },
);



export const checkOut = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const loaderUserId = req.user?._id;
    if (!loaderUserId) return next(new ErrorHandler("Unauthorized.", 401));

    const loader = await resolveLoader(loaderUserId, next, true);
    if (!loader) return;

    const { notes } = req.body as { notes?: string };
    const shiftSnapshot = { ...(loader.currentShift as any) };

    await loader.checkOut(notes);

    return res.status(200).json({
      success: true,
      message: "Shift ended. You are now checked out.",
      data: {
        shiftSummary: {
          startedAt:              shiftSnapshot.startedAt,
          endedAt:                new Date(),
          packagesLoadedCount:    shiftSnapshot.packagesLoadedCount,
          packagesUnloadedCount:  shiftSnapshot.packagesUnloadedCount,
          manifestsLoadedCount:   shiftSnapshot.manifestsLoadedCount,
          manifestsUnloadedCount: shiftSnapshot.manifestsUnloadedCount,
          durationMinutes:        Math.round(
            (Date.now() - new Date(shiftSnapshot.startedAt).getTime()) / 60000,
          ),
        },
      },
    });
  },
);

