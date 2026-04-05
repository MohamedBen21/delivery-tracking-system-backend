import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import VehicleModel, { VehicleType, VehicleStatus } from "../models/vehicle.model";
import ManagerModel from "../models/manager.model";
import CompanyModel from "../models/company.model";
import BranchModel from "../models/branch.model";
import userModel from "../models/user.model";

// ─────────────────────────────────────────────
//  INTERFACES
// ─────────────────────────────────────────────

interface IVehicleDocumentsBody {
  registrationCard?: string;
  insurance?: string;
  insuranceExpiry?: Date;
  technicalInspection?: string;
  inspectionExpiry?: Date;
}

interface ICreateVehicle {
  type: VehicleType;
  registrationNumber: string;
  brand?: string;
  modelName?: string;
  year?: number;
  color?: string;
  maxWeight: number;
  maxVolume: number;
  supportsFragile?: boolean;
  documents?: IVehicleDocumentsBody;
  currentBranchId?: string;
  notes?: string;
}

interface IUpdateVehicle {
  type?: VehicleType;
  registrationNumber?: string;
  brand?: string;
  modelName?: string;
  year?: number;
  color?: string;
  maxWeight?: number;
  maxVolume?: number;
  supportsFragile?: boolean;
  documents?: IVehicleDocumentsBody;
  currentBranchId?: string;
  status?: VehicleStatus;
  notes?: string;
}

// ─────────────────────────────────────────────
//  CREATE VEHICLE
// ─────────────────────────────────────────────

export const createVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;
      const { companyId } = req.params;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const {
        type,
        registrationNumber,
        brand,
        modelName,
        year,
        color,
        maxWeight,
        maxVolume,
        supportsFragile,
        documents,
        currentBranchId,
        notes,
      } = req.body as ICreateVehicle;

      // Required fields validation
      if (!type || !registrationNumber || maxWeight === undefined || maxVolume === undefined) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("type, registrationNumber, maxWeight, and maxVolume are required", 400)
        );
      }

      const validTypes: VehicleType[] = ["motorcycle", "car", "van", "small_truck", "large_truck"];
      if (!validTypes.includes(type)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(`type must be one of: ${validTypes.join(", ")}`, 400)
        );
      }

      if (typeof maxWeight !== "number" || maxWeight < 1) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("maxWeight must be a positive number (min 1)", 400));
      }

      if (typeof maxVolume !== "number" || maxVolume < 0.1) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("maxVolume must be a positive number (min 0.1)", 400));
      }

      if (currentBranchId && !mongoose.Types.ObjectId.isValid(currentBranchId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      // Auth: manager must be active and have permission
      const [company, manager] = await Promise.all([
        CompanyModel.findById(companyId).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
      ]);

      if (!company) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Company not found", 404));
      }

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      if (!manager.hasPermission("can_manage_vehicles" as any)) {
        // Fallback: also allow if manager has general settings permission
        if (!manager.hasPermission("can_manage_settings")) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("You don't have permission to manage vehicles", 403));
        }
      }

      if (company.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot add vehicles to an inactive company", 400));
      }

      // Check registration number uniqueness
      const existingVehicle = await VehicleModel.findOne({
        registrationNumber: registrationNumber.toUpperCase(),
      }).session(session);

      if (existingVehicle) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("A vehicle with this registration number already exists", 400));
      }

      // Validate branch belongs to company
      if (currentBranchId) {
        const branch = await BranchModel.findOne({
          _id: currentBranchId,
          companyId,
        }).session(session);

        if (!branch) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Branch not found or does not belong to this company", 404));
        }
      }

      const vehicle = await VehicleModel.create(
        [
          {
            companyId,
            type,
            registrationNumber,
            ...(brand && { brand }),
            ...(modelName && { modelName }),
            ...(year && { year }),
            ...(color && { color }),
            maxWeight,
            maxVolume,
            supportsFragile: supportsFragile ?? true,
            ...(documents && { documents }),
            ...(currentBranchId && {
              currentBranchId: new mongoose.Types.ObjectId(currentBranchId),
            }),
            ...(notes && { notes }),
            status: "available",
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populatedVehicle = await VehicleModel.findById(vehicle[0]._id)
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Vehicle created successfully",
        data: populatedVehicle,
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();

      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((err: any) => err.message)
              .join(", "),
            400
          )
        );
      }

      if (error.code === 11000) {
        return next(new ErrorHandler("A vehicle with this registration number already exists", 400));
      }

      return next(new ErrorHandler(error.message || "Error creating vehicle", 500));
    }
  }
);

// ─────────────────────────────────────────────
//  UPDATE VEHICLE
// ─────────────────────────────────────────────

