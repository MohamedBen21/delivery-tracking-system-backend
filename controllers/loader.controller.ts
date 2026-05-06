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




//  POST /loader/manifests
//  The loader opens a new manifest bag at the origin branch.
//  Destination branch + priority are specified upfront so that
//  the manifest label can be printed immediately.


export const createManifest = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let committed = false;

    try {
      const loaderUserId = req.user?._id;
      const loader = await resolveLoader(loaderUserId, next, true, session);
      if (!loader) return;

      const {
        destinationBranchId,
        priority = "standard",
        notes,
        internalReference,
      } = req.body as {
        destinationBranchId: string;
        priority?: "standard" | "express" | "urgent";
        notes?: string;
        internalReference?: string;
      };

      if (!destinationBranchId || !mongoose.Types.ObjectId.isValid(destinationBranchId)) {
        return next(new ErrorHandler("Valid destinationBranchId is required.", 400));
      }

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;

      if (activeBranchId.toString() === destinationBranchId) {
        return next(
          new ErrorHandler("Origin and destination branches cannot be the same.", 400),
        );
      }

      const [originBranch, destinationBranch] = await Promise.all([
        BranchModel.findById(activeBranchId).session(session).lean(),
        BranchModel.findById(destinationBranchId).session(session).lean(),
      ]);

      if (!originBranch || originBranch.status !== "active") {
        return next(new ErrorHandler("Origin branch not found or not active.", 404));
      }
      if (!destinationBranch || destinationBranch.status !== "active") {
        return next(new ErrorHandler("Destination branch not found or not active.", 404));
      }

      if (!["standard", "express", "urgent"].includes(priority)) {
        return next(
          new ErrorHandler("priority must be standard, express, or urgent.", 400),
        );
      }

      // Generate the manifest code using the static model method
      const manifestCode = await ManifestModel.generateManifestCode(
        originBranch.code,
        destinationBranch.code,
      );

      const [manifest] = await ManifestModel.create(
        [
          {
            manifestCode,
            companyId: loader.companyId,
            originBranchId: activeBranchId,
            destinationBranchId: new mongoose.Types.ObjectId(destinationBranchId),
            status: "open",
            priority,
            createdBy: loaderUserId,
            packages: [],
            totalDeclaredWeight: 0,
            packageCount: 0,
            notes: notes?.trim(),
            internalReference: internalReference?.trim(),
          },
        ],
        { session },
      );

      // ManifestEvent — audit trail
      await ManifestEventModel.create(
        [
          {
            manifestId: manifest._id,
            manifestCode,
            eventType: "created",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            newStatus: "open",
            notes: `Manifest created by loader.`,
            timestamp: new Date(),
          },
        ],
        { session },
      );


      await LoaderModel.findByIdAndUpdate(
        loader._id,
        {
          $inc: {
            "stats.totalManifestsCreated": 1,
            "currentShift.manifestsLoadedCount": 0,
          },
          $set: { "stats.lastActiveAt": new Date() },
          $push: {
            recentScans: {
              $each: [
                {
                  action: "create_manifest",
                  scannedId: manifest._id,
                  scannedCode: manifestCode,
                  manifestId: manifest._id,
                  manifestCode,
                  branchId: activeBranchId,
                  timestamp: new Date(),
                  success: true,
                },
              ],
              $position: 0,
              $slice: 200,
            },
          },
        },
        { session },
      );

      await session.commitTransaction();
      committed = true;

      return res.status(201).json({
        success: true,
        message: "Manifest created successfully.",
        data: {
          manifestId: manifest._id,
          manifestCode,
          status: "open",
          priority,
          originBranch: {
            id: originBranch._id,
            name: originBranch.name,
            code: originBranch.code,
          },
          destinationBranch: {
            id: destinationBranch._id,
            name: destinationBranch.name,
            code: destinationBranch.code,
          },
          packageCount: 0,
          totalDeclaredWeight: 0,
          createdAt: manifest.createdAt,
        },
      });

    } catch (err: any) {
      if (err.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(err.errors).map((e: any) => e.message).join(", "), 400,
        ));
      }
      return next(err);
    } finally {
      if (!committed) await session.abortTransaction().catch(() => {});
      await session.endSession();
    }
  },
);


//  POST /loader/manifests/:manifestId/scan-in
//  Loader scans each package barcode and places it inside the manifest bag.
//  Package must be 'at_origin_branch' to be scanned in.
//  Status → 'manifested'

