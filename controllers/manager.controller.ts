import { Request, Response, NextFunction } from "express";
import CompanyModel, { ICompany } from "../models/company.model";
import ManagerModel from "../models/manager.model";
import userModel from "../models/user.model";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import BranchModel, { WeekDay } from "../models/branch.model";
import SupervisorModel, {
  SupervisorPermission,
} from "../models/supervisor.model";
import VehicleModel, { AssignedUserRole, IVehicleDocuments, VehicleStatus, VehicleType } from "../models/vehicle.model";

type CompanyBusinessType = "solo" | "company";

interface IHeadquarters {
  address: string;
  city: string;
  postalCode?: string;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
}

interface ICreateCompany {
  name: string;
  businessType: CompanyBusinessType;

  registrationNumber?: string;

  email?: string;
  phone?: string;

  logo?: {
    public_id: string;
    url: string;
  };

  headquarters?: IHeadquarters;
}

export const createCompany = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized - User not authenticated", 401),
        );
      }

      const {
        name,
        businessType,
        registrationNumber,
        email,
        phone,
        logo,
        headquarters,
      } = req.body as ICreateCompany;

      if (!name || !businessType) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Name and business type are required", 400),
        );
      }

      const companyType = ["solo", "company"];

      if (
        !businessType ||
        typeof name !== "string" ||
        companyType.includes(businessType)
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Name and business type does not meet the requirements",
            400,
          ),
        );
      }

      if (registrationNumber && typeof registrationNumber !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Registration number must be a string", 400),
        );
      }

      if (businessType === "company" && !registrationNumber) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Registration number is required for company business type",
            400,
          ),
        );
      }

      if (email && typeof email !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("email must be a string", 400));
      }

      if (phone && typeof phone !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("phone number must be a string", 400));
      }

      if (headquarters) {
        const hq = headquarters;

        if (typeof hq.address !== "string" || typeof hq.city !== "string") {
          return next(
            new ErrorHandler("Invalid headquarters address data", 400),
          );
        }

        if (
          !hq.location ||
          hq.location.type !== "Point" ||
          !Array.isArray(hq.location.coordinates) ||
          hq.location.coordinates.length !== 2
        ) {
          return next(
            new ErrorHandler("Invalid headquarters location format", 400),
          );
        }
      }

      const existingCompany = await CompanyModel.findOne({ name }).session(
        session,
      );

      if (existingCompany) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Company with this name already exists.", 400),
        );
      }

      let companyWithSameRegistration = null;

      if (businessType === "company" && registrationNumber) {
        companyWithSameRegistration = await CompanyModel.findOne({
          registrationNumber,
        }).session(session);

        if (companyWithSameRegistration) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler(
              "Company with this registration number already exists.",
              400,
            ),
          );
        }
      }

      const [user, manager] = await Promise.all([
        userModel.findById(userId).session(session),
        ManagerModel.findOne({ userId }).session(session),
      ]);

      if (!user) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User Not found", 400));
      }

      if (companyWithSameRegistration) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Company with this registration number already exists.",
            400,
          ),
        );
      }

      const company = await CompanyModel.create(
        [
          {
            name,
            businessType,
            userId,
            registrationNumber,
            email,
            phone,
            logo,
            headquarters,
            status: "active",
          },
        ],
        { session },
      );

      await session.commitTransaction();
      session.endSession();

      const populatedCompany = await CompanyModel.findById(company[0]._id)
        .populate("userId", "firstName lastName email phone username")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Company created successfully",
        data: {
          company: populatedCompany,
          user,
          manager,
        },
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
            400,
          ),
        );
      }

      return next(
        new ErrorHandler(error.message || "Error creating company", 500),
      );
    }
  },
);

interface IUpdateCompany {
  name?: string;
  businessType?: CompanyBusinessType;
  registrationNumber?: string;
  email?: string;
  phone?: string;
  logo?: {
    public_id: string;
    url: string;
  };
  headquarters?: IHeadquarters;
  status?: "active" | "inactive" | "suspended";
}

//update company
export const updateCompany = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;
      const { companyId } = req.params;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized, you are not authenticated", 401),
        );
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const body = req.body as IUpdateCompany;

      if (Object.keys(body).length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("No update data provided", 400));
      }

      if (body.name && typeof body.name !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Company name must be a string", 400));
      }

      if (
        body.businessType &&
        !["solo", "company"].includes(body.businessType)
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid business type", 400));
      }

      if (
        body.registrationNumber &&
        typeof body.registrationNumber !== "string"
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Registration number must be a string", 400),
        );
      }

      if (body.email && typeof body.email !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Email must be a string", 400));
      }

      if (body.phone && typeof body.phone !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Phone must be a string", 400));
      }

      if (body.headquarters) {
        const hq = body.headquarters;

        if (typeof hq.address !== "string" || typeof hq.city !== "string") {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("Invalid headquarters address data", 400),
          );
        }

        if (
          !hq.location ||
          hq.location.type !== "Point" ||
          !Array.isArray(hq.location.coordinates) ||
          hq.location.coordinates.length !== 2
        ) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("Invalid headquarters location format", 400),
          );
        }
      }

      const [company, user, manager] = await Promise.all([
        CompanyModel.findById(companyId).session(session),
        userModel.findById(userId).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
      ]);

      if (!company) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Company not found", 404));
      }

      if (!user) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User not found", 404));
      }

      if (!manager) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "You are not authorized to update this company",
            403,
          ),
        );
      }

      if (!manager.hasPermission("can_manage_settings")) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "You don't have permission to update company settings",
            403,
          ),
        );
      }

      const finalBusinessType = body.businessType ?? company.businessType;
      const finalRegistration =
        body.registrationNumber ?? company.registrationNumber;

      if (finalBusinessType === "company" && !finalRegistration) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Registration number is required for company business type",
            400,
          ),
        );
      }

      if (body.name) {
        const nameExists = await CompanyModel.findOne({
          name: body.name,
          _id: { $ne: companyId },
        }).session(session);

        if (nameExists) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Company name already exists", 400));
        }
      }

      if (finalBusinessType === "company" && body.registrationNumber) {
        const regExists = await CompanyModel.findOne({
          registrationNumber: body.registrationNumber,
          _id: { $ne: companyId },
        }).session(session);

        if (regExists) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler(
              "Company with this registration number already exists",
              400,
            ),
          );
        }
      }

      Object.assign(company, body);
      await company.save({ session });

      await session.commitTransaction();
      session.endSession();

      const populatedCompany = await CompanyModel.findById(companyId)
        .populate("userId", "firstName lastName email phone username")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Company updated successfully",
        data: populatedCompany,
        user,
        manager,
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
            400,
          ),
        );
      }

      return next(
        new ErrorHandler(error.message || "Error updating company", 500),
      );
    }
  },
);