export const updateVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;
      const { companyId, vehicleId } = req.params;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!vehicleId || !mongoose.Types.ObjectId.isValid(vehicleId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid vehicle ID", 400));
      }

      const body = req.body as IUpdateVehicle;

      if (Object.keys(body).length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("No update data provided", 400));
      }

      const validStatuses: VehicleStatus[] = [
        "available", "in_use", "maintenance", "out_of_service", "retired",
      ];
      if (body.status && !validStatuses.includes(body.status)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(`status must be one of: ${validStatuses.join(", ")}`, 400)
        );
      }

      if (body.currentBranchId !== undefined && body.currentBranchId !== null) {
        if (!mongoose.Types.ObjectId.isValid(body.currentBranchId)) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Invalid branch ID", 400));
        }
      }

      const [vehicle, manager] = await Promise.all([
        VehicleModel.findOne({ _id: vehicleId, companyId }).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
      ]);

      if (!vehicle) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Vehicle not found", 404));
      }

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      // Check registration uniqueness if changing
      if (body.registrationNumber && body.registrationNumber.toUpperCase() !== vehicle.registrationNumber) {
        const exists = await VehicleModel.findOne({
          registrationNumber: body.registrationNumber.toUpperCase(),
          _id: { $ne: vehicleId },
        }).session(session);

        if (exists) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("A vehicle with this registration number already exists", 400));
        }
      }

      // Validate branch if being changed
      if (body.currentBranchId) {
        const branch = await BranchModel.findOne({
          _id: body.currentBranchId,
          companyId,
        }).session(session);

        if (!branch) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("Branch not found or does not belong to this company", 404)
          );
        }
      }

      const updateData: any = { ...body };
      if (body.registrationNumber) {
        updateData.registrationNumber = body.registrationNumber.toUpperCase();
      }
      if (body.currentBranchId) {
        updateData.currentBranchId = new mongoose.Types.ObjectId(body.currentBranchId);
      }

      Object.assign(vehicle, updateData);
      await vehicle.save({ session });

      await session.commitTransaction();
      session.endSession();

      const updatedVehicle = await VehicleModel.findById(vehicleId)
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .populate("assignedUserId", "firstName lastName email phone role")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Vehicle updated successfully",
        data: updatedVehicle,
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();

      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((err: any) => err.message)
              .join(", "),
            400
          )
        );
      }

      return next(new ErrorHandler(error.message || "Error updating vehicle", 500));
    }
  }
);

// ─────────────────────────────────────────────
//  TOGGLE VEHICLE STATUS (available ↔ out_of_service)
// ─────────────────────────────────────────────

export const toggleVehicleStatus = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;
      const { companyId, vehicleId } = req.params;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!vehicleId || !mongoose.Types.ObjectId.isValid(vehicleId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid vehicle ID", 400));
      }

      const [vehicle, manager, requestingUser] = await Promise.all([
        VehicleModel.findOne({ _id: vehicleId, companyId }).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
        userModel.findById(userId).select("role").session(session),
      ]);

      if (!vehicle) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Vehicle not found", 404));
      }

      if (vehicle.status === "in_use") {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Cannot toggle status of a vehicle that is currently in use", 400)
        );
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedManager = manager && manager.isActive;

      if (!isAdmin && !isAuthorizedManager) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Not authorized to change this vehicle's status", 403));
      }

      const newStatus: VehicleStatus =
        vehicle.status === "available" ? "out_of_service" : "available";

      vehicle.status = newStatus;
      await vehicle.save({ session });

      await session.commitTransaction();
      session.endSession();

      const updatedVehicle = await VehicleModel.findById(vehicleId)
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: `Vehicle ${newStatus === "available" ? "activated" : "deactivated"} successfully`,
        data: {
          vehicle: updatedVehicle,
          newStatus,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error toggling vehicle status", 500));
    }
  }
);

// ─────────────────────────────────────────────
//  GET VEHICLE BY ID
// ─────────────────────────────────────────────

export const getVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const { companyId, vehicleId } = req.params;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      return next(new ErrorHandler("Invalid company ID", 400));
    }

    if (!vehicleId || !mongoose.Types.ObjectId.isValid(vehicleId.toString())) {
      return next(new ErrorHandler("Invalid vehicle ID", 400));
    }

    const [vehicle, manager, requestingUser] = await Promise.all([
      VehicleModel.findOne({ _id: vehicleId, companyId })
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .populate("assignedUserId", "firstName lastName email phone role")
        .lean(),
      ManagerModel.findOne({ userId, companyId }).lean(),
      userModel.findById(userId).select("role").lean(),
    ]);

    const isAdmin = requestingUser?.role === "admin";
    const isAuthorizedManager = manager && manager.isActive;

    if (!isAdmin && !isAuthorizedManager) {
      return next(new ErrorHandler("Not authorized to view this vehicle", 403));
    }

    if (!vehicle) {
      return next(new ErrorHandler("Vehicle not found", 404));
    }

    return res.status(200).json({
      success: true,
      data: vehicle,
    });
  }
);

// ─────────────────────────────────────────────
//  GET ALL VEHICLES OF COMPANY
// ─────────────────────────────────────────────

export const getMyVehicles = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const { companyId } = req.params;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      return next(new ErrorHandler("Invalid company ID", 400));
    }

    const [company, manager] = await Promise.all([
      CompanyModel.findById(companyId).lean(),
      ManagerModel.findOne({ userId, companyId }).lean(),
    ]);

    if (!company) {
      return next(new ErrorHandler("Company not found", 404));
    }

    if (!manager || !manager.isActive) {
      return next(new ErrorHandler("You are not an active manager of this company", 403));
    }

    const vehicleQuery: mongoose.FilterQuery<typeof VehicleModel> = { companyId };

    const { status, type, currentBranchId, isAvailable, search } = req.query;

    if (status && typeof status === "string") {
      vehicleQuery.status = status;
    }

    if (type && typeof type === "string") {
      vehicleQuery.type = type;
    }

    if (currentBranchId && typeof currentBranchId === "string") {
      if (mongoose.Types.ObjectId.isValid(currentBranchId)) {
        vehicleQuery.currentBranchId = new mongoose.Types.ObjectId(currentBranchId);
      }
    }

    // isAvailable is a virtual — filter by status instead
    if (isAvailable !== undefined) {
      if (isAvailable === "true") {
        vehicleQuery.status = "available";
      } else if (isAvailable === "false") {
        vehicleQuery.status = { $ne: "available" };
      }
    }

    if (search && typeof search === "string") {
      vehicleQuery.$or = [
        { registrationNumber: { $regex: search, $options: "i" } },
        { brand: { $regex: search, $options: "i" } },
        { modelName: { $regex: search, $options: "i" } },
      ];
    }

    const vehicles = await VehicleModel.find(vehicleQuery)
      .populate("currentBranchId", "name code address status")
      .populate("assignedUserId", "firstName lastName email phone role")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: vehicles.length,
      data: vehicles,
    });
  }
);

// ─────────────────────────────────────────────
//  ASSIGN VEHICLE TO USER
// ─────────────────────────────────────────────

export const assignVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;
      const { companyId, vehicleId } = req.params;
      const { assignedUserId, assignedUserRole, branchId } = req.body;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!vehicleId || !mongoose.Types.ObjectId.isValid(vehicleId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid vehicle ID", 400));
      }

      if (!assignedUserId || !mongoose.Types.ObjectId.isValid(assignedUserId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid assigned user ID", 400));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const validRoles = ["transporter", "deliverer", "driver"];
      if (assignedUserRole && !validRoles.includes(assignedUserRole)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(`assignedUserRole must be one of: ${validRoles.join(", ")}`, 400)
        );
      }

      const [vehicle, manager, assignedUser, branch] = await Promise.all([
        VehicleModel.findOne({ _id: vehicleId, companyId }).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
        userModel.findById(assignedUserId).select("role status").session(session),
        BranchModel.findOne({ _id: branchId, companyId }).session(session),
      ]);

      if (!vehicle) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Vehicle not found", 404));
      }

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      if (!assignedUser) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Assigned user not found", 404));
      }

      if (!branch) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Branch not found or does not belong to this company", 404));
      }

      if (vehicle.status !== "available") {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(`Vehicle cannot be assigned. Current status: ${vehicle.status}`, 400)
        );
      }

      vehicle.assignedUserId = new mongoose.Types.ObjectId(assignedUserId);
      vehicle.assignedUserRole = assignedUserRole || assignedUser.role;
      vehicle.currentBranchId = new mongoose.Types.ObjectId(branchId);
      vehicle.status = "in_use";

      await vehicle.save({ session });

      await session.commitTransaction();
      session.endSession();

      const updatedVehicle = await VehicleModel.findById(vehicleId)
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .populate("assignedUserId", "firstName lastName email phone role")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Vehicle assigned successfully",
        data: updatedVehicle,
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error assigning vehicle", 500));
    }
  }
);

// ─────────────────────────────────────────────
//  RELEASE VEHICLE (unassign)
// ─────────────────────────────────────────────

export const releaseVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;
      const { companyId, vehicleId } = req.params;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!vehicleId || !mongoose.Types.ObjectId.isValid(vehicleId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid vehicle ID", 400));
      }

      const [vehicle, manager] = await Promise.all([
        VehicleModel.findOne({ _id: vehicleId, companyId }).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
      ]);

      if (!vehicle) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Vehicle not found", 404));
      }

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      if (vehicle.status !== "in_use") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Vehicle is not currently in use", 400));
      }

      vehicle.assignedUserId = undefined;
      vehicle.assignedUserRole = undefined;
      vehicle.status = "available";
      await vehicle.save({ session });

      await session.commitTransaction();
      session.endSession();

      const updatedVehicle = await VehicleModel.findById(vehicleId)
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Vehicle released successfully",
        data: updatedVehicle,
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error releasing vehicle", 500));
    }
  }
);