export const scanPackageIn = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let committed = false;

    try {
      const loaderUserId = req.user?._id;
      const { manifestId } = req.params;
      const { trackingNumber, notes } = req.body as {
        trackingNumber: string;
        notes?: string;
      };

      if (!manifestId || !mongoose.Types.ObjectId.isValid((manifestId).toString())) {
        return next(new ErrorHandler("Invalid manifestId.", 400));
      }
      if (!trackingNumber?.trim()) {
        return next(new ErrorHandler("trackingNumber is required.", 400));
      }

      const loader = await resolveLoader(loaderUserId, next, true, session);
      if (!loader) return;

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;
      const now = new Date();


      const [manifest, packageDoc] = await Promise.all([
        ManifestModel.findById(manifestId).session(session),
        PackageModel.findOne({
          trackingNumber: trackingNumber.trim().toUpperCase(),
        }).session(session),
      ]);

      if (!manifest) {
        return next(new ErrorHandler("Manifest not found.", 404));
      }


      if (manifest.originBranchId.toString() !== activeBranchId.toString()) {
        return next(
          new ErrorHandler(
            "This manifest belongs to a different branch. You cannot scan packages into it here.",
            403,
          ),
        );
      }

      if (manifest.status !== "open") {
        return next(
          new ErrorHandler(
            `Manifest is '${manifest.status}'. Only open manifests accept new packages.`,
            400,
          ),
        );
      }

      if (!packageDoc) {
        return next(
          new ErrorHandler(`No package found with tracking number ${trackingNumber}.`, 404),
        );
      }


      if (packageDoc.status !== "at_origin_branch") {
        return next(
          new ErrorHandler(
            `Package must be in 'at_origin_branch' status to be manifested. Current status: '${packageDoc.status}'.`,
            400,
          ),
        );
      }

      if (
        !packageDoc.originBranchId ||
        packageDoc.originBranchId.toString() !== activeBranchId.toString()
      ) {
        return next(
          new ErrorHandler(
            "Package origin branch does not match your current branch.",
            403,
          ),
        );
      }


      if ((packageDoc as any).currentManifestId) {
        return next(
          new ErrorHandler(
            "Package is already assigned to another manifest. Remove it first.",
            400,
          ),
        );
      }

      // ── Update manifest (uses model method for weight/count sync) ─────────
      await manifest.addPackage(
        packageDoc._id as mongoose.Types.ObjectId,
        packageDoc.trackingNumber,
        packageDoc.weight,
        loaderUserId as mongoose.Types.ObjectId,
      );


      await PackageModel.findByIdAndUpdate(
        packageDoc._id,
        {
          $set: {
            status: "manifested" as PackageStatus,
            currentManifestId: manifest._id,
          },
          $push: {
            trackingHistory: {
              status: "manifested",
              branchId: activeBranchId,
              userId: loaderUserId,
              notes: notes?.trim() || `Scanned into manifest ${manifest.manifestCode}`,
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
            status: "manifested" as PackageStatus,
            branchId: activeBranchId,
            handledBy: loaderUserId,
            handlerName: loaderName(req),
            handlerRole: "loader",
            manifestId: manifest._id,
            notes: notes?.trim() || `Scanned into manifest ${manifest.manifestCode}`,
            timestamp: now,
          },
        ],
        { session },
      );


      await ManifestEventModel.create(
        [
          {
            manifestId: manifest._id,
            manifestCode: manifest.manifestCode,
            eventType: "package_added",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            packageId: packageDoc._id,
            packageTrackingNumber: packageDoc.trackingNumber,
            notes: `Package scanned in. Sequence #${manifest.packages.length}.`,
            timestamp: now,
          },
        ],
        { session },
      );


      await LoaderModel.findByIdAndUpdate(
        loader._id,
        {
          $inc: {
            "stats.totalPackagesLoaded": 1,
            "currentShift.packagesLoadedCount": 1,
          },
          $set: { "stats.lastActiveAt": now },
          $push: {
            recentScans: {
              $each: [
                {
                  action: "scan_in_package",
                  scannedId: packageDoc._id,
                  scannedCode: packageDoc.trackingNumber,
                  manifestId: manifest._id,
                  manifestCode: manifest.manifestCode,
                  branchId: activeBranchId,
                  timestamp: now,
                  notes: notes?.trim(),
                  success: true,
                },
              ],
              $position: 0,
              $slice: 200,
            },
          },
        },
        { session },
      );

      await session.commitTransaction();
      committed = true;

      return res.status(200).json({
        success: true,
        message: `Package ${packageDoc.trackingNumber} scanned into manifest ${manifest.manifestCode}.`,
        data: {
          manifestId: manifest._id,
          manifestCode: manifest.manifestCode,
          packageId: packageDoc._id,
          trackingNumber: packageDoc.trackingNumber,
          packageStatus: "manifested",
          manifestSnapshot: {
            packageCount: manifest.packages.length,
            totalDeclaredWeight: manifest.totalDeclaredWeight,
            status: manifest.status,
          },
        },
      });

    } catch (err: any) {
      if (err.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(err.errors).map((e: any) => e.message).join(", "), 400,
        ));
      }
      return next(err);
    } finally {
      if (!committed) await session.abortTransaction().catch(() => {});
      await session.endSession();
    }
  },
);