type CompanyStatus = "active" | "suspended";

//toggle between suspend and activate company
export const toggleBlockCompany = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;
      const { companyId } = req.params;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized, you are not authenticated.", 401),
        );
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const [company, manager, user] = await Promise.all([
        CompanyModel.findById(companyId).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
        userModel.findById(userId).select("role").session(session),
      ]);

      if (!company) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Company not found", 404));
      }

      const isAdmin = user?.role === "admin";
      const isAuthorizedManager =
        manager && manager.hasPermission("can_manage_settings");

      if (!isAdmin && !isAuthorizedManager) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Not authorized to change company status", 403),
        );
      }

      if (!["active", "suspended"].includes(company.status)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(`Invalid company status: ${company.status}`, 400),
        );
      }

      const newStatus: CompanyStatus =
        company.status === "active" ? "suspended" : "active";

      company.status = newStatus;
      await company.save({ session });

      await session.commitTransaction();
      session.endSession();

      const updatedCompany = await CompanyModel.findById(companyId)
        .populate("userId", "firstName lastName email phone username")
        .lean();

      return res.status(200).json({
        success: true,
        message: `Company ${newStatus === "active" ? "activated" : "suspended"} successfully`,
        data: {
          company: updatedCompany,
          newStatus,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(
        new ErrorHandler(error.message || "Error toggling company status", 500),
      );
    }
  },
);

//get company
export const getCompany = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;
      const { companyId } = req.params;

      if (!userId) {
        return next(
          new ErrorHandler("Unauthorized, user not authenticated.", 401),
        );
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const [company, manager, user] = await Promise.all([
        CompanyModel.findById(companyId)
          .populate("userId", "firstName lastName email phone username")
          .lean(),
        ManagerModel.findOne({ userId, companyId }).lean(),
        userModel.findById(userId).select("role").lean(),
      ]);

      if (!company) {
        return next(new ErrorHandler("Company not found", 404));
      }

      const isAdmin = user?.role === "admin";
      const isManager = !!manager;

      if (!isAdmin && !isManager) {
        return next(
          new ErrorHandler("Not authorized to view this company", 403),
        );
      }

      return res.status(200).json({
        success: true,
        data: {
          company,
          userRole: isAdmin ? "admin" : "manager",
          managerPermissions: manager?.permissions || [],
        },
      });
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Error getting company.", 500),
      );
    }
  },
);

export const getMyCompany = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;

    if (!userId) {
      return next(
        new ErrorHandler("Unauthorized, you are not authenticated.", 401),
      );
    }

    const manager = await ManagerModel.findOne({ userId })
      .populate({
        path: "userId",
        select: "firstName lastName email phone username",
      })
      .populate("companyId")
      .lean();

    if (!manager) {
      return next(
        new ErrorHandler("You are not a manager of any company", 404),
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        company: manager.companyId,
        managerProfile: {
          accessLevel: manager.accessLevel,
          permissions: manager.permissions,
          branchAccess: manager.branchAccess,
          isActive: manager.isActive,
        },
        user: manager.userId,
      },
    });
  },
);

// ─────────────────────────────────────────────
//  BRANCH FUNCTIONS
// ─────────────────────────────────────────────

interface IBranchLocation {
  type: "Point";
  coordinates: [number, number]; // [longitude, latitude]
}

interface IBranchAddressBody {
  street: string;
  city: string;
  state: string;
  postalCode?: string;
}

interface IOperatingHoursBody {
  open: string;
  close: string;
}

interface ICreateBranch {
  name: string;
  code: string;
  address: IBranchAddressBody;
  location: IBranchLocation;
  phone: string;
  email: string;
  operatingHours?: Record<string, IOperatingHoursBody>;
  capacityLimit?: number;
}

interface IUpdateBranch {
  name?: string;
  address?: Partial<IBranchAddressBody>;
  location?: IBranchLocation;
  phone?: string;
  email?: string;
  operatingHours?: Record<string, IOperatingHoursBody>;
  capacityLimit?: number;
}

type BranchStatus = "active" | "inactive" | "maintenance" | "pending";

export const createBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;
      const { companyId } = req.params;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized, you are not authenticated.", 401),
        );
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const {
        name,
        code,
        address,
        location,
        phone,
        email,
        operatingHours,
        capacityLimit,
      } = req.body as ICreateBranch;

      if (!name || !code || !address || !location || !phone || !email) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "name, code, address, location, phone and email are required",
            400,
          ),
        );
      }

      if (typeof name !== "string" || typeof code !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("name and code must be strings", 400));
      }

      if (
        !address.street ||
        typeof address.street !== "string" ||
        !address.city ||
        typeof address.city !== "string" ||
        !address.state ||
        typeof address.state !== "string"
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("address must include street, city and state", 400),
        );
      }

      if (
        !location ||
        location.type !== "Point" ||
        !Array.isArray(location.coordinates) ||
        location.coordinates.length !== 2 ||
        typeof location.coordinates[0] !== "number" ||
        typeof location.coordinates[1] !== "number"
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Invalid location format. Expected GeoJSON Point with [lng, lat]",
            400,
          ),
        );
      }

      if (
        capacityLimit !== undefined &&
        (typeof capacityLimit !== "number" || capacityLimit < 1)
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("capacityLimit must be a positive number", 400),
        );
      }

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
        return next(
          new ErrorHandler(
            "You are not an active manager of this company",
            403,
          ),
        );
      }

      if (!manager.hasPermission("can_manage_branches")) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("You don't have permission to manage branches", 403),
        );
      }

      if (company.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Cannot create branch for an inactive or suspended company",
            400,
          ),
        );
      }

      const existingBranch = await BranchModel.findOne({
        code: code.toUpperCase(),
      }).session(session);

      if (existingBranch) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("A branch with this code already exists", 400),
        );
      }

      const branch = await BranchModel.create(
        [
          {
            companyId,
            name,
            code,
            address,
            location,
            phone,
            email,
            ...(operatingHours && { operatingHours }),
            ...(capacityLimit !== undefined && { capacityLimit }),
            status: "active",
          },
        ],
        { session },
      );

      await session.commitTransaction();
      session.endSession();

      const populatedBranch = await BranchModel.findById(branch[0]._id)
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Branch created successfully",
        data: populatedBranch,
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
            400,
          ),
        );
      }

      return next(
        new ErrorHandler(error.message || "Error creating branch", 500),
      );
    }
  },
);

//  UPDATE BRANCH

export const updateBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;
      const { companyId, branchId } = req.params;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized, you are not authenticated.", 401),
        );
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const body = req.body as IUpdateBranch;

      if (Object.keys(body).length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("No update data provided", 400));
      }

      if (body.name !== undefined && typeof body.name !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("name must be a string", 400));
      }

      if (body.address) {
        const { street, city, state } = body.address;
        if (
          (street !== undefined && typeof street !== "string") ||
          (city !== undefined && typeof city !== "string") ||
          (state !== undefined && typeof state !== "string")
        ) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("address fields must be strings", 400));
        }
      }

      if (body.location) {
        if (
          body.location.type !== "Point" ||
          !Array.isArray(body.location.coordinates) ||
          body.location.coordinates.length !== 2 ||
          typeof body.location.coordinates[0] !== "number" ||
          typeof body.location.coordinates[1] !== "number"
        ) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler(
              "Invalid location format. Expected GeoJSON Point with [lng, lat]",
              400,
            ),
          );
        }
      }

      if (
        body.capacityLimit !== undefined &&
        (typeof body.capacityLimit !== "number" || body.capacityLimit < 1)
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("capacityLimit must be a positive number", 400),
        );
      }

      const [branch, company, manager] = await Promise.all([
        BranchModel.findOne({ _id: branchId, companyId }).session(session),
        CompanyModel.findById(companyId).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
      ]);

      if (!branch) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Branch not found", 404));
      }

      if (!company) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Company not found", 404));
      }

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "You are not an active manager of this company",
            403,
          ),
        );
      }

      if (!manager.hasPermission("can_manage_branches")) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("You don't have permission to manage branches", 403),
        );
      }

      if (
        !manager.canAccessBranch(
          new mongoose.Types.ObjectId(branchId.toString()),
        )
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("You don't have access to this branch", 403),
        );
      }

      if (
        body.capacityLimit !== undefined &&
        body.capacityLimit < branch.currentLoad
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Capacity limit cannot be less than current load (${branch.currentLoad})`,
            400,
          ),
        );
      }

      Object.assign(branch, body);
      await branch.save({ session });

      await session.commitTransaction();
      session.endSession();

      const populatedBranch = await BranchModel.findById(branchId)
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Branch updated successfully",
        data: populatedBranch,
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
            400,
          ),
        );
      }

      return next(
        new ErrorHandler(error.message || "Error updating branch", 500),
      );
    }
  },
);

//  TOGGLE BLOCK / ACTIVATE BRANCH

export const toggleBlockBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userId = req.user?._id;
      const { companyId, branchId } = req.params;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized, you are not authenticated.", 401),
        );
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const [branch, manager, user] = await Promise.all([
        BranchModel.findOne({ _id: branchId, companyId }).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
        userModel.findById(userId).select("role").session(session),
      ]);

      if (!branch) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Branch not found", 404));
      }

      const isAdmin = user?.role === "admin";
      const isAuthorizedManager =
        manager &&
        manager.isActive &&
        manager.hasPermission("can_manage_branches") &&
        manager.canAccessBranch(
          new mongoose.Types.ObjectId(branchId.toString()),
        );

      if (!isAdmin && !isAuthorizedManager) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Not authorized to change this branch status", 403),
        );
      }

      if (!["active", "inactive"].includes(branch.status)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Cannot toggle a branch with status "${branch.status}". Only active/inactive branches can be toggled`,
            400,
          ),
        );
      }

      const newStatus: BranchStatus =
        branch.status === "active" ? "inactive" : "active";

      branch.status = newStatus;
      await branch.save({ session });

      await session.commitTransaction();
      session.endSession();

      const updatedBranch = await BranchModel.findById(branchId)
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(200).json({
        success: true,
        message: `Branch ${newStatus === "active" ? "activated" : "deactivated"} successfully`,
        data: {
          branch: updatedBranch,
          newStatus,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(
        new ErrorHandler(error.message || "Error toggling branch status", 500),
      );
    }
  },
);

//  GET BRANCH BY ID

export const getBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const { companyId, branchId } = req.params;

    if (!userId) {
      return next(
        new ErrorHandler("Unauthorized, you are not authenticated.", 401),
      );
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      return next(new ErrorHandler("Invalid company ID", 400));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const [branch, manager, user] = await Promise.all([
      BranchModel.findOne({ _id: branchId, companyId })
        .populate("companyId", "name businessType status")
        .lean(),
      ManagerModel.findOne({ userId, companyId }).lean(),
      userModel.findById(userId).select("role").lean(),
    ]);

    if (!branch) {
      return next(new ErrorHandler("Branch not found", 404));
    }

    const isAdmin = user?.role === "admin";
    const isAuthorizedManager =
      manager &&
      manager.isActive &&
      manager.canAccessBranch(new mongoose.Types.ObjectId(branchId.toString()));

    if (!isAdmin && !isAuthorizedManager) {
      return next(new ErrorHandler("Not authorized to view this branch", 403));
    }

    return res.status(200).json({
      success: true,
      data: branch,
    });
  },
);

//  GET ALL BRANCHES OF MANAGER'S COMPANY

export const getMyBranches = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const { companyId } = req.params;

    if (!userId) {
      return next(
        new ErrorHandler("Unauthorized, you are not authenticated.", 401),
      );
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
      return next(
        new ErrorHandler("You are not an active manager of this company", 403),
      );
    }

    const branchQuery: mongoose.FilterQuery<typeof BranchModel> = { companyId };

    if (!manager.branchAccess.allBranches) {
      branchQuery._id = { $in: manager.branchAccess.specificBranches };
    }

    const { status, city, search } = req.query;

    if (status && typeof status === "string") {
      branchQuery.status = status;
    }

    if (city && typeof city === "string") {
      branchQuery["address.city"] = { $regex: city, $options: "i" };
    }

    if (search && typeof search === "string") {
      branchQuery.$or = [
        { name: { $regex: search, $options: "i" } },
        { code: { $regex: search, $options: "i" } },
      ];
    }

    const branches = await BranchModel.find(branchQuery)
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: branches.length,
      data: branches,
    });
  },
);

//supervisor functions and interfaces

interface IWorkScheduleDayBody {
  start: string;
  end: string;
  dayOff: boolean;
}

interface ICreateSupervisor {
  branchId: string;

  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;

  permissions?: SupervisorPermission[];
  workSchedule?: Partial<Record<WeekDay, IWorkScheduleDayBody>>;
}

interface IUpdateSupervisor {
  permissions?: SupervisorPermission[];
  workSchedule?: Partial<Record<WeekDay, IWorkScheduleDayBody>>;
  isActive?: boolean;

  userData?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    imageUrl?: string;
  };
}

//  CREATE SUPERVISOR
export const createSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const managerId = req.user?._id;
      const { companyId } = req.params;

      if (!managerId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized, user not authenticated.", 401),
        );
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const {
        branchId,
        firstName,
        lastName,
        email,
        phone,
        password,
        permissions,
        workSchedule,
      } = req.body as ICreateSupervisor;

      if (
        !branchId ||
        !firstName ||
        !lastName ||
        !email ||
        !phone ||
        !password
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("All required fields must be provided", 400),
        );
      }

      if (
        typeof branchId !== "string" ||
        typeof firstName !== "string" ||
        typeof lastName !== "string" ||
        typeof email !== "string" ||
        typeof phone !== "string" ||
        typeof password !== "string"
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "All required fields must be in their proper types.",
            400,
          ),
        );
      }

      if (!mongoose.Types.ObjectId.isValid(branchId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (permissions !== undefined) {
        if (!Array.isArray(permissions)) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Permissions must be an array", 400));
        }

        if (new Set(permissions).size !== permissions.length) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("Duplicate permissions are not allowed", 400),
          );
        }
      }

      // ===== Fetch required data =====
      const [manager, branch, existingUser] = await Promise.all([
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
        BranchModel.findOne({ _id: branchId, companyId }).session(session),
        userModel.findOne({ email }).session(session),
      ]);

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active manager", 403));
      }

      if (!manager.hasPermission("can_manage_supervisors")) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("No permission to manage supervisors", 403),
        );
      }

      if (!branch || branch.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid or inactive branch", 400));
      }

      if (existingUser) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("User with this email already exists", 400),
        );
      }

      const user = await userModel.create(
        [
          {
            firstName,
            lastName,
            email,
            phone,
            password, 
            role: "supervisor",
          },
        ],
        { session },
      );

      const supervisor = await SupervisorModel.create(
        [
          {
            userId: user[0]._id,
            companyId,
            branchId,
            permissions: permissions || [],
            ...(workSchedule && { workSchedule }),
            isActive: true,
          },
        ],
        { session },
      );

      await session.commitTransaction();
      session.endSession();

      const populatedSupervisor = await SupervisorModel.findById(
        supervisor[0]._id,
      )
        .populate("userId", "firstName lastName email phone username imageUrl")
        .populate("branchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Supervisor created successfully",
        data: populatedSupervisor,
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
            400,
          ),
        );
      }

      return next(
        new ErrorHandler(error.message || "Error creating supervisor", 500),
      );
    }
  },
);

//  UPDATE SUPERVISOR
export const updateSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const managerId = req.user?._id;
      const { supervisorId } = req.params;

      if (!managerId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized, user is not authenticated", 401),
        );
      }

      if (
        !supervisorId ||
        !mongoose.Types.ObjectId.isValid(supervisorId.toString())
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid supervisor ID", 400));
      }

      const { permissions, workSchedule, isActive, userData } =
        req.body as IUpdateSupervisor;

      if (
        permissions === undefined &&
        workSchedule === undefined &&
        isActive === undefined &&
        userData === undefined
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("No update data provided", 400));
      }

      const supervisor =
        await SupervisorModel.findById(supervisorId).session(session);

      if (!supervisor) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Supervisor not found", 404));
      }

      const manager = await ManagerModel.findOne({
        userId: managerId,
        companyId: supervisor.companyId,
      }).session(session);

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("You are not authorized to update supervisors", 403),
        );
      }

      if (!manager.hasPermission("can_manage_supervisors")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Permission denied", 403));
      }

      if (permissions !== undefined) {
        if (!Array.isArray(permissions)) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("permissions must be an array", 400));
        }

        if (new Set(permissions).size !== permissions.length) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("Duplicate permissions are not allowed", 400),
          );
        }

        supervisor.permissions = permissions;
      }

      if (workSchedule !== undefined) {
        supervisor.workSchedule = {
          ...supervisor.workSchedule,
          ...workSchedule,
        };
      }

      if (typeof isActive === "boolean") {
        supervisor.isActive = isActive;
      }

      await supervisor.save({ session });

      if (userData) {
        const user = await userModel
          .findById(supervisor.userId)
          .session(session);

        if (!user) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Linked user not found", 404));
        }

        if (userData.firstName !== undefined) {
          if (typeof userData.firstName !== "string") {
            await session.abortTransaction();
            session.endSession();
            return next(new ErrorHandler("firstName must be string", 400));
          }
          user.firstName = userData.firstName;
        }

        if (userData.lastName !== undefined) {
          if (typeof userData.lastName !== "string") {
            await session.abortTransaction();
            session.endSession();
            return next(new ErrorHandler("lastName must be string", 400));
          }
          user.lastName = userData.lastName;
        }

        if (userData.phone !== undefined) {
          if (typeof userData.phone !== "string") {
            await session.abortTransaction();
            session.endSession();
            return next(new ErrorHandler("phone must be string", 400));
          }
          user.phone = userData.phone;
        }

        if (userData.imageUrl !== undefined) {
          if (typeof userData.imageUrl !== "string") {
            await session.abortTransaction();
            session.endSession();
            return next(new ErrorHandler("imageUrl must be string", 400));
          }
          user.imageUrl = userData.imageUrl;
        }

        await user.save({ session });
      }

      await session.commitTransaction();
      session.endSession();

      const updatedSupervisor = await SupervisorModel.findById(supervisorId)
        .populate("userId", "firstName lastName email phone username imageUrl")
        .populate("branchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Supervisor updated successfully",
        data: updatedSupervisor,
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
            400,
          ),
        );
      }

      return next(
        new ErrorHandler(error.message || "Error updating supervisor", 500),
      );
    }
  },
);

//  TOGGLE BLOCK / ACTIVATE SUPERVISOR
export const toggleBlockSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const managerId = req.user?._id;
      const { companyId, supervisorId } = req.params;

      if (!managerId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized, you are not authenticated.", 401),
        );
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (
        !supervisorId ||
        !mongoose.Types.ObjectId.isValid(supervisorId.toString())
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid supervisor ID", 400));
      }

      const [supervisor, manager, requestingUser] = await Promise.all([
        SupervisorModel.findOne({ _id: supervisorId, companyId }).session(
          session,
        ),
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
        userModel.findById(managerId).select("role").session(session),
      ]);

      if (!supervisor) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Supervisor not found", 404));
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedManager =
        manager &&
        manager.isActive &&
        manager.hasPermission("can_manage_supervisors") &&
        manager.canAccessBranch(supervisor.branchId);

      if (!isAdmin && !isAuthorizedManager) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Not authorized to change this supervisor's status",
            403,
          ),
        );
      }

      const newIsActive = !supervisor.isActive;

      await Promise.all([
        supervisor.set({ isActive: newIsActive }).save({ session }),
        userModel.findByIdAndUpdate(
          supervisor.userId,
          { status: newIsActive ? "active" : "suspended" },
          { session },
        ),
      ]);

      await session.commitTransaction();
      session.endSession();

      const updatedSupervisor = await SupervisorModel.findById(supervisorId)
        .populate("userId", "firstName lastName email phone username imageUrl")
        .populate("branchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: `Supervisor ${newIsActive ? "activated" : "suspended"} successfully`,
        data: {
          supervisor: updatedSupervisor,
          isActive: newIsActive,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(
        new ErrorHandler(
          error.message || "Error toggling supervisor status",
          500,
        ),
      );
    }
  },
);

//  GET BRANCH SUPERVISOR
export const getBranchSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const managerId = req.user?._id;
    const { companyId, branchId } = req.params;

    if (!managerId) {
      return next(
        new ErrorHandler("Unauthorized, you are not authenticated.", 401),
      );
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      return next(new ErrorHandler("Invalid company ID", 400));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const [supervisor, manager, requestingUser] = await Promise.all([
      SupervisorModel.findOne({ branchId, companyId })
        .populate("userId", "firstName lastName email phone username imageUrl")
        .populate("branchId", "name code address status")
        .lean(),
      ManagerModel.findOne({ userId: managerId, companyId }).lean(),
      userModel.findById(managerId).select("role").lean(),
    ]);

    const isAdmin = requestingUser?.role === "admin";
    const isAuthorizedManager =
      manager &&
      manager.isActive &&
      manager.canAccessBranch(new mongoose.Types.ObjectId(branchId.toString()));

    if (!isAdmin && !isAuthorizedManager) {
      return next(
        new ErrorHandler(
          "Not authorized to view this branch's supervisor",
          403,
        ),
      );
    }

    if (!supervisor) {
      return next(new ErrorHandler("No supervisor found for this branch", 404));
    }

    return res.status(200).json({
      success: true,
      data: supervisor,
    });
  },
);

//  GET ALL ACTIVE SUPERVISORS OF MY COMPANY
export const getMySupervisors = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const managerId = req.user?._id;
    const { companyId } = req.params;

    if (!managerId) {
      return next(
        new ErrorHandler("Unauthorized, you are not authenticated.", 401),
      );
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      return next(new ErrorHandler("Invalid company ID", 400));
    }

    const [company, manager] = await Promise.all([
      CompanyModel.findById(companyId).lean(),
      ManagerModel.findOne({ userId: managerId, companyId }).lean(),
    ]);

    if (!company) {
      return next(new ErrorHandler("Company not found", 404));
    }

    if (!manager || !manager.isActive) {
      return next(
        new ErrorHandler("You are not an active manager of this company", 403),
      );
    }

    const supervisorQuery: mongoose.FilterQuery<typeof SupervisorModel> = {
      companyId,
      isActive: true,
    };

    if (!manager.branchAccess.allBranches) {
      supervisorQuery.branchId = { $in: manager.branchAccess.specificBranches };
    }

    const { search } = req.query;

    const supervisors = await SupervisorModel.find(supervisorQuery)
      .populate({
        path: "userId",
        select: "firstName lastName email phone username imageUrl",
        ...(search && typeof search === "string"
          ? {
              match: {
                $or: [
                  { firstName: { $regex: search, $options: "i" } },
                  { lastName: { $regex: search, $options: "i" } },
                  { email: { $regex: search, $options: "i" } },
                ],
              },
            }
          : {}),
      })
      .populate("branchId", "name code address status")
      .sort({ createdAt: -1 })
      .lean();

    const filtered = search
      ? supervisors.filter((s) => s.userId !== null)
      : supervisors;

    return res.status(200).json({
      success: true,
      count: filtered.length,
      data: filtered,
    });
  },
);



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

const ASSIGNED_USER_ROLES: AssignedUserRole[] = [
  "transporter",
  "deliverer",
  "driver",
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


//  HELPER — validate document sub-object


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



// ─────────────────────────────────────────────
//  CREATE VEHICLE
// ─────────────────────────────────────────────

export const createVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const managerId = req.user?._id;
      const { companyId } = req.params;

      // ── Auth ──────────────────────────────────────────────────────────────
      if (!managerId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized, you are not authenticated.", 401),
        );
      }

      // ── Param validation ──────────────────────────────────────────────────
      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      // ── Body extraction ───────────────────────────────────────────────────
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

      // ── Required fields ───────────────────────────────────────────────────
      if (!type) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Vehicle type is required", 400));
      }

      if (!VEHICLE_TYPES.includes(type)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Invalid vehicle type. Must be one of: ${VEHICLE_TYPES.join(", ")}`,
            400,
          ),
        );
      }

      if (!registrationNumber) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Registration number is required", 400),
        );
      }

      if (typeof registrationNumber !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Registration number must be a string", 400),
        );
      }

      const normalizedRegNum = registrationNumber.trim().toUpperCase();

      if (!REGISTRATION_NUMBER_REGEX.test(normalizedRegNum)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Registration number must be 5–20 characters and contain only letters, numbers, spaces, or hyphens",
            400,
          ),
        );
      }

      if (maxWeight === undefined || maxWeight === null) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("maxWeight is required", 400));
      }

      if (typeof maxWeight !== "number" || isNaN(maxWeight)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("maxWeight must be a number", 400));
      }

      if (maxWeight < 1 || maxWeight > 50000) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("maxWeight must be between 1 and 50 000 kg", 400),
        );
      }

      if (maxVolume === undefined || maxVolume === null) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("maxVolume is required", 400));
      }

      if (typeof maxVolume !== "number" || isNaN(maxVolume)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("maxVolume must be a number", 400));
      }

      if (maxVolume < 0.1 || maxVolume > 100) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "maxVolume must be between 0.1 and 100 cubic meters",
            400,
          ),
        );
      }

      // ── Optional field validation ──────────────────────────────────────────
      if (brand !== undefined) {
        if (typeof brand !== "string" || brand.trim().length === 0) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("brand must be a non-empty string", 400),
          );
        }
        if (brand.trim().length > 50) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("brand cannot exceed 50 characters", 400),
          );
        }
      }

      if (modelName !== undefined) {
        if (typeof modelName !== "string" || modelName.trim().length === 0) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("modelName must be a non-empty string", 400),
          );
        }
        if (modelName.trim().length > 50) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("modelName cannot exceed 50 characters", 400),
          );
        }
      }

      if (year !== undefined) {
        if (!Number.isInteger(year)) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("year must be an integer", 400));
        }
        const maxYear = new Date().getFullYear() + 1;
        if (year < 1900 || year > maxYear) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler(
              `year must be between 1900 and ${maxYear}`,
              400,
            ),
          );
        }
      }

      if (color !== undefined && typeof color !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("color must be a string", 400));
      }

      if (supportsFragile !== undefined && typeof supportsFragile !== "boolean") {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("supportsFragile must be a boolean", 400),
        );
      }

      if (currentBranchId !== undefined) {
        if (!mongoose.Types.ObjectId.isValid(currentBranchId)) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Invalid currentBranchId", 400));
        }
      }

      if (notes !== undefined) {
        if (typeof notes !== "string") {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("notes must be a string", 400));
        }
        if (notes.trim().length > 500) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("notes cannot exceed 500 characters", 400),
          );
        }
      }

      if (documents !== undefined) {
        if (typeof documents !== "object" || Array.isArray(documents)) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("documents must be an object", 400),
          );
        }
        const docsValid = validateDocuments(documents, next);
        if (!docsValid) {
          await session.abortTransaction();
          session.endSession();
          return;
        }
      }

      // ── DB checks (parallel) ──────────────────────────────────────────────
      const [company, manager, requestingUser, existingVehicle] =
        await Promise.all([
          CompanyModel.findById(companyId).session(session).lean(),
          ManagerModel.findOne({ userId: managerId, companyId }).session(
            session,
          ),
          userModel.findById(managerId).select("role").session(session).lean(),
          VehicleModel.findOne({ registrationNumber: normalizedRegNum })
            .session(session)
            .lean(),
        ]);

      if (!company) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Company not found", 404));
      }

      if (company.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Cannot add vehicles to an inactive company", 400),
        );
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedManager =
        manager &&
        manager.isActive &&
        manager.hasPermission("can_manage_vehicles");

      if (!isAdmin && !isAuthorizedManager) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Not authorized to manage vehicles for this company",
            403,
          ),
        );
      }

      if (existingVehicle) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "A vehicle with this registration number already exists",
            400,
          ),
        );
      }

      // ── Build documents payload ────────────────────────────────────────────
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

      // ── Create ────────────────────────────────────────────────────────────
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
      session.endSession();

      // ── Response (aggregation for rich data) ──────────────────────────────
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
      await session.abortTransaction();
      session.endSession();

      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((err: any) => err.message)
              .join(", "),
            400,
          ),
        );
      }

      if (error.code === 11000) {
        return next(
          new ErrorHandler(
            "A vehicle with this registration number already exists",
            400,
          ),
        );
      }

      return next(
        new ErrorHandler(error.message || "Error creating vehicle", 500),
      );
    }
  },
);



// ─────────────────────────────────────────────
//  UPDATE VEHICLE  (info only — no assignment)
// ─────────────────────────────────────────────

export const updateVehicle = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const managerId = req.user?._id;
      const { companyId, vehicleId } = req.params;

      // ── Auth ──────────────────────────────────────────────────────────────
      if (!managerId) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Unauthorized, you are not authenticated.", 401),
        );
      }

      // ── Param validation ──────────────────────────────────────────────────
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

      // ── Body extraction ───────────────────────────────────────────────────
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

      // Reject attempts to assign vehicles via this endpoint
      if (
        (req.body as any).assignedUserId !== undefined ||
        (req.body as any).assignedUserRole !== undefined
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Use the dedicated assign/release endpoint to manage vehicle assignment",
            400,
          ),
        );
      }

      // ── Field-level validation ────────────────────────────────────────────
      if (type !== undefined && !VEHICLE_TYPES.includes(type)) {
        await session.abortTransaction();
        session.endSession();
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
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("Registration number must be a string", 400),
          );
        }
        normalizedRegNum = registrationNumber.trim().toUpperCase();
        if (!REGISTRATION_NUMBER_REGEX.test(normalizedRegNum)) {
          await session.abortTransaction();
          session.endSession();
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
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("maxWeight must be a number", 400));
        }
        if (maxWeight < 1 || maxWeight > 50000) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("maxWeight must be between 1 and 50 000 kg", 400),
          );
        }
      }

      if (maxVolume !== undefined) {
        if (typeof maxVolume !== "number" || isNaN(maxVolume)) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("maxVolume must be a number", 400));
        }
        if (maxVolume < 0.1 || maxVolume > 100) {
          await session.abortTransaction();
          session.endSession();
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
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("brand must be a non-empty string", 400),
          );
        }
        if (brand.trim().length > 50) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("brand cannot exceed 50 characters", 400),
          );
        }
      }

      if (modelName !== undefined) {
        if (typeof modelName !== "string" || modelName.trim().length === 0) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("modelName must be a non-empty string", 400),
          );
        }
        if (modelName.trim().length > 50) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("modelName cannot exceed 50 characters", 400),
          );
        }
      }

      if (year !== undefined) {
        if (!Number.isInteger(year)) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("year must be an integer", 400));
        }
        const maxYear = new Date().getFullYear() + 1;
        if (year < 1900 || year > maxYear) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler(`year must be between 1900 and ${maxYear}`, 400),
          );
        }
      }

      if (color !== undefined && typeof color !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("color must be a string", 400));
      }

      if (supportsFragile !== undefined && typeof supportsFragile !== "boolean") {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("supportsFragile must be a boolean", 400),
        );
      }

      if (currentBranchId !== undefined) {
        if (!mongoose.Types.ObjectId.isValid(currentBranchId)) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Invalid currentBranchId", 400));
        }
      }

      if (status !== undefined) {
        if (status === "in_use") {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler(
              "Cannot manually set status to 'in_use'. Use the assign endpoint instead.",
              400,
            ),
          );
        }
        if (!VEHICLE_STATUSES.includes(status)) {
          await session.abortTransaction();
          session.endSession();
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
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("notes must be a string", 400));
        }
        if (notes.trim().length > 500) {
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler("notes cannot exceed 500 characters", 400),
          );
        }
      }

      if (documents !== undefined) {
        if (typeof documents !== "object" || Array.isArray(documents)) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("documents must be an object", 400));
        }
        const docsValid = validateDocuments(documents, next);
        if (!docsValid) {
          await session.abortTransaction();
          session.endSession();
          return;
        }
      }

      // ── DB checks (parallel) ──────────────────────────────────────────────
      const [vehicle, manager, requestingUser] = await Promise.all([
        VehicleModel.findOne({ _id: vehicleId, companyId }).session(session),
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
        userModel.findById(managerId).select("role").session(session).lean(),
      ]);

      if (!vehicle) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Vehicle not found or does not belong to this company",
            404,
          ),
        );
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedManager =
        manager &&
        manager.isActive &&
        manager.hasPermission("can_manage_vehicles");

      if (!isAdmin && !isAuthorizedManager) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Not authorized to manage vehicles for this company",
            403,
          ),
        );
      }

      // Guard: cannot change status away from in_use without releasing first
      if (vehicle.status === "in_use" && status) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Cannot change status of a vehicle currently in use. Release the vehicle first.",
            400,
          ),
        );
      }

      // Check registration number uniqueness only if it changed
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
          await session.abortTransaction();
          session.endSession();
          return next(
            new ErrorHandler(
              "A vehicle with this registration number already exists",
              400,
            ),
          );
        }
      }

      // ── Build update payload ──────────────────────────────────────────────
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

      // Merge documents (partial update — only supplied keys are overwritten)
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
      session.endSession();

      // ── Response (aggregation) ────────────────────────────────────────────
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
      await session.abortTransaction();
      session.endSession();

      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((err: any) => err.message)
              .join(", "),
            400,
          ),
        );
      }

      if (error.code === 11000) {
        return next(
          new ErrorHandler(
            "A vehicle with this registration number already exists",
            400,
          ),
        );
      }

      return next(
        new ErrorHandler(error.message || "Error updating vehicle", 500),
      );
    }
  },
);



// ─────────────────────────────────────────────
//  GET COMPANY VEHICLES
// ─────────────────────────────────────────────

export const getCompanyVehicles = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const managerId = req.user?._id;
    const { companyId } = req.params;

    // ── Auth ──────────────────────────────────────────────────────────────
    if (!managerId) {
      return next(
        new ErrorHandler("Unauthorized, you are not authenticated.", 401),
      );
    }

    // ── Param validation ──────────────────────────────────────────────────
    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      return next(new ErrorHandler("Invalid company ID", 400));
    }

    // ── Query params ──────────────────────────────────────────────────────
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

    // ── Authorization + company check (parallel) ──────────────────────────
    const [company, manager, requestingUser] = await Promise.all([
      CompanyModel.findById(companyId).lean(),
      ManagerModel.findOne({ userId: managerId, companyId }).lean(),
      userModel.findById(managerId).select("role").lean(),
    ]);

    if (!company) {
      return next(new ErrorHandler("Company not found", 404));
    }

    const isAdmin = requestingUser?.role === "admin";
    const isAuthorizedManager = manager && manager.isActive;

    if (!isAdmin && !isAuthorizedManager) {
      return next(
        new ErrorHandler(
          "Not authorized to view vehicles for this company",
          403,
        ),
      );
    }

    // ── Build aggregation pipeline ────────────────────────────────────────
    const matchStage: Record<string, any> = {
      companyId: new mongoose.Types.ObjectId(companyId.toString()),
    };

    if (type) matchStage.type = type;
    if (status) matchStage.status = status;

    // Branch filter: respect manager's branch access scope
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

    // ── Search filter (text match on registration, brand, modelName) ──────
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
      // ── Lookup company ────────────────────────────────────────────────
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
      // ── Lookup current branch ─────────────────────────────────────────
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
      // ── Lookup assigned user ──────────────────────────────────────────
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
      // ── Computed fields (mirrors model virtuals) ───────────────────────
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
      // ── Sort ──────────────────────────────────────────────────────────
      { $sort: { [sortBy]: sortDirection } },
      // ── Facet: paginated results + total count ────────────────────────
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limitNum }],
          totalCount: [{ $count: "count" }],
          // Fleet summary stats (counts per status & type)
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

    // Reshape summaries into plain objects
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
  },
);