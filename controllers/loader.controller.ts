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

        throw new ErrorHandler("Valid destinationBranchId is required.", 400);
      }

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;

      if (activeBranchId.toString() === destinationBranchId) {

          throw new ErrorHandler("Origin and destination branches cannot be the same.", 400
        );
      }

      const [originBranch, destinationBranch] = await Promise.all([
        BranchModel.findById(activeBranchId).session(session).lean(),
        BranchModel.findById(destinationBranchId).session(session).lean(),
      ]);

      if (!originBranch || originBranch.status !== "active") {

        throw new ErrorHandler("Origin branch not found or not active.", 404);
      }
      if (!destinationBranch || destinationBranch.status !== "active") {

        throw new ErrorHandler("Destination branch not found or not active.", 404);
      }

      if (!["standard", "express", "urgent"].includes(priority)) {

        throw new ErrorHandler("priority must be standard, express, or urgent.", 400);
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

        throw new ErrorHandler("Manifest not found.", 404);
      }


      if (manifest.originBranchId.toString() !== activeBranchId.toString()) {

        throw new ErrorHandler(
          "This manifest belongs to a different branch. You cannot scan packages into it here.",
          403,
        );
      }

      if (manifest.status !== "open") {

        throw new ErrorHandler(
          `Manifest is '${manifest.status}'. Only open manifests accept new packages.`,
          400,
        );
      }

      if (!packageDoc) {

        throw new ErrorHandler(`No package found with tracking number ${trackingNumber}.`, 404);
      }


      if (packageDoc.status !== "at_origin_branch") {

        throw new ErrorHandler(
          `Package must be in 'at_origin_branch' status to be manifested. Current status: '${packageDoc.status}'.`,
          400,
        );
      }

      if (
        !packageDoc.originBranchId ||
        packageDoc.originBranchId.toString() !== activeBranchId.toString()
      ) {

        throw new ErrorHandler(
          "Package origin branch does not match your current branch.",
          403,
        );
      }


      if ((packageDoc as any).currentManifestId) {

        throw new ErrorHandler(
          "Package is already assigned to another manifest. Remove it first.",
          400,
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



// ─────────────────────────────────────────────────────────────────────────────
// 5.  REMOVE PACKAGE FROM MANIFEST (before sealing)
//     DELETE /loader/manifests/:manifestId/packages/:packageId
//
//  Only allowed while the manifest is still 'open'.
//  Package returns to 'at_origin_branch'.
// ─────────────────────────────────────────────────────────────────────────────

export const removePackageFromManifest = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let committed = false;

    try {
      const loaderUserId = req.user?._id;
      const { manifestId, packageId } = req.params;
      const { notes } = req.body as { notes?: string };

      if (!mongoose.Types.ObjectId.isValid(manifestId.toString())) {
        return next(new ErrorHandler("Invalid manifestId.", 400));
      }
      if (!mongoose.Types.ObjectId.isValid(packageId.toString())) {
        return next(new ErrorHandler("Invalid packageId.", 400));
      }

      const loader = await resolveLoader(loaderUserId, next, true, session);
      if (!loader) return;

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;
      const now = new Date();

      const [manifest, packageDoc] = await Promise.all([
        ManifestModel.findById(manifestId).session(session),
        PackageModel.findById(packageId).session(session),
      ]);

      if (!manifest) throw new ErrorHandler("Manifest not found.", 404);

      if (!packageDoc) throw new ErrorHandler("Package not found.", 404);

      if (manifest.originBranchId.toString() !== activeBranchId.toString()) {

        throw new ErrorHandler("This manifest belongs to a different branch.", 403);
      }

      if (manifest.status !== "open") {

        throw new ErrorHandler(
          `Cannot remove packages from a '${manifest.status}' manifest. Only open manifests can be modified.`,
          400,
        );
      }


      await manifest.removePackage(
        packageDoc._id as mongoose.Types.ObjectId,
        loaderUserId as mongoose.Types.ObjectId,
        notes,
      );


      await PackageModel.findByIdAndUpdate(
        packageDoc._id,
        {
          $set: {
            status: "at_origin_branch" as PackageStatus,
            currentManifestId: null,
          },
          $push: {
            trackingHistory: {
              status: "at_origin_branch",
              branchId: activeBranchId,
              userId: loaderUserId,
              notes: notes?.trim() || `Removed from manifest ${manifest.manifestCode}`,
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
            branchId: activeBranchId,
            handledBy: loaderUserId,
            handlerName: loaderName(req),
            handlerRole: "loader",
            manifestId: manifest._id,
            notes: notes?.trim() || `Removed from manifest ${manifest.manifestCode} before sealing.`,
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
            eventType: "package_removed",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            packageId: packageDoc._id,
            packageTrackingNumber: packageDoc.trackingNumber,
            notes: notes?.trim() || `Package removed before sealing.`,
            timestamp: now,
          },
        ],
        { session },
      );

      await session.commitTransaction();
      committed = true;

      return res.status(200).json({
        success: true,
        message: `Package ${packageDoc.trackingNumber} removed from manifest ${manifest.manifestCode}.`,
        data: {
          manifestId: manifest._id,
          manifestCode: manifest.manifestCode,
          packageId: packageDoc._id,
          trackingNumber: packageDoc.trackingNumber,
          packageStatus: "at_origin_branch",
          manifestSnapshot: {
            packageCount: manifest.packageCount - 1,
            status: manifest.status,
          },
        },
      });

    } catch (err: any) {
      return next(err);
    } finally {

      if (!committed) await session.abortTransaction().catch(() => {});

      await session.endSession();
    }
  },
);


//  POST /loader/manifests/:manifestId/seal
//  Physically closes and labels the bag.
//  After this no packages can be added or removed.
//  Status: open → sealed


export const sealManifest = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let committed = false;

    try {
      const loaderUserId = req.user?._id;
      const { manifestId } = req.params;
      const { sealNumber, notes } = req.body as {
        sealNumber: string;
        notes?: string;
      };

      if (!mongoose.Types.ObjectId.isValid(manifestId.toString())) {
        return next(new ErrorHandler("Invalid manifestId.", 400));
      }
      if (!sealNumber?.trim()) {
        return next(new ErrorHandler("sealNumber is required.", 400));
      }

      const loader = await resolveLoader(loaderUserId, next, true, session);
      if (!loader) return;

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;
      const now = new Date();

      const manifest = await ManifestModel.findById(manifestId).session(session);

      if (!manifest) throw new ErrorHandler("Manifest not found.", 404);

      if (manifest.originBranchId.toString() !== activeBranchId.toString()) {

        throw new ErrorHandler("This manifest belongs to a different branch.", 403);
      }

      if (manifest.status !== "open") {

        throw new ErrorHandler(`Cannot seal a '${manifest.status}' manifest.`, 400);
      }

      if (manifest.packages.length === 0) {

        throw new ErrorHandler("Cannot seal an empty manifest.", 400);
      }

     
      await manifest.seal(
        loaderUserId as mongoose.Types.ObjectId,
        sealNumber.trim().toUpperCase(),
        notes,
      );

      await ManifestEventModel.create(
        [
          {
            manifestId: manifest._id,
            manifestCode: manifest.manifestCode,
            eventType: "sealed",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            previousStatus: "open",
            newStatus: "sealed",
            metadata: { sealNumber: sealNumber.trim().toUpperCase() },
            notes: notes?.trim() || `Manifest sealed. ${manifest.packages.length} packages, ${manifest.totalDeclaredWeight}kg.`,
            timestamp: now,
          },
        ],
        { session },
      );

      await LoaderModel.findByIdAndUpdate(
        loader._id,
        {
          $inc: { "stats.totalManifestsSealed": 1 },
          $set: { "stats.lastActiveAt": now },
          $push: {
            recentScans: {
              $each: [
                {
                  action: "seal_manifest",
                  scannedId: manifest._id,
                  scannedCode: manifest.manifestCode,
                  manifestId: manifest._id,
                  manifestCode: manifest.manifestCode,
                  branchId: activeBranchId,
                  timestamp: now,
                  notes: `Sealed with ${sealNumber}`,
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
        message: `Manifest ${manifest.manifestCode} sealed successfully.`,
        data: {
          manifestId: manifest._id,
          manifestCode: manifest.manifestCode,
          status: "sealed",
          sealNumber: sealNumber.trim().toUpperCase(),
          packageCount: manifest.packageCount,
          totalDeclaredWeight: manifest.totalDeclaredWeight,
          sealedAt: now,
          packages: manifest.packages.map((p: IManifestPackageEntry) => ({
            trackingNumber: p.trackingNumber,
            weight: p.weight,
            sequence: p.sequence,
          })),
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



//  POST /loader/manifests/:manifestId/load-on-truck
//  Loader scans the sealed manifest bag barcode and loads it onto the vehicle.
//  A transporter (driver) and vehicle must be specified.
//  Status: sealed → loaded


export const loadManifestOnTruck = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let committed = false;

    try {
      const loaderUserId = req.user?._id;
      const { manifestId } = req.params;
      const { transporterUserId, vehicleId, estimatedArrival, notes } = req.body as {
        transporterUserId: string;
        vehicleId?: string;
        estimatedArrival?: string;
        notes?: string;
      };

      if (!mongoose.Types.ObjectId.isValid(manifestId.toString())) {
        return next(new ErrorHandler("Invalid manifestId.", 400));
      }
      if (!transporterUserId || !mongoose.Types.ObjectId.isValid(transporterUserId)) {
        return next(new ErrorHandler("Valid transporterUserId is required.", 400));
      }
      if (vehicleId && !mongoose.Types.ObjectId.isValid(vehicleId)) {
        return next(new ErrorHandler("Invalid vehicleId.", 400));
      }

      const loader = await resolveLoader(loaderUserId, next, true, session);
      if (!loader) return;

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;
      const now = new Date();


      const [manifest, transporter, vehicle] = await Promise.all([
        ManifestModel.findById(manifestId).session(session),
        userModel.findById(transporterUserId).session(session).lean(),
        vehicleId ? VehicleModel.findById(vehicleId).session(session) : Promise.resolve(null),
      ]);

      if (!manifest) throw new ErrorHandler("Manifest not found.", 404);

      if (manifest.originBranchId.toString() !== activeBranchId.toString()) {

        throw new ErrorHandler("This manifest belongs to a different branch.", 403);
      }

      if (manifest.status !== "sealed") {

        throw new ErrorHandler(
          `Manifest must be sealed before loading onto a truck. Current status: '${manifest.status}'.`,
          400,
        );
      }

      if (!transporter) {
        throw new ErrorHandler("Transporter user not found.", 404);
      }

      if (!["transporter", "driver"].includes(transporter.role)) {

        throw new ErrorHandler(
          `User must have role 'transporter' or 'driver'. Current role: '${transporter.role}'.`,
          400,
        );
      }

      if (vehicle) {
        if (vehicle.status !== "available" && vehicle.status !== "in_use") {

          throw new ErrorHandler(
            `Vehicle is '${vehicle.status}' and cannot be used for transport.`,
            400,
          );
        }


        const hasFragile = manifest.packages.some(async () => {
          const pkg = await PackageModel.findOne({
            _id: { $in: manifest.packages.map((p: IManifestPackageEntry) => p.packageId) },
            isFragile: true,
          });
          return !!pkg;
        });

        if (!vehicle.supportsFragile && manifest.packages.some((p: any) => p.isFragile)) {

          throw new ErrorHandler("Vehicle does not support fragile packages.", 400);
        }
      }

      const eta = estimatedArrival ? new Date(estimatedArrival) : undefined;

      if (eta && isNaN(eta.getTime())) {

        throw new ErrorHandler("estimatedArrival is not a valid date.", 400);
      }


      await manifest.assignTransport(
        new mongoose.Types.ObjectId(transporterUserId),
        vehicleId ? new mongoose.Types.ObjectId(vehicleId) : undefined,
        eta,
      );


      if (vehicle) {
        await VehicleModel.findByIdAndUpdate(
          vehicleId,
          {
            $set: {
              status: "in_use",
              assignedUserId: new mongoose.Types.ObjectId(transporterUserId),
              assignedUserRole: "transporter",
              currentBranchId: activeBranchId,
            },
          },
          { session },
        );
      }

      await ManifestEventModel.create(
        [
          {
            manifestId: manifest._id,
            manifestCode: manifest.manifestCode,
            eventType: "loaded_on_vehicle",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            previousStatus: "sealed",
            newStatus: "loaded",
            metadata: {
              transporterId: transporterUserId,
              vehicleId: vehicleId ?? null,
              estimatedArrival: eta ?? null,
            },
            notes: notes?.trim() || `Manifest loaded onto vehicle by loader.`,
            timestamp: now,
          },
        ],
        { session },
      );

      await LoaderModel.findByIdAndUpdate(
        loader._id,
        {
          $inc: {
            "stats.totalManifestsLoaded": 1,
            "currentShift.manifestsLoadedCount": 1,
          },
          $set: { "stats.lastActiveAt": now },
          $push: {
            recentScans: {
              $each: [
                {
                  action: "scan_manifest_on_truck",
                  scannedId: manifest._id,
                  scannedCode: manifest.manifestCode,
                  manifestId: manifest._id,
                  manifestCode: manifest.manifestCode,
                  vehicleId: vehicleId ? new mongoose.Types.ObjectId(vehicleId) : undefined,
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
        message: `Manifest ${manifest.manifestCode} loaded onto vehicle. Ready for departure.`,
        data: {
          manifestId: manifest._id,
          manifestCode: manifest.manifestCode,
          previousStatus: "sealed",
          currentStatus: "loaded",
          transporter: {
            id: transporter._id,
            name: `${transporter.firstName} ${transporter.lastName}`,
          },
          vehicleId: vehicleId ?? null,
          estimatedArrival: eta ?? null,
          packageCount: manifest.packageCount,
        },
      });

    } catch (err: any) {
      return next(err);
    } finally {
      if (!committed) await session.abortTransaction().catch(() => {});
      await session.endSession();
    }
  },
);



//   POST /loader/manifests/:manifestId/depart
//  Called by the loader when the truck physically leaves the origin branch.
//  Status: loaded → in_transit
//  All packages inside the manifest move to 'in_transit_to_branch'.


export const markManifestDeparted = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let committed = false;

    try {
      const loaderUserId = req.user?._id;
      const { manifestId } = req.params;
      const { notes } = req.body as { notes?: string };

      if (!mongoose.Types.ObjectId.isValid(manifestId.toString())) {
        return next(new ErrorHandler("Invalid manifestId.", 400));
      }

      const loader = await resolveLoader(loaderUserId, next, true, session);
      if (!loader) return;

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;
      const now = new Date();

      const manifest = await ManifestModel.findById(manifestId).session(session);

      if (!manifest) throw new ErrorHandler("Manifest not found.", 404);

      if (manifest.originBranchId.toString() !== activeBranchId.toString()) {

        throw new ErrorHandler("This manifest belongs to a different branch.", 403);
      }

      if (manifest.status !== "loaded") {

        throw new ErrorHandler(
          `Manifest must be in 'loaded' status before departure. Current status: '${manifest.status}'.`,
          400,
        );
      }

      await manifest.markDeparted(loaderUserId as mongoose.Types.ObjectId);


      const packageIds = manifest.packages.map((p: IManifestPackageEntry) => p.packageId);

      await PackageModel.updateMany(
        { _id: { $in: packageIds } },
        {
          $set: { status: "in_transit_to_branch" as PackageStatus },
          $push: {
            trackingHistory: {
              status: "in_transit_to_branch",
              branchId: activeBranchId,
              userId: loaderUserId,
              notes: `Truck departed from ${activeBranchId}. Manifest: ${manifest.manifestCode}.`,
              timestamp: now,
            },
          },
        },
        { session },
      );


      const historyDocs = packageIds.map((pkgId: mongoose.Types.ObjectId) => ({
        packageId: pkgId,
        status: "in_transit_to_branch" as PackageStatus,
        branchId: activeBranchId,
        handledBy: loaderUserId,
        handlerName: loaderName(req),
        handlerRole: "loader",
        manifestId: manifest._id,
        notes: `Departed in manifest ${manifest.manifestCode}.`,
        timestamp: now,
      }));

      await PackageHistoryModel.insertMany(historyDocs, { session });

      await ManifestEventModel.create(
        [
          {
            manifestId: manifest._id,
            manifestCode: manifest.manifestCode,
            eventType: "departed",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            previousStatus: "loaded",
            newStatus: "in_transit",
            notes: notes?.trim() || `Manifest departed. ${packageIds.length} packages in transit.`,
            timestamp: now,
          },
        ],
        { session },
      );


      await BranchModel.findByIdAndUpdate(
        activeBranchId,
        { $inc: { currentLoad: -packageIds.length } },
        { session },
      );

      await session.commitTransaction();
      committed = true;

      return res.status(200).json({
        success: true,
        message: `Manifest ${manifest.manifestCode} is now in transit. ${packageIds.length} packages on the way.`,
        data: {
          manifestId: manifest._id,
          manifestCode: manifest.manifestCode,
          previousStatus: "loaded",
          currentStatus: "in_transit",
          departedAt: now,
          packagesInTransit: packageIds.length,
          estimatedArrival: manifest.estimatedArrival ?? null,
        },
      });

    } catch (err: any) {
      return next(err);
    } finally {

      if (!committed) await session.abortTransaction().catch(() => {});

      await session.endSession();
    }
  },
);


//   POST /loader/manifests/:manifestId/arrive
//  Called by the loader at the DESTINATION branch when the truck pulls in.
//  Status: in_transit → arrived
//  All packages move to 'at_destination_branch'.

export const markManifestArrived = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let committed = false;

    try {
      const loaderUserId = req.user?._id;
      const { manifestId } = req.params;
      const { notes } = req.body as { notes?: string };

      if (!mongoose.Types.ObjectId.isValid(manifestId.toString())) {
        return next(new ErrorHandler("Invalid manifestId.", 400));
      }

      const loader = await resolveLoader(loaderUserId, next, true, session);
      if (!loader) return;

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;
      const now = new Date();

      const manifest = await ManifestModel.findById(manifestId).session(session);
      if (!manifest) return next(new ErrorHandler("Manifest not found.", 404));


      if (manifest.destinationBranchId.toString() !== activeBranchId.toString()) {
        return next(
          new ErrorHandler(
            "You are not at this manifest's destination branch. Cannot mark arrival.",
            403,
          ),
        );
      }

      if (manifest.status !== "in_transit") {
        return next(
          new ErrorHandler(
            `Manifest must be 'in_transit' to mark arrival. Current status: '${manifest.status}'.`,
            400,
          ),
        );
      }

      await manifest.markArrived(loaderUserId as mongoose.Types.ObjectId);

      const packageIds = manifest.packages.map((p: IManifestPackageEntry) => p.packageId);


      await PackageModel.updateMany(
        { _id: { $in: packageIds } },
        {
          $set: {
            status: "at_destination_branch" as PackageStatus,
            currentBranchId: activeBranchId,
          },
          $push: {
            trackingHistory: {
              status: "at_destination_branch",
              branchId: activeBranchId,
              userId: loaderUserId,
              notes: `Arrived at destination branch. Manifest: ${manifest.manifestCode}.`,
              timestamp: now,
            },
          },
        },
        { session },
      );

      const historyDocs = packageIds.map((pkgId: mongoose.Types.ObjectId) => ({
        packageId: pkgId,
        status: "at_destination_branch" as PackageStatus,
        branchId: activeBranchId,
        handledBy: loaderUserId,
        handlerName: loaderName(req),
        handlerRole: "loader",
        manifestId: manifest._id,
        notes: `Arrived in manifest ${manifest.manifestCode}.`,
        timestamp: now,
      }));

      await PackageHistoryModel.insertMany(historyDocs, { session });

      await ManifestEventModel.create(
        [
          {
            manifestId: manifest._id,
            manifestCode: manifest.manifestCode,
            eventType: "arrived",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            previousStatus: "in_transit",
            newStatus: "arrived",
            notes: notes?.trim() || `Manifest arrived. ${packageIds.length} packages to unload.`,
            timestamp: now,
          },
        ],
        { session },
      );


      await BranchModel.findByIdAndUpdate(
        activeBranchId,
        { $inc: { currentLoad: packageIds.length } },
        { session },
      );


      if (manifest.transportLeg?.vehicleId) {
        await VehicleModel.findByIdAndUpdate(
          manifest.transportLeg.vehicleId,
          {
            $set: {
              status: "available",
              currentBranchId: activeBranchId,
            },
            $unset: { assignedUserId: 1, assignedUserRole: 1 },
          },
          { session },
        );
      }

      await session.commitTransaction();
      committed = true;

      return res.status(200).json({
        success: true,
        message: `Manifest ${manifest.manifestCode} arrived. Ready for unloading.`,
        data: {
          manifestId: manifest._id,
          manifestCode: manifest.manifestCode,
          previousStatus: "in_transit",
          currentStatus: "arrived",
          arrivedAt: now,
          packageCount: packageIds.length,
          destinationBranchId: activeBranchId,
        },
      });

    } catch (err: any) {
      return next(err);
    } finally {
      if (!committed) await session.abortTransaction().catch(() => {});
      await session.endSession();
    }
  },
);



//  POST /loader/manifests/:manifestId/scan-out
//  Loader at destination branch scans each package out of the manifest bag.
//  Status: at_destination_branch — package is now loose at this branch and can
//  be dispatched for home delivery or picked up by the client.


export const scanPackageOut = catchAsyncError(
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

      if (!mongoose.Types.ObjectId.isValid(manifestId.toString())) {
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

      if (!manifest) throw new ErrorHandler("Manifest not found.", 404);

      if (manifest.destinationBranchId.toString() !== activeBranchId.toString()) {

        throw new ErrorHandler("You are not at this manifest's destination branch.", 403);
      }

      if (!["arrived", "unloading"].includes(manifest.status)) {

        throw new ErrorHandler(
          `Manifest must be 'arrived' or 'unloading' to scan packages out. Current status: '${manifest.status}'.`,
          400,
        );
      }

      if (!packageDoc) {

        throw new ErrorHandler(`No package found with tracking number ${trackingNumber}.`, 404);
      }

      
      const entry = manifest.packages.find(
        (p: IManifestPackageEntry) =>
          p.packageId.toString() === (packageDoc._id as mongoose.Types.ObjectId).toString(),
      );

      if (!entry) {

        throw new ErrorHandler(
          `Package ${trackingNumber} is not part of manifest ${manifest.manifestCode}.`,
          400,
        );
      }

      if (entry.entryStatus !== "in_manifest") {

        throw new ErrorHandler(
          `Package entry is already '${entry.entryStatus}'. Cannot unload again.`,
          400,
        );
      }


      await manifest.unloadPackage(
        packageDoc._id as mongoose.Types.ObjectId,
        loaderUserId as mongoose.Types.ObjectId,
        notes,
      );


      await PackageModel.findByIdAndUpdate(
        packageDoc._id,
        {
          $set: { currentManifestId: null },
          $push: {
            trackingHistory: {
              status: "at_destination_branch",
              branchId: activeBranchId,
              userId: loaderUserId,
              notes: notes?.trim() || `Scanned out of manifest ${manifest.manifestCode}. Ready for dispatch.`,
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
            status: "at_destination_branch" as PackageStatus,
            branchId: activeBranchId,
            handledBy: loaderUserId,
            handlerName: loaderName(req),
            handlerRole: "loader",
            manifestId: manifest._id,
            notes: notes?.trim() || `Unloaded from manifest ${manifest.manifestCode}. Awaiting dispatch.`,
            timestamp: now,
          },
        ],
        { session },
      );

      const isFirstScan = manifest.status === "arrived"; 

      await ManifestEventModel.create(
        [
          {
            manifestId: manifest._id,
            manifestCode: manifest.manifestCode,
            eventType: isFirstScan ? "unload_started" : "package_unloaded",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            packageId: packageDoc._id,
            packageTrackingNumber: packageDoc.trackingNumber,
            notes: `Package unloaded from manifest bag.`,
            timestamp: now,
          },
        ],
        { session },
      );

      await LoaderModel.findByIdAndUpdate(
        loader._id,
        {
          $inc: {
            "stats.totalPackagesUnloaded": 1,
            "currentShift.packagesUnloadedCount": 1,
          },
          $set: { "stats.lastActiveAt": now },
          $push: {
            recentScans: {
              $each: [
                {
                  action: "scan_out_package",
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

      
      const remaining = manifest.packages.filter(
        (p: IManifestPackageEntry) => p.entryStatus === "in_manifest",
      ).length;

      let autoClosedAt: Date | null = null;

      if (remaining === 0) {
        await manifest.close(loaderUserId as mongoose.Types.ObjectId);
        autoClosedAt = new Date();

        await ManifestEventModel.create(
          [
            {
              manifestId: manifest._id,
              manifestCode: manifest.manifestCode,
              eventType: "closed",
              performedBy: loaderUserId,
              performerName: loaderName(req),
              performerRole: "loader",
              branchId: activeBranchId,
              previousStatus: "unloading",
              newStatus: "closed",
              notes: "All packages unloaded. Manifest auto-closed.",
              timestamp: autoClosedAt,
            },
          ],
          { session },
        );

        await LoaderModel.findByIdAndUpdate(
          loader._id,
          {
            $inc: {
              "stats.totalManifestsUnloaded": 1,
              "currentShift.manifestsUnloadedCount": 1,
            },
          },
          { session },
        );
      }

      await session.commitTransaction();
      committed = true;

      return res.status(200).json({
        success: true,
        message: `Package ${packageDoc.trackingNumber} scanned out successfully.`,
        data: {
          manifestId: manifest._id,
          manifestCode: manifest.manifestCode,
          packageId: packageDoc._id,
          trackingNumber: packageDoc.trackingNumber,
          entryStatus: "unloaded",
          manifestSnapshot: {
            remaining,
            totalInManifest: manifest.packageCount,
            status: remaining === 0 ? "closed" : "unloading",
            autoClosedAt,
          },
        },
      });

    } catch (err: any) {
      return next(err);
    } finally {
      if (!committed) await session.abortTransaction().catch(() => {});
      await session.endSession();
    }
  },
);



//  POST /loader/manifests/:manifestId/re-manifest
//  A package that arrived at a hub but needs to go to yet another branch
//  is scanned out of the current manifest and into a new outbound manifest.
//  This covers the hub-relay scenario.


export const remanifestPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let committed = false;

    try {
      const loaderUserId = req.user?._id;
      const { manifestId } = req.params;   
      const { trackingNumber, newManifestId, notes } = req.body as {
        trackingNumber: string;
        newManifestId: string;             
        notes?: string;
      };

      if (!mongoose.Types.ObjectId.isValid(manifestId.toString())) {
        return next(new ErrorHandler("Invalid manifestId.", 400));
      }
      if (!trackingNumber?.trim()) {
        return next(new ErrorHandler("trackingNumber is required.", 400));
      }
      if (!newManifestId || !mongoose.Types.ObjectId.isValid(newManifestId)) {
        return next(new ErrorHandler("Valid newManifestId is required.", 400));
      }
      if (manifestId === newManifestId) {
        return next(new ErrorHandler("Source and target manifests cannot be the same.", 400));
      }

      const loader = await resolveLoader(loaderUserId, next, true, session);
      if (!loader) return;

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;
      const now = new Date();

      const [sourceManifest, targetManifest, packageDoc] = await Promise.all([
        ManifestModel.findById(manifestId).session(session),
        ManifestModel.findById(newManifestId).session(session),
        PackageModel.findOne({
          trackingNumber: trackingNumber.trim().toUpperCase(),
        }).session(session),
      ]);

      if (!sourceManifest) throw new ErrorHandler("Source manifest not found.", 404);
      if (!targetManifest) throw new ErrorHandler("Target manifest not found.", 404);
      if (!packageDoc)     throw new ErrorHandler(`Package ${trackingNumber} not found.`, 404);


      if (sourceManifest.destinationBranchId.toString() !== activeBranchId.toString()) {

        throw new ErrorHandler("You are not at the source manifest's destination branch.", 403);
      }

      if (!["arrived", "unloading"].includes(sourceManifest.status)) {

        throw new ErrorHandler(
          `Source manifest must be arrived or unloading. Current: '${sourceManifest.status}'.`,
          400,
        );
      }


      if (targetManifest.status !== "open") {

        throw new ErrorHandler(`Target manifest must be open. Current: '${targetManifest.status}'.`, 400);
      }

      if (targetManifest.originBranchId.toString() !== activeBranchId.toString()) {

        throw new ErrorHandler("Target manifest does not originate from your current branch.", 403);
      }

      const entry = sourceManifest.packages.find(
        (p: IManifestPackageEntry) =>
          p.packageId.toString() === (packageDoc._id as mongoose.Types.ObjectId).toString(),
      );

      if (!entry) {

        throw new ErrorHandler(
          `Package ${trackingNumber} is not in the source manifest.`,
          400,
        );
      }

      if (!["in_manifest", "unloaded"].includes(entry.entryStatus)) {

        throw new ErrorHandler(
          `Package entry status is '${entry.entryStatus}'. Cannot re-manifest.`,
          400,
        );
      }


      await sourceManifest.remanifestPackage(
        packageDoc._id as mongoose.Types.ObjectId,
        targetManifest._id as mongoose.Types.ObjectId,
        loaderUserId as mongoose.Types.ObjectId,
      );


      await targetManifest.addPackage(
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
            currentManifestId: targetManifest._id,
          },
          $push: {
            trackingHistory: {
              status: "manifested",
              branchId: activeBranchId,
              userId: loaderUserId,
              notes: notes?.trim() ||
                `Re-manifested from ${sourceManifest.manifestCode} → ${targetManifest.manifestCode}.`,
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
            manifestId: targetManifest._id,
            notes: notes?.trim() ||
              `Transferred from manifest ${sourceManifest.manifestCode} to ${targetManifest.manifestCode} at hub.`,
            timestamp: now,
          },
        ],
        { session },
      );

      await ManifestEventModel.create(
        [
          {
            manifestId: sourceManifest._id,
            manifestCode: sourceManifest.manifestCode,
            eventType: "package_remanifested",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            packageId: packageDoc._id,
            packageTrackingNumber: packageDoc.trackingNumber,
            metadata: { targetManifestId: targetManifest._id, targetManifestCode: targetManifest.manifestCode },
            notes: `Package moved to manifest ${targetManifest.manifestCode}.`,
            timestamp: now,
          },
          {
            manifestId: targetManifest._id,
            manifestCode: targetManifest.manifestCode,
            eventType: "package_added",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            packageId: packageDoc._id,
            packageTrackingNumber: packageDoc.trackingNumber,
            metadata: { fromManifestId: sourceManifest._id, fromManifestCode: sourceManifest.manifestCode },
            notes: `Package transferred from manifest ${sourceManifest.manifestCode}.`,
            timestamp: now,
          },
        ],
        { session },
      );

      await session.commitTransaction();
      committed = true;

      return res.status(200).json({
        success: true,
        message: `Package ${packageDoc.trackingNumber} moved to manifest ${targetManifest.manifestCode}.`,
        data: {
          packageId: packageDoc._id,
          trackingNumber: packageDoc.trackingNumber,
          fromManifest: {
            id: sourceManifest._id,
            code: sourceManifest.manifestCode,
          },
          toManifest: {
            id: targetManifest._id,
            code: targetManifest.manifestCode,
            packageCount: targetManifest.packages.length,
          },
        },
      });

    } catch (err: any) {
      return next(err);
    } finally {

      if (!committed) await session.abortTransaction().catch(() => {});

      await session.endSession();
    }
  },
);


//  POST /loader/manifests/:manifestId/close
//  If not all packages have been scanned out (some missing/damaged),
//  the supervisor/loader can force-close the manifest.
//  Remaining 'in_manifest' entries are marked 'missing' by the model method.


export const closeManifest = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let committed = false;

    try {
      const loaderUserId = req.user?._id;
      const { manifestId } = req.params;
      const { notes } = req.body as { notes?: string };

      if (!mongoose.Types.ObjectId.isValid(manifestId.toString())) {
        return next(new ErrorHandler("Invalid manifestId.", 400));
      }

      const loader = await resolveLoader(loaderUserId, next, true, session);
      if (!loader) return;

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;
      const now = new Date();

      const manifest = await ManifestModel.findById(manifestId).session(session);

      if (!manifest) throw new ErrorHandler("Manifest not found.", 404);

      if (manifest.destinationBranchId.toString() !== activeBranchId.toString()) {

        throw new ErrorHandler("You are not at this manifest's destination branch.", 403);
      }

      if (!["unloading", "arrived", "discrepancy"].includes(manifest.status)) {

        throw new ErrorHandler(
          `Cannot close a manifest with status '${manifest.status}'.`,
          400,
        );
      }

      const missingEntries = manifest.packages.filter(
        (p: IManifestPackageEntry) => p.entryStatus === "in_manifest",
      );


      await manifest.close(loaderUserId as mongoose.Types.ObjectId);


      if (missingEntries.length > 0) {
        const missingIds = missingEntries.map((p: IManifestPackageEntry) => p.packageId);

        await PackageModel.updateMany(
          { _id: { $in: missingIds } },
          {
            $set: { status: "lost" as PackageStatus, currentManifestId: null },
            $push: {
              trackingHistory: {
                status: "lost",
                branchId: activeBranchId,
                userId: loaderUserId,
                notes: `Package not found when manifest ${manifest.manifestCode} was closed.`,
                timestamp: now,
              },
            },
          },
          { session },
        );

        const lostHistoryDocs = missingIds.map((pkgId: mongoose.Types.ObjectId) => ({
          packageId: pkgId,
          status: "lost" as PackageStatus,
          branchId: activeBranchId,
          handledBy: loaderUserId,
          handlerName: loaderName(req),
          handlerRole: "loader",
          manifestId: manifest._id,
          notes: `Not accounted for on manifest close. Marked lost.`,
          timestamp: now,
        }));

        await PackageHistoryModel.insertMany(lostHistoryDocs, { session });
      }

      await ManifestEventModel.create(
        [
          {
            manifestId: manifest._id,
            manifestCode: manifest.manifestCode,
            eventType: "closed",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            previousStatus: manifest.status,
            newStatus: "closed",
            notes: notes?.trim() ||
              `Manifest closed. ${missingEntries.length} packages marked missing.`,
            timestamp: now,
          },
        ],
        { session },
      );

      await LoaderModel.findByIdAndUpdate(
        loader._id,
        {
          $inc: {
            "stats.totalManifestsUnloaded": 1,
            "currentShift.manifestsUnloadedCount": 1,
          },
          $set: { "stats.lastActiveAt": now },
          $push: {
            recentScans: {
              $each: [
                {
                  action: "close_manifest",
                  scannedId: manifest._id,
                  scannedCode: manifest.manifestCode,
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
        message: `Manifest ${manifest.manifestCode} closed.`,
        data: {
          manifestId: manifest._id,
          manifestCode: manifest.manifestCode,
          status: "closed",
          closedAt: now,
          summary: {
            totalPackages:   manifest.packageCount,
            unloaded:        manifest.packages.filter((p: IManifestPackageEntry) => p.entryStatus === "unloaded").length,
            remanifested:    manifest.packages.filter((p: IManifestPackageEntry) => p.entryStatus === "remanifested").length,
            missingOnClose:  missingEntries.length,
          },
        },
      });

    } catch (err: any) {
      return next(err);
    } finally {

      if (!committed) await session.abortTransaction().catch(() => {});

      await session.endSession();
    }
  },
);


//  POST /loader/manifests/:manifestId/discrepancy
//  Called when the loader finds a count mismatch on arrival that requires
//  supervisor investigation before the manifest can be closed.


export const flagDiscrepancy = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let committed = false;

    try {
      const loaderUserId = req.user?._id;
      const { manifestId } = req.params;
      const { missingTrackingNumbers = [], extraTrackingNumbers = [], notes } = req.body as {
        missingTrackingNumbers?: string[];
        extraTrackingNumbers?: string[];
        notes: string;
      };

      if (!mongoose.Types.ObjectId.isValid(manifestId.toString())) {
        return next(new ErrorHandler("Invalid manifestId.", 400));
      }
      if (!notes?.trim()) {
        return next(new ErrorHandler("Discrepancy notes are required.", 400));
      }

      const loader = await resolveLoader(loaderUserId, next, true, session);
      if (!loader) return;

      const activeBranchId = (loader as any).temporaryBranchId ?? loader.assignedBranchId;
      const now = new Date();

      const manifest = await ManifestModel.findById(manifestId).session(session);

      if (!manifest) throw new ErrorHandler("Manifest not found.", 404);

      if (manifest.destinationBranchId.toString() !== activeBranchId.toString()) {

        throw new ErrorHandler("You are not at this manifest's destination branch.", 403);
      }

      if (!["arrived", "unloading", "closed"].includes(manifest.status)) {

        throw new ErrorHandler(
          `Cannot flag discrepancy on a '${manifest.status}' manifest.`,
          400,
        );
      }


      const [missingPackages, extraPackages] = await Promise.all([
        missingTrackingNumbers.length > 0
          ? PackageModel.find({
              trackingNumber: { $in: missingTrackingNumbers.map((t: string) => t.toUpperCase()) },
            }).select("_id").session(session).lean()
          : Promise.resolve([]),
        extraTrackingNumbers.length > 0
          ? PackageModel.find({
              trackingNumber: { $in: extraTrackingNumbers.map((t: string) => t.toUpperCase()) },
            }).select("_id").session(session).lean()
          : Promise.resolve([]),
      ]);

      const missingIds = missingPackages.map((p: any) => p._id);
      const extraIds   = extraPackages.map((p: any) => p._id);

      await manifest.flagDiscrepancy(
        loaderUserId as mongoose.Types.ObjectId,
        missingIds,
        extraIds,
        notes.trim(),
      );

      await ManifestEventModel.create(
        [
          {
            manifestId: manifest._id,
            manifestCode: manifest.manifestCode,
            eventType: "discrepancy_flagged",
            performedBy: loaderUserId,
            performerName: loaderName(req),
            performerRole: "loader",
            branchId: activeBranchId,
            previousStatus: manifest.status,
            newStatus: "discrepancy",
            metadata: { missingCount: missingIds.length, extraCount: extraIds.length },
            notes: notes.trim(),
            timestamp: now,
          },
        ],
        { session },
      );

      await LoaderModel.findByIdAndUpdate(
        loader._id,
        {
          $inc: { "stats.totalDiscrepanciesFlagged": 1 },
          $set: { "stats.lastActiveAt": now },
          $push: {
            recentScans: {
              $each: [
                {
                  action: "flag_discrepancy",
                  scannedId: manifest._id,
                  scannedCode: manifest.manifestCode,
                  manifestId: manifest._id,
                  manifestCode: manifest.manifestCode,
                  branchId: activeBranchId,
                  timestamp: now,
                  notes: notes.trim(),
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
        message: `Discrepancy flagged on manifest ${manifest.manifestCode}. Supervisor review required.`,
        data: {
          manifestId: manifest._id,
          manifestCode: manifest.manifestCode,
          status: "discrepancy",
          discrepancy: {
            expectedCount: manifest.packageCount,
            missingCount: missingIds.length,
            extraCount: extraIds.length,
            notes: notes.trim(),
            reportedAt: now,
          },
        },
      });

    } catch (err: any) {
      return next(err);
    } finally {

      if (!committed) await session.abortTransaction().catch(() => {});
      
      await session.endSession();
    }
  },
);





export const getMyShift = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const loaderUserId = req.user?._id;
    if (!loaderUserId) return next(new ErrorHandler("Unauthorized.", 401));

    const loader = await LoaderModel.findOne({ userId: loaderUserId, status: "active" })
      .populate("assignedBranchId", "name code address")
      .populate("temporaryBranchId", "name code")
      .lean();

    if (!loader) return next(new ErrorHandler("Active loader profile not found.", 404));

    const shift = loader.currentShift as any;
    const isCheckedIn = !!shift && shift.status === "active";

    const durationMinutes = isCheckedIn
      ? Math.round((Date.now() - new Date(shift.startedAt).getTime()) / 60000)
      : null;

    // Fetch active manifests at this loader's branch
    const activeBranchId = (loader as any).temporaryBranchId?._id ?? (loader as any).assignedBranchId._id;

    const activeManifests = await ManifestModel.find({
      originBranchId: activeBranchId,
      status: { $in: ["open", "sealed", "loaded"] },
    })
      .select("manifestCode status packageCount totalDeclaredWeight priority createdAt")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const arrivingManifests = await ManifestModel.find({
      destinationBranchId: activeBranchId,
      status: { $in: ["in_transit", "arrived", "unloading"] },
    })
      .select("manifestCode status packageCount estimatedArrival arrivedAt")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        isCheckedIn,
        assignedBranch: loader.assignedBranchId,
        temporaryBranch: loader.temporaryBranchId ?? null,
        currentShift: isCheckedIn ? { ...shift, durationMinutes } : null,
        stats: loader.stats,
        recentScans: (loader.recentScans as any[]).slice(0, 20),
        activeManifests,      
        arrivingManifests,   
      },
    });
  },
);



export const getManifestDetail = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const loaderUserId = req.user?._id;
    const { manifestId } = req.params;

    if (!loaderUserId) return next(new ErrorHandler("Unauthorized.", 401));

    if (!mongoose.Types.ObjectId.isValid(manifestId.toString())) {
      return next(new ErrorHandler("Invalid manifestId.", 400));
    }

    const [loader, manifest] = await Promise.all([
      LoaderModel.findOne({ userId: loaderUserId, status: "active" }).lean(),
      ManifestModel.findById(manifestId)
        .populate("originBranchId",      "name code address")
        .populate("destinationBranchId", "name code address")
        .populate("createdBy",           "firstName lastName")
        .populate("sealInfo.sealedBy",   "firstName lastName")
        .populate("transportLeg.transporterId", "firstName lastName phone")
        .lean(),
    ]);

    if (!loader) return next(new ErrorHandler("Active loader profile not found.", 404));
    if (!manifest) return next(new ErrorHandler("Manifest not found.", 404));


    const events = await ManifestEventModel.find({ manifestId: manifest._id })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        ...manifest,
        events,
      },
    });
  },
);



export const getMyStats = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const loaderUserId = req.user?._id;
    if (!loaderUserId) return next(new ErrorHandler("Unauthorized.", 401));

    const loader = await LoaderModel.findOne({ userId: loaderUserId, status: "active" })
      .select("stats recentShifts employeeCode assignedBranchId")
      .populate("assignedBranchId", "name code")
      .lean();

    if (!loader) return next(new ErrorHandler("Active loader profile not found.", 404));

    return res.status(200).json({
      success: true,
      data: {
        employeeCode: loader.employeeCode,
        assignedBranch: loader.assignedBranchId,
        stats: loader.stats,
        recentShifts: (loader.recentShifts as any[]).slice(0, 10),
      },
    });
  },
);
