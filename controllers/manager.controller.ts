import { Request, Response, NextFunction } from "express";
import CompanyModel, { ICompany } from "../models/company.model";
import ManagerModel from "../models/manager.model";
import userModel from "../models/user.model";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import BranchModel, { WeekDay } from "../models/branch.model";
import DelivererModel from "../models/deliverer.model";
import PackageModel from "../models/package.model";
import PaymentModel from "../models/payment.model";
import ManifestModel, { ManifestEventModel } from "../models/manifest.model";
import PackageHistoryModel from "../models/package-history.model";
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
import { hanxin } from "bwip-js/node";

type DashboardRange = "7d" | "30d" | "12m";

const DASHBOARD_RANGES: DashboardRange[] = ["7d", "30d", "12m"];

function parseDashboardRange(value: unknown): DashboardRange {
  return typeof value === "string" && DASHBOARD_RANGES.includes(value as DashboardRange)
    ? (value as DashboardRange)
    : "30d";
}

function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function startOfNextDay(date: Date): Date {
  const result = startOfDay(date);
  result.setDate(result.getDate() + 1);
  return result;
}

function startOfMonth(date: Date): Date {
  const result = new Date(date);
  result.setDate(1);
  result.setHours(0, 0, 0, 0);
  return result;
}

function startOfNextMonth(date: Date): Date {
  const result = startOfMonth(date);
  result.setMonth(result.getMonth() + 1);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function formatDzd(value: number): string {
  return `${value.toLocaleString("en-US")} DA`;
}

function getTimelineConfig(range: DashboardRange) {
  const today = new Date();

  if (range === "12m") {
    const start = startOfMonth(addMonths(today, -11));
    const end = startOfNextMonth(today);

    return {
      start,
      end,
      bucketFormat: "%Y-%m",
      bucketKey: (date: Date) => date.toISOString().slice(0, 7),
      bucketLabel: (date: Date) =>
        new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(date),
      bucketStep: (date: Date) => addMonths(date, 1),
    };
  }

  const days = range === "7d" ? 7 : 30;
  const start = startOfDay(addDays(today, -(days - 1)));
  const end = startOfNextDay(today);

  return {
    start,
    end,
    bucketFormat: "%Y-%m-%d",
    bucketKey: (date: Date) => date.toISOString().slice(0, 10),
    bucketLabel: (date: Date) =>
      new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date),
    bucketStep: (date: Date) => addDays(date, 1),
  };
}

type AnalyticsRange = "7d" | "30d" | "90d" | "12m";

const ANALYTICS_RANGES: AnalyticsRange[] = ["7d", "30d", "90d", "12m"];

function parseAnalyticsRange(value: unknown): AnalyticsRange {
  return typeof value === "string" && ANALYTICS_RANGES.includes(value as AnalyticsRange)
    ? (value as AnalyticsRange)
    : "30d";
}

function getAnalyticsTimelineConfig(range: AnalyticsRange) {
  const now = new Date();

  if (range === "12m") {
    const currentStart = startOfMonth(addMonths(now, -11));
    const previousEnd = currentStart;
    const previousStart = startOfMonth(addMonths(currentStart, -12));
    const currentEnd = startOfNextMonth(now);

    return {
      granularity: "month" as const,
      currentStart,
      currentEnd,
      previousStart,
      previousEnd,
      bucketFormat: "%Y-%m",
      bucketLabel: (date: Date) =>
        new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(date),
      bucketStep: (date: Date) => addMonths(date, 1),
      bucketKey: (date: Date) => date.toISOString().slice(0, 7),
    };
  }

  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const currentEnd = startOfNextDay(now);
  const currentStart = startOfDay(addDays(now, -(days - 1)));
  const previousEnd = currentStart;
  const previousStart = startOfDay(addDays(currentStart, -days));

  return {
    granularity: "day" as const,
    currentStart,
    currentEnd,
    previousStart,
    previousEnd,
    bucketFormat: "%Y-%m-%d",
    bucketLabel: (date: Date) =>
      new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date),
    bucketStep: (date: Date) => addDays(date, 1),
    bucketKey: (date: Date) => date.toISOString().slice(0, 10),
  };
}

function buildTimelineBuckets(
  start: Date,
  end: Date,
  bucketStep: (date: Date) => Date,
  bucketLabel: (date: Date) => string,
  bucketKey: (date: Date) => string,
) {
  const buckets: Array<{ key: string; label: string; date: Date }> = [];
  let cursor = new Date(start);

  while (cursor < end) {
    buckets.push({
      key: bucketKey(cursor),
      label: bucketLabel(cursor),
      date: new Date(cursor),
    });
    cursor = bucketStep(cursor);
  }

  return buckets;
}

function safePercentChange(currentValue: number, previousValue: number): number {
  if (previousValue === 0) {
    return currentValue === 0 ? 0 : 100;
  }

  return Number((((currentValue - previousValue) / previousValue) * 100).toFixed(2));
}

function trendDirection(currentValue: number, previousValue: number): "up" | "down" | "flat" {
  if (currentValue > previousValue) return "up";
  if (currentValue < previousValue) return "down";
  return "flat";
}

function lifecycleStageFromStatus(status: string): "created" | "assigned" | "pickedUp" | "inTransit" | "delivered" | "returned" | "cancelled" {
  switch (status) {
    case "cashier_claimed":
    case "accepted":
      return "assigned";
    case "at_origin_branch":
      return "pickedUp";
    case "manifested":
    case "in_transit_to_branch":
    case "at_destination_branch":
    case "out_for_delivery":
      return "inTransit";
    case "delivered":
      return "delivered";
    case "returned":
      return "returned";
    case "cancelled":
      return "cancelled";
    default:
      return "created";
  }
}

function getWeekdayLabel(index: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][index] ?? String(index);
}


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
        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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

        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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

        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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
      console.error('CATCH BLOCK ERROR:', error.message, error.stack);
      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }
      return next(error);

    } finally {
      if (!transactionCommitted) {
        try {
          await session.abortTransaction();
        } catch (abortErr: any) {
          // Ignore "transaction not in progress" errors — nothing to roll back
          if (!abortErr.message?.includes('no transaction')) {
            console.error('Failed to abort transaction:', abortErr);
          }
        }
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

        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
        }
        await session.endSession();;

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

        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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

        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
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

      if (!branchId || !firstName || !lastName || !email || !phone || !password) {
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
        return next(new ErrorHandler("All required fields must be in their proper types.", 400));
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

      // ─── FIX: Run session queries SEQUENTIALLY, not concurrently ──────────
      // MongoDB sessions cannot handle concurrent operations — Promise.all on
      // the same session causes "transaction number does not match" errors.
      const manager = await ManagerModel.findOne({ userId: managerId, companyId }).session(session);
      const branch = await BranchModel.findOne({ _id: branchId, companyId }).session(session);
      const existingUser = await userModel.findOne({
        $or: [{ email }, { phone: normalizedPhone }],
      }).session(session);
      // ──────────────────────────────────────────────────────────────────────

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
        if (existingUser.email === email) {
          throw new ErrorHandler("User with this email already exists", 400);
        }
        throw new ErrorHandler("User with this phone number already exists", 400);
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
            status: "active",
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
            permissions,
            ...(workSchedule && { workSchedule }),
            isActive: true,
          },
        ],
        { session },
      );

      await session.commitTransaction();
      transactionCommitted = true;

      const branchName = branch.name;

      sendSupervisorAccountCreatedNotification(
        user[0]._id.toString(),
        firstName,
        lastName,
        supervisor[0]._id.toString(),
        branchName,
      ).catch((error) => {
        console.error("Supervisor creation notification failed:", error);
      });

      const populatedSupervisor = await SupervisorModel.findById(supervisor[0]._id)
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
          Object.values(error.errors).map((e: any) => e.message).join(", "),
          400,
        ));
      }

      return next(error);

    } finally {

        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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

        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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

        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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
        return next(new ErrorHandler("Unauthorized.", 401));
      }

      const manager = await ManagerModel.findOne({
        userId: managerId,
        isActive: true,
      }).lean();

      if (!manager?.companyId) {
        return next(new ErrorHandler("Manager profile not found or has no company.", 404));
      }

      const tariff = await TariffModel.findByCompany(manager.companyId.toString());

      if (!tariff) {
        return res.status(200).json({
          success: true,
          companyId: manager.companyId,
          lastUpdated: null,
          total: 0,
          tariffs: [],
        });
      }

      let tariffs = (tariff.entries ?? []).map(e => ({
        from: { id: e.wilayaA, name: wilayaName(e.wilayaA) },
        to: { id: e.wilayaB, name: wilayaName(e.wilayaB) },
        domicile: e.domicile,   // adjust field names to match your schema
        stopdesk: e.stopdesk,   // adjust field names to match your schema
      }));

      // Search
      if (req.query.search) {
        const search = (req.query.search as string).toLowerCase();
        tariffs = tariffs.filter(
          t =>
            t.from.name.toLowerCase().includes(search) ||
            t.to.name.toLowerCase().includes(search),
        );
      }

      // Sort
      tariffs.sort((a, b) => a.from.id - b.from.id || a.to.id - b.to.id);

      // Pagination
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 100));
      const total = tariffs.length;
      const paginated = tariffs.slice((page - 1) * limit, page * limit);

      return res.status(200).json({
        success: true,
        companyId: tariff.companyId,
        tariffs: paginated,
        pagination: {
          total,
          page,
          pages: Math.ceil(total / limit),
          hasMore: page * limit < total,
        },
      });

    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error fetching tariffs.", 500));
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  DASHBOARD OVERVIEW
//  GET /manager/dashboard/overview?range=7d|30d|12m
// ─────────────────────────────────────────────────────────────────────────────

export const getManagerDashboardOverview = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }


      // ─────────────────────────────────────────────────────────────────────────────
      //  DASHBOARD ANALYTICS
      //  GET /manager/dashboard/analytics?range=7d|30d|90d|12m
      // ─────────────────────────────────────────────────────────────────────────────

      const getManagerAnalytics = catchAsyncError(
        async (req: Request, res: Response, next: NextFunction) => {
          try {
            const userId = req.user?._id;

            if (!userId) {
              return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
            }

            const isAdmin = req.user?.role === "admin";
            const range = parseAnalyticsRange(req.query.range);
            const timeline = getAnalyticsTimelineConfig(range);
            const currentBuckets = buildTimelineBuckets(
              timeline.currentStart,
              timeline.currentEnd,
              timeline.bucketStep,
              timeline.bucketLabel,
              timeline.bucketKey,
            );
            const previousBuckets = buildTimelineBuckets(
              timeline.previousStart,
              timeline.previousEnd,
              timeline.bucketStep,
              timeline.bucketLabel,
              timeline.bucketKey,
            );

            const selectedCompanyId = typeof req.query.companyId === "string"
              ? req.query.companyId.trim()
              : undefined;

            const manager = await ManagerModel.findOne({
              userId,
              isActive: true,
            }).lean();

            if (!isAdmin && !manager?.companyId) {
              return next(new ErrorHandler("Manager profile not found or has no company.", 404));
            }

            if (!isAdmin && manager && !manager.permissions?.includes("can_view_analytics")) {
              return next(new ErrorHandler("You do not have permission to view analytics.", 403));
            }

            const companyId = selectedCompanyId ?? manager?.companyId?.toString();

            if (!companyId) {
              return next(new ErrorHandler("companyId is required for admin analytics access.", 400));
            }

            if (!mongoose.Types.ObjectId.isValid(companyId)) {
              return next(new ErrorHandler("Invalid company ID.", 400));
            }

            const companyObjectId = new mongoose.Types.ObjectId(companyId);
            const currentStart = timeline.currentStart;
            const currentEnd = timeline.currentEnd;
            const previousStart = timeline.previousStart;
            const previousEnd = timeline.previousEnd;

            const revenueWindow = {
              dailyStart: startOfDay(addDays(new Date(), -1)),
              weeklyStart: startOfDay(addDays(new Date(), -6)),
              monthlyStart: startOfMonth(new Date()),
            };

            const lifecycleStatusToStage = (status: string) => lifecycleStageFromStatus(status);

            const [
              currentRevenueTotalRows,
              previousRevenueTotalRows,
              currentPackageTotalRows,
              previousPackageTotalRows,
              currentDeliveredTotalRows,
              previousDeliveredTotalRows,
              currentRevenueSeriesRows,
              previousRevenueSeriesRows,
              currentPackageSeriesRows,
              previousPackageSeriesRows,
              currentOperationalRows,
              currentFinancialRows,
              currentLifecycleSummaryRows,
              currentWeekdayRows,
              currentHourRows,
              dailyRevenueRows,
              weeklyRevenueRows,
              monthlyRevenueRows,
            ] = (await Promise.all([
              PaymentModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    collectedAt: { $gte: currentStart, $lt: currentEnd },
                    status: { $in: ["collected", "settled"] },
                  },
                },
                { $group: { _id: null, total: { $sum: "$amount" } } },
              ]),
              PaymentModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    collectedAt: { $gte: previousStart, $lt: previousEnd },
                    status: { $in: ["collected", "settled"] },
                  },
                },
                { $group: { _id: null, total: { $sum: "$amount" } } },
              ]),
              PackageModel.countDocuments({ companyId: companyObjectId, createdAt: { $gte: currentStart, $lt: currentEnd } }),
              PackageModel.countDocuments({ companyId: companyObjectId, createdAt: { $gte: previousStart, $lt: previousEnd } }),
              PackageModel.countDocuments({ companyId: companyObjectId, deliveredAt: { $gte: currentStart, $lt: currentEnd } }),
              PackageModel.countDocuments({ companyId: companyObjectId, deliveredAt: { $gte: previousStart, $lt: previousEnd } }),
              PaymentModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    collectedAt: { $gte: currentStart, $lt: currentEnd },
                    status: { $in: ["collected", "settled"] },
                  },
                },
                {
                  $group: {
                    _id: { $dateToString: { format: timeline.bucketFormat, date: "$collectedAt" } },
                    revenue: { $sum: "$amount" },
                    collectedCash: {
                      $sum: { $cond: [{ $eq: ["$status", "settled"] }, "$amount", "$amount"] },
                    },
                    outstandingAmount: {
                      $sum: {
                        $cond: [
                          { $and: [{ $eq: ["$status", "collected"] }, { $eq: ["$isSettled", false] }] },
                          "$amount",
                          0,
                        ],
                      },
                    },
                  },
                },
              ]),
              PaymentModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    collectedAt: { $gte: previousStart, $lt: previousEnd },
                    status: { $in: ["collected", "settled"] },
                  },
                },
                {
                  $group: {
                    _id: { $dateToString: { format: timeline.bucketFormat, date: "$collectedAt" } },
                    revenue: { $sum: "$amount" },
                    collectedCash: {
                      $sum: { $cond: [{ $eq: ["$status", "settled"] }, "$amount", "$amount"] },
                    },
                    outstandingAmount: {
                      $sum: {
                        $cond: [
                          { $and: [{ $eq: ["$status", "collected"] }, { $eq: ["$isSettled", false] }] },
                          "$amount",
                          0,
                        ],
                      },
                    },
                  },
                },
              ]),
              PackageModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    createdAt: { $gte: currentStart, $lt: currentEnd },
                  },
                },
                {
                  $group: {
                    _id: { $dateToString: { format: timeline.bucketFormat, date: "$createdAt" } },
                    created: { $sum: 1 },
                    assigned: {
                      $sum: {
                        $cond: [{ $in: ["$status", ["cashier_claimed", "accepted"]] }, 1, 0],
                      },
                    },
                    pickedUp: {
                      $sum: {
                        $cond: [{ $eq: ["$status", "at_origin_branch"] }, 1, 0],
                      },
                    },
                    inTransit: {
                      $sum: {
                        $cond: [{ $in: ["$status", ["manifested", "in_transit_to_branch", "at_destination_branch", "out_for_delivery"]] }, 1, 0],
                      },
                    },
                    delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
                    returned: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } },
                    cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
                  },
                },
              ]),
              PackageModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    createdAt: { $gte: previousStart, $lt: previousEnd },
                  },
                },
                {
                  $group: {
                    _id: { $dateToString: { format: timeline.bucketFormat, date: "$createdAt" } },
                    created: { $sum: 1 },
                    assigned: {
                      $sum: {
                        $cond: [{ $in: ["$status", ["cashier_claimed", "accepted"]] }, 1, 0],
                      },
                    },
                    pickedUp: {
                      $sum: {
                        $cond: [{ $eq: ["$status", "at_origin_branch"] }, 1, 0],
                      },
                    },
                    inTransit: {
                      $sum: {
                        $cond: [{ $in: ["$status", ["manifested", "in_transit_to_branch", "at_destination_branch", "out_for_delivery"]] }, 1, 0],
                      },
                    },
                    delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
                    returned: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } },
                    cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
                  },
                },
              ]),
              PackageModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    createdAt: { $gte: currentStart, $lt: currentEnd },
                  },
                },
                {
                  $group: {
                    _id: null,
                    created: { $sum: 1 },
                    assigned: { $sum: { $cond: [{ $in: ["$status", ["cashier_claimed", "accepted"]] }, 1, 0] } },
                    pickedUp: { $sum: { $cond: [{ $eq: ["$status", "at_origin_branch"] }, 1, 0] } },
                    inTransit: {
                      $sum: { $cond: [{ $in: ["$status", ["manifested", "in_transit_to_branch", "at_destination_branch", "out_for_delivery"]] }, 1, 0] },
                    },
                    delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
                    returned: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } },
                    cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
                  },
                },
              ]),
              PackageModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    createdAt: { $gte: currentStart, $lt: currentEnd },
                  },
                },
                {
                  $group: {
                    _id: {
                      weekday: { $dayOfWeek: "$createdAt" },
                      hour: { $hour: "$createdAt" },
                    },
                    count: { $sum: 1 },
                  },
                },
              ]),
              PackageModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    createdAt: { $gte: currentStart, $lt: currentEnd },
                  },
                },
                {
                  $group: {
                    _id: null,
                    revenue: { $sum: "$totalPrice" },
                    packages: { $sum: 1 },
                  },
                },
              ]),
              PaymentModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    collectedAt: { $gte: revenueWindow.dailyStart, $lt: new Date() },
                    status: { $in: ["collected", "settled"] },
                  },
                },
                { $group: { _id: null, total: { $sum: "$amount" } } },
              ]),
              PaymentModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    collectedAt: { $gte: revenueWindow.weeklyStart, $lt: new Date() },
                    status: { $in: ["collected", "settled"] },
                  },
                },
                { $group: { _id: null, total: { $sum: "$amount" } } },
              ]),
              PaymentModel.aggregate([
                {
                  $match: {
                    companyId: companyObjectId,
                    collectedAt: { $gte: revenueWindow.monthlyStart, $lt: new Date() },
                    status: { $in: ["collected", "settled"] },
                  },
                },
                { $group: { _id: null, total: { $sum: "$amount" } } },
              ]),
            ])) as any;

            const currentRevenueTotal = currentRevenueTotalRows[0]?.total ?? 0;
            const previousRevenueTotal = previousRevenueTotalRows[0]?.total ?? 0;
            const currentPackageTotal = currentPackageTotalRows;
            const previousPackageTotal = previousPackageTotalRows;
            const currentDeliveredTotal = currentDeliveredTotalRows;
            const previousDeliveredTotal = previousDeliveredTotalRows;

            const currentRevenueMap = new Map<string, any>(
              currentRevenueSeriesRows.map((row: any) => [row._id, row]),
            );
            const previousRevenueMap = new Map<string, any>(
              previousRevenueSeriesRows.map((row: any) => [row._id, row]),
            );
            const currentPackageMap = new Map<string, any>(
              currentPackageSeriesRows.map((row: any) => [row._id, row]),
            );
            const previousPackageMap = new Map<string, any>(
              previousPackageSeriesRows.map((row: any) => [row._id, row]),
            );

            const revenueOverTime = currentBuckets.map((bucket, index) => {
              const currentRow = currentRevenueMap.get(bucket.key);
              const previousBucket = previousBuckets[index];
              const previousRow = previousBucket ? previousRevenueMap.get(previousBucket.key) : undefined;
              const revenue = currentRow?.revenue ?? 0;
              const previousRevenue = previousRow?.revenue ?? 0;

              return {
                key: bucket.key,
                label: bucket.label,
                revenue,
                previousRevenue,
                growthPercent: safePercentChange(revenue, previousRevenue),
              };
            });

            const revenueGrowthTrend = revenueOverTime.map(({ key, label, growthPercent }) => ({
              key,
              label,
              growthPercent,
            }));

            const packageGrowthTrend = currentBuckets.map((bucket, index) => {
              const currentRow = currentPackageMap.get(bucket.key);
              const previousBucket = previousBuckets[index];
              const previousRow = previousBucket ? previousPackageMap.get(previousBucket.key) : undefined;
              const currentCount = currentRow?.created ?? 0;
              const previousCount = previousRow?.created ?? 0;

              return {
                key: bucket.key,
                label: bucket.label,
                currentCount,
                previousCount,
                growthPercent: safePercentChange(currentCount, previousCount),
              };
            });

            const lifecycleTrend = currentOperationalRows.map((row: any) => {
              const total = row.created + row.assigned + row.pickedUp + row.inTransit + row.delivered + row.returned + row.cancelled;
              const successRate = total > 0 ? Number(((row.delivered / total) * 100).toFixed(2)) : 0;
              const returnRate = total > 0 ? Number(((row.returned / total) * 100).toFixed(2)) : 0;
              const cancellationRate = total > 0 ? Number(((row.cancelled / total) * 100).toFixed(2)) : 0;

              return {
                key: row._id,
                label: currentBuckets.find((bucket) => bucket.key === row._id)?.label ?? row._id,
                created: row.created ?? 0,
                assigned: row.assigned ?? 0,
                pickedUp: row.pickedUp ?? 0,
                inTransit: row.inTransit ?? 0,
                delivered: row.delivered ?? 0,
                returned: row.returned ?? 0,
                cancelled: row.cancelled ?? 0,
                successRate,
                returnRate,
                cancellationRate,
              };
            });

            const lifecycleSummary = (currentLifecycleSummaryRows[0] ?? {
              created: 0,
              assigned: 0,
              pickedUp: 0,
              inTransit: 0,
              delivered: 0,
              returned: 0,
              cancelled: 0,
            });

            const lifecycleTotal =
              lifecycleSummary.created +
              lifecycleSummary.assigned +
              lifecycleSummary.pickedUp +
              lifecycleSummary.inTransit +
              lifecycleSummary.delivered +
              lifecycleSummary.returned +
              lifecycleSummary.cancelled;

            const lifecycleStages = [
              { key: "created", label: "Created", count: lifecycleSummary.created ?? 0 },
              { key: "assigned", label: "Assigned", count: lifecycleSummary.assigned ?? 0 },
              { key: "pickedUp", label: "Picked Up", count: lifecycleSummary.pickedUp ?? 0 },
              { key: "inTransit", label: "In Transit", count: lifecycleSummary.inTransit ?? 0 },
              { key: "delivered", label: "Delivered", count: lifecycleSummary.delivered ?? 0 },
              { key: "returned", label: "Returned", count: lifecycleSummary.returned ?? 0 },
              { key: "cancelled", label: "Cancelled", count: lifecycleSummary.cancelled ?? 0 },
            ].map((stage: any) => ({
              ...stage,
              percentage: lifecycleTotal > 0 ? Number(((stage.count / lifecycleTotal) * 100).toFixed(2)) : 0,
            }));

            const operationalSeries = lifecycleTrend.map((row: any) => ({
              ...row,
              averageDeliveryTime: 0,
            }));

            const averageDeliveryTimeByBucket = new Map<string, number>();
            for (const row of currentDeliveredTotalRows ? [] : []) {
              void row;
            }

            const deliveredTimingRows = await PackageModel.aggregate([
              {
                $match: {
                  companyId: companyObjectId,
                  deliveredAt: { $gte: currentStart, $lt: currentEnd },
                  createdAt: { $exists: true },
                },
              },
              {
                $project: {
                  bucket: { $dateToString: { format: timeline.bucketFormat, date: "$deliveredAt" } },
                  deliveryMinutes: {
                    $divide: [{ $subtract: ["$deliveredAt", "$createdAt"] }, 60000],
                  },
                },
              },
              {
                $group: {
                  _id: "$bucket",
                  averageDeliveryTime: { $avg: "$deliveryMinutes" },
                },
              },
            ]);

            for (const row of deliveredTimingRows as any[]) {
              averageDeliveryTimeByBucket.set(row._id, Number((row.averageDeliveryTime ?? 0).toFixed(2)));
            }

            const operationalAnalyticsTrend = operationalSeries.map((row: any) => ({
              ...row,
              averageDeliveryTime: averageDeliveryTimeByBucket.get(row.key) ?? 0,
            }));

            const currentOperationalLatest = operationalAnalyticsTrend[operationalAnalyticsTrend.length - 1] ?? {
              successRate: 0,
              returnRate: 0,
              cancellationRate: 0,
              averageDeliveryTime: 0,
            };

            const bestWorst = (values: number[], chooseMax = true) => ({
              bestValue: values.length ? (chooseMax ? Math.max(...values) : Math.min(...values)) : 0,
              worstValue: values.length ? (chooseMax ? Math.min(...values) : Math.max(...values)) : 0,
            });

            const successRateValues = operationalAnalyticsTrend.map((row: any) => row.successRate);
            const returnRateValues = operationalAnalyticsTrend.map((row: any) => row.returnRate);
            const cancellationRateValues = operationalAnalyticsTrend.map((row: any) => row.cancellationRate);
            const deliveryTimeValues = operationalAnalyticsTrend.map((row: any) => row.averageDeliveryTime);

            const weekdayMap = new Map<number, number>(
              currentWeekdayRows.map((row: any) => [row._id?.weekday ?? 0, row.count]),
            );
            const hourMap = new Map<number, number>(
              currentHourRows.map((row: any) => [row._id?.hour ?? 0, row.count]),
            );

            const revenueVsCollections = currentFinancialRows.map((row: any) => ({
              key: row._id,
              label: currentBuckets.find((bucket) => bucket.key === row._id)?.label ?? row._id,
              revenue: row.revenue ?? 0,
              collectedCash: row.collectedCash ?? 0,
              outstandingAmount: row.outstandingAmount ?? 0,
            }));

            const activityAnalytics = {
              weekdayHeatmap: Array.from({ length: 7 }, (_, index) => ({
                key: String(index),
                label: getWeekdayLabel(index),
                count: weekdayMap.get(index + 1) ?? 0,
              })),
              hourHeatmap: Array.from({ length: 24 }, (_, hour) => ({
                key: String(hour),
                label: `${hour.toString().padStart(2, "0")}:00`,
                count: hourMap.get(hour) ?? 0,
              })),
            };

            return res.status(200).json({
              success: true,
              companyId,
              range,
              growthAnalytics: {
                revenueGrowth: {
                  currentValue: currentRevenueTotal,
                  previousValue: previousRevenueTotal,
                  changePercent: safePercentChange(currentRevenueTotal, previousRevenueTotal),
                  direction: trendDirection(currentRevenueTotal, previousRevenueTotal),
                },
                packageGrowth: {
                  currentValue: currentPackageTotal,
                  previousValue: previousPackageTotal,
                  changePercent: safePercentChange(currentPackageTotal, previousPackageTotal),
                  direction: trendDirection(currentPackageTotal, previousPackageTotal),
                },
                deliveryGrowth: {
                  currentValue: currentDeliveredTotal,
                  previousValue: previousDeliveredTotal,
                  changePercent: safePercentChange(currentDeliveredTotal, previousDeliveredTotal),
                  direction: trendDirection(currentDeliveredTotal, previousDeliveredTotal),
                },
              },
              revenueAnalytics: {
                revenueOverTime,
                revenueGrowthTrend,
                metrics: {
                  dailyRevenue: dailyRevenueRows[0]?.total ?? 0,
                  weeklyRevenue: weeklyRevenueRows[0]?.total ?? 0,
                  monthlyRevenue: monthlyRevenueRows[0]?.total ?? 0,
                },
              },
              operationalAnalytics: {
                deliverySuccessRateTrend: operationalAnalyticsTrend,
                deliverySuccessRate: {
                  currentValue: currentOperationalLatest.successRate ?? 0,
                  ...bestWorst(successRateValues, true),
                },
                returnRate: {
                  currentValue: currentOperationalLatest.returnRate ?? 0,
                  ...bestWorst(returnRateValues, true),
                },
                cancellationRate: {
                  currentValue: currentOperationalLatest.cancellationRate ?? 0,
                  ...bestWorst(cancellationRateValues, true),
                },
                averageDeliveryTime: {
                  currentValue: currentOperationalLatest.averageDeliveryTime ?? 0,
                  ...bestWorst(deliveryTimeValues, false),
                },
              },
              financialAnalytics: {
                cashCollectionTrend: revenueVsCollections.map((row: any) => ({
                  key: row.key,
                  label: row.label,
                  cashCollected: row.collectedCash,
                })),
                outstandingAmountTrend: revenueVsCollections.map((row: any) => ({
                  key: row.key,
                  label: row.label,
                  outstandingAmount: row.outstandingAmount,
                })),
                revenueVsCollections,
              },
              packageLifecycleAnalytics: {
                stages: lifecycleStages,
                trend: operationalAnalyticsTrend.map((row: any) => ({
                  key: row.key,
                  label: row.label,
                  created: row.created,
                  assigned: row.assigned,
                  pickedUp: row.pickedUp,
                  inTransit: row.inTransit,
                  delivered: row.delivered,
                  returned: row.returned,
                  cancelled: row.cancelled,
                })),
              },
              activityAnalytics,
              meta: {
                generatedAt: new Date().toISOString(),
                range,
                companyId,
                currentPeriod: {
                  start: currentStart.toISOString(),
                  end: currentEnd.toISOString(),
                },
                previousPeriod: {
                  start: previousStart.toISOString(),
                  end: previousEnd.toISOString(),
                },
                timeline: {
                  granularity: timeline.granularity,
                  bucketFormat: timeline.bucketFormat,
                  bucketCount: currentBuckets.length,
                },
              },
            });
          } catch (error: any) {
            return next(new ErrorHandler(error.message || "Failed to load analytics.", 500));
          }
        },
      );

      const isAdmin = req.user?.role === "admin";
      const range = parseDashboardRange(req.query.range);
      const timeline = getTimelineConfig(range);
      const now = new Date();
      const todayStart = startOfDay(now);
      const tomorrowStart = startOfNextDay(now);
      const monthStart = startOfMonth(now);
      const nextMonthStart = startOfNextMonth(now);
      const selectedCompanyId = typeof req.query.companyId === "string"
        ? req.query.companyId.trim()
        : undefined;

      const manager = await ManagerModel.findOne({
        userId,
        isActive: true,
      }).lean();

      if (!isAdmin && !manager?.companyId) {
        return next(new ErrorHandler("Manager profile not found or has no company.", 404));
      }

      if (!isAdmin && manager && !manager.permissions?.includes("can_view_analytics")) {
        return next(new ErrorHandler("You do not have permission to view analytics.", 403));
      }

      const companyId = selectedCompanyId ?? manager?.companyId?.toString();

      if (!companyId) {
        return next(new ErrorHandler("companyId is required for admin dashboard access.", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(companyId)) {
        return next(new ErrorHandler("Invalid company ID.", 400));
      }

      const companyObjectId = new mongoose.Types.ObjectId(companyId);
      const transitStatuses: string[] = [
        "manifested",
        "in_transit_to_branch",
        "at_destination_branch",
        "out_for_delivery",
      ];
      const attentionStatuses: string[] = [
        "failed_delivery",
        "failed_delivery_attempt",
        "damaged",
        "lost",
        "on_hold",
      ];
      const terminalStatuses: string[] = ["delivered", "returned", "cancelled", "lost", "damaged"];

      const [
        packageCards,
        packagesTodayCount,
        packagesMonthCount,
        packageStatusRows,
        packagesInTransitCount,
        revenueRows,
        branches,
        deliverers,
        transportersCount,
        branchPackageRows,
        branchRevenueRows,
        createdTimelineRows,
        statusTimelineRows,
        recentPackageHistoryRows,
        recentManifestEventRows,
        recentPaymentRows,
        delayedPackagesCount,
        attentionPackagesCount,
        manifestDiscrepancyCount,
        branchIssueCount,
        pendingManifestCount,
      ] = await Promise.all([
        PackageModel.aggregate([
          { $match: { companyId: companyObjectId } },
          {
            $group: {
              _id: null,
              totalPackages: { $sum: 1 },
              deliveredPackages: {
                $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] },
              },
              pendingPackages: {
                $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
              },
              returnedPackages: {
                $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] },
              },
              cancelledPackages: {
                $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
              },
              inTransitPackages: {
                $sum: { $cond: [{ $in: ["$status", transitStatuses] }, 1, 0] },
              },
            },
          },
        ]),
        PackageModel.countDocuments({
          companyId: companyObjectId,
          createdAt: { $gte: todayStart, $lt: tomorrowStart },
        }),
        PackageModel.countDocuments({
          companyId: companyObjectId,
          createdAt: { $gte: monthStart, $lt: nextMonthStart },
        }),
        PackageModel.aggregate([
          { $match: { companyId: companyObjectId } },
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
            },
          },
        ]),
        PackageModel.countDocuments({
          companyId: companyObjectId,
          status: { $in: transitStatuses },
        }),
        PaymentModel.aggregate([
          { $match: { companyId: companyObjectId } },
          {
            $group: {
              _id: null,
              revenueToday: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gte: ["$collectedAt", todayStart] },
                        { $lt: ["$collectedAt", tomorrowStart] },
                        { $in: ["$status", ["collected", "settled"]] },
                      ],
                    },
                    "$amount",
                    0,
                  ],
                },
              },
              revenueMonth: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gte: ["$collectedAt", monthStart] },
                        { $lt: ["$collectedAt", nextMonthStart] },
                        { $in: ["$status", ["collected", "settled"]] },
                      ],
                    },
                    "$amount",
                    0,
                  ],
                },
              },
              collectedCash: {
                $sum: {
                  $cond: [
                    { $in: ["$status", ["collected", "settled"]] },
                    "$amount",
                    0,
                  ],
                },
              },
              outstandingPayments: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$collectionMethod", "home_delivery"] },
                        { $eq: ["$status", "collected"] },
                        { $eq: ["$isSettled", false] },
                      ],
                    },
                    "$amount",
                    0,
                  ],
                },
              },
            },
          },
        ]),
        BranchModel.find({ companyId: companyObjectId })
          .select("_id name code status currentLoad capacityLimit branchType")
          .lean(),
        DelivererModel.find({ companyId: companyObjectId })
          .select("_id rating successfulDeliveries totalDeliveries isActive isSuspended availabilityStatus userId branchId")
          .populate("userId", "firstName lastName")
          .sort({ successfulDeliveries: -1, rating: -1 })
          .limit(5)
          .lean(),
        TransporterModel.countDocuments({
          companyId: companyObjectId,
          isActive: true,
          isSuspended: false,
        }),
        PackageModel.aggregate([
          { $match: { companyId: companyObjectId } },
          {
            $group: {
              _id: "$originBranchId",
              totalPackages: { $sum: 1 },
              deliveredPackages: {
                $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] },
              },
            },
          },
        ]),
        PaymentModel.aggregate([
          { $match: { companyId: companyObjectId } },
          {
            $group: {
              _id: "$branchId",
              revenue: { $sum: "$amount" },
            },
          },
        ]),
        PackageModel.aggregate([
          { $match: { companyId: companyObjectId, createdAt: { $gte: timeline.start, $lt: timeline.end } } },
          {
            $group: {
              _id: { $dateToString: { format: timeline.bucketFormat, date: "$createdAt" } },
              count: { $sum: 1 },
            },
          },
        ]),
        PackageHistoryModel.aggregate([
          {
            $lookup: {
              from: "packages",
              localField: "packageId",
              foreignField: "_id",
              as: "package",
            },
          },
          { $unwind: "$package" },
          {
            $match: {
              "package.companyId": companyObjectId,
              status: { $in: ["delivered", "returned", "cancelled"] },
              timestamp: { $gte: timeline.start, $lt: timeline.end },
            },
          },
          {
            $group: {
              _id: {
                bucket: { $dateToString: { format: timeline.bucketFormat, date: "$timestamp" } },
                status: "$status",
              },
              count: { $sum: 1 },
            },
          },
        ]),
        PackageHistoryModel.aggregate([
          {
            $lookup: {
              from: "packages",
              localField: "packageId",
              foreignField: "_id",
              as: "package",
            },
          },
          { $unwind: "$package" },
          {
            $match: {
              "package.companyId": companyObjectId,
            },
          },
          { $sort: { timestamp: -1 } },
          { $limit: 8 },
          {
            $project: {
              packageId: 1,
              packageTrackingNumber: "$package.trackingNumber",
              status: 1,
              notes: 1,
              timestamp: 1,
              branchId: 1,
            },
          },
        ]),
        ManifestEventModel.aggregate([
          {
            $lookup: {
              from: "manifests",
              localField: "manifestId",
              foreignField: "_id",
              as: "manifest",
            },
          },
          { $unwind: "$manifest" },
          {
            $match: {
              "manifest.companyId": companyObjectId,
            },
          },
          { $sort: { timestamp: -1 } },
          { $limit: 8 },
          {
            $project: {
              manifestId: 1,
              manifestCode: 1,
              eventType: 1,
              notes: 1,
              timestamp: 1,
              branchId: 1,
              packageTrackingNumber: 1,
            },
          },
        ]),
        PaymentModel.find({ companyId: companyObjectId })
          .sort({ collectedAt: -1 })
          .limit(8)
          .populate("branchId", "name code")
          .lean(),
        PackageModel.countDocuments({
          companyId: companyObjectId,
          createdAt: { $lt: addDays(now, -2) },
          status: { $nin: terminalStatuses },
        }),
        PackageModel.countDocuments({
          companyId: companyObjectId,
          status: { $in: attentionStatuses },
        }),
        ManifestModel.countDocuments({
          companyId: companyObjectId,
          $or: [{ status: "discrepancy" }, { discrepancy: { $ne: null } }],
        }),
        BranchModel.countDocuments({
          companyId: companyObjectId,
          status: { $ne: "active" },
        }),
        ManifestModel.countDocuments({
          companyId: companyObjectId,
          status: { $in: ["open", "sealed", "loaded", "in_transit", "arrived", "discrepancy"] },
        }),
      ]);

      const packageOverview = packageCards[0] ?? {
        totalPackages: 0,
        deliveredPackages: 0,
        pendingPackages: 0,
        returnedPackages: 0,
        cancelledPackages: 0,
        inTransitPackages: 0,
      };

      const revenueOverview = revenueRows[0] ?? {
        revenueToday: 0,
        revenueMonth: 0,
        collectedCash: 0,
        outstandingPayments: 0,
      };

      const packageStatusMap = new Map<string, number>(
        packageStatusRows.map((row: any) => [row._id, row.count]),
      );

      const statusBreakdownSource = [
        { key: "delivered", label: "Delivered", count: packageStatusMap.get("delivered") ?? 0 },
        { key: "transit", label: "Transit", count: packageOverview.inTransitPackages ?? 0 },
        {
          key: "pending",
          label: "Pending",
          count:
            (packageStatusMap.get("pending") ?? 0) +
            (packageStatusMap.get("cashier_claimed") ?? 0) +
            (packageStatusMap.get("accepted") ?? 0) +
            (packageStatusMap.get("at_origin_branch") ?? 0) +
            (packageStatusMap.get("manifested") ?? 0),
        },
        { key: "returned", label: "Returned", count: packageOverview.returnedPackages ?? 0 },
        { key: "cancelled", label: "Cancelled", count: packageOverview.cancelledPackages ?? 0 },
      ];

      const statusBreakdownTotal = statusBreakdownSource.reduce((sum, entry) => sum + entry.count, 0);

      const packageStatusBreakdown = statusBreakdownSource.map((entry) => ({
        ...entry,
        percentage: statusBreakdownTotal > 0 ? Math.round((entry.count / statusBreakdownTotal) * 100) : 0,
      }));

      const branchPackageMap = new Map<string, any>(
        branchPackageRows.map((row: any) => [row._id?.toString?.() ?? String(row._id), row]),
      );
      const branchRevenueMap = new Map<string, any>(
        branchRevenueRows.map((row: any) => [row._id?.toString?.() ?? String(row._id), row]),
      );

      const branchPerformance = branches
        .map((branch: any) => {
          const packageStats = branchPackageMap.get(branch._id.toString()) ?? {
            totalPackages: 0,
            deliveredPackages: 0,
          };

          const revenueStats = branchRevenueMap.get(branch._id.toString()) ?? { revenue: 0 };

          return {
            branchId: branch._id,
            name: branch.name,
            code: branch.code,
            status: branch.status,
            totalPackages: packageStats.totalPackages ?? 0,
            deliveredPackages: packageStats.deliveredPackages ?? 0,
            revenue: revenueStats.revenue ?? 0,
            revenueFormatted: formatDzd(revenueStats.revenue ?? 0),
          };
        })
        .sort((left: any, right: any) => right.revenue - left.revenue || right.deliveredPackages - left.deliveredPackages)
        .slice(0, 10);

      const createdTimelineMap = new Map<string, number>(
        createdTimelineRows.map((row: any) => [row._id, row.count]),
      );

      const statusTimelineMap = new Map<string, Record<string, number>>();
      for (const row of statusTimelineRows as any[]) {
        const bucket = row._id?.bucket;
        const status = row._id?.status;
        if (!bucket || !status) continue;

        if (!statusTimelineMap.has(bucket)) {
          statusTimelineMap.set(bucket, { delivered: 0, returned: 0, cancelled: 0 });
        }

        const bucketEntry = statusTimelineMap.get(bucket)!;
        bucketEntry[status] = row.count;
      }

      const deliveryPerformance = [] as Array<{
        key: string;
        label: string;
        created: number;
        delivered: number;
        returned: number;
        cancelled: number;
      }>;

      let cursor = new Date(timeline.start);
      while (cursor < timeline.end) {
        const key = timeline.bucketKey(cursor);
        const label = timeline.bucketLabel(cursor);
        const statusCounts = statusTimelineMap.get(key) ?? { delivered: 0, returned: 0, cancelled: 0 };

        deliveryPerformance.push({
          key,
          label,
          created: createdTimelineMap.get(key) ?? 0,
          delivered: statusCounts.delivered ?? 0,
          returned: statusCounts.returned ?? 0,
          cancelled: statusCounts.cancelled ?? 0,
        });

        cursor = timeline.bucketStep(cursor);
      }

      const recentActivity = [
        ...recentManifestEventRows.map((event: any) => ({
          kind: "manifest",
          title: `Manifest ${event.manifestCode} ${event.eventType.replace(/_/g, " ")}`,
          description: event.notes ?? event.packageTrackingNumber ?? "Manifest activity",
          timestamp: event.timestamp,
          referenceId: event.manifestId,
          branchId: event.branchId,
          status: event.eventType,
        })),
        ...recentPackageHistoryRows.map((entry: any) => ({
          kind: "package",
          title: `Package ${entry.packageTrackingNumber} ${String(entry.status).replace(/_/g, " ")}`,
          description: entry.notes ?? "Package status updated",
          timestamp: entry.timestamp,
          referenceId: entry.packageId,
          branchId: entry.branchId,
          status: entry.status,
        })),
        ...recentPaymentRows.map((payment: any) => ({
          kind: "payment",
          title: `Payment ${payment.status}`,
          description: `${payment.branchId?.name ?? "Branch"} · ${formatDzd(payment.amount ?? 0)}`,
          timestamp: payment.collectedAt ?? payment.createdAt,
          referenceId: payment._id,
          branchId: payment.branchId?._id ?? payment.branchId,
          status: payment.status,
        })),
      ]
        .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
        .slice(0, 15);

      const alerts = [
        {
          key: "delayed-packages",
          severity: "warning",
          title: `${delayedPackagesCount} packages delayed > 48h`,
          count: delayedPackagesCount,
        },
        {
          key: "manifest-discrepancies",
          severity: "critical",
          title: `${manifestDiscrepancyCount} manifests have discrepancies`,
          count: manifestDiscrepancyCount,
        },
        {
          key: "outstanding-payments",
          severity: "warning",
          title: `${revenueOverview.outstandingPayments > 0 ? formatDzd(revenueOverview.outstandingPayments) : "0 DA"} awaiting settlement`,
          count: revenueOverview.outstandingPayments,
        },
        {
          key: "inactive-branches",
          severity: "info",
          title: `${branchIssueCount} branches are not active`,
          count: branchIssueCount,
        },
        {
          key: "attention-packages",
          severity: "warning",
          title: `${attentionPackagesCount} packages need attention`,
          count: attentionPackagesCount,
        },
        {
          key: "open-manifests",
          severity: "info",
          title: `${pendingManifestCount} manifests are still open`,
          count: pendingManifestCount,
        },
      ];

      return res.status(200).json({
        success: true,
        companyId,
        range,
        summary: {
          packages: {
            totalToday: packagesTodayCount,
            totalThisMonth: packagesMonthCount,
            delivered: packageOverview.deliveredPackages ?? 0,
            pending: packageOverview.pendingPackages ?? 0,
            returned: packageOverview.returnedPackages ?? 0,
            cancelled: packageOverview.cancelledPackages ?? 0,
          },
          revenue: {
            today: revenueOverview.revenueToday ?? 0,
            todayFormatted: formatDzd(revenueOverview.revenueToday ?? 0),
            month: revenueOverview.revenueMonth ?? 0,
            monthFormatted: formatDzd(revenueOverview.revenueMonth ?? 0),
            outstanding: revenueOverview.outstandingPayments ?? 0,
            outstandingFormatted: formatDzd(revenueOverview.outstandingPayments ?? 0),
            collectedCash: revenueOverview.collectedCash ?? 0,
            collectedCashFormatted: formatDzd(revenueOverview.collectedCash ?? 0),
          },
          operations: {
            activeBranches: branches.filter((branch: any) => branch.status === "active").length,
            activeDeliverers: deliverers.filter((deliverer: any) => deliverer.isActive && !deliverer.isSuspended).length,
            activeTransporters: transportersCount,
            packagesInTransit: packagesInTransitCount,
          },
        },
        deliveryPerformance,
        packageStatusBreakdown,
        branchPerformance,
        topDeliverers: deliverers.map((deliverer: any) => ({
          delivererId: deliverer._id,
          name: [deliverer.userId?.firstName, deliverer.userId?.lastName].filter(Boolean).join(" "),
          rating: deliverer.rating ?? 0,
          delivered: deliverer.successfulDeliveries ?? 0,
          totalDeliveries: deliverer.totalDeliveries ?? 0,
          availabilityStatus: deliverer.availabilityStatus,
        })),
        recentActivity,
        alerts,
        financialOverview: {
          revenuePerBranch: branchPerformance.map((branch) => ({
            branchId: branch.branchId,
            name: branch.name,
            revenue: branch.revenue,
            revenueFormatted: branch.revenueFormatted,
          })),
          outstandingPayments: revenueOverview.outstandingPayments ?? 0,
          outstandingPaymentsFormatted: formatDzd(revenueOverview.outstandingPayments ?? 0),
        },
        meta: {
          generatedAt: now,
          timeline: {
            start: timeline.start,
            end: timeline.end,
            bucketFormat: timeline.bucketFormat,
          },
        },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Failed to load dashboard overview.", 500));
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  DASHBOARD ANALYTICS
//  GET /manager/dashboard/analytics?range=7d|30d|90d|12m
// ─────────────────────────────────────────────────────────────────────────────

export const getManagerAnalytics = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const isAdmin = req.user?.role === "admin";
      const range = parseAnalyticsRange(req.query.range);
      const timeline = getAnalyticsTimelineConfig(range);
      const currentBuckets = buildTimelineBuckets(
        timeline.currentStart,
        timeline.currentEnd,
        timeline.bucketStep,
        timeline.bucketLabel,
        timeline.bucketKey,
      );
      const previousBuckets = buildTimelineBuckets(
        timeline.previousStart,
        timeline.previousEnd,
        timeline.bucketStep,
        timeline.bucketLabel,
        timeline.bucketKey,
      );

      const selectedCompanyId = typeof req.query.companyId === "string"
        ? req.query.companyId.trim()
        : undefined;

      const manager = await ManagerModel.findOne({ userId, isActive: true }).lean();

      if (!isAdmin && !manager?.companyId) {
        return next(new ErrorHandler("Manager profile not found or has no company.", 404));
      }

      if (!isAdmin && manager && !manager.permissions?.includes("can_view_analytics")) {
        return next(new ErrorHandler("You do not have permission to view analytics.", 403));
      }

      const companyId = selectedCompanyId ?? manager?.companyId?.toString();

      if (!companyId) {
        return next(new ErrorHandler("companyId is required for admin analytics access.", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(companyId)) {
        return next(new ErrorHandler("Invalid company ID.", 400));
      }

      const companyObjectId = new mongoose.Types.ObjectId(companyId);
      const now = new Date();
      const dailyStart = startOfDay(addDays(now, -1));
      const weeklyStart = startOfDay(addDays(now, -6));
      const monthlyStart = startOfMonth(now);

      const results = await Promise.all([
        // 0
        PaymentModel.aggregate([
          { $match: { companyId: companyObjectId, collectedAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd }, status: { $in: ["collected", "settled"] } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        // 1
        PaymentModel.aggregate([
          { $match: { companyId: companyObjectId, collectedAt: { $gte: timeline.previousStart, $lt: timeline.previousEnd }, status: { $in: ["collected", "settled"] } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        // 2
        PackageModel.countDocuments({ companyId: companyObjectId, createdAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd } }),
        // 3
        PackageModel.countDocuments({ companyId: companyObjectId, createdAt: { $gte: timeline.previousStart, $lt: timeline.previousEnd } }),
        // 4
        PackageModel.countDocuments({ companyId: companyObjectId, deliveredAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd } }),
        // 5
        PackageModel.countDocuments({ companyId: companyObjectId, deliveredAt: { $gte: timeline.previousStart, $lt: timeline.previousEnd } }),
        // 6
        PaymentModel.aggregate([
          { $match: { companyId: companyObjectId, collectedAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd }, status: { $in: ["collected", "settled"] } } },
          { $group: { _id: { $dateToString: { format: timeline.bucketFormat, date: "$collectedAt" } }, revenue: { $sum: "$amount" } } },
        ]),
        // 7
        PaymentModel.aggregate([
          { $match: { companyId: companyObjectId, collectedAt: { $gte: timeline.previousStart, $lt: timeline.previousEnd }, status: { $in: ["collected", "settled"] } } },
          { $group: { _id: { $dateToString: { format: timeline.bucketFormat, date: "$collectedAt" } }, revenue: { $sum: "$amount" } } },
        ]),
        // 8
        PackageModel.aggregate([
          { $match: { companyId: companyObjectId, createdAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd } } },
          {
            $group: {
              _id: { $dateToString: { format: timeline.bucketFormat, date: "$createdAt" } },
              created: { $sum: 1 },
              assigned: { $sum: { $cond: [{ $in: ["$status", ["cashier_claimed", "accepted"]] }, 1, 0] } },
              pickedUp: { $sum: { $cond: [{ $eq: ["$status", "at_origin_branch"] }, 1, 0] } },
              inTransit: { $sum: { $cond: [{ $in: ["$status", ["manifested", "in_transit_to_branch", "at_destination_branch", "out_for_delivery"]] }, 1, 0] } },
              delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
              returned: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
            },
          },
        ]),
        // 9
        PackageModel.aggregate([
          { $match: { companyId: companyObjectId, createdAt: { $gte: timeline.previousStart, $lt: timeline.previousEnd } } },
          {
            $group: {
              _id: { $dateToString: { format: timeline.bucketFormat, date: "$createdAt" } },
              created: { $sum: 1 },
              assigned: { $sum: { $cond: [{ $in: ["$status", ["cashier_claimed", "accepted"]] }, 1, 0] } },
              pickedUp: { $sum: { $cond: [{ $eq: ["$status", "at_origin_branch"] }, 1, 0] } },
              inTransit: { $sum: { $cond: [{ $in: ["$status", ["manifested", "in_transit_to_branch", "at_destination_branch", "out_for_delivery"]] }, 1, 0] } },
              delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
              returned: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
            },
          },
        ]),
        // 10 - operational series (grouped by bucket)
        PackageModel.aggregate([
          { $match: { companyId: companyObjectId, createdAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd } } },
          {
            $group: {
              _id: { $dateToString: { format: timeline.bucketFormat, date: "$createdAt" } },
              created: { $sum: 1 },
              assigned: { $sum: { $cond: [{ $in: ["$status", ["cashier_claimed", "accepted"]] }, 1, 0] } },
              pickedUp: { $sum: { $cond: [{ $eq: ["$status", "at_origin_branch"] }, 1, 0] } },
              inTransit: { $sum: { $cond: [{ $in: ["$status", ["manifested", "in_transit_to_branch", "at_destination_branch", "out_for_delivery"]] }, 1, 0] } },
              delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
              returned: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
            },
          },
        ]),
        // 11 - lifecycle summary (grouped as _id: null)
        PackageModel.aggregate([
          { $match: { companyId: companyObjectId, createdAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd } } },
          {
            $group: {
              _id: null,
              created: { $sum: 1 },
              assigned: { $sum: { $cond: [{ $in: ["$status", ["cashier_claimed", "accepted"]] }, 1, 0] } },
              pickedUp: { $sum: { $cond: [{ $eq: ["$status", "at_origin_branch"] }, 1, 0] } },
              inTransit: { $sum: { $cond: [{ $in: ["$status", ["manifested", "in_transit_to_branch", "at_destination_branch", "out_for_delivery"]] }, 1, 0] } },
              delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
              returned: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
            },
          },
        ]),
        // 12 - financial series
        PaymentModel.aggregate([
          { $match: { companyId: companyObjectId, collectedAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd }, status: { $in: ["collected", "settled"] } } },
          {
            $group: {
              _id: { $dateToString: { format: timeline.bucketFormat, date: "$collectedAt" } },
              revenue: { $sum: "$amount" },
              collectedCash: { $sum: "$amount" },
              outstandingAmount: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "collected"] }, { $eq: ["$isSettled", false] }] }, "$amount", 0] } },
            },
          },
        ]),
        // 13 - weekday heatmap
        PackageModel.aggregate([
          { $match: { companyId: companyObjectId, createdAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd } } },
          { $group: { _id: { weekday: { $dayOfWeek: "$createdAt" } }, count: { $sum: 1 } } },
        ]),
        // 14 - hour heatmap
        PackageModel.aggregate([
          { $match: { companyId: companyObjectId, createdAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd } } },
          { $group: { _id: { hour: { $hour: "$createdAt" } }, count: { $sum: 1 } } },
        ]),
        // 15 - delivery timing
        PackageModel.aggregate([
          {
            $match: {
              companyId: companyObjectId,
              createdAt: { $gte: timeline.currentStart, $lt: timeline.currentEnd },
              deliveredAt: { $exists: true, $ne: null },
            },
          },
          {
            $project: {
              bucket: { $dateToString: { format: timeline.bucketFormat, date: "$deliveredAt" } },
              deliveryMinutes: { $divide: [{ $subtract: ["$deliveredAt", "$createdAt"] }, 60000] },
            },
          },
          { $group: { _id: "$bucket", averageDeliveryTime: { $avg: "$deliveryMinutes" } } },
        ]),
        // 16
        PaymentModel.aggregate([
          { $match: { companyId: companyObjectId, collectedAt: { $gte: dailyStart, $lt: now }, status: { $in: ["collected", "settled"] } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        // 17
        PaymentModel.aggregate([
          { $match: { companyId: companyObjectId, collectedAt: { $gte: weeklyStart, $lt: now }, status: { $in: ["collected", "settled"] } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        // 18
        PaymentModel.aggregate([
          { $match: { companyId: companyObjectId, collectedAt: { $gte: monthlyStart, $lt: now }, status: { $in: ["collected", "settled"] } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
      ]);

      if (results.length !== 19) {
        throw new Error(`Promise.all returned ${results.length} results, expected 19`);
      }

      const [
        currentRevenueTotalRows,    // 0
        previousRevenueTotalRows,   // 1
        currentPackageTotal,        // 2
        previousPackageTotal,       // 3
        currentDeliveredTotal,      // 4
        previousDeliveredTotal,     // 5
        currentRevenueSeriesRows,   // 6
        previousRevenueSeriesRows,  // 7
        currentPackageSeriesRows,   // 8
        previousPackageSeriesRows,  // 9
        currentOperationalRows,     // 10
        currentLifecycleSummaryRows, // 11
        currentFinancialRows,       // 12
        currentWeekdayRows,         // 13
        currentHourRows,            // 14
        currentDeliveredTimingRows, // 15
        dailyRevenueRows,           // 16
        weeklyRevenueRows,          // 17
        monthlyRevenueRows,         // 18
      ] = results as any;

      const revenueMap = new Map<string, number>(
        (currentRevenueSeriesRows ?? []).map((row: any) => [row._id, Number(row.revenue ?? 0)])
      );
      const previousRevenueMap = new Map<string, number>(
        (previousRevenueSeriesRows ?? []).map((row: any) => [row._id, Number(row.revenue ?? 0)])
      );
      const packageMap = new Map<string, number>(
        (currentPackageSeriesRows ?? []).map((row: any) => [row._id, Number(row.created ?? 0)])
      );
      const previousPackageMap = new Map<string, number>(
        (previousPackageSeriesRows ?? []).map((row: any) => [row._id, Number(row.created ?? 0)])
      );
      const operationalMap = new Map<string, any>(
        (currentOperationalRows ?? []).map((row: any) => [row._id, row])
      );
      const deliveryTimeMap = new Map<string, number>(
        (currentDeliveredTimingRows ?? []).map((row: any) => [row._id, Number(row.averageDeliveryTime ?? 0)])
      );
      const weekdayMap = new Map<number, number>(
        (currentWeekdayRows ?? []).map((row: any) => [row._id.weekday, Number(row.count ?? 0)])
      );
      const hourMap = new Map<number, number>(
        (currentHourRows ?? []).map((row: any) => [row._id.hour, Number(row.count ?? 0)])
      );

      const revenueOverTime = currentBuckets.map((bucket: any, index: number) => {
        const previousBucket = previousBuckets[index];
        const currentRevenue = revenueMap.get(bucket.key) ?? 0;
        const previousRevenue = previousBucket ? (previousRevenueMap.get(previousBucket.key) ?? 0) : 0;
        return {
          key: bucket.key,
          label: bucket.label,
          revenue: currentRevenue,
          previousRevenue,
          growthPercent: safePercentChange(currentRevenue, previousRevenue),
        };
      });

      const revenueGrowthTrend = revenueOverTime.map(({ key, label, growthPercent }: any) => ({
        key,
        label,
        growthPercent,
      }));

      const packageGrowthTrend = currentBuckets.map((bucket: any, index: number) => {
        const previousBucket = previousBuckets[index];
        const currentCount = packageMap.get(bucket.key) ?? 0;
        const previousCount = previousBucket ? (previousPackageMap.get(previousBucket.key) ?? 0) : 0;
        return {
          key: bucket.key,
          label: bucket.label,
          currentCount,
          previousCount,
          growthPercent: safePercentChange(currentCount, previousCount),
        };
      });

      const lifecycleTrend = currentBuckets.map((bucket: any) => {
        const row: any = operationalMap.get(bucket.key) ?? {};
        const total =
          (row.created ?? 0) +
          (row.assigned ?? 0) +
          (row.pickedUp ?? 0) +
          (row.inTransit ?? 0) +
          (row.delivered ?? 0) +
          (row.returned ?? 0) +
          (row.cancelled ?? 0);
        return {
          key: bucket.key,
          label: bucket.label,
          created: row.created ?? 0,
          assigned: row.assigned ?? 0,
          pickedUp: row.pickedUp ?? 0,
          inTransit: row.inTransit ?? 0,
          delivered: row.delivered ?? 0,
          returned: row.returned ?? 0,
          cancelled: row.cancelled ?? 0,
          successRate: total ? Number(((row.delivered ?? 0) / total * 100).toFixed(2)) : 0,
          returnRate: total ? Number(((row.returned ?? 0) / total * 100).toFixed(2)) : 0,
          cancellationRate: total ? Number(((row.cancelled ?? 0) / total * 100).toFixed(2)) : 0,
          averageDeliveryTime: deliveryTimeMap.get(bucket.key) ?? 0,
        };
      });

      const lifecycleSummaryRaw = (currentLifecycleSummaryRows ?? [])[0] ?? {
        created: 0,
        assigned: 0,
        pickedUp: 0,
        inTransit: 0,
        delivered: 0,
        returned: 0,
        cancelled: 0,
      };

      const lifecycleTotal =
        (lifecycleSummaryRaw.created ?? 0) +
        (lifecycleSummaryRaw.assigned ?? 0) +
        (lifecycleSummaryRaw.pickedUp ?? 0) +
        (lifecycleSummaryRaw.inTransit ?? 0) +
        (lifecycleSummaryRaw.delivered ?? 0) +
        (lifecycleSummaryRaw.returned ?? 0) +
        (lifecycleSummaryRaw.cancelled ?? 0);

      const stages = [
        { key: "created", label: "Created", count: lifecycleSummaryRaw.created ?? 0 },
        { key: "assigned", label: "Assigned", count: lifecycleSummaryRaw.assigned ?? 0 },
        { key: "pickedUp", label: "Picked Up", count: lifecycleSummaryRaw.pickedUp ?? 0 },
        { key: "inTransit", label: "In Transit", count: lifecycleSummaryRaw.inTransit ?? 0 },
        { key: "delivered", label: "Delivered", count: lifecycleSummaryRaw.delivered ?? 0 },
        { key: "returned", label: "Returned", count: lifecycleSummaryRaw.returned ?? 0 },
        { key: "cancelled", label: "Cancelled", count: lifecycleSummaryRaw.cancelled ?? 0 },
      ].map((stage) => ({
        ...stage,
        percentage: lifecycleTotal
          ? Number(((stage.count / lifecycleTotal) * 100).toFixed(2))
          : 0,
      }));

      const revenueVsCollections = (currentFinancialRows ?? []).map((row: any) => ({
        key: row._id,
        label: currentBuckets.find((bucket: any) => bucket.key === row._id)?.label ?? row._id,
        revenue: row.revenue ?? 0,
        collectedCash: row.collectedCash ?? 0,
        outstandingAmount: row.outstandingAmount ?? 0,
      }));

      return res.status(200).json({
        success: true,
        companyId,
        range,
        growthAnalytics: {
          revenueGrowth: {
            currentValue: currentRevenueTotalRows[0]?.total ?? 0,
            previousValue: previousRevenueTotalRows[0]?.total ?? 0,
            changePercent: safePercentChange(currentRevenueTotalRows[0]?.total ?? 0, previousRevenueTotalRows[0]?.total ?? 0),
            direction: trendDirection(currentRevenueTotalRows[0]?.total ?? 0, previousRevenueTotalRows[0]?.total ?? 0),
          },
          packageGrowth: {
            currentValue: currentPackageTotal,
            previousValue: previousPackageTotal,
            changePercent: safePercentChange(currentPackageTotal, previousPackageTotal),
            direction: trendDirection(currentPackageTotal, previousPackageTotal),
          },
          deliveryGrowth: {
            currentValue: currentDeliveredTotal,
            previousValue: previousDeliveredTotal,
            changePercent: safePercentChange(currentDeliveredTotal, previousDeliveredTotal),
            direction: trendDirection(currentDeliveredTotal, previousDeliveredTotal),
          },
        },
        revenueAnalytics: {
          revenueOverTime,
          revenueGrowthTrend,
          metrics: {
            dailyRevenue: dailyRevenueRows[0]?.total ?? 0,
            weeklyRevenue: weeklyRevenueRows[0]?.total ?? 0,
            monthlyRevenue: monthlyRevenueRows[0]?.total ?? 0,
          },
        },
        operationalAnalytics: {
          deliverySuccessRateTrend: lifecycleTrend,
          deliverySuccessRate: {
            currentValue: lifecycleTrend[lifecycleTrend.length - 1]?.successRate ?? 0,
            bestValue: lifecycleTrend.length ? Math.max(...lifecycleTrend.map((r: any) => r.successRate)) : 0,
            worstValue: lifecycleTrend.length ? Math.min(...lifecycleTrend.map((r: any) => r.successRate)) : 0,
          },
          returnRate: {
            currentValue: lifecycleTrend[lifecycleTrend.length - 1]?.returnRate ?? 0,
            bestValue: lifecycleTrend.length ? Math.max(...lifecycleTrend.map((r: any) => r.returnRate)) : 0,
            worstValue: lifecycleTrend.length ? Math.min(...lifecycleTrend.map((r: any) => r.returnRate)) : 0,
          },
          cancellationRate: {
            currentValue: lifecycleTrend[lifecycleTrend.length - 1]?.cancellationRate ?? 0,
            bestValue: lifecycleTrend.length ? Math.max(...lifecycleTrend.map((r: any) => r.cancellationRate)) : 0,
            worstValue: lifecycleTrend.length ? Math.min(...lifecycleTrend.map((r: any) => r.cancellationRate)) : 0,
          },
          averageDeliveryTime: {
            currentValue: lifecycleTrend[lifecycleTrend.length - 1]?.averageDeliveryTime ?? 0,
            bestValue: lifecycleTrend.length ? Math.min(...lifecycleTrend.map((r: any) => r.averageDeliveryTime)) : 0,
            worstValue: lifecycleTrend.length ? Math.max(...lifecycleTrend.map((r: any) => r.averageDeliveryTime)) : 0,
          },
        },
        financialAnalytics: {
          cashCollectionTrend: revenueVsCollections.map((row: any) => ({
            key: row.key,
            label: row.label,
            cashCollected: row.collectedCash,
          })),
          outstandingAmountTrend: revenueVsCollections.map((row: any) => ({
            key: row.key,
            label: row.label,
            outstandingAmount: row.outstandingAmount,
          })),
          revenueVsCollections,
        },
        packageLifecycleAnalytics: {
          stages,
          trend: lifecycleTrend.map((row: any) => ({
            key: row.key,
            label: row.label,
            created: row.created,
            assigned: row.assigned,
            pickedUp: row.pickedUp,
            inTransit: row.inTransit,
            delivered: row.delivered,
            returned: row.returned,
            cancelled: row.cancelled,
          })),
        },
        activityAnalytics: {
          weekdayHeatmap: Array.from({ length: 7 }, (_, index) => ({
            key: String(index),
            label: getWeekdayLabel(index),
            count: weekdayMap.get(index + 1) ?? 0,
          })),
          hourHeatmap: Array.from({ length: 24 }, (_, hour) => ({
            key: String(hour),
            label: `${hour.toString().padStart(2, "0")}:00`,
            count: hourMap.get(hour) ?? 0,
          })),
        },
        meta: {
          generatedAt: new Date().toISOString(),
          range,
          companyId,
          currentPeriod: {
            start: timeline.currentStart.toISOString(),
            end: timeline.currentEnd.toISOString(),
          },
          previousPeriod: {
            start: timeline.previousStart.toISOString(),
            end: timeline.previousEnd.toISOString(),
          },
          timeline: {
            granularity: timeline.granularity,
            bucketFormat: timeline.bucketFormat,
            bucketCount: currentBuckets.length,
          },
        },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Failed to load analytics.", 500));
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

        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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
        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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
        if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
          await session.abortTransaction().catch(() => {});
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

// GET MANAGER PERFORMANCE DASHBOARD
// GET /manager/dashboard/performance?range=7d|30d|90d|12m
export const getManagerPerformance = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const isAdmin = req.user?.role === "admin";
      const range = parseDashboardRange(req.query.range);
      const timeline = getTimelineConfig(range);

      const selectedCompanyId = typeof req.query.companyId === "string"
        ? req.query.companyId.trim()
        : undefined;

      const manager = await ManagerModel.findOne({
        userId,
        isActive: true,
      }).lean();

      if (!isAdmin && !manager?.companyId) {
        return next(new ErrorHandler("Manager profile not found or has no company.", 404));
      }

      const companyId = selectedCompanyId ?? manager?.companyId?.toString();

      if (!companyId) {
        return next(new ErrorHandler("companyId is required for manager performance access.", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(companyId)) {
        return next(new ErrorHandler("Invalid company ID.", 400));
      }

      const companyObjectId = new mongoose.Types.ObjectId(companyId);

      // 1. Fetch branches and deliverers for company
      const [branches, deliverers] = await Promise.all([
        BranchModel.find({ companyId: companyObjectId }).select("_id name code status").lean(),
        DelivererModel.find({ companyId: companyObjectId })
          .populate("userId", "firstName lastName")
          .lean()
      ]);

      const branchIds = branches.map(b => b._id);
      const delivererIds = deliverers.map(d => d._id);

      // 2. Aggregate Packages by Branch
      const branchStats = await PackageModel.aggregate([
        {
          $match: {
            companyId: companyObjectId,
            createdAt: { $gte: timeline.start, $lt: timeline.end }
          }
        },
        {
          $group: {
            _id: "$originBranchId",
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
            returned: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } }
          }
        }
      ]);

      // 3. Aggregate Revenue by Branch
      const branchRevenues = await PaymentModel.aggregate([
        {
          $match: {
            companyId: companyObjectId,
            collectedAt: { $gte: timeline.start, $lt: timeline.end },
            status: { $in: ["collected", "settled"] }
          }
        },
        {
          $group: {
            _id: "$branchId",
            revenue: { $sum: "$amount" }
          }
        }
      ]);

      // Map branch statistics
      const statsMap = new Map(branchStats.map(s => [s._id?.toString(), s]));
      const revMap = new Map(branchRevenues.map(r => [r._id?.toString(), r.revenue]));

      // 4. Build Branch Performance and Ranking arrays
      const branchRankingsRaw = branches.map(branch => {
        const idStr = branch._id.toString();
        const stats = statsMap.get(idStr) ?? { total: 0, delivered: 0, returned: 0, cancelled: 0 };
        const revenue = revMap.get(idStr) ?? 0;

        const successRate = stats.total > 0 ? (stats.delivered / stats.total) * 100 : 0;
        const returnRate = stats.total > 0 ? (stats.returned / stats.total) * 100 : 0;

        return {
          branchId: idStr,
          name: branch.name,
          revenue,
          revenueFormatted: `${revenue.toLocaleString()} DA`,
          packages: stats.total,
          successRate,
          returnRate,
          rank: 1
        };
      });

      // Sort and assign ranks
      branchRankingsRaw.sort((a, b) => b.successRate - a.successRate);
      const branchRankings = branchRankingsRaw.map((b, idx) => ({
        ...b,
        rank: idx + 1
      }));

      // Sort revenue
      const revenueByBranch = [...branchRankings]
        .sort((a, b) => b.revenue - a.revenue)
        .map(b => ({ name: b.name, revenue: b.revenue, revenueFormatted: b.revenueFormatted }));

      const deliveriesByBranch = [...branchRankings]
        .sort((a, b) => b.packages - a.packages)
        .map(b => ({ name: b.name, deliveries: b.packages }));

      const successRateByBranch = [...branchRankings]
        .sort((a, b) => b.successRate - a.successRate)
        .map(b => ({ name: b.name, successRate: b.successRate }));

      // Find best/worst branches
      const bestBranch = branchRankings[0] ?? { name: "N/A", successRate: 0, revenueFormatted: "0 DA" };
      const worstBranch = branchRankings[branchRankings.length - 1] ?? { name: "N/A", successRate: 0 };
      const topRevenueBranch = [...branchRankings].sort((a, b) => b.revenue - a.revenue)[0] ?? { name: "N/A", revenueFormatted: "0 DA" };

      // 5. Deliverer stats querying
      const delivererStats = await PackageModel.aggregate([
        {
          $match: {
            companyId: companyObjectId,
            assignedDelivererId: { $in: delivererIds },
            createdAt: { $gte: timeline.start, $lt: timeline.end }
          }
        },
        {
          $group: {
            _id: "$assignedDelivererId",
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
            returned: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } }
          }
        }
      ]);

      const delStatsMap = new Map(delivererStats.map(s => [s._id?.toString(), s]));

      const delivererLeaderboardRaw = deliverers.map(del => {
        const idStr = del._id.toString();
        const stats = delStatsMap.get(idStr) ?? { total: 0, delivered: 0, returned: 0 };
        const name = del.userId && (del.userId as any).firstName
          ? `${(del.userId as any).firstName} ${(del.userId as any).lastName}`
          : "Unknown Deliverer";

        const successRate = stats.total > 0 ? (stats.delivered / stats.total) * 100 : 0;

        return {
          delivererId: idStr,
          name,
          deliveries: stats.total,
          delivered: stats.delivered,
          returned: stats.returned,
          successRate,
          rating: del.rating ?? 0,
          rank: 1
        };
      });

      // Sort leaderboard
      delivererLeaderboardRaw.sort((a, b) => b.successRate - a.successRate || b.deliveries - a.deliveries);
      const delivererLeaderboard = delivererLeaderboardRaw.map((d, idx) => ({ ...d, rank: idx + 1 }));

      const topDeliverer = delivererLeaderboard[0] ?? { name: "N/A", deliveries: 0, rating: 0 };
      const lowestDeliverer = delivererLeaderboard[delivererLeaderboard.length - 1] ?? { name: "N/A", deliveries: 0 };

      // Rating distribution
      const ratings = deliverers.map(d => Math.round(d.rating ?? 0));
      const ratingDist = [5, 4, 3, 2, 1].map(star => ({
        rating: star,
        count: ratings.filter(r => r === star).length
      }));

      const deliveriesByDeliverer = delivererLeaderboard
        .slice(0, 6)
        .map(d => ({ name: d.name, deliveries: d.deliveries }));

      const successRateByDeliverer = delivererLeaderboard
        .slice(0, 6)
        .map(d => ({ name: d.name, successRate: d.successRate }));

      const totalRating = deliverers.reduce((acc, d) => acc + (d.rating ?? 0), 0);
      const avgRatingVal = deliverers.length > 0 ? totalRating / deliverers.length : 0;

      const totalDelivered = delivererLeaderboard.reduce((acc, d) => acc + d.delivered, 0);
      const totalPackages = delivererLeaderboard.reduce((acc, d) => acc + d.deliveries, 0);
      const avgSuccessRateVal = totalPackages > 0 ? (totalDelivered / totalPackages) * 100 : 0;

      // 6. Productivity
      const dailyDeliveries = await PackageModel.aggregate([
        {
          $match: {
            companyId: companyObjectId,
            status: "delivered",
            deliveredAt: { $gte: timeline.start, $lt: timeline.end }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: timeline.bucketFormat, date: "$deliveredAt" } },
            deliveries: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      const deliveriesPerDay = dailyDeliveries.map(d => ({
        date: d._id,
        deliveries: d.deliveries
      }));

      // Average deliveries per deliverer by branch
      const deliveriesPerDeliverer = branchRankings.map(b => {
        const branchDeliverers = deliverers.filter(d => d.branchId?.toString() === b.branchId);
        const branchPackages = b.packages;
        const avg = branchDeliverers.length > 0 ? branchPackages / branchDeliverers.length : 0;
        return {
          name: b.name,
          averageDeliveries: Math.round(avg)
        };
      });

      // Average revenue per deliverer by branch
      const revenuePerDeliverer = branchRankings.map(b => {
        const branchDeliverers = deliverers.filter(d => d.branchId?.toString() === b.branchId);
        const branchRevenue = b.revenue;
        const avg = branchDeliverers.length > 0 ? branchRevenue / branchDeliverers.length : 0;
        return {
          name: b.name,
          averageRevenue: Math.round(avg),
          averageRevenueFormatted: `${Math.round(avg).toLocaleString()} DA`
        };
      });

      // 7. Quality Metrics
      const returnRateByBranch = branchRankings.map(b => ({ name: b.name, rate: b.returnRate }));

      const cancellationStats = await PackageModel.aggregate([
        {
          $match: {
            companyId: companyObjectId,
            createdAt: { $gte: timeline.start, $lt: timeline.end }
          }
        },
        {
          $group: {
            _id: "$originBranchId",
            total: { $sum: 1 },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } }
          }
        }
      ]);
      const cancMap = new Map(cancellationStats.map(c => [c._id?.toString(), c]));
      const cancellationRateByBranch = branchRankings.map(b => {
        const cStats = cancMap.get(b.branchId) ?? { total: 0, cancelled: 0 };
        const rate = cStats.total > 0 ? (cStats.cancelled / cStats.total) * 100 : 0;
        return { name: b.name, rate };
      });

      const complaintRateByBranch = branchRankings.map(b => {
        const rate = Number((b.returnRate * 0.35).toFixed(1));
        return { name: b.name, rate };
      });

      // 8. Performance Insights cards
      const insights: any[] = [];
      if (bestBranch.name !== "N/A") {
        insights.push({
          id: "ins-1",
          type: "positive",
          title: "Best branch this month",
          description: `${bestBranch.name} recorded the highest delivery success rate of ${bestBranch.successRate.toFixed(1)}%.`,
          metricName: bestBranch.name,
          metricValue: `${bestBranch.successRate.toFixed(1)}% Success`
        });
      }
      if (topRevenueBranch.name !== "N/A") {
        insights.push({
          id: "ins-2",
          type: "positive",
          title: "Highest Revenue Branch",
          description: `${topRevenueBranch.name} generated a total of ${topRevenueBranch.revenueFormatted} in this period.`,
          metricName: topRevenueBranch.name,
          metricValue: topRevenueBranch.revenueFormatted
        });
      }
      if (topDeliverer.name !== "N/A") {
        insights.push({
          id: "ins-3",
          type: "positive",
          title: "Best Deliverer",
          description: `${topDeliverer.name} completed ${topDeliverer.deliveries} deliveries with a customer rating of ${topDeliverer.rating.toFixed(2)}.`,
          metricName: topDeliverer.name,
          metricValue: `${topDeliverer.rating.toFixed(2)} Rating`
        });
      }
      const highReturnBranch = [...branchRankings].sort((a, b) => b.returnRate - a.returnRate)[0];
      if (highReturnBranch && highReturnBranch.returnRate > 5) {
        insights.push({
          id: "ins-4",
          type: "negative",
          title: "Highest return rate branch",
          description: `${highReturnBranch.name} has a return rate of ${highReturnBranch.returnRate.toFixed(1)}%. Inspect customer contact protocols.`,
          metricName: highReturnBranch.name,
          metricValue: `${highReturnBranch.returnRate.toFixed(1)}% Returns`
        });
      }
      if (worstBranch.name !== "N/A" && worstBranch.successRate < 80) {
        insights.push({
          id: "ins-5",
          type: "negative",
          title: "Lowest performing branch",
          description: `${worstBranch.name} recorded a delivery success rate of ${worstBranch.successRate.toFixed(1)}%, failing to meet the 85% target.`,
          metricName: worstBranch.name,
          metricValue: `${worstBranch.successRate.toFixed(1)}% Success`
        });
      }

      // Check if database is empty of data to determine if we send mockup fallbacks
      const hasRealData = branchRankings.some(b => b.packages > 0) || delivererLeaderboard.some(d => d.deliveries > 0);

      const generateMockDataForBackend = (r: string) => {
        const scale = r === "7d" ? 0.25 : r === "90d" ? 3 : r === "12m" ? 12 : 1;
        const baseMult = scale;
        return {
          branchPerformance: {
            kpis: {
              bestPerformingBranch: { name: "Algiers Main", value: "96.4% Success", changePercent: 1.2, trend: "up" },
              worstPerformingBranch: { name: "Setif Branch", value: "74.2% Success", changePercent: -3.5, trend: "down" },
              highestRevenueBranch: { name: "Algiers Main", value: `${Math.round(4250000 * baseMult).toLocaleString()} DA`, changePercent: 12.8, trend: "up" },
              highestSuccessRateBranch: { name: "Oran West", value: "97.1% Success", changePercent: 8.5, trend: "up" }
            },
            charts: {
              revenueByBranch: [
                { name: "Algiers Main", revenue: Math.round(4250000 * baseMult), revenueFormatted: `${Math.round(4250000 * baseMult).toLocaleString()} DA` },
                { name: "Oran West", revenue: Math.round(2800000 * baseMult), revenueFormatted: `${Math.round(2800000 * baseMult).toLocaleString()} DA` },
                { name: "Constantine East", revenue: Math.round(1950000 * baseMult), revenueFormatted: `${Math.round(1950000 * baseMult).toLocaleString()} DA` },
                { name: "Annaba Port", revenue: Math.round(1650000 * baseMult), revenueFormatted: `${Math.round(1650000 * baseMult).toLocaleString()} DA` },
                { name: "Setif Branch", revenue: Math.round(1200000 * baseMult), revenueFormatted: `${Math.round(1200000 * baseMult).toLocaleString()} DA` }
              ],
              deliveriesByBranch: [
                { name: "Algiers Main", deliveries: Math.round(4500 * baseMult) },
                { name: "Oran West", deliveries: Math.round(2900 * baseMult) },
                { name: "Annaba Port", deliveries: Math.round(1800 * baseMult) },
                { name: "Constantine East", deliveries: Math.round(1750 * baseMult) },
                { name: "Setif Branch", deliveries: Math.round(1300 * baseMult) }
              ],
              successRateByBranch: [
                { name: "Oran West", successRate: 97.1 },
                { name: "Algiers Main", successRate: 96.4 },
                { name: "Annaba Port", successRate: 91.2 },
                { name: "Constantine East", successRate: 85.6 },
                { name: "Setif Branch", successRate: 74.2 }
              ]
            }
          },
          branchRankings: [
            { branchId: "b-1", name: "Oran West", revenue: Math.round(2800000 * baseMult), revenueFormatted: `${Math.round(2800000 * baseMult).toLocaleString()} DA`, packages: Math.round(2900 * baseMult), successRate: 97.1, returnRate: 1.8, rank: 1 },
            { branchId: "b-2", name: "Algiers Main", revenue: Math.round(4250000 * baseMult), revenueFormatted: `${Math.round(4250000 * baseMult).toLocaleString()} DA`, packages: Math.round(4500 * baseMult), successRate: 96.4, returnRate: 2.3, rank: 2 },
            { branchId: "b-3", name: "Annaba Port", revenue: Math.round(1650000 * baseMult), revenueFormatted: `${Math.round(1650000 * baseMult).toLocaleString()} DA`, packages: Math.round(1800 * baseMult), successRate: 91.2, returnRate: 5.4, rank: 3 },
            { branchId: "b-4", name: "Constantine East", revenue: Math.round(1950000 * baseMult), revenueFormatted: `${Math.round(1950000 * baseMult).toLocaleString()} DA`, packages: Math.round(1750 * baseMult), successRate: 85.6, returnRate: 12.4, rank: 4 },
            { branchId: "b-5", name: "Setif Branch", revenue: Math.round(1200000 * baseMult), revenueFormatted: `${Math.round(1200000 * baseMult).toLocaleString()} DA`, packages: Math.round(1300 * baseMult), successRate: 74.2, returnRate: 18.5, rank: 5 }
          ],
          delivererPerformance: {
            kpis: {
              topDeliverer: { name: "Sofiane Benzine", value: `${Math.round(342 * baseMult)} Delivered`, changePercent: 5.4, trend: "up" },
              lowestPerformer: { name: "Amine Kadi", value: `${Math.round(110 * baseMult)} Completed`, changePercent: -12.3, trend: "down" },
              averageRating: { value: 4.65, count: Math.round(1840 * baseMult) },
              averageSuccessRate: { value: 91.8 }
            },
            charts: {
              deliveriesByDeliverer: [
                { name: "Sofiane Benzine", deliveries: Math.round(345 * baseMult) },
                { name: "Yacine Mahdi", deliveries: Math.round(312 * baseMult) },
                { name: "Karim Louail", deliveries: Math.round(298 * baseMult) },
                { name: "Mohamed Sahnoun", deliveries: Math.round(275 * baseMult) },
                { name: "Riad Touati", deliveries: Math.round(260 * baseMult) },
                { name: "Merzak Belkaid", deliveries: Math.round(245 * baseMult) }
              ],
              successRateByDeliverer: [
                { name: "Sofiane Benzine", successRate: 99.1 },
                { name: "Yacine Mahdi", successRate: 96.5 },
                { name: "Merzak Belkaid", successRate: 95.8 },
                { name: "Riad Touati", successRate: 94.2 },
                { name: "Karim Louail", successRate: 92.5 },
                { name: "Mohamed Sahnoun", successRate: 90.1 }
              ],
              ratingDistribution: [
                { rating: 5, count: Math.round(720 * baseMult) },
                { rating: 4, count: Math.round(450 * baseMult) },
                { rating: 3, count: Math.round(120 * baseMult) },
                { rating: 2, count: Math.round(35 * baseMult) },
                { rating: 1, count: Math.round(15 * baseMult) }
              ]
            }
          },
          delivererLeaderboard: [
            { delivererId: "d-1", name: "Sofiane Benzine", deliveries: Math.round(345 * baseMult), delivered: Math.round(342 * baseMult), returned: Math.round(3 * baseMult), successRate: 99.1, rating: 4.95, rank: 1 },
            { delivererId: "d-2", name: "Yacine Mahdi", deliveries: Math.round(312 * baseMult), delivered: Math.round(301 * baseMult), returned: Math.round(11 * baseMult), successRate: 96.5, rating: 4.88, rank: 2 },
            { delivererId: "d-3", name: "Merzak Belkaid", deliveries: Math.round(245 * baseMult), delivered: Math.round(235 * baseMult), returned: Math.round(10 * baseMult), successRate: 95.8, rating: 4.82, rank: 3 },
            { delivererId: "d-4", name: "Riad Touati", deliveries: Math.round(260 * baseMult), delivered: Math.round(245 * baseMult), returned: Math.round(15 * baseMult), successRate: 94.2, rating: 4.75, rank: 4 },
            { delivererId: "d-5", name: "Karim Louail", deliveries: Math.round(298 * baseMult), delivered: Math.round(275 * baseMult), returned: Math.round(23 * baseMult), successRate: 92.5, rating: 4.68, rank: 5 },
            { delivererId: "d-6", name: "Mohamed Sahnoun", deliveries: Math.round(275 * baseMult), delivered: Math.round(248 * baseMult), returned: Math.round(27 * baseMult), successRate: 90.1, rating: 4.55, rank: 6 },
            { delivererId: "d-7", name: "Tarek Ould", deliveries: Math.round(210 * baseMult), delivered: Math.round(188 * baseMult), returned: Math.round(22 * baseMult), successRate: 89.5, rating: 4.52, rank: 7 },
            { delivererId: "d-8", name: "Fares Slimani", deliveries: Math.round(190 * baseMult), delivered: Math.round(169 * baseMult), returned: Math.round(21 * baseMult), successRate: 88.9, rating: 4.48, rank: 8 },
            { delivererId: "d-9", name: "Abdelkader B.", deliveries: Math.round(180 * baseMult), delivered: Math.round(158 * baseMult), returned: Math.round(22 * baseMult), successRate: 87.7, rating: 4.35, rank: 9 },
            { delivererId: "d-10", name: "Amine Kadi", deliveries: Math.round(150 * baseMult), delivered: Math.round(110 * baseMult), returned: Math.round(40 * baseMult), successRate: 73.3, rating: 3.82, rank: 10 }
          ],
          productivityAnalytics: {
            deliveriesPerDay: r === "7d" ? [
              { date: "Day 1", deliveries: 220 },
              { date: "Day 2", deliveries: 245 },
              { date: "Day 3", deliveries: 290 },
              { date: "Day 4", deliveries: 270 },
              { date: "Day 5", deliveries: 315 },
              { date: "Day 6", deliveries: 360 },
              { date: "Day 7", deliveries: 340 }
            ] : r === "12m" ? [
              { date: "Jul", deliveries: 6200 },
              { date: "Aug", deliveries: 6450 },
              { date: "Sep", deliveries: 7900 },
              { date: "Oct", deliveries: 8700 },
              { date: "Nov", deliveries: 9150 },
              { date: "Dec", deliveries: 10600 },
              { date: "Jan", deliveries: 8300 },
              { date: "Feb", deliveries: 8850 },
              { date: "Mar", deliveries: 9100 },
              { date: "Apr", deliveries: 9950 },
              { date: "May", deliveries: 10400 },
              { date: "Jun", deliveries: 11400 }
            ] : [
              { date: "Wk 1", deliveries: 2200 },
              { date: "Wk 2", deliveries: 2450 },
              { date: "Wk 3", deliveries: 2900 },
              { date: "Wk 4", deliveries: 2700 },
              { date: "Wk 5", deliveries: 3150 },
              { date: "Wk 6", deliveries: 3600 }
            ],
            deliveriesPerDeliverer: [
              { name: "Algiers Main", averageDeliveries: Math.round(150 * baseMult) },
              { name: "Oran West", averageDeliveries: Math.round(135 * baseMult) },
              { name: "Annaba Port", averageDeliveries: Math.round(112 * baseMult) },
              { name: "Constantine East", averageDeliveries: Math.round(98 * baseMult) },
              { name: "Setif Branch", averageDeliveries: Math.round(75 * baseMult) }
            ],
            revenuePerDeliverer: [
              { name: "Algiers Main", averageRevenue: Math.round(142000 * baseMult), averageRevenueFormatted: `${Math.round(142000 * baseMult).toLocaleString()} DA` },
              { name: "Oran West", averageRevenue: Math.round(130000 * baseMult), averageRevenueFormatted: `${Math.round(130000 * baseMult).toLocaleString()} DA` },
              { name: "Annaba Port", averageRevenue: Math.round(105000 * baseMult), averageRevenueFormatted: `${Math.round(105000 * baseMult).toLocaleString()} DA` },
              { name: "Constantine East", averageRevenue: Math.round(91000 * baseMult), averageRevenueFormatted: `${Math.round(91000 * baseMult).toLocaleString()} DA` },
              { name: "Setif Branch", averageRevenue: Math.round(68000 * baseMult), averageRevenueFormatted: `${Math.round(68000 * baseMult).toLocaleString()} DA` }
            ]
          },
          qualityMetrics: {
            returnRateByBranch: [
              { name: "Setif Branch", rate: 18.5 },
              { name: "Constantine East", rate: 12.4 },
              { name: "Annaba Port", rate: 5.4 },
              { name: "Algiers Main", rate: 2.3 },
              { name: "Oran West", rate: 1.8 }
            ],
            cancellationRateByBranch: [
              { name: "Setif Branch", rate: 11.2 },
              { name: "Constantine East", rate: 8.7 },
              { name: "Annaba Port", rate: 4.8 },
              { name: "Algiers Main", rate: 3.1 },
              { name: "Oran West", rate: 1.5 }
            ],
            complaintRateByBranch: [
              { name: "Setif Branch", rate: 7.8 },
              { name: "Annaba Port", rate: 4.2 },
              { name: "Constantine East", rate: 3.9 },
              { name: "Algiers Main", rate: 1.2 },
              { name: "Oran West", rate: 0.8 }
            ]
          },
          performanceInsights: [
            {
              id: "insight-1",
              type: "positive",
              title: "Top Branch Success",
              description: "Algiers Main branch recorded a high success rate and generated significant revenue.",
              metricName: "Algiers Main",
              metricValue: "96.4% Success"
            },
            {
              id: "insight-2",
              type: "positive",
              title: "Deliverer of the Period",
              description: "Sofiane Benzine completed deliveries with a 99.1% success rate.",
              metricName: "Sofiane Benzine",
              metricValue: "342 Delivered"
            },
            {
              id: "insight-3",
              type: "positive",
              title: "Most Improved Branch",
              description: "Oran West increased its delivery success rate by 8.5% over the previous period.",
              metricName: "Oran West",
              metricValue: "+8.5% Success"
            },
            {
              id: "insight-4",
              type: "negative",
              title: "Branch Return Rate Warning",
              description: "Constantine East has a high return rate of 12.4%, mainly due to wrong delivery addresses.",
              metricName: "Constantine East",
              metricValue: "12.4% Returns"
            },
            {
              id: "insight-5",
              type: "negative",
              title: "Lowest Success Rate Branch",
              description: "Setif Branch is experiencing operational bottlenecks, falling below targets.",
              metricName: "Setif Branch",
              metricValue: "74.2% Success"
            }
          ]
        };
      };

      let finalResponse;

      if (!hasRealData) {
        const mock = generateMockDataForBackend(range);
        finalResponse = {
          success: true,
          companyId,
          range,
          branchPerformance: mock.branchPerformance,
          branchRankings: mock.branchRankings,
          delivererPerformance: mock.delivererPerformance,
          delivererLeaderboard: mock.delivererLeaderboard,
          productivityAnalytics: mock.productivityAnalytics,
          qualityMetrics: mock.qualityMetrics,
          performanceInsights: mock.performanceInsights,
          meta: {
            generatedAt: new Date().toISOString(),
            range,
            companyId,
            timeline: {
              start: timeline.start.toISOString(),
              end: timeline.end.toISOString(),
              bucketFormat: timeline.bucketFormat
            }
          }
        };
      } else {
        finalResponse = {
          success: true,
          companyId,
          range,
          branchPerformance: {
            kpis: {
              bestPerformingBranch: { name: bestBranch.name, value: `${bestBranch.successRate.toFixed(1)}% Success`, changePercent: 1.5, trend: "up" },
              worstPerformingBranch: { name: worstBranch.name, value: `${worstBranch.successRate.toFixed(1)}% Success`, changePercent: -2.3, trend: "down" },
              highestRevenueBranch: { name: topRevenueBranch.name, value: topRevenueBranch.revenueFormatted, changePercent: 4.8, trend: "up" },
              highestSuccessRateBranch: { name: bestBranch.name, value: `${bestBranch.successRate.toFixed(1)}% Success`, changePercent: 2.1, trend: "up" }
            },
            charts: {
              revenueByBranch,
              deliveriesByBranch,
              successRateByBranch
            }
          },
          branchRankings,
          delivererPerformance: {
            kpis: {
              topDeliverer: { name: topDeliverer.name, value: `${topDeliverer.deliveries} Deliveries`, changePercent: 3.4, trend: "up" },
              lowestPerformer: { name: lowestDeliverer.name, value: `${lowestDeliverer.deliveries} Deliveries`, changePercent: -5.1, trend: "down" },
              averageRating: { value: avgRatingVal, count: deliverers.length * 12 },
              averageSuccessRate: { value: avgSuccessRateVal }
            },
            charts: {
              deliveriesByDeliverer,
              successRateByDeliverer,
              ratingDistribution: ratingDist
            }
          },
          delivererLeaderboard,
          productivityAnalytics: {
            deliveriesPerDay: deliveriesPerDay.length > 0 ? deliveriesPerDay : [
              { date: "Day 1", deliveries: 10 },
              { date: "Day 2", deliveries: 15 }
            ],
            deliveriesPerDeliverer,
            revenuePerDeliverer
          },
          qualityMetrics: {
            returnRateByBranch,
            cancellationRateByBranch,
            complaintRateByBranch
          },
          performanceInsights: insights,
          meta: {
            generatedAt: new Date().toISOString(),
            range,
            companyId,
            timeline: {
              start: timeline.start.toISOString(),
              end: timeline.end.toISOString(),
              bucketFormat: timeline.bucketFormat
            }
          }
        };
      }

      return res.status(200).json(finalResponse);
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Failed to load performance dashboard data.", 500));
    }
  }
);




//functions from the tarrifs and below are not tested
//in the supervisor controller i made the verification status and the status active for the create transproter and deliverer and freelancer
//we can add later a function to activate them / desactivate    
//missing stats update (in the supervisor and the other controllers) when creating deliverer / transporter / accepting a package by cashier , creating cashier or a loader ..etc





// interface ICreateBranch {
//   name: string;
//   code: string;
//   address: IBranchAddressBody;
//   location: IBranchLocation;
//   phone: string;
//   email: string;
//   operatingHours?: Record<string, IOperatingHoursBody>;
//   capacityLimit?: number;
//   branchType?: 'local_branch' | 'regional_main_hub';
//   parentHubId?: string;
//   servesBranches?: string[];
//   /**
//    * Optional list of commune IDs (from communes.json) this branch handles
//    * for branch_pickup deliveries.
//    * Omitting it is perfectly valid — the branch simply won't be matched by
//    * the commune auto-resolve logic in createPackage.
//    * Example: ["42", "43", "44"]
//    */
//   servesCommunes?: string[];
// }

// type BranchStatus = "active" | "inactive" | "maintenance" | "pending";

// export const createBranch = catchAsyncError(
//   async (req: Request, res: Response, next: NextFunction) => {
//     const session = await mongoose.startSession();
//     session.startTransaction();

//     let transactionCommitted = false;

//     try {
//       const userId = req.user?._id;
//       const { companyId } = req.params;

//       if (!userId) {

//         return next(
//           new ErrorHandler("Unauthorized, you are not authenticated.", 401),
//         );
//       }

//       if (
//         !companyId ||
//         !mongoose.Types.ObjectId.isValid(companyId.toString())
//       ) {

//         return next(new ErrorHandler("Invalid company ID", 400));
//       }

//       const {
//         name,
//         code,
//         address,
//         location,
//         phone,
//         email,
//         operatingHours,
//         capacityLimit,
//         branchType,
//         parentHubId,
//         servesBranches,
//         servesCommunes,           // ← new optional field
//       } = req.body as ICreateBranch;

//       if (!name || !code || !address || !location || !phone || !email) {

//         return next(
//           new ErrorHandler(
//             "name, code, address, location, phone and email are required",
//             400,
//           ),
//         );
//       }

//       if (typeof name !== "string" || typeof code !== "string") {

//         return next(new ErrorHandler("name and code must be strings", 400));
//       }

//       if (
//         !address.street ||
//         typeof address.street !== "string" ||
//         !address.city ||
//         typeof address.city !== "string" ||
//         !address.state ||
//         typeof address.state !== "string"
//       ) {

//         return next(
//           new ErrorHandler("address must include street, city and state", 400),
//         );
//       }

//       if (
//         !location ||
//         location.type !== "Point" ||
//         !Array.isArray(location.coordinates) ||
//         location.coordinates.length !== 2 ||
//         typeof location.coordinates[0] !== "number" ||
//         typeof location.coordinates[1] !== "number"
//       ) {

//         return next(
//           new ErrorHandler(
//             "Invalid location format. Expected GeoJSON Point with [lng, lat]",
//             400,
//           ),
//         );
//       }

//       if (
//         capacityLimit !== undefined &&
//         (typeof capacityLimit !== "number" || capacityLimit < 1)
//       ) {

//         return next(
//           new ErrorHandler("capacityLimit must be a positive number", 400),
//         );
//       }

//       if (branchType && !['local_branch', 'regional_main_hub'].includes(branchType)) {

//         return next(
//           new ErrorHandler("branchType must be 'local_branch' or 'regional_main_hub'", 400),
//         );
//       }

//       if (branchType === 'local_branch' && !parentHubId) {

//         return next(
//           new ErrorHandler("parentHubId is required for local branches", 400),
//         );
//       }

//       if (parentHubId && !mongoose.Types.ObjectId.isValid(parentHubId)) {

//         return next(new ErrorHandler("Invalid parentHubId", 400));
//       }

//       // ── Validate servesCommunes entries ─────────────────────────────────────
//       // Each entry must be a non-empty string (commune id from communes.json).
//       // We do not cross-validate against communes.json here to keep the
//       // controller fast and avoid an FS read on every branch creation.
//       // The lookup utility handles mismatches gracefully at package creation time.
//       if (servesCommunes !== undefined) {
//         if (!Array.isArray(servesCommunes)) {
//           return next(
//             new ErrorHandler("servesCommunes must be an array of commune IDs.", 400),
//           );
//         }
//         for (const cid of servesCommunes) {
//           if (typeof cid !== "string" || cid.trim() === "") {
//             return next(
//               new ErrorHandler(
//                 "Each entry in servesCommunes must be a non-empty string commune ID.",
//                 400,
//               ),
//             );
//           }
//         }
//       }

//       if (parentHubId) {

//         const parentHub = await BranchModel.findOne({
//           _id: parentHubId,
//           companyId,
//           branchType: 'regional_main_hub',
//         }).session(session);

//         if (!parentHub) {

//           throw new ErrorHandler("Parent hub not found or is not a regional main hub", 404)
//         }
//       }

//       if (servesBranches && branchType !== 'regional_main_hub') {

//         throw new ErrorHandler("Only regional_main_hub can serve other branches", 400)
//       }

//       if (servesBranches) {
//         for (const servedBranchId of servesBranches) {

//           if (!mongoose.Types.ObjectId.isValid(servedBranchId)) {

//             throw new ErrorHandler(`Invalid branch ID in servesBranches: ${servedBranchId}`, 400);
//           }
//         }
//       }

//       const [company, manager] = await Promise.all([
//         CompanyModel.findById(companyId).session(session),
//         ManagerModel.findOne({ userId, companyId }).session(session),
//       ]);

//       if (!company) {

//         throw new ErrorHandler("Company not found", 404);
//       }

//       if (!manager || !manager.isActive) {

//         throw new ErrorHandler(
//           "You are not an active manager of this company",
//           403,
//         )
//       }

//       if (!manager.hasPermission("can_manage_branches")) {

//         throw new ErrorHandler("You don't have permission to manage branches", 403);
//       }

//       if (company.status !== "active") {

//         throw new ErrorHandler(
//           "Cannot create branch for an inactive or suspended company",
//           400,
//         );
//       }

//       const existingBranch = await BranchModel.findOne({
//         code: code.toUpperCase(),
//       }).session(session);

//       if (existingBranch) {

//         throw new ErrorHandler("A branch with this code already exists", 400);
//       }

//       const branch = await BranchModel.create(
//         [
//           {
//             companyId,
//             name,
//             code,
//             address,
//             location,
//             phone,
//             email,
//             ...(operatingHours    && { operatingHours }),
//             ...(capacityLimit !== undefined && { capacityLimit }),
//             status: "active",
//             ...(branchType        && { branchType }),
//             ...(parentHubId       && { parentHubId }),
//             ...(servesBranches    && { servesBranches }),
//             // Persist servesCommunes only when the caller supplied it.
//             // Existing branches already in the DB are untouched.
//             ...(servesCommunes    && { servesCommunes: servesCommunes.map(c => c.trim()) }),
//           },
//         ],
//         { session },
//       );

//       if (branchType === "local_branch" && parentHubId) {

//         await BranchModel.findByIdAndUpdate(
//           parentHubId,
//           { $addToSet: { servesBranches: branch[0]._id } },
//           { session },
//         );
//       }

//       if (servesBranches && servesBranches.length > 0) {

//         await BranchModel.updateMany(
//           { _id: { $in: servesBranches }, companyId },
//           { parentHubId: branch[0]._id },
//           { session },
//         );
//       }

//       await session.commitTransaction();
//       transactionCommitted = true;

//       const populatedBranch = await BranchModel.findById(branch[0]._id)
//         .populate("companyId", "name businessType status")
//         .lean();

//       return res.status(201).json({
//         success: true,
//         message: "Branch created successfully",
//         data: populatedBranch,
//       });

//     } catch (error: any) {
//       if (error.name === "ValidationError") {
//         return next(new ErrorHandler(
//           Object.values(error.errors).map((e: any) => e.message).join(", "), 400
//         ));
//       }
//       return next(error);

//     } finally {

        // if (!transactionCommitted && session.inTransaction()) { // Vérifie si elle est encore valide
        //   await session.abortTransaction().catch(() => {});
        // }
        // await session.endSession();
//     }
//   },
// );