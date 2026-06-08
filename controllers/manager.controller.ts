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
import { notifyAdminsNewEntityPending, sendSupervisorAccountCreatedNotification, sendSupervisorBlockStatusNotification } from "../services/notification.service";
import TariffModel, { ITariff, ITariffEntry } from "../models/tariff.model";
import { WILAYAS, isValidWilayaCode, wilayaName } from "../models/wilayas.constant";
import TransporterModel from "../models/transporter.model";
import { sendToken } from "../utils/Token.util";
import RouteModel from "../models/route.model";


type CompanyBusinessType = "solo" | "company";

interface IHeadquarters {
  street: string;
  city: string;
  state: string;
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

    let transactionCommitted = false;

    try {
      const userId = req.user?._id;

      if (!userId) {

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

        return next(
          new ErrorHandler("Name and business type are required", 400),
        );
      }

      const companyType = ["solo", "company"];

      if (
        !businessType ||
        typeof name !== "string" ||
        !companyType.includes(businessType)
      ) {

        return next(
          new ErrorHandler(
            "Name and business type does not meet the requirements",
            400,
          ),
        );
      }

      if (registrationNumber && typeof registrationNumber !== "string") {

        return next(
          new ErrorHandler("Registration number must be a string", 400),
        );
      }

      if (businessType === "company" && !registrationNumber) {

        return next(
          new ErrorHandler(
            "Registration number is required for company business type",
            400,
          ),
        );
      }

      if (email && typeof email !== "string") {

        return next(new ErrorHandler("email must be a string", 400));
      }

      if (phone && typeof phone !== "string") {

        return next(new ErrorHandler("phone number must be a string", 400));
      }

      if (headquarters) {
        const hq = headquarters;

        if (typeof hq.street !== "string" || typeof hq.city !== "string" || typeof hq.state !== "string") {
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

        throw new ErrorHandler("Company with this name already exists.", 400)
      }

      let companyWithSameRegistration = null;

      if (businessType === "company" && registrationNumber) {
        companyWithSameRegistration = await CompanyModel.findOne({
          registrationNumber,
        }).session(session);

        if (companyWithSameRegistration) {


          throw new ErrorHandler(
            "Company with this registration number already exists.",
            400,
          )
        }
      }

      const user = await userModel.findById(userId).session(session);

      if (!user) {
        throw new ErrorHandler("User Not found", 400)
      }

      if (user.role !== "client") {
        throw new ErrorHandler("Only users with client role can create a company", 403)
      }

      if (companyWithSameRegistration) {

        throw new ErrorHandler(
          "Company with this registration number already exists.",
          400,
        )
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

      const [manager] = await ManagerModel.create(
        [
          {
            userId: user._id,
            companyId: company[0]._id,
            accessLevel: "full",
            isActive: true,
            branchAccess: {
              allBranches: true,
              specificBranches: []
            }
          }
        ],
        { session }
      );

      user.role = "manager";
      await user.save({ session });


      await session.commitTransaction();
      transactionCommitted = true;

      notifyAdminsNewEntityPending(
        company[0]._id.toString(),
        "Manager",
        `${user.firstName} ${user.lastName} - Company: ${name}`

      ).catch(error => {

        console.error('Admin notification for new company failed:', error);

      });

      await sendToken(user, 201, res);
    } catch (error: any) {

      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }

      return next(error);

    } finally {
      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
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

    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const { companyId } = req.params;

      if (!userId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated", 401));
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {

        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const body = req.body as IUpdateCompany;

      if (Object.keys(body).length === 0) {

        return next(new ErrorHandler("No update data provided", 400));
      }

      if (body.name && typeof body.name !== "string") {

        return next(new ErrorHandler("Company name must be a string", 400));
      }

      if (
        body.businessType &&
        !["solo", "company"].includes(body.businessType)
      ) {

        return next(new ErrorHandler("Invalid business type", 400));
      }

      if (
        body.registrationNumber &&
        typeof body.registrationNumber !== "string"
      ) {

        return next(new ErrorHandler("Registration number must be a string", 400));
      }

      if (body.email && typeof body.email !== "string") {

        return next(new ErrorHandler("Email must be a string", 400));
      }

      if (body.phone && typeof body.phone !== "string") {

        return next(new ErrorHandler("Phone must be a string", 400));
      }

      if (body.headquarters) {
        const hq = body.headquarters;

        if (typeof hq.street !== "string" || typeof hq.city !== "string") {

          return next(new ErrorHandler("Invalid headquarters address data", 400));
        }

        if (
          !hq.location ||
          hq.location.type !== "Point" ||
          !Array.isArray(hq.location.coordinates) ||
          hq.location.coordinates.length !== 2
        ) {

          return next(new ErrorHandler("Invalid headquarters location format", 400));
        }
      }

      const [company, user, manager] = await Promise.all([
        CompanyModel.findById(companyId).session(session),
        userModel.findById(userId).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
      ]);

      if (!company) {

        throw new ErrorHandler("Company not found", 404);
      }

      if (!user) {

        throw new ErrorHandler("User not found", 404);
      }

      if (!manager) {

        throw new ErrorHandler(
          "You are not authorized to update this company",
          403,
        )
      }

      if (!manager.hasPermission("can_manage_settings")) {


        throw new ErrorHandler(
          "You don't have permission to update company settings",
          403,
        )
      }

      const finalBusinessType = body.businessType ?? company.businessType;
      const finalRegistration =
        body.registrationNumber ?? company.registrationNumber;

      if (finalBusinessType === "company" && !finalRegistration) {

        throw new ErrorHandler(
          "Registration number is required for company business type",
          400,
        )
      }

      if (body.name) {
        const nameExists = await CompanyModel.findOne({
          name: body.name,
          _id: { $ne: companyId },
        }).session(session);

        if (nameExists) {

          throw new ErrorHandler("Company name already exists", 400)
        }
      }

      if (finalBusinessType === "company" && body.registrationNumber) {
        const regExists = await CompanyModel.findOne({
          registrationNumber: body.registrationNumber,
          _id: { $ne: companyId },
        }).session(session);

        if (regExists) {


          throw new ErrorHandler(
            "Company with this registration number already exists",
            400,
          )
        }
      }

      Object.assign(company, body);
      await company.save({ session });

      await session.commitTransaction();
      transactionCommitted = true;

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

      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }

      return next(error);

    } finally {

      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }

      await session.endSession();
    }

  },
);

type CompanyStatus = "active" | "suspended";

//toggle between suspend and activate company
export const toggleBlockCompany = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const { companyId } = req.params;

      if (!userId) {

        return next(
          new ErrorHandler("Unauthorized, you are not authenticated.", 401),
        );
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {

        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const [company, manager, user] = await Promise.all([
        CompanyModel.findById(companyId).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
        userModel.findById(userId).select("role").session(session),
      ]);

      if (!company) {

        throw new ErrorHandler("Company not found", 404);
      }

      const isAdmin = user?.role === "admin";
      const isAuthorizedManager =
        manager && manager.companyId?.toString() === companyId && manager.hasPermission("can_manage_settings");

      if (!isAdmin && !isAuthorizedManager) {

        throw new ErrorHandler("Not authorized to change company status", 403)
      }

      if (!["active", "suspended"].includes(company.status)) {


        throw new ErrorHandler(`Invalid company status: ${company.status}`, 400)
      }

      const newStatus: CompanyStatus =
        company.status === "active" ? "suspended" : "active";

      company.status = newStatus;
      // console.log("Before save — status:", company.status, "isModified:", company.isModified("status"));
      await company.save({ session });
      // console.log("After save — status:", company.status);

      await session.commitTransaction();
      transactionCommitted = true;

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

      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }
      return next(error);

    } finally {

      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }

      await session.endSession();
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

export const getAllCompanies = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companies = await CompanyModel.find()
        .populate("userId", "firstName lastName email phone username")
        .sort({ createdAt: -1 })
        .lean();

      return res.status(200).json({
        success: true,
        data: companies,
      });
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Error getting companies.", 500),
      );
    }
  },
);

export const getAllRoutes = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;
      const userRole = req.user?.role as string;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      let matchStage: any = {};

      if (userRole === "manager") {
        const manager = await ManagerModel.findOne({ userId }).lean();
        if (!manager) {
          return next(new ErrorHandler("Manager profile not found", 404));
        }
        matchStage.companyId = manager.companyId;
      } else if (userRole !== "admin") {
         return next(new ErrorHandler("Not authorized to view all routes", 403));
      }

      const routes = await RouteModel.find(matchStage)
        .populate("originBranchId", "name code wilaya")
        .populate("destinationBranchId", "name code wilaya")
        .populate({
          path: "assignedTransporterId",
          select: "userId rating availabilityStatus transporterType",
          populate: { path: "userId", select: "firstName lastName phone avatar" }
        })
        .populate({
          path: "assignedDelivererId",
          select: "userId rating availabilityStatus",
          populate: { path: "userId", select: "firstName lastName phone avatar" }
        })
        .populate("stops.branchId", "name")
        .sort({ createdAt: -1 })
        .lean();

      const formattedData = routes.map((r: any) => ({
        ...r,
        originBranch: r.originBranchId,
        destinationBranch: r.destinationBranchId,
        transporterName: r.assignedTransporterId?.userId 
          ? `${r.assignedTransporterId.userId.firstName} ${r.assignedTransporterId.userId.lastName}` 
          : undefined,
        transporterId: r.assignedTransporterId?._id,
        packageCount: r.stops?.reduce((acc: number, stop: any) => acc + (stop.packageIds?.length || 0), 0) || 0
      }));

      return res.status(200).json({
        success: true,
        data: formattedData,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error getting routes.", 500));
    }
  }
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
  branchType?: 'local_branch' | 'regional_main_hub';
  parentHubId?: string;
  servesBranches?: string[];
}

interface IUpdateBranch {
  name?: string;
  address?: Partial<IBranchAddressBody>;
  location?: IBranchLocation;
  phone?: string;
  email?: string;
  operatingHours?: Record<string, IOperatingHoursBody>;
  capacityLimit?: number;

  branchType?: 'local_branch' | 'regional_main_hub';
  parentHubId?: string | null;
  servesBranches?: string[];
}

type BranchStatus = "active" | "inactive" | "maintenance" | "pending";

export const createBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const { companyId } = req.params;

      if (!userId) {

        return next(
          new ErrorHandler("Unauthorized, you are not authenticated.", 401),
        );
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {

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
        branchType,
        parentHubId,
        servesBranches,
      } = req.body as ICreateBranch;

      if (!name || !code || !address || !location || !phone || !email) {

        return next(
          new ErrorHandler(
            "name, code, address, location, phone and email are required",
            400,
          ),
        );
      }

      if (typeof name !== "string" || typeof code !== "string") {

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


        return next(
          new ErrorHandler("capacityLimit must be a positive number", 400),
        );
      }



      if (branchType && !['local_branch', 'regional_main_hub'].includes(branchType)) {


        return next(
          new ErrorHandler("branchType must be 'local_branch' or 'regional_main_hub'", 400),
        );
      }


      if (branchType === 'local_branch' && !parentHubId) {


        return next(
          new ErrorHandler("parentHubId is required for local branches", 400),
        );
      }


      if (parentHubId && !mongoose.Types.ObjectId.isValid(parentHubId)) {


        return next(new ErrorHandler("Invalid parentHubId", 400));
      }


      if (parentHubId) {

        const parentHub = await BranchModel.findOne({

          _id: parentHubId,
          companyId,
          branchType: 'regional_main_hub',
        }).session(session);

        if (!parentHub) {


          throw new ErrorHandler("Parent hub not found or is not a regional main hub", 404)
        }
      }


      if (servesBranches && branchType !== 'regional_main_hub') {


        throw new ErrorHandler("Only regional_main_hub can serve other branches", 400)
      }


      if (servesBranches) {
        for (const servedBranchId of servesBranches) {

          if (!mongoose.Types.ObjectId.isValid(servedBranchId)) {


            throw new ErrorHandler(`Invalid branch ID in servesBranches: ${servedBranchId}`, 400);
          }
        }
      }

      const [company, manager] = await Promise.all([
        CompanyModel.findById(companyId).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
      ]);

      if (!company) {

        throw new ErrorHandler("Company not found", 404);
      }

      if (!manager || !manager.isActive) {


        throw new ErrorHandler(
          "You are not an active manager of this company",
          403,
        )

      }

      if (!manager.hasPermission("can_manage_branches")) {


        throw new ErrorHandler("You don't have permission to manage branches", 403);

      }

      if (company.status !== "active") {


        throw new ErrorHandler(
          "Cannot create branch for an inactive or suspended company",
          400,
        );
      }

      const existingBranch = await BranchModel.findOne({
        code: code.toUpperCase(),
      }).session(session);

      if (existingBranch) {


        throw new ErrorHandler("A branch with this code already exists", 400);

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

            ...(branchType && { branchType }),
            ...(parentHubId && { parentHubId }),
            ...(servesBranches && { servesBranches }),
          },
        ],
        { session },
      );

      if (branchType === "local_branch" && parentHubId) {

        await BranchModel.findByIdAndUpdate(
          parentHubId,
          { $addToSet: { servesBranches: branch[0]._id } },
          { session },
        );

      }

      if (servesBranches && servesBranches.length > 0) {

        await BranchModel.updateMany(
          { _id: { $in: servesBranches }, companyId },
          { parentHubId: branch[0]._id },
          { session },
        );
      }

      await session.commitTransaction();
      transactionCommitted = true;

      const populatedBranch = await BranchModel.findById(branch[0]._id)
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Branch created successfully",
        data: populatedBranch,
      });

    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }
      return next(error);

    } finally {

      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  },
);

//  UPDATE BRANCH

export const updateBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const { companyId, branchId } = req.params;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {

        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {

        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const body = req.body as IUpdateBranch;

      if (Object.keys(body).length === 0) {

        return next(new ErrorHandler("No update data provided", 400));
      }

      if (body.name !== undefined && typeof body.name !== "string") {

        return next(new ErrorHandler("name must be a string", 400));
      }

      if (body.address) {
        const { street, city, state } = body.address;
        if (
          (street !== undefined && typeof street !== "string") ||
          (city !== undefined && typeof city !== "string") ||
          (state !== undefined && typeof state !== "string")
        ) {
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
          return next(new ErrorHandler(
            "Invalid location format. Expected GeoJSON Point with [lng, lat]",
            400,
          ));
        }
      }

      if (
        body.capacityLimit !== undefined &&
        (typeof body.capacityLimit !== "number" || body.capacityLimit < 1)
      ) {
        return next(new ErrorHandler("capacityLimit must be a positive number", 400));
      }

      if (body.branchType && !['local_branch', 'regional_main_hub'].includes(body.branchType)) {

        return next(new ErrorHandler("branchType must be 'local_branch' or 'regional_main_hub'", 400));
      }

      if (body.parentHubId && !mongoose.Types.ObjectId.isValid(body.parentHubId)) {

        return next(new ErrorHandler("Invalid parentHubId", 400));
      }

      const [branch, company, manager] = await Promise.all([
        BranchModel.findOne({ _id: branchId, companyId }).session(session),
        CompanyModel.findById(companyId).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
      ]);

      if (!branch) {
        throw new ErrorHandler("Branch not found", 404);
      }

      if (!company) {
        throw new ErrorHandler("Company not found", 404);
      }

      if (body.branchType === 'local_branch' && branch.branchType === 'regional_main_hub') {

        const childBranches = await BranchModel.find({ parentHubId: branchId }).session(session);
        if (childBranches.length > 0) {
          throw new ErrorHandler(
            `Cannot change hub to local branch. It currently serves ${childBranches.length} branches. Reassign them first.`,
            400,
          );
        }
      }

      if (body.parentHubId) {

        const parentHub = await BranchModel.findOne({
          _id: body.parentHubId,
          companyId,
          branchType: 'regional_main_hub',
        }).session(session);

        if (!parentHub) {

          throw new ErrorHandler("Parent hub not found or is not a regional main hub", 404);
        }

        if (branch.branchType === 'regional_main_hub') {

          throw new ErrorHandler("Regional main hubs cannot have a parent hub", 400);
        }
      }

      if (body.parentHubId === null && branch.branchType === 'local_branch') {

        throw new ErrorHandler("Local branches must have a parent hub", 400);
      }

      if (!manager || !manager.isActive) {

        throw new ErrorHandler(
          "You are not an active manager of this company",
          403,
        );
      }

      if (!manager.hasPermission("can_manage_branches")) {

        throw new ErrorHandler("You don't have permission to manage branches", 403);
      }

      if (
        !manager.canAccessBranch(
          new mongoose.Types.ObjectId(branchId.toString()),
        )
      ) {
        throw new ErrorHandler("You don't have access to this branch", 403);
      }

      if (
        body.capacityLimit !== undefined &&
        body.capacityLimit < branch.currentLoad
      ) {
        throw new ErrorHandler(
          `Capacity limit cannot be less than current load (${branch.currentLoad})`,
          400,
        );
      }

      Object.assign(branch, body);
      await branch.save({ session });

      await session.commitTransaction();
      transactionCommitted = true;

      const populatedBranch = await BranchModel.findById(branchId)
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Branch updated successfully",
        data: populatedBranch,
      });
    } catch (error: any) {

      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }

      return next(error);

    } finally {

      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }

      await session.endSession();

    }
  },
);

//  TOGGLE BLOCK / ACTIVATE BRANCH

export const toggleBlockBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const { companyId, branchId } = req.params;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const [branch, manager, user] = await Promise.all([
        BranchModel.findOne({ _id: branchId, companyId }).session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
        userModel.findById(userId).select("role").session(session),
      ]);

      if (!branch) {
        throw new ErrorHandler("Branch not found", 404);
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

        throw new ErrorHandler("Not authorized to change this branch status", 403);
      }

      if (!["active", "inactive"].includes(branch.status)) {

        throw new ErrorHandler(
          `Cannot toggle a branch with status "${branch.status}". Only active/inactive branches can be toggled`,
          400,
        );
      }

      const newStatus: BranchStatus =
        branch.status === "active" ? "inactive" : "active";

      if (newStatus === "inactive" && branch.isHub) {
        const childBranches = await BranchModel.find({
          parentHubId: branchId,
          status: "active",
        }).session(session);

        if (childBranches.length > 0) {

          throw new ErrorHandler(
            `Cannot deactivate this hub. It currently serves ${childBranches.length} active branches: ${childBranches.map(b => b.name).join(", ")}. Reassign them to another hub first.`,
            400,
          );
        }
      }

      branch.status = newStatus;
      await branch.save({ session });

      await session.commitTransaction();
      transactionCommitted = true;

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

      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }

      return next(error);

    } finally {

      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }

      await session.endSession();
    }

  },
);




export const switchBranchHub = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const { companyId, branchId, promotedBranchId } = req.params;

      if (!userId || !mongoose.Types.ObjectId.isValid(userId.toString())) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {

        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {

        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!promotedBranchId || !mongoose.Types.ObjectId.isValid(promotedBranchId.toString())) {
        return next(new ErrorHandler("Invalid promoted branch ID", 400));
      }

      if (branchId === promotedBranchId) {
        return next(new ErrorHandler("Cannot switch hub with itself", 400));
      }

      const [user, manager, company] = await Promise.all([
        userModel.findById(userId).select("role").session(session),
        ManagerModel.findOne({ userId, companyId }).session(session),
        CompanyModel.findById(companyId).session(session),
      ]);

      if (!user) {
        throw new ErrorHandler("User not found", 404);
      }

      if (user.role !== "manager") {

        throw new ErrorHandler("Only managers can switch branch hub", 403);
      }

      if (!manager) {

        throw new ErrorHandler("You are not a manager of this company", 403);
      }

      if (!manager.isActive || !manager.hasPermission("can_manage_branches")) {
        throw new ErrorHandler("You don't have permission to manage branches", 403);
      }


      if (!company) {

        throw new ErrorHandler("Company not found", 404);
      }

      if (company.status !== "active") {

        throw new ErrorHandler("Cannot switch hub for an inactive company", 400);
      }

      if (
        !manager.canAccessBranch(new mongoose.Types.ObjectId(branchId.toString())) ||
        !manager.canAccessBranch(new mongoose.Types.ObjectId(promotedBranchId.toString()))
      ) {

        throw new ErrorHandler("You don't have access to one or both of these branches", 403);
      }

      const [branch, promotedBranch] = await Promise.all([
        BranchModel.findOne({ _id: branchId, companyId }).session(session),
        BranchModel.findOne({ _id: promotedBranchId, companyId }).session(session),
      ]);

      if (!branch || branch.branchType !== "regional_main_hub") {
        throw new ErrorHandler("Branch not found or is not a regional main hub", 404);
      }

      if (branch.status !== "active") {
        throw new ErrorHandler(`Cannot switch an inactive hub. Current status: ${branch.status}`, 400);
      }

      if (!promotedBranch || promotedBranch.branchType !== "local_branch") {
        throw new ErrorHandler("Promoted branch not found or is not a local branch", 404);
      }

      if (promotedBranch.status !== "active") {

        throw new ErrorHandler(`Cannot promote an inactive branch. Current status: ${promotedBranch.status}`, 400);
      }

      if (promotedBranch.parentHubId?.toString() !== branchId) {

        throw new ErrorHandler("The promoted branch must be a child of the hub being replaced", 400);
      }

      const hubChildBranches = await BranchModel.find({
        parentHubId: branchId,
        companyId,
        _id: { $ne: promotedBranchId },
      }).session(session);

      promotedBranch.branchType = "regional_main_hub";
      promotedBranch.parentHubId = null;
      promotedBranch.servesBranches = [
        branch._id,
        ...hubChildBranches.map((b) => b._id),
      ];

      branch.branchType = "local_branch";
      branch.parentHubId = promotedBranch._id;
      branch.servesBranches = [];

      await Promise.all([
        promotedBranch.save({ session }),
        branch.save({ session }),
      ]);

      if (hubChildBranches.length > 0) {
        await BranchModel.updateMany(
          {
            _id: { $in: hubChildBranches.map((b) => b._id) },
          },
          { parentHubId: promotedBranch._id },
          { session },
        );
      }

      await session.commitTransaction();
      transactionCommitted = true;

      const [updatedHub, updatedOldHub] = await Promise.all([
        BranchModel.findById(promotedBranchId)
          .populate("companyId", "name businessType status")
          .populate("servesBranches", "name code branchType status")
          .lean(),
        BranchModel.findById(branchId)
          .populate("parentHubId", "name code")
          .lean(),
      ]);

      return res.status(200).json({
        success: true,
        message: `Hub switched successfully. ${promotedBranch.name} is now the regional main hub.`,
        data: {
          newHub: updatedHub,
          previousHub: updatedOldHub,
          branchesReassigned: hubChildBranches.length + 1,
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

      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }

      await session.endSession();
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
      ManagerModel.findOne({ userId, companyId }),
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

  };
}

//  CREATE SUPERVISOR
export const createSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const managerId = req.user?._id;
      const { companyId } = req.params;

      if (!managerId) {

        return next(new ErrorHandler("Unauthorized, user not authenticated.", 401));
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
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

        return next(new ErrorHandler("All required fields must be provided", 400));
      }

      if (
        typeof branchId !== "string" ||
        typeof firstName !== "string" ||
        typeof lastName !== "string" ||
        typeof email !== "string" ||
        typeof phone !== "string" ||
        typeof password !== "string"
      ) {

        return next(new ErrorHandler(
          "All required fields must be in their proper types.",
          400,
        ));
      }

      if (!mongoose.Types.ObjectId.isValid(branchId)) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (permissions !== undefined) {
        if (!Array.isArray(permissions)) {

          return next(new ErrorHandler("Permissions must be an array", 400));
        }

        if (new Set(permissions).size !== permissions.length) {
          return next(new ErrorHandler("Duplicate permissions are not allowed", 400));
        }
      }

      const normalizedPhone = userModel.normalizePhone(phone);

      const [manager, branch, existingUser] = await Promise.all([
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
        BranchModel.findOne({ _id: branchId, companyId }).session(session),
        userModel.findOne({
          $or: [
            { email },
            { phone: normalizedPhone }
          ]
        }).session(session),
      ]);

      if (existingUser) {
        if (existingUser.email === email) {
          throw new ErrorHandler("User with this email already exists", 400);
        }
        throw new ErrorHandler("User with this phone number already exists", 400);
      }

      if (!manager || !manager.isActive) {
        throw new ErrorHandler("You are not an active manager", 403);
      }

      if (!manager.hasPermission("can_manage_supervisors")) {
        throw new ErrorHandler("No permission to manage supervisors", 403);
      }

      if (!branch || branch.status !== "active") {

        throw new ErrorHandler("Invalid or inactive branch", 400);
      }

      if (existingUser) {

        throw new ErrorHandler("User with this email already exists", 400);
      }

      const user = await userModel.create(
        [
          {
            firstName,
            lastName,
            email,
            phone,
            passwordHash: password,
            role: "supervisor",
            status: "active"
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
            permissions: permissions,
            ...(workSchedule && { workSchedule }),
            isActive: true,
          },
        ],
        { session },
      );

      await session.commitTransaction();
      transactionCommitted = true;



      const branchName = branch ? branch.name : "Branch";

      sendSupervisorAccountCreatedNotification(
        user[0]._id.toString(),
        firstName,
        lastName,
        supervisor[0]._id.toString(),
        branchName
      ).catch(error => {
        console.error('Supervisor creation notification failed:', error);
      });


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

      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }

      return next(error);

    } finally {

      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }

      await session.endSession();
    }
  },
);

//  UPDATE SUPERVISOR
export const updateSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const managerId = req.user?._id;
      const { supervisorId } = req.params;

      if (!managerId) {
        return next(new ErrorHandler("Unauthorized, user is not authenticated", 401));
      }

      if (
        !supervisorId ||
        !mongoose.Types.ObjectId.isValid(supervisorId.toString())
      ) {
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
        return next(new ErrorHandler("No update data provided", 400));
      }

      const supervisor =
        await SupervisorModel.findById(supervisorId).session(session);

      if (!supervisor) {
        throw new ErrorHandler("Supervisor not found", 404);
      }

      const manager = await ManagerModel.findOne({
        userId: managerId,
        companyId: supervisor.companyId,
      }).session(session);

      if (!manager || !manager.isActive) {
        throw new ErrorHandler("You are not authorized to update supervisors", 403);
      }

      if (!manager.hasPermission("can_manage_supervisors")) {
        throw new ErrorHandler("Permission denied", 403);
      }

      if (permissions !== undefined) {
        if (!Array.isArray(permissions)) {
          throw new ErrorHandler("permissions must be an array", 400);
        }

        if (new Set(permissions).size !== permissions.length) {
          throw new ErrorHandler("Duplicate permissions are not allowed", 400);
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
          throw new ErrorHandler("Linked user not found", 404);
        }

        if (userData.firstName !== undefined) {
          if (typeof userData.firstName !== "string") {
            throw new ErrorHandler("firstName must be string", 400);
          }
          user.firstName = userData.firstName;
        }

        if (userData.lastName !== undefined) {
          if (typeof userData.lastName !== "string") {
            throw new ErrorHandler("lastName must be string", 400);
          }
          user.lastName = userData.lastName;
        }

        if (userData.phone !== undefined) {
          if (typeof userData.phone !== "string") {
            throw new ErrorHandler("phone must be string", 400);
          }


          const normalizedPhone = userModel.normalizePhone(userData.phone);
          const phoneExists = await userModel.findOne({
            phone: normalizedPhone,
            _id: { $ne: user._id }
          }).session(session);

          if (phoneExists) {
            throw new ErrorHandler("This phone number is already in use", 400);
          }

          user.phone = normalizedPhone;
        }


        await user.save({ session });
      }

      await session.commitTransaction();
      transactionCommitted = true;

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

      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }

      return next(error);

    } finally {

      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }

      await session.endSession();

    }
  },
);

//  TOGGLE BLOCK / ACTIVATE SUPERVISOR
export const toggleBlockSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const managerId = req.user?._id;
      const { companyId, supervisorId } = req.params;

      if (!managerId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (
        !companyId ||
        !mongoose.Types.ObjectId.isValid(companyId.toString())
      ) {
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (
        !supervisorId ||
        !mongoose.Types.ObjectId.isValid(supervisorId.toString())
      ) {
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

        throw new ErrorHandler("Supervisor not found", 404);
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedManager =
        manager &&
        manager.isActive &&
        manager.hasPermission("can_manage_supervisors") &&
        manager.canAccessBranch(supervisor.branchId);

      if (!isAdmin && !isAuthorizedManager) {

        throw new ErrorHandler(
          "Not authorized to change this supervisor's status",
          403,
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
      transactionCommitted = true;


      sendSupervisorBlockStatusNotification(

        supervisor.userId.toString(),
        supervisorId.toString(),
        !newIsActive

      ).catch(error => {

        console.error('Supervisor block status notification failed:', error);

      });

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

      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }

      return next(error);

    } finally {

      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }

      await session.endSession();

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
      ManagerModel.findOne({ userId: managerId, companyId }),
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


export const getMeManager = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    const [user, manager] = await Promise.all([
      userModel.findById(userId)
        .select("firstName lastName email phone imageUrl role status createdAt")
        .lean(),
      ManagerModel.findOne({ userId })
        .populate("companyId", "name logo status businessType")
        .lean(),
    ]);

    if (!user) {
      return next(new ErrorHandler("User not found.", 404));
    }
    if (!manager || !manager.isActive) {
      return next(new ErrorHandler("Manager profile not found or inactive.", 404));
    }

    return res.status(200).json({
      success: true,
      data: {

        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        imageUrl: user.imageUrl,
        role: user.role,
        status: user.status,
        accessLevel: manager.accessLevel,
        permissions: manager.permissions,
        branchAccess: manager.branchAccess,
        company: manager.companyId,
      },
    });
  },
);



export function buildUserFieldUpdates(
  body: { firstName?: string; lastName?: string },
  next: NextFunction
): Record<string, any> | void {
  const $set: Record<string, any> = {};

  if (body.firstName !== undefined) {
    if (typeof body.firstName !== "string" || body.firstName.trim().length < 3) {
      return next(new ErrorHandler("firstName must be at least 3 characters", 400));

    }
    if (body.firstName.trim().length > 30) {
      return next(new ErrorHandler("firstName cannot exceed 30 characters", 400));

    }
    $set.firstName = body.firstName.trim();
  }

  if (body.lastName !== undefined) {
    if (typeof body.lastName !== "string" || body.lastName.trim().length < 3) {
      return next(new ErrorHandler("lastName must be at least 3 characters", 400));

    }
    if (body.lastName.trim().length > 30) {
      return next(new ErrorHandler("lastName cannot exceed 30 characters", 400));

    }
    $set.lastName = body.lastName.trim();
  }

  return $set;
}



//  UPDATE ME — MANAGER
//  PATCH /manager/me
//  Updatable: firstName, lastName
//  Everything on ManagerModel is blocked — only an admin can change that.


export const updateMeManager = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    // Block any attempt to touch manager-level fields
    const blocked = ["accessLevel", "permissions", "branchAccess", "companyId", "isActive"];
    const blockedFound = blocked.filter((f) => f in req.body);
    if (blockedFound.length) {
      return next(
        new ErrorHandler(
          `Field(s) cannot be self-updated: ${blockedFound.join(", ")}`,
          400,
        ),
      );
    }

    const user = await userModel.findById(userId).lean();
    if (!user) return next(new ErrorHandler("User not found.", 404));

    const userUpdates = buildUserFieldUpdates(req.body, next);

    if (!userUpdates) return;

    if (Object.keys(userUpdates).length === 0) {
      return next(new ErrorHandler("No valid fields to update.", 400));
    }

    const updatedUser = await userModel.findByIdAndUpdate(
      userId,
      { $set: userUpdates },
      { new: true, runValidators: true },
    ).select("firstName lastName email phone imageUrl role status");

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: updatedUser,
    });
  },
);




// ─────────────────────────────────────────────────────────────────────────────
//  GET WILAYA LIST (reference data for frontend dropdowns)
//  GET /manager/wilayas
// ─────────────────────────────────────────────────────────────────────────────

export const getWilayaList = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const wilayas = Object.entries(WILAYAS).map(([code, name]) => ({
        code: parseInt(code),
        name,
      }));

      return res.status(200).json({
        success: true,
        count: wilayas.length,
        data: wilayas,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error fetching wilaya list.", 500));
    }
  },
);


// ─────────────────────────────────────────────────────────────────────────────
//  GET ALL TARIFFS FOR MY COMPANY
//  GET /manager/tariffs
//  Query params: ?search=Alger  (filter by wilaya name)
// ─────────────────────────────────────────────────────────────────────────────

export const getMyTariffs = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const managerId = req.user?._id;

      if (!managerId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const manager = await ManagerModel.findOne({
        userId: managerId,
        isActive: true,
      }).lean();

      if (!manager || !manager.companyId) {
        return next(new ErrorHandler("Manager profile not found or inactive or doesnt have a company.", 404));
      }

      const tariff = await TariffModel.findByCompany(manager.companyId.toString());

      let entries: (ITariffEntry & { wilayaAName: string; wilayaBName: string })[] =
        (tariff?.entries ?? []).map(e => ({
          ...e,
          wilayaAName: wilayaName(e.wilayaA),
          wilayaBName: wilayaName(e.wilayaB),
        }));

      // Filter by search
      if (req.query.search) {
        const search = (req.query.search as string).toLowerCase();
        entries = entries.filter(
          e =>
            e.wilayaAName.toLowerCase().includes(search) ||
            e.wilayaBName.toLowerCase().includes(search),
        );
      }

      // Sort by wilayaA then wilayaB
      entries.sort((a, b) => a.wilayaA - b.wilayaA || a.wilayaB - b.wilayaB);

      // Pagination (optional)
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 100));
      const total = entries.length;
      const paginated = entries.slice((page - 1) * limit, page * limit);

      return res.status(200).json({
        success: true,
        data: {
          companyId: tariff?.companyId,
          entries: paginated,
          pagination: {
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
            hasMore: page * limit < total,
          },
          lastUpdated: tariff?.updatedAt ?? null,
        },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error fetching tariffs.", 500));
    }
  },
);


// ─────────────────────────────────────────────────────────────────────────────
//  GET SINGLE TARIFF PRICE
//  GET /manager/tariffs/price?from=16&to=31
// ─────────────────────────────────────────────────────────────────────────────

export const getTariffPrice = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const managerId = req.user?._id;

      if (!managerId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const manager = await ManagerModel.findOne({
        userId: managerId,
        isActive: true,
      }).lean();

      if (!manager || !manager.companyId) {
        return next(new ErrorHandler("Manager profile not found or inactive or doesnt have a company.", 404));
      }

      const from = parseInt(req.query.from as string);
      const to = parseInt(req.query.to as string);

      if (isNaN(from) || isNaN(to)) {
        return next(
          new ErrorHandler("Query params 'from' and 'to' are required and must be numbers.", 400),
        );
      }

      if (!isValidWilayaCode(from) || !isValidWilayaCode(to)) {
        return next(new ErrorHandler("Invalid wilaya code(s). Must be 1–58.", 400));
      }

      const entry = await TariffModel.findPrice(
        manager.companyId.toString(),
        from,
        to,
      );

      if (!entry) {
        return res.status(200).json({
          success: true,
          found: false,
          message: `No tariff set for ${wilayaName(from)} ↔ ${wilayaName(to)}.`,
          data: null,
        });
      }

      return res.status(200).json({
        success: true,
        found: true,
        data: {
          ...entry,
          wilayaAName: wilayaName(entry.wilayaA),
          wilayaBName: wilayaName(entry.wilayaB),
        },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error fetching tariff price.", 500));
    }
  },
);


// ─────────────────────────────────────────────────────────────────────────────
//  UPSERT TARIFF (set price for one wilaya pair)
//  POST /manager/tariffs
//  Body: { wilayaFrom: 16, wilayaTo: 31, stopdesk: 500, domicile: 700 }
// ─────────────────────────────────────────────────────────────────────────────

interface IUpsertTariffBody {
  wilayaFrom: number;
  wilayaTo: number;
  stopdesk: number;
  domicile: number;
}

export const upsertTariff = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const managerId = req.user?._id;

      if (!managerId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const { wilayaFrom, wilayaTo, stopdesk, domicile } = req.body as IUpsertTariffBody;


      if (wilayaFrom === undefined || wilayaTo === undefined) {
        return next(new ErrorHandler("wilayaFrom and wilayaTo are required.", 400));
      }

      if (!isValidWilayaCode(wilayaFrom) || !isValidWilayaCode(wilayaTo)) {
        return next(new ErrorHandler("Invalid wilaya code(s). Must be 1–58.", 400));
      }

      if (stopdesk === undefined || domicile === undefined) {
        return next(new ErrorHandler("stopdesk and domicile prices are required.", 400));
      }

      if (typeof stopdesk !== "number" || stopdesk < 0) {
        return next(new ErrorHandler("stopdesk price must be a non-negative number.", 400));
      }

      if (typeof domicile !== "number" || domicile < 0) {
        return next(new ErrorHandler("domicile price must be a non-negative number.", 400));
      }

      if (domicile < stopdesk) {
        return next(
          new ErrorHandler("Domicile price must be greater than or equal to stopdesk price.", 400),
        );
      }


      const manager = await ManagerModel.findOne({
        userId: managerId,
        isActive: true,
      }).session(session);

      if (!manager || !manager.companyId) {
        throw new ErrorHandler("Manager profile not found or inactive or doesnt have a company.", 404);
      }

      if (!manager.hasPermission("can_manage_settings")) {
        throw new ErrorHandler("You don't have permission to manage tariffs.", 403);
      }


      const tariff = await TariffModel.setPrice(
        manager.companyId.toString(),
        wilayaFrom,
        wilayaTo,
        { stopdesk, domicile },
        managerId.toString(),
      );


      const [a, b] = wilayaFrom <= wilayaTo ? [wilayaFrom, wilayaTo] : [wilayaTo, wilayaFrom];
      const entry = tariff.entries.find(e => e.wilayaA === a && e.wilayaB === b);

      await session.commitTransaction();
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message: `Tariff for ${wilayaName(a)} ↔ ${wilayaName(b)} saved successfully.`,
        data: entry
          ? {
            ...(entry as any).toObject?.() ?? entry,
            wilayaAName: wilayaName(entry.wilayaA),
            wilayaBName: wilayaName(entry.wilayaB),
          }
          : null,
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
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  },
);


// ─────────────────────────────────────────────────────────────────────────────
//  BULK UPSERT TARIFFS (replace all entries at once)
//  POST /manager/tariffs/bulk
//  Body: { tariffs: [{ wilayaA, wilayaB, stopdesk, domicile }, ...] }
//
//  NOTE: This REPLACES the entire entries array. Use for seeding or full import.
//  For incremental updates, call POST /manager/tariffs for each pair.
// ─────────────────────────────────────────────────────────────────────────────

interface IBulkTariffEntry {
  wilayaA: number;
  wilayaB: number;
  stopdesk: number;
  domicile: number;
}

interface IBulkUpsertTariffsBody {
  tariffs: IBulkTariffEntry[];
}

export const bulkUpsertTariffs = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const managerId = req.user?._id;

      if (!managerId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const { tariffs } = req.body as IBulkUpsertTariffsBody;

      if (!tariffs || !Array.isArray(tariffs) || tariffs.length === 0) {
        return next(new ErrorHandler("tariffs must be a non-empty array.", 400));
      }

      if (tariffs.length > 1653) {
        return next(
          new ErrorHandler(`Maximum 1,653 entries allowed (all possible wilaya pairs).`, 400),
        );
      }


      for (let i = 0; i < tariffs.length; i++) {
        const t = tariffs[i];
        if (!isValidWilayaCode(t.wilayaA) || !isValidWilayaCode(t.wilayaB)) {
          return next(new ErrorHandler(`Entry ${i}: Invalid wilaya code(s).`, 400));
        }
        if (typeof t.stopdesk !== "number" || t.stopdesk < 0) {
          return next(new ErrorHandler(`Entry ${i}: Invalid stopdesk price.`, 400));
        }
        if (typeof t.domicile !== "number" || t.domicile < 0) {
          return next(new ErrorHandler(`Entry ${i}: Invalid domicile price.`, 400));
        }
        if (t.domicile < t.stopdesk) {
          return next(
            new ErrorHandler(`Entry ${i}: Domicile price must be ≥ stopdesk price.`, 400),
          );
        }
      }


      const manager = await ManagerModel.findOne({
        userId: managerId,
        isActive: true,
      }).session(session);

      if (!manager || !manager.companyId) {
        throw new ErrorHandler("Manager profile not found or inactive or doesnt have a company.", 404);
      }

      if (!manager.hasPermission("can_manage_settings")) {
        throw new ErrorHandler("You don't have permission to manage tariffs.", 403);
      }


      const tariff = await TariffModel.bulkSetPrices(
        manager.companyId.toString(),
        tariffs.map(t => ({
          wilayaA: t.wilayaA,
          wilayaB: t.wilayaB,
          stopdesk: t.stopdesk,
          domicile: t.domicile,
        })),
        managerId.toString(),
      );

      await session.commitTransaction();
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message: `${tariff.entries.length} tariff(s) saved successfully.`,
        data: {
          companyId: tariff.companyId,
          count: tariff.entries.length,
          lastUpdated: tariff.updatedAt,
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
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  },
);


// ─────────────────────────────────────────────────────────────────────────────
//  DELETE TARIFF ENTRY (remove one wilaya pair)
//  DELETE /manager/tariffs?wilayaA=16&wilayaB=31
//
//  Removes a single entry from the company's entries array.
//  The company's tariff document continues to exist with remaining entries.
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTariff = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const managerId = req.user?._id;

      if (!managerId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const wilayaA = parseInt(req.query.wilayaA as string);
      const wilayaB = parseInt(req.query.wilayaB as string);

      if (isNaN(wilayaA) || isNaN(wilayaB)) {
        return next(
          new ErrorHandler("Query params 'wilayaA' and 'wilayaB' are required and must be numbers.", 400),
        );
      }

      if (!isValidWilayaCode(wilayaA) || !isValidWilayaCode(wilayaB)) {
        return next(new ErrorHandler("Invalid wilaya code(s). Must be 1–58.", 400));
      }

      const [a, b] = wilayaA <= wilayaB ? [wilayaA, wilayaB] : [wilayaB, wilayaA];


      const manager = await ManagerModel.findOne({
        userId: managerId,
        isActive: true,
      }).session(session);

      if (!manager) {
        throw new ErrorHandler("Manager profile not found or inactive.", 404);
      }

      if (!manager.hasPermission("can_manage_settings")) {
        throw new ErrorHandler("You don't have permission to manage tariffs.", 403);
      }


      const tariff = await TariffModel.findOneAndUpdate(
        { companyId: manager.companyId },
        {
          $pull: { entries: { wilayaA: a, wilayaB: b } },
          $set: { lastUpdatedBy: new mongoose.Types.ObjectId(managerId.toString()) },
        },
        { new: true, session },
      );

      if (!tariff) {
        throw new ErrorHandler("Tariff document not found for this company.", 404);
      }

      await session.commitTransaction();
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message: `Tariff for ${wilayaName(a)} ↔ ${wilayaName(b)} removed successfully.`,
        data: {
          companyId: tariff.companyId,
          remainingEntries: tariff.entries.length,
        },
      });
    } catch (error: any) {
      return next(error);
    } finally {
      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  },
);


// ─────────────────────────────────────────────────────────────────────────────
//  ASSIGN HUB LINE  (hub_to_hub transporter)
//
//  POST /manager/transporters/:id/assign-hub-line
//  Body: { hubAId: string, hubBId: string }
//
//  Sets this transporter's type to hub_to_hub and records the two main-hub
//  branch IDs they shuttle between.  The transporter may travel in either
//  direction; the optimizer decides direction based on available manifests.
//
//  Validations:
//    • Both IDs are valid ObjectIds
//    • Both IDs are distinct
//    • Both branches belong to this company
//    • Both branches are regional_main_hub
//    • Transporter belongs to this company
// ─────────────────────────────────────────────────────────────────────────────

export const assignTransporterHubLine = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const managerId = req.user?._id;
      if (!managerId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const { id: transporterDocId } = req.params;
      const { hubAId, hubBId } = req.body as { hubAId?: string; hubBId?: string };

      // ── Basic input validation ──────────────────────────────────────────────
      if (!transporterDocId || !mongoose.Types.ObjectId.isValid(transporterDocId.toString())) {
        return next(new ErrorHandler("Invalid transporter ID.", 400));
      }
      if (!hubAId || !mongoose.Types.ObjectId.isValid(hubAId)) {
        return next(new ErrorHandler("hubAId is required and must be a valid ObjectId.", 400));
      }
      if (!hubBId || !mongoose.Types.ObjectId.isValid(hubBId)) {
        return next(new ErrorHandler("hubBId is required and must be a valid ObjectId.", 400));
      }
      if (hubAId === hubBId) {
        return next(new ErrorHandler("hubAId and hubBId must be different branches.", 400));
      }

      // ── Manager resolution ─────────────────────────────────────────────────
      const manager = await ManagerModel.findOne({
        userId: managerId,
        isActive: true,
      }).lean();

      if (!manager) {
        return next(new ErrorHandler("Manager profile not found or inactive.", 404));
      }

      const companyId = manager.companyId;


      const transporter = await TransporterModel.findOne({
        _id: transporterDocId,
        companyId,
      });

      if (!transporter) {
        return next(
          new ErrorHandler("Transporter not found or does not belong to your company.", 404),
        );
      }

      // ── Validate both hubs exist, belong to this company, are regional_main_hub
      const hubAOid = new mongoose.Types.ObjectId(hubAId);
      const hubBOid = new mongoose.Types.ObjectId(hubBId);

      const [hubA, hubB] = await Promise.all([
        BranchModel.findOne({ _id: hubAOid, companyId, branchType: "regional_main_hub" }).lean(),
        BranchModel.findOne({ _id: hubBOid, companyId, branchType: "regional_main_hub" }).lean(),
      ]);

      if (!hubA) {
        return next(
          new ErrorHandler(
            `hubAId (${hubAId}) is not a valid regional_main_hub for this company.`,
            400,
          ),
        );
      }
      if (!hubB) {
        return next(
          new ErrorHandler(
            `hubBId (${hubBId}) is not a valid regional_main_hub for this company.`,
            400,
          ),
        );
      }

      // ── Apply assignment using the model's instance method ─────────────────
      await transporter.assignHubLine(hubAOid, hubBOid);

      return res.status(200).json({
        success: true,
        message: `Transporter assigned to hub line: ${(hubA as any).name} ↔ ${(hubB as any).name}.`,
        data: {
          transporterId: transporter._id,
          transporterType: "hub_to_hub",
          assignedLine: [
            { _id: hubAOid, name: (hubA as any).name, code: (hubA as any).code },
            { _id: hubBOid, name: (hubB as any).name, code: (hubB as any).code },
          ],
        },
      });
    } catch (error: any) {
      // The model's assignHubLine throws a plain Error for bad input
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(", "),
            400,
          ),
        );
      }
      return next(error);
    }
  },
);


// ─────────────────────────────────────────────────────────────────────────────
//  ASSIGN BRANCHES  (hub_to_branch transporter)
//
//  POST /manager/transporters/:id/assign-branches
//  Body: { branchIds: string[] }
//
//  Sets this transporter's type to hub_to_branch and records the set of local
//  branches they deliver manifests to from their home hub.
//  The optimizer will only build stops at branches in this list.
//
//  Validations:
//    • branchIds is a non-empty array
//    • All IDs are valid ObjectIds
//    • All IDs are distinct
//    • All branches belong to this company
//    • All branches are local_branch (not hubs)
//    • Transporter belongs to this company
// ─────────────────────────────────────────────────────────────────────────────

export const assignTransporterBranches = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const managerId = req.user?._id;
      if (!managerId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const { id: transporterDocId } = req.params;
      const { branchIds } = req.body as { branchIds?: string[] };

      // ── Basic input validation ──────────────────────────────────────────────
      if (!transporterDocId || !mongoose.Types.ObjectId.isValid(transporterDocId.toString())) {
        return next(new ErrorHandler("Invalid transporter ID.", 400));
      }
      if (!branchIds || !Array.isArray(branchIds) || branchIds.length === 0) {
        return next(new ErrorHandler("branchIds must be a non-empty array.", 400));
      }

      const invalidIds = branchIds.filter((id) => !mongoose.Types.ObjectId.isValid(id));
      if (invalidIds.length > 0) {
        return next(
          new ErrorHandler(
            `Invalid branch ID(s): ${invalidIds.join(", ")}`,
            400,
          ),
        );
      }

      const uniqueBranchIds = [...new Set(branchIds)];
      if (uniqueBranchIds.length !== branchIds.length) {
        return next(new ErrorHandler("branchIds must not contain duplicates.", 400));
      }

      // ── Manager resolution ─────────────────────────────────────────────────
      const manager = await ManagerModel.findOne({
        userId: managerId,
        isActive: true,
      }).lean();

      if (!manager) {
        return next(new ErrorHandler("Manager profile not found or inactive.", 404));
      }

      const companyId = manager.companyId;

      // ── Validate transporter belongs to this company ────────────────────────
      const transporter = await TransporterModel.findOne({
        _id: transporterDocId,
        companyId,
      });

      if (!transporter) {
        return next(
          new ErrorHandler("Transporter not found or does not belong to your company.", 404),
        );
      }

      // ── Validate all branches exist, belong to this company, are local_branch ─
      const branchOids = uniqueBranchIds.map((id) => new mongoose.Types.ObjectId(id));

      const foundBranches = await BranchModel.find({
        _id: { $in: branchOids },
        companyId,
      })
        .select("_id name code branchType")
        .lean();

      if (foundBranches.length !== branchOids.length) {
        const foundIds = new Set(foundBranches.map((b) => b._id.toString()));
        const missingIds = uniqueBranchIds.filter((id) => !foundIds.has(id));
        return next(
          new ErrorHandler(
            `The following branch ID(s) were not found in your company: ${missingIds.join(", ")}`,
            400,
          ),
        );
      }

      const hubBranches = foundBranches.filter(
        (b) => (b as any).branchType === "regional_main_hub",
      );
      if (hubBranches.length > 0) {
        return next(
          new ErrorHandler(
            `The following ID(s) are hubs, not local branches — a hub_to_branch transporter ` +
            `serves local branches only: ${hubBranches.map((b) => (b as any).code).join(", ")}`,
            400,
          ),
        );
      }

      // ── Apply assignment using the model's instance method ─────────────────
      await transporter.assignBranches(branchOids);

      return res.status(200).json({
        success: true,
        message: `Transporter assigned to ${branchOids.length} local branch(es).`,
        data: {
          transporterId: transporter._id,
          transporterType: "hub_to_branch",
          assignedBranches: foundBranches.map((b) => ({
            _id: b._id,
            name: (b as any).name,
            code: (b as any).code,
          })),
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
    }
  },
);



//functions from the tarrifs and below are not tested
//in the supervisor controller i made the verification status and the status active for the create transproter and deliverer and freelancer
//we can add later a function to activate them / desactivate    
//missing stats update (in the supervisor and the other controllers) when creating deliverer / transporter / accepting a package by cashier , creating cashier or a loader ..etc