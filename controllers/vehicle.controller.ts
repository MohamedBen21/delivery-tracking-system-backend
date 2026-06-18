import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import VehicleModel, { VehicleType, VehicleStatus, IVehicleDocuments, AssignedUserRole } from "../models/vehicle.model";
import ManagerModel from "../models/manager.model";
import CompanyModel from "../models/company.model";
import BranchModel from "../models/branch.model";
import userModel from "../models/user.model";
import { notifyAdminsNewEntityPending } from "../services/notification.service";
import DelivererModel from "../models/deliverer.model";
import TransporterModel from "../models/transporter.model";
import SupervisorModel from "../models/supervisor.model";
import LoaderModel from "../models/loader.model";

const VEHICLE_TYPES: VehicleType[] = [
  "motorcycle",
  "car",
  "van",
  "small_truck",
  "large_truck",
];

const VEHICLE_STATUSES: VehicleStatus[] = [
  "available",
  "in_use",
  "maintenance",
  "out_of_service",
  "retired",
];



const REGISTRATION_NUMBER_REGEX = /^[A-Z0-9\s\-]{5,20}$/;


interface ICreateVehicleDocuments {
  registrationCard?: string;
  insurance?: string;
  insuranceExpiry?: string;
  technicalInspection?: string;
  inspectionExpiry?: string;
}

interface ICreateVehicleBody {
  type: VehicleType;
  registrationNumber: string;
  brand?: string;
  modelName?: string;
  year?: number;
  color?: string;
  maxWeight: number;
  maxVolume: number;
  supportsFragile?: boolean;
  currentBranchId?: string;
  documents?: ICreateVehicleDocuments;
  notes?: string;
}

interface IUpdateVehicleBody {

  type?: VehicleType;
  registrationNumber?: string;
  brand?: string;
  modelName?: string;
  year?: number;
  color?: string;
  maxWeight?: number;
  maxVolume?: number;
  supportsFragile?: boolean;
  currentBranchId?: string;
  documents?: ICreateVehicleDocuments;
  status?: VehicleStatus;
  notes?: string;
}

interface IGetCompanyVehiclesQuery {
  type?: VehicleType;
  status?: VehicleStatus;
  branchId?: string;
  search?: string;
  page?: string;
  limit?: string;
  sortBy?: "createdAt" | "maxWeight" | "maxVolume" | "year" | "status";
  sortOrder?: "asc" | "desc";
}



function validateDocuments(
  docs: ICreateVehicleDocuments,
  next: NextFunction,
): boolean {
  const urlFields: (keyof ICreateVehicleDocuments)[] = [
    "registrationCard",
    "insurance",
    "technicalInspection",
  ];

  for (const field of urlFields) {
    const val = docs[field];
    if (val !== undefined) {
      if (typeof val !== "string" || val.trim().length === 0) {
        next(
          new ErrorHandler(
            `documents.${field} must be a non-empty string (URL)`,
            400,
          ),
        );
        return false;
      }
    }
  }

  const dateFields: Array<{
    key: "insuranceExpiry" | "inspectionExpiry";
    label: string;
  }> = [
      { key: "insuranceExpiry", label: "documents.insuranceExpiry" },
      { key: "inspectionExpiry", label: "documents.inspectionExpiry" },
    ];

  for (const { key, label } of dateFields) {
    const val = docs[key];
    if (val !== undefined) {
      if (typeof val !== "string") {
        next(new ErrorHandler(`${label} must be an ISO date string`, 400));
        return false;
      }
      const parsed = new Date(val);
      if (isNaN(parsed.getTime())) {
        next(new ErrorHandler(`${label} is not a valid date`, 400));
        return false;
      }
      if (parsed <= new Date()) {
        next(
          new ErrorHandler(`${label} must be a future date`, 400),
        );
        return false;
      }
    }
  }

  return true;
}





export const createVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const { companyId } = req.params;

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
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
        currentBranchId,
        documents,
        notes,
      } = req.body as ICreateVehicleBody;

      if (!type) {
        return next(new ErrorHandler("Vehicle type is required", 400));
      }

      if (!VEHICLE_TYPES.includes(type)) {
        return next(
          new ErrorHandler(
            `Invalid vehicle type. Must be one of: ${VEHICLE_TYPES.join(", ")}`,
            400,
          ),
        );
      }

      if (!registrationNumber) {
        return next(
          new ErrorHandler("Registration number is required", 400),
        );
      }

      if (typeof registrationNumber !== "string") {
        return next(
          new ErrorHandler("Registration number must be a string", 400),
        );
      }

      const normalizedRegNum = registrationNumber.trim().toUpperCase();

      if (!REGISTRATION_NUMBER_REGEX.test(normalizedRegNum)) {
        return next(
          new ErrorHandler(
            "Registration number must be 5–20 characters and contain only letters, numbers, spaces, or hyphens",
            400,
          ),
        );
      }

      if (maxWeight === undefined || maxWeight === null) {
        return next(new ErrorHandler("maxWeight is required", 400));
      }

      if (typeof maxWeight !== "number" || isNaN(maxWeight)) {
        return next(new ErrorHandler("maxWeight must be a number", 400));
      }

      if (maxWeight < 1 || maxWeight > 50000) {
        return next(
          new ErrorHandler("maxWeight must be between 1 and 50 000 kg", 400),
        );
      }

      if (maxVolume === undefined || maxVolume === null) {
        return next(new ErrorHandler("maxVolume is required", 400));
      }

      if (typeof maxVolume !== "number" || isNaN(maxVolume)) {
        return next(new ErrorHandler("maxVolume must be a number", 400));
      }

      if (maxVolume < 0.1 || maxVolume > 100) {
        return next(
          new ErrorHandler(
            "maxVolume must be between 0.1 and 100 cubic meters",
            400,
          ),
        );
      }

      if (brand !== undefined) {
        if (typeof brand !== "string" || brand.trim().length === 0) {
          return next(
            new ErrorHandler("brand must be a non-empty string", 400),
          );
        }
        if (brand.trim().length > 50) {
          return next(
            new ErrorHandler("brand cannot exceed 50 characters", 400),
          );
        }
      }

      if (modelName !== undefined) {
        if (typeof modelName !== "string" || modelName.trim().length === 0) {
          return next(
            new ErrorHandler("modelName must be a non-empty string", 400),
          );
        }
        if (modelName.trim().length > 50) {
          return next(
            new ErrorHandler("modelName cannot exceed 50 characters", 400),
          );
        }
      }

      if (year !== undefined) {
        if (!Number.isInteger(year)) {
          return next(new ErrorHandler("year must be an integer", 400));
        }
        const maxYear = new Date().getFullYear() + 1;
        if (year < 1900 || year > maxYear) {
          return next(
            new ErrorHandler(
              `year must be between 1900 and ${maxYear}`,
              400,
            ),
          );
        }
      }

      if (color !== undefined && typeof color !== "string") {
        return next(new ErrorHandler("color must be a string", 400));
      }

      if (supportsFragile !== undefined && typeof supportsFragile !== "boolean") {
        return next(
          new ErrorHandler("supportsFragile must be a boolean", 400),
        );
      }

      if (currentBranchId !== undefined) {
        if (!mongoose.Types.ObjectId.isValid(currentBranchId)) {
          return next(new ErrorHandler("Invalid currentBranchId", 400));
        }
      }

      if (notes !== undefined) {
        if (typeof notes !== "string") {
          return next(new ErrorHandler("notes must be a string", 400));
        }
        if (notes.trim().length > 500) {
          return next(
            new ErrorHandler("notes cannot exceed 500 characters", 400),
          );
        }
      }

      if (documents !== undefined) {
        if (typeof documents !== "object" || Array.isArray(documents)) {
          return next(
            new ErrorHandler("documents must be an object", 400),
          );
        }
        const docsValid = validateDocuments(documents, next);
        if (!docsValid) {
          return;
        }
      }

      const [company, manager, supervisor, requestingUser, existingVehicle] =
        await Promise.all([
          CompanyModel.findById(companyId).session(session).lean(),
          ManagerModel.findOne({ userId: userId, companyId }).session(
            session,
          ),
          SupervisorModel.findOne({ userId: userId, companyId }).session(
            session,
          ),
          userModel.findById(userId).select("role").session(session).lean(),
          VehicleModel.findOne({ registrationNumber: normalizedRegNum })
            .session(session)
            .lean(),
        ]);

      if (!company) {
        throw new ErrorHandler("Company not found", 404);
      }

      if (company.status !== "active") {
        throw new ErrorHandler("Cannot add vehicles to an inactive company", 400);
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedManager =
        manager &&
        manager.isActive &&
        manager.hasPermission("can_manage_vehicles");
      const isAuthorizedSupervisor =
        supervisor &&
        supervisor.isActive &&
        supervisor.hasPermission("can_manage_vehicles");

      if (!isAdmin && !isAuthorizedManager && !isAuthorizedSupervisor) {
        throw new ErrorHandler(
          "Not authorized to manage vehicles for this company",
          403,
        );
      }

      if (existingVehicle) {
        throw new ErrorHandler(
          "A vehicle with this registration number already exists",
          400,
        );
      }

      let docsPayload: Partial<IVehicleDocuments> | undefined;
      if (documents) {
        docsPayload = {
          ...(documents.registrationCard && {
            registrationCard: documents.registrationCard,
          }),
          ...(documents.insurance && { insurance: documents.insurance }),
          ...(documents.insuranceExpiry && {
            insuranceExpiry: new Date(documents.insuranceExpiry),
          }),
          ...(documents.technicalInspection && {
            technicalInspection: documents.technicalInspection,
          }),
          ...(documents.inspectionExpiry && {
            inspectionExpiry: new Date(documents.inspectionExpiry),
          }),
        };
      }

      const [vehicle] = await VehicleModel.create(
        [
          {
            companyId,
            type,
            registrationNumber: normalizedRegNum,
            ...(brand && { brand: brand.trim() }),
            ...(modelName && { modelName: modelName.trim() }),
            ...(year !== undefined && { year }),
            ...(color && { color: color.trim() }),
            maxWeight,
            maxVolume,
            supportsFragile: supportsFragile ?? true,
            ...(currentBranchId && { currentBranchId }),
            ...(docsPayload && { documents: docsPayload }),
            ...(notes && { notes: notes.trim() }),
            status: "available",
          },
        ],
        { session },
      );

      await session.commitTransaction();
      transactionCommitted = true;


      notifyAdminsNewEntityPending(
        vehicle._id.toString(),
        "Vehicle",
        `New Vehicle: ${normalizedRegNum} (${type}) - ${brand || 'Unknown'} ${modelName || ''}`
      ).catch(error => {

        console.error('Admin notification for new vehicle failed:', error);

      });

      const [populatedVehicle] = await VehicleModel.aggregate([
        { $match: { _id: vehicle._id } },
        {
          $lookup: {
            from: "companies",
            localField: "companyId",
            foreignField: "_id",
            as: "company",
            pipeline: [{ $project: { name: 1, businessType: 1, status: 1 } }],
          },
        },
        { $unwind: { path: "$company", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "branches",
            localField: "currentBranchId",
            foreignField: "_id",
            as: "currentBranch",
            pipeline: [{ $project: { name: 1, code: 1, status: 1 } }],
          },
        },
        {
          $unwind: {
            path: "$currentBranch",
            preserveNullAndEmptyArrays: true,
          },
        },
      ]);

      return res.status(201).json({
        success: true,
        message: "Vehicle created successfully",
        data: populatedVehicle,
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }
      return next(error);
    } finally {
      if (!transactionCommitted && session.inTransaction()) {
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  },
);







export const updateVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const managerId = req.user?._id;
      const { companyId, vehicleId } = req.params;


      if (!managerId) {
        return next(
          new ErrorHandler("Unauthorized, you are not authenticated.", 401),
        );
      }


      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!vehicleId || !mongoose.Types.ObjectId.isValid(vehicleId.toString())) {
        return next(new ErrorHandler("Invalid vehicle ID", 400));
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
        currentBranchId,
        documents,
        status,
        notes,
      } = req.body as IUpdateVehicleBody;


      if (
        (req.body as any).assignedUserId !== undefined ||
        (req.body as any).assignedUserRole !== undefined
      ) {
        return next(
          new ErrorHandler(
            "Use the dedicated assign/release endpoint to manage vehicle assignment",
            400,
          ),
        );
      }

      if (type !== undefined && !VEHICLE_TYPES.includes(type)) {
        return next(
          new ErrorHandler(
            `Invalid vehicle type. Must be one of: ${VEHICLE_TYPES.join(", ")}`,
            400,
          ),
        );
      }

      let normalizedRegNum: string | undefined;
      if (registrationNumber !== undefined) {
        if (typeof registrationNumber !== "string") {
          return next(
            new ErrorHandler("Registration number must be a string", 400),
          );
        }
        normalizedRegNum = registrationNumber.trim().toUpperCase();
        if (!REGISTRATION_NUMBER_REGEX.test(normalizedRegNum)) {
          return next(
            new ErrorHandler(
              "Registration number must be 5–20 characters and contain only letters, numbers, spaces, or hyphens",
              400,
            ),
          );
        }
      }

      if (maxWeight !== undefined) {
        if (typeof maxWeight !== "number" || isNaN(maxWeight)) {
          return next(new ErrorHandler("maxWeight must be a number", 400));
        }
        if (maxWeight < 1 || maxWeight > 50000) {
          return next(
            new ErrorHandler("maxWeight must be between 1 and 50 000 kg", 400),
          );
        }
      }

      if (maxVolume !== undefined) {
        if (typeof maxVolume !== "number" || isNaN(maxVolume)) {
          return next(new ErrorHandler("maxVolume must be a number", 400));
        }
        if (maxVolume < 0.1 || maxVolume > 100) {
          return next(
            new ErrorHandler(
              "maxVolume must be between 0.1 and 100 cubic meters",
              400,
            ),
          );
        }
      }

      if (brand !== undefined) {
        if (typeof brand !== "string" || brand.trim().length === 0) {
          return next(
            new ErrorHandler("brand must be a non-empty string", 400),
          );
        }
        if (brand.trim().length > 50) {
          return next(
            new ErrorHandler("brand cannot exceed 50 characters", 400),
          );
        }
      }

      if (modelName !== undefined) {
        if (typeof modelName !== "string" || modelName.trim().length === 0) {
          return next(
            new ErrorHandler("modelName must be a non-empty string", 400),
          );
        }
        if (modelName.trim().length > 50) {
          return next(
            new ErrorHandler("modelName cannot exceed 50 characters", 400),
          );
        }
      }

      if (year !== undefined) {
        if (!Number.isInteger(year)) {
          return next(new ErrorHandler("year must be an integer", 400));
        }
        const maxYear = new Date().getFullYear() + 1;
        if (year < 1900 || year > maxYear) {
          return next(
            new ErrorHandler(`year must be between 1900 and ${maxYear}`, 400),
          );
        }
      }

      if (color !== undefined && typeof color !== "string") {
        return next(new ErrorHandler("color must be a string", 400));
      }

      if (supportsFragile !== undefined && typeof supportsFragile !== "boolean") {
        return next(
          new ErrorHandler("supportsFragile must be a boolean", 400),
        );
      }

      if (currentBranchId !== undefined) {
        if (!mongoose.Types.ObjectId.isValid(currentBranchId)) {
          return next(new ErrorHandler("Invalid currentBranchId", 400));
        }
      }

      if (status !== undefined) {
        if (status === "in_use") {
          return next(
            new ErrorHandler(
              "Cannot manually set status to 'in_use'. Use the assign endpoint instead.",
              400,
            ),
          );
        }
        if (!VEHICLE_STATUSES.includes(status)) {
          return next(
            new ErrorHandler(
              `Invalid status. Must be one of: ${VEHICLE_STATUSES.filter((s) => s !== "in_use").join(", ")}`,
              400,
            ),
          );
        }
      }

      if (notes !== undefined) {
        if (typeof notes !== "string") {
          return next(new ErrorHandler("notes must be a string", 400));
        }
        if (notes.trim().length > 500) {
          return next(
            new ErrorHandler("notes cannot exceed 500 characters", 400),
          );
        }
      }

      if (documents !== undefined) {
        if (typeof documents !== "object" || Array.isArray(documents)) {
          return next(new ErrorHandler("documents must be an object", 400));
        }
        const docsValid = validateDocuments(documents, next);
        if (!docsValid) {
          return;
        }
      }


      const [vehicle, manager, requestingUser] = await Promise.all([
        VehicleModel.findOne({ _id: vehicleId, companyId }).session(session),
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
        userModel.findById(managerId).select("role").session(session).lean(),
      ]);

      if (!vehicle) {
        throw new ErrorHandler(
          "Vehicle not found or does not belong to this company",
          404,
        );
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedManager =
        manager &&
        manager.isActive &&
        manager.hasPermission("can_manage_vehicles");

      if (!isAdmin && !isAuthorizedManager) {
        throw new ErrorHandler(
          "Not authorized to manage vehicles for this company",
          403,
        );
      }


      if (vehicle.status === "in_use" && status) {
        throw new ErrorHandler(
          "Cannot change status of a vehicle currently in use. Release the vehicle first.",
          400,
        );
      }


      if (
        normalizedRegNum &&
        normalizedRegNum !== vehicle.registrationNumber
      ) {
        const duplicate = await VehicleModel.findOne({
          registrationNumber: normalizedRegNum,
          _id: { $ne: vehicleId },
        })
          .session(session)
          .lean();

        if (duplicate) {
          throw new ErrorHandler(
            "A vehicle with this registration number already exists",
            400,
          );
        }
      }


      const updatePayload: Record<string, any> = {};

      if (type !== undefined) updatePayload.type = type;
      if (normalizedRegNum !== undefined)
        updatePayload.registrationNumber = normalizedRegNum;
      if (brand !== undefined) updatePayload.brand = brand.trim();
      if (modelName !== undefined) updatePayload.modelName = modelName.trim();
      if (year !== undefined) updatePayload.year = year;
      if (color !== undefined) updatePayload.color = color.trim();
      if (maxWeight !== undefined) updatePayload.maxWeight = maxWeight;
      if (maxVolume !== undefined) updatePayload.maxVolume = maxVolume;
      if (supportsFragile !== undefined)
        updatePayload.supportsFragile = supportsFragile;
      if (currentBranchId !== undefined)
        updatePayload.currentBranchId = currentBranchId;
      if (status !== undefined) updatePayload.status = status;
      if (notes !== undefined) updatePayload.notes = notes.trim();


      if (documents) {
        if (documents.registrationCard !== undefined)
          updatePayload["documents.registrationCard"] =
            documents.registrationCard;
        if (documents.insurance !== undefined)
          updatePayload["documents.insurance"] = documents.insurance;
        if (documents.insuranceExpiry !== undefined)
          updatePayload["documents.insuranceExpiry"] = new Date(
            documents.insuranceExpiry,
          );
        if (documents.technicalInspection !== undefined)
          updatePayload["documents.technicalInspection"] =
            documents.technicalInspection;
        if (documents.inspectionExpiry !== undefined)
          updatePayload["documents.inspectionExpiry"] = new Date(
            documents.inspectionExpiry,
          );
      }

      const updatedVehicle = await VehicleModel.findByIdAndUpdate(
        vehicleId,
        { $set: updatePayload },
        { new: true, runValidators: true, session },
      );

      await session.commitTransaction();
      transactionCommitted = true;

      const [populatedVehicle] = await VehicleModel.aggregate([
        { $match: { _id: updatedVehicle!._id } },
        {
          $lookup: {
            from: "companies",
            localField: "companyId",
            foreignField: "_id",
            as: "company",
            pipeline: [{ $project: { name: 1, businessType: 1, status: 1 } }],
          },
        },
        { $unwind: { path: "$company", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "branches",
            localField: "currentBranchId",
            foreignField: "_id",
            as: "currentBranch",
            pipeline: [{ $project: { name: 1, code: 1, status: 1 } }],
          },
        },
        {
          $unwind: {
            path: "$currentBranch",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "assignedUserId",
            foreignField: "_id",
            as: "assignedUser",
            pipeline: [
              {
                $project: { firstName: 1, lastName: 1, email: 1, phone: 1 },
              },
            ],
          },
        },
        {
          $unwind: {
            path: "$assignedUser",
            preserveNullAndEmptyArrays: true,
          },
        },
      ]);

      return res.status(200).json({
        success: true,
        message: "Vehicle updated successfully",
        data: populatedVehicle,
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }
      return next(error);
    } finally {
      if (!transactionCommitted && session.inTransaction()) {
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  },
);




export const toggleVehicleStatus = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
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
        VehicleModel.findOne({ _id: vehicleId, companyId }).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
        userModel.findById(userId).select("role").session(session),
      ]);

      if (!vehicle) {
        throw new ErrorHandler("Vehicle not found", 404);
      }

      if (vehicle.status === "in_use") {
        throw new ErrorHandler("Cannot toggle status of a vehicle that is currently in use", 400);
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedManager = manager && manager.isActive;

      if (!isAdmin && !isAuthorizedManager) {
        throw new ErrorHandler("Not authorized to change this vehicle's status", 403);
      }

      const newStatus: VehicleStatus =
        vehicle.status === "available" ? "out_of_service" : "available";

      vehicle.status = newStatus;
      await vehicle.save({ session });

      await session.commitTransaction();
      transactionCommitted = true;

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
      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }
      return next(error);
    } finally {
      if (!transactionCommitted && session.inTransaction()) {
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  }
);



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


    const vehicle = await VehicleModel.findOne({ _id: vehicleId, companyId })
      .populate("companyId", "name businessType status")
      .populate("currentBranchId", "name code address status")
      .populate("assignedUserId", "firstName lastName email phone role")
      .lean();

    if (!vehicle) {
      return next(new ErrorHandler("Vehicle not found", 404));
    }


    const requestingUser = await userModel.findById(userId).select("role").lean();

    if (!requestingUser) {
      return next(new ErrorHandler("User not found", 404));
    }

    let isAuthorized = false;

    if (requestingUser.role === "admin") {

      isAuthorized = true;
    } else if (requestingUser.role === "manager") {

      const manager = await ManagerModel.findOne({ userId, companyId }).lean();
      isAuthorized = !!(manager && manager.isActive);
    } else if (requestingUser.role === "transporter") {

      const transporter = await TransporterModel.findOne({ userId }).lean();
      isAuthorized = !!(
        transporter &&
        vehicle.assignedUserId &&
        (vehicle.assignedUserId as any)._id?.toString() === transporter.userId.toString()
      );
    } else if (requestingUser.role === "deliverer") {

      const deliverer = await DelivererModel.findOne({ userId }).lean();
      isAuthorized = !!(
        deliverer &&
        vehicle.assignedUserId &&
        (vehicle.assignedUserId as any)._id?.toString() === deliverer.userId.toString()
      );
    } else if (requestingUser.role === "supervisor") {

      const supervisor = await SupervisorModel.findOne({ userId }).lean();
      isAuthorized = !!(supervisor && supervisor.isActive && supervisor.companyId.toString() === companyId.toString());
    }

    console.log("Authorization check for user", userId.toString(), "with role", requestingUser.role, "isAuthorized:", isAuthorized);

    if (!isAuthorized) {
      return next(new ErrorHandler("Not authorized to view this vehicle", 403));
    }

    return res.status(200).json({
      success: true,
      vehicle,
    });
  }
);





export const getCompanyVehicles = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    console.log("Received request to get company vehicles with query:", req.query);
    try {

      const { companyId } = req.params;
      const userId = req.user?._id;

      console.log("Company ID:", companyId);


      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        return next(new ErrorHandler("Invalid company ID", 400));
      }


      const {
        type,
        status,
        branchId,
        search,
        page = "1",
        limit = "20",
        sortBy = "createdAt",
        sortOrder = "desc",
      } = req.query as IGetCompanyVehiclesQuery;

      if (type && !VEHICLE_TYPES.includes(type as VehicleType)) {
        return next(
          new ErrorHandler(
            `Invalid type filter. Must be one of: ${VEHICLE_TYPES.join(", ")}`,
            400,
          ),
        );
      }

      if (status && !VEHICLE_STATUSES.includes(status as VehicleStatus)) {
        return next(
          new ErrorHandler(
            `Invalid status filter. Must be one of: ${VEHICLE_STATUSES.join(", ")}`,
            400,
          ),
        );
      }

      if (branchId && !mongoose.Types.ObjectId.isValid(branchId)) {
        return next(new ErrorHandler("Invalid branchId filter", 400));
      }

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      if (isNaN(pageNum) || pageNum < 1) {
        return next(new ErrorHandler("page must be a positive integer", 400));
      }
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        return next(
          new ErrorHandler("limit must be between 1 and 100", 400),
        );
      }

      const ALLOWED_SORT_FIELDS = [
        "createdAt",
        "maxWeight",
        "maxVolume",
        "year",
        "status",
      ];
      if (!ALLOWED_SORT_FIELDS.includes(sortBy)) {
        return next(
          new ErrorHandler(
            `sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(", ")}`,
            400,
          ),
        );
      }
      if (!["asc", "desc"].includes(sortOrder)) {
        return next(
          new ErrorHandler("sortOrder must be 'asc' or 'desc'", 400),
        );
      }


      const [company, manager, requestingUser, supervisor, loader] = await Promise.all([
        CompanyModel.findById(companyId).lean(),
        ManagerModel.findOne({ userId: userId, companyId }).lean(),
        userModel.findById(userId).select("role").lean(),
        SupervisorModel.findOne({ userId: userId, companyId }).lean(),
        LoaderModel.findOne({ userId: userId, companyId }).lean(),
      ]);

      if (!company) {
        return next(new ErrorHandler("Company not found", 404));
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedManager = manager && manager.isActive;
      const isAuthorizedSupervisor = supervisor && supervisor.isActive;
      const isAuthorizedLoader = loader;
      if (!isAdmin && !isAuthorizedManager && !isAuthorizedSupervisor && !isAuthorizedLoader) {
        return next(
          new ErrorHandler(
            "Not authorized to view vehicles for this company",
            403,
          ),
        );
      }


      const matchStage: Record<string, any> = {
        companyId: new mongoose.Types.ObjectId(companyId.toString()),
      };

      if (type) matchStage.type = type;
      if (status) matchStage.status = status;


      if (branchId) {
        if (!isAdmin && manager && !manager.branchAccess.allBranches) {
          const allowedIds = manager.branchAccess.specificBranches.map((id) =>
            id.toString(),
          );
          if (!allowedIds.includes(branchId)) {
            return next(
              new ErrorHandler(
                "You do not have access to this branch",
                403,
              ),
            );
          }
        }
        matchStage.currentBranchId = new mongoose.Types.ObjectId(branchId);
      } else if (!isAdmin && manager && !manager.branchAccess.allBranches) {
        matchStage.currentBranchId = {
          $in: manager.branchAccess.specificBranches,
        };
      }


      if (search && typeof search === "string" && search.trim().length > 0) {
        const searchRegex = { $regex: search.trim(), $options: "i" };
        matchStage.$or = [
          { registrationNumber: searchRegex },
          { brand: searchRegex },
          { modelName: searchRegex },
        ];
      }

      const sortDirection = sortOrder === "asc" ? 1 : -1;
      const skip = (pageNum - 1) * limitNum;

      const pipeline: mongoose.PipelineStage[] = [
        { $match: matchStage },

        {
          $lookup: {
            from: "companies",
            localField: "companyId",
            foreignField: "_id",
            as: "company",
            pipeline: [{ $project: { name: 1, businessType: 1 } }],
          },
        },
        { $unwind: { path: "$company", preserveNullAndEmptyArrays: true } },

        {
          $lookup: {
            from: "branches",
            localField: "currentBranchId",
            foreignField: "_id",
            as: "currentBranch",
            pipeline: [{ $project: { name: 1, code: 1, status: 1 } }],
          },
        },
        { $unwind: { path: "$currentBranch", preserveNullAndEmptyArrays: true } },

        {
          $lookup: {
            from: "users",
            localField: "assignedUserId",
            foreignField: "_id",
            as: "assignedUser",
            pipeline: [
              {
                $project: { firstName: 1, lastName: 1, email: 1, phone: 1 },
              },
            ],
          },
        },
        { $unwind: { path: "$assignedUser", preserveNullAndEmptyArrays: true } },

        {
          $addFields: {
            isAssigned: {
              $and: [
                { $ifNull: ["$assignedUserId", false] },
                { $ifNull: ["$currentBranchId", false] },
              ],
            },
            isHeavy: {
              $in: ["$type", ["large_truck", "small_truck"]],
            },
            isLight: {
              $in: ["$type", ["motorcycle", "car"]],
            },
            category: {
              $switch: {
                branches: [
                  {
                    case: { $in: ["$type", ["motorcycle", "car"]] },
                    then: "Light",
                  },
                  { case: { $eq: ["$type", "van"] }, then: "Medium" },
                  {
                    case: {
                      $in: ["$type", ["small_truck", "large_truck"]],
                    },
                    then: "Heavy",
                  },
                ],
                default: "Unknown",
              },
            },
          },
        },

        { $sort: { [sortBy]: sortDirection } },

        {
          $facet: {
            data: [{ $skip: skip }, { $limit: limitNum }],
            totalCount: [{ $count: "count" }],

            statusSummary: [
              { $group: { _id: "$status", count: { $sum: 1 } } },
            ],
            typeSummary: [
              { $group: { _id: "$type", count: { $sum: 1 } } },
            ],
          },
        },
      ];

      const [result] = await VehicleModel.aggregate(pipeline);

      const total: number = result.totalCount[0]?.count ?? 0;
      const totalPages = Math.ceil(total / limitNum);


      const statusSummary = Object.fromEntries(
        (result.statusSummary as { _id: string; count: number }[]).map(
          ({ _id, count }) => [_id, count],
        ),
      );

      const typeSummary = Object.fromEntries(
        (result.typeSummary as { _id: string; count: number }[]).map(
          ({ _id, count }) => [_id, count],
        ),
      );

      return res.status(200).json({
        success: true,
        data: result.data,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages,
          hasNextPage: pageNum < totalPages,
          hasPrevPage: pageNum > 1,
        },
        summary: {
          byStatus: statusSummary,
          byType: typeSummary,
        },
      });

    } catch (error: any) {

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

      return next(error);

    }
  },
);





export const assignVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const { companyId, vehicleId } = req.params;
      const { assignedUserId, assignedUserRole, branchId } = req.body;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!vehicleId || !mongoose.Types.ObjectId.isValid(vehicleId.toString())) {
        return next(new ErrorHandler("Invalid vehicle ID", 400));
      }

      if (!assignedUserId || !mongoose.Types.ObjectId.isValid(assignedUserId)) {
        return next(new ErrorHandler("Invalid assigned user ID", 400));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const validRoles = ["transporter", "deliverer"];
      if (assignedUserRole && !validRoles.includes(assignedUserRole)) {
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
        throw new ErrorHandler("Vehicle not found", 404);
      }

      if (!manager || !manager.isActive) {
        throw new ErrorHandler("You are not an active manager of this company", 403);
      }

      if (!assignedUser) {
        throw new ErrorHandler("Assigned user not found", 404);
      }

      if (!branch) {
        throw new ErrorHandler("Branch not found or does not belong to this company", 404);
      }

      if (assignedUser.status !== "active") {
        throw new ErrorHandler(`Cannot assign vehicle to user with status: ${assignedUser.status}`, 400);
      }

      if (vehicle.status !== "available") {
        throw new ErrorHandler(`Vehicle cannot be assigned. Current status: ${vehicle.status}`, 400);
      }


      vehicle.assignedUserId = assignedUserId;
      vehicle.assignedUserRole = assignedUserRole || assignedUser.role;
      vehicle.currentBranchId = branchId;
      vehicle.status = "in_use";

      await vehicle.save({ session });


      const userRole = assignedUserRole || assignedUser.role;

      if (userRole === "deliverer") {
        const deliverer = await DelivererModel.findOne({ userId: assignedUserId }).session(session);

        if (!deliverer) {
          throw new ErrorHandler("Deliverer profile not found for this user", 404);
        }


        // if (deliverer.currentVehicleId) {
        //   throw new ErrorHandler(`Deliverer already has an assigned vehicle: ${deliverer.currentVehicleId}`, 400);
        // }

        deliverer.currentVehicleId = vehicle._id;
        deliverer.lastActiveAt = new Date();


        // if (deliverer.availabilityStatus === "available") {
        //   deliverer.availabilityStatus = "on_route";
        // }

        await deliverer.save({ session });

      } else if (userRole === "transporter") {
        const transporter = await TransporterModel.findOne({ userId: assignedUserId }).session(session);

        if (!transporter) {
          throw new ErrorHandler("Transporter profile not found for this user", 404);
        }


        // if (transporter.currentVehicleId) {
        //   throw new ErrorHandler(`Transporter already has an assigned vehicle: ${transporter.currentVehicleId}`, 400);
        // }

        transporter.currentVehicleId = vehicle._id;
        transporter.lastActiveAt = new Date();


        // if (transporter.availabilityStatus === "available") {
        //   transporter.availabilityStatus = "on_route";
        // }

        await transporter.save({ session });

      } else {
        throw new ErrorHandler(`Cannot assign vehicle to user role: ${userRole}. Only deliverers and transporters can be assigned vehicles.`, 400);
      }

      await session.commitTransaction();
      transactionCommitted = true;


      const updatedVehicle = await VehicleModel.findById(vehicleId)
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .populate("assignedUserId", "firstName lastName email phone role")
        .lean();


      let assignedProfile = null;
      if (userRole === "deliverer") {
        assignedProfile = await DelivererModel.findOne({ userId: assignedUserId })
          .select("userId currentVehicleId availabilityStatus lastActiveAt")
          .lean();
      } else if (userRole === "transporter") {
        assignedProfile = await TransporterModel.findOne({ userId: assignedUserId })
          .select("userId currentVehicleId availabilityStatus lastActiveAt")
          .lean();
      }

      return res.status(200).json({
        success: true,
        message: "Vehicle assigned successfully",
        data: {
          vehicle: updatedVehicle,
          assignedUser: {
            userId: assignedUserId,
            role: userRole,
            profile: assignedProfile,
          },
        },
      });

    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }
      return next(error);
    } finally {
      if (!transactionCommitted && session.inTransaction()) {
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  }
);



export const releaseVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
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

      const [vehicle, manager] = await Promise.all([
        VehicleModel.findOne({ _id: vehicleId, companyId }).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
      ]);

      if (!vehicle) {
        throw new ErrorHandler("Vehicle not found", 404);
      }

      if (!manager || !manager.isActive) {
        throw new ErrorHandler("You are not an active manager of this company", 403);
      }

      if (vehicle.status !== "in_use") {
        throw new ErrorHandler("Vehicle is not currently in use", 400);
      }


      if (vehicle.assignedUserId) {
        const assignedRole = vehicle.assignedUserRole;

        if (assignedRole === "deliverer") {
          const updated = await DelivererModel.findOneAndUpdate(
            { userId: vehicle.assignedUserId },
            {
              $unset: { currentVehicleId: "" },
              $set: {
                availabilityStatus: "available",
                lastActiveAt: new Date(),
              },
            },
            { new: true, session },
          );

        } else if (assignedRole === "transporter") {
          const updated = await TransporterModel.findOneAndUpdate(
            { userId: vehicle.assignedUserId },
            {
              $unset: { currentVehicleId: "" },
              $set: {
                availabilityStatus: "available",
                lastActiveAt: new Date(),
              },
            },
            { new: true, session },
          );
          // console.log("Transporter after release:", updated?.currentVehicleId);
        }
      }


      vehicle.assignedUserId = undefined;
      vehicle.assignedUserRole = undefined;
      vehicle.status = "available";
      await vehicle.save({ session });

      await session.commitTransaction();
      transactionCommitted = true;

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
      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }
      return next(error);
    } finally {
      if (!transactionCommitted && session.inTransaction()) {
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  }
);




// export const getVehicleById = catchAsyncError(
//   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
//     try {

//       const userId = req.user?._id;

//       if(!userId){
//         return next(new ErrorHandler("Authentication required.", 401));
//       }

//       const user = await userModel.findById(userId);

//       if(!user || (user.role != "admin" && user.role != "supervisor" && user.role != "manager")){

//         return next(new ErrorHandler("Access denied. only admins and supervisors or a manager.", 403));

//       }


//       const { id } = req.params;

//       if (!id || !mongoose.Types.ObjectId.isValid(id.toString())) {
//         return next(new ErrorHandler("Invalid vehicle ID.", 400));
//       }

//       const vehicle = await VehicleModel.findById(id)
//         .populate("companyId", "name")
//         .populate("currentBranchId", "name code address")
//         .populate("assignedUserId", "name email phone")
//         .lean({ virtuals: true });

//       if (!vehicle) {
//         return next(new ErrorHandler("Vehicle not found.", 404));
//       }

//       res.status(200).json({
//         success: true,
//         vehicle
//       });

//     } catch (error: any) {
//       return next(
//         new ErrorHandler(error.message || "Error fetching vehicle.", 500),
//       );
//     }
//   },
// );
