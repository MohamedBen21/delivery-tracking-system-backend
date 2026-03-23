import { Request, Response, NextFunction } from "express";
import DelivererModel from "../models/deliverer.model";
import SupervisorModel from "../models/supervisor.model";
import BranchModel from "../models/branch.model";
import userModel, { IUser } from "../models/user.model";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import ManagerModel from "../models/manager.model";
import CompanyModel from "../models/company.model";
import TransporterModel from "../models/transporter.model";
import PackageModel, { DeliveryType, PackageStatus, PackageType, PaymentStatus } from "../models/package.model";
import FreelancerModel from "../models/freelancer.model";
import clientModel from "../models/client.model";
import PackageHistoryModel from "../models/package-history.model";
import RouteModel, { RouteStatus, RouteType } from "../models/route.model";
import VehicleModel from "../models/vehicle.model";
import { deleteImage } from "../utils/Multer.util";
import { buildUserFieldUpdates } from "./manager.controller";


interface ILocationBody {
  type: "Point";
  coordinates: [number, number];
}

interface IDelivererDocumentsBody {
  contractImage?: string;
  idCardImage?: string;
  licenseImage?: string;
  licenseNumber?: string;
  licenseExpiry?: Date;
  backgroundCheck?: string;
  insuranceImage?: string;
}

interface ICreateDeliverer {
  email: string;
  phone: string;
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  // imageUrl?: string;

  currentLocation?: ILocationBody;
  documents?: IDelivererDocumentsBody;
}

interface IUpdateDeliverer {
  email?: string;
  phone?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  // imageUrl?: string;

  currentLocation?: ILocationBody;
  documents?: IDelivererDocumentsBody;
  availabilityStatus?: "available" | "on_route" | "off_duty" | "on_break" | "maintenance";
}



//  CREATE DELIVERER
export const createDeliverer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const {
        email,
        phone,
        username,
        password,
        firstName,
        lastName,
        // imageUrl,
        currentLocation,
        documents,
      } = req.body as ICreateDeliverer;

      if (!email || !phone || !username || !password || !firstName || !lastName) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("email, phone, username, password, firstName, and lastName are required", 400)
        );
      }

      if (
        typeof email !== "string" ||
        typeof phone !== "string" ||
        typeof username !== "string" ||
        typeof password !== "string" ||
        typeof firstName !== "string" ||
        typeof lastName !== "string"
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("All required fields must be strings", 400));
      }

      if (currentLocation) {
        if (
          currentLocation.type !== "Point" ||
          !Array.isArray(currentLocation.coordinates) ||
          currentLocation.coordinates.length !== 2 ||
          typeof currentLocation.coordinates[0] !== "number" ||
          typeof currentLocation.coordinates[1] !== "number"
        ) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Invalid location format. Expected GeoJSON Point", 400));
        }
      }

      const [supervisor, branch] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        BranchModel.findById(branchId).session(session),
      ]);

      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage deliverers", 403));
      }

      if (!branch) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Branch not found", 404));
      }

      if (branch.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot create deliverer for an inactive branch", 400));
      }

      const [existingEmail, existingPhone, existingUsername] = await Promise.all([
        userModel.findOne({ email }).session(session),
        userModel.findOne({ phone }).session(session),
        userModel.findOne({ username }).session(session),
      ]);

      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Email already exists", 400));
      }

      if (existingPhone) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Phone number already exists", 400));
      }

      if (existingUsername) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Username already exists", 400));
      }

      const user = await userModel.create(
        [
          {
            email,
            phone,
            username,
            passwordHash: password,
            firstName,
            lastName,
            // imageUrl,
            role: "deliverer",
            status: "pending",
          },
        ],
        { session }
      );

      const deliverer = await DelivererModel.create(
        [
          {
            userId: user[0]._id,
            companyId: branch.companyId,
            branchId,
            ...(currentLocation && { currentLocation }),
            ...(documents && { documents }),
            availabilityStatus: "off_duty",
            verificationStatus: "pending",
            isActive: true,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populatedDeliverer = await DelivererModel.findById(deliverer[0]._id)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("branchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Deliverer created successfully",
        data: populatedDeliverer,
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

      return next(new ErrorHandler(error.message || "Error creating deliverer", 500));
    }
  }
);



//  UPDATE DELIVERER
export const updateDeliverer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, delivererId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!delivererId || !mongoose.Types.ObjectId.isValid(delivererId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid deliverer ID", 400));
      }

      const body = req.body as IUpdateDeliverer;

      if (Object.keys(body).length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("No update data provided", 400));
      }

      if (body.email !== undefined && typeof body.email !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("email must be a string", 400));
      }

      if (body.phone !== undefined && typeof body.phone !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("phone must be a string", 400));
      }

      if (body.username !== undefined && typeof body.username !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("username must be a string", 400));
      }

      if (body.currentLocation) {
        if (
          body.currentLocation.type !== "Point" ||
          !Array.isArray(body.currentLocation.coordinates) ||
          body.currentLocation.coordinates.length !== 2 ||
          typeof body.currentLocation.coordinates[0] !== "number" ||
          typeof body.currentLocation.coordinates[1] !== "number"
        ) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Invalid location format. Expected GeoJSON Point", 400));
        }
      }

      const [deliverer, supervisor] = await Promise.all([
        DelivererModel.findOne({ _id: delivererId, branchId }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
      ]);

      if (!deliverer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Deliverer not found", 404));
      }

      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage deliverers", 403));
      }


      const duplicateChecks: Promise<any>[] = [];

      if (body.email) {
        duplicateChecks.push(
          userModel.findOne({ email: body.email, _id: { $ne: deliverer.userId } }).session(session)
        );
      }

      if (body.phone) {
        duplicateChecks.push(
          userModel.findOne({ phone: body.phone, _id: { $ne: deliverer.userId } }).session(session)
        );
      }

      if (body.username) {
        duplicateChecks.push(
          userModel.findOne({ username: body.username, _id: { $ne: deliverer.userId } }).session(session)
        );
      }

      const duplicateResults = await Promise.all(duplicateChecks);

      if (duplicateResults.some((result) => result !== null)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Email, phone, or username already exists", 400));
      }


      const userUpdates: any = {};
      const delivererUpdates: any = {};

      if (body.email) userUpdates.email = body.email;
      if (body.phone) userUpdates.phone = body.phone;
      if (body.username) userUpdates.username = body.username;
      if (body.firstName) userUpdates.firstName = body.firstName;
      if (body.lastName) userUpdates.lastName = body.lastName;
      // if (body.imageUrl !== undefined) userUpdates.imageUrl = body.imageUrl;

      if (body.currentLocation) delivererUpdates.currentLocation = body.currentLocation;
      if (body.documents) delivererUpdates.documents = body.documents;
      if (body.availabilityStatus) delivererUpdates.availabilityStatus = body.availabilityStatus;


      if (Object.keys(userUpdates).length > 0) {
        await userModel.findByIdAndUpdate(deliverer.userId, { $set: userUpdates }, { session });
      }


      Object.assign(deliverer, delivererUpdates);
      await deliverer.save({ session });

      await session.commitTransaction();
      session.endSession();

      const populatedDeliverer = await DelivererModel.findById(delivererId)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("branchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Deliverer updated successfully",
        data: populatedDeliverer,
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

      return next(new ErrorHandler(error.message || "Error updating deliverer", 500));
    }
  }
);



//  TOGGLE BLOCK / ACTIVATE DELIVERER
export const toggleBlockDeliverer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, delivererId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!delivererId || !mongoose.Types.ObjectId.isValid(delivererId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid deliverer ID", 400));
      }

      const [deliverer, supervisor, requestingUser] = await Promise.all([
        DelivererModel.findOne({ _id: delivererId, branchId }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        userModel.findById(supervisorUserId).select("role").session(session),
      ]);

      if (!deliverer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Deliverer not found", 404));
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedSupervisor =
        supervisor && supervisor.isActive && supervisor.hasPermission("can_manage_deliverers");

      if (!isAdmin && !isAuthorizedSupervisor) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Not authorized to change this deliverer's status", 403));
      }

      const newIsActive = !deliverer.isActive;

      await Promise.all([
        deliverer.set({ isActive: newIsActive }).save({ session }),
        userModel.findByIdAndUpdate(
          deliverer.userId,
          { status: newIsActive ? "active" : "suspended" },
          { session }
        ),
      ]);

      await session.commitTransaction();
      session.endSession();

      const updatedDeliverer = await DelivererModel.findById(delivererId)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("branchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: `Deliverer ${newIsActive ? "activated" : "suspended"} successfully`,
        data: {
          deliverer: updatedDeliverer,
          isActive: newIsActive,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error toggling deliverer status", 500));
    }
  }
);



//  GET DELIVERER BY ID
export const getDeliverer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId, delivererId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    if (!delivererId || !mongoose.Types.ObjectId.isValid(delivererId.toString())) {
      return next(new ErrorHandler("Invalid deliverer ID", 400));
    }

    const [deliverer, supervisor, requestingUser] = await Promise.all([
      DelivererModel.findOne({ _id: delivererId, branchId })
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("branchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
      userModel.findById(supervisorUserId).select("role").lean(),
    ]);

    const isAdmin = requestingUser?.role === "admin";
    const isAuthorizedSupervisor = supervisor && supervisor.isActive;

    if (!isAdmin && !isAuthorizedSupervisor) {
      return next(new ErrorHandler("Not authorized to view this deliverer", 403));
    }

    if (!deliverer) {
      return next(new ErrorHandler("Deliverer not found", 404));
    }

    return res.status(200).json({
      success: true,
      data: deliverer,
    });
  }
);



//  GET ALL MY DELIVERERS (BRANCH)
export const getMyDeliverers = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const [branch, supervisor] = await Promise.all([
      BranchModel.findById(branchId).lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
    ]);

    if (!branch) {
      return next(new ErrorHandler("Branch not found", 404));
    }

    if (!supervisor || !supervisor.isActive) {
      return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
    }

    const delivererQuery: mongoose.FilterQuery<typeof DelivererModel> = {
      branchId,
    };

    const { verificationStatus, availabilityStatus, isActive, search } = req.query;

    if (verificationStatus && typeof verificationStatus === "string") {
      delivererQuery.verificationStatus = verificationStatus;
    }

    if (availabilityStatus && typeof availabilityStatus === "string") {
      delivererQuery.availabilityStatus = availabilityStatus;
    }

    if (isActive !== undefined) {
      delivererQuery.isActive = isActive === "true";
    }

    if (search && typeof search === "string") {
      const matchingUsers = await userModel.find({
        $or: [
          { firstName: { $regex: search, $options: "i" } },
          { lastName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ],
      }).select("_id").lean();
      
      const matchingUserIds = matchingUsers.map(user => user._id);
      
      if (matchingUserIds.length > 0) {
        delivererQuery.userId = { $in: matchingUserIds };
      } else {
        return res.status(200).json({
          success: true,
          count: 0,
          data: [],
        });
      }
    }

    const deliverers = await DelivererModel.find(delivererQuery)
      .populate("userId", "firstName lastName email phone username imageUrl role status")
      .populate("branchId", "name code address status")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: deliverers.length,
      data: deliverers,
    });
  }
);




//  TRANSPORTERS INTERFACES

interface ITransporterDocumentsBody {
  contractImage?: string;
  idCardImage?: string;
  licenseImage?: string;
  licenseNumber?: string;
  licenseExpiry?: Date;
  backgroundCheck?: string;
  insuranceImage?: string;
}

interface ICreateTransporter {

  email: string;
  phone: string;
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  // imageUrl?: string;

  documents?: ITransporterDocumentsBody;
}

interface IUpdateTransporter {

  email?: string;
  phone?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  // imageUrl?: string;

  documents?: ITransporterDocumentsBody;
  availabilityStatus?: "available" | "on_route" | "off_duty" | "on_break" | "maintenance";
  currentBranchId?: string;
}



//  CREATE TRANSPORTER
export const createTransporter = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const managerId = req.user?._id;
      const { companyId } = req.params;

      if (!managerId) {
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
        email,
        phone,
        username,
        password,
        firstName,
        lastName,
        // imageUrl,
        documents,
      } = req.body as ICreateTransporter;


      if (!email || !phone || !username || !password || !firstName || !lastName) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("email, phone, username, password, firstName, and lastName are required", 400)
        );
      }


      if (
        typeof email !== "string" ||
        typeof phone !== "string" ||
        typeof username !== "string" ||
        typeof password !== "string" ||
        typeof firstName !== "string" ||
        typeof lastName !== "string"
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("All required fields must be strings", 400));
      }


      const [manager, company] = await Promise.all([
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
        CompanyModel.findById(companyId).session(session),
      ]);

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      if (!manager.hasPermission("can_manage_users")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage transporters", 403));
      }

      if (!company) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Company not found", 404));
      }

      if (company.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot create transporter for an inactive company", 400));
      }


      const [existingEmail, existingPhone, existingUsername] = await Promise.all([
        userModel.findOne({ email }).session(session),
        userModel.findOne({ phone }).session(session),
        userModel.findOne({ username }).session(session),
      ]);

      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Email already exists", 400));
      }

      if (existingPhone) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Phone number already exists", 400));
      }

      if (existingUsername) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Username already exists", 400));
      }


      const user = await userModel.create(
        [
          {
            email,
            phone,
            username,
            passwordHash: password,
            firstName,
            lastName,
            // imageUrl,
            role: "transporter",
            status: "pending",
          },
        ],
        { session }
      );

      const transporter = await TransporterModel.create(
        [
          {
            userId: user[0]._id,
            companyId,
            ...(documents && { documents }),
            availabilityStatus: "off_duty",
            verificationStatus: "pending",
            isActive: true,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populatedTransporter = await TransporterModel.findById(transporter[0]._id)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Transporter created successfully",
        data: populatedTransporter,
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

      return next(new ErrorHandler(error.message || "Error creating transporter", 500));
    }
  }
);




//  UPDATE TRANSPORTER
export const updateTransporter = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const managerId = req.user?._id;
      const { companyId, transporterId } = req.params;

      if (!managerId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!transporterId || !mongoose.Types.ObjectId.isValid(transporterId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid transporter ID", 400));
      }

      const body = req.body as IUpdateTransporter;

      if (Object.keys(body).length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("No update data provided", 400));
      }


      if (body.email !== undefined && typeof body.email !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("email must be a string", 400));
      }

      if (body.phone !== undefined && typeof body.phone !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("phone must be a string", 400));
      }

      if (body.username !== undefined && typeof body.username !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("username must be a string", 400));
      }

      if (body.currentBranchId !== undefined && !mongoose.Types.ObjectId.isValid(body.currentBranchId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }


      const [transporter, manager] = await Promise.all([
        TransporterModel.findOne({ _id: transporterId, companyId }).session(session),
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
      ]);

      if (!transporter) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Transporter not found", 404));
      }

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      if (!manager.hasPermission("can_manage_users")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage transporters", 403));
      }

      const duplicateChecks: Promise<any>[] = [];

      if (body.email) {
        duplicateChecks.push(
          userModel.findOne({ email: body.email, _id: { $ne: transporter.userId } }).session(session)
        );
      }

      if (body.phone) {
        duplicateChecks.push(
          userModel.findOne({ phone: body.phone, _id: { $ne: transporter.userId } }).session(session)
        );
      }

      if (body.username) {
        duplicateChecks.push(
          userModel.findOne({ username: body.username, _id: { $ne: transporter.userId } }).session(session)
        );
      }

      const duplicateResults = await Promise.all(duplicateChecks);

      if (duplicateResults.some((result) => result !== null)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Email, phone, or username already exists", 400));
      }

      const userUpdates: any = {};
      const transporterUpdates: any = {};

      if (body.email) userUpdates.email = body.email;
      if (body.phone) userUpdates.phone = body.phone;
      if (body.username) userUpdates.username = body.username;
      if (body.firstName) userUpdates.firstName = body.firstName;
      if (body.lastName) userUpdates.lastName = body.lastName;
      // if (body.imageUrl !== undefined) userUpdates.imageUrl = body.imageUrl;

      if (body.documents) transporterUpdates.documents = body.documents;
      if (body.availabilityStatus) transporterUpdates.availabilityStatus = body.availabilityStatus;
      if (body.currentBranchId !== undefined) {
        transporterUpdates.currentBranchId = body.currentBranchId
          ? new mongoose.Types.ObjectId(body.currentBranchId)
          : undefined;
      }


      if (Object.keys(userUpdates).length > 0) {
        await userModel.findByIdAndUpdate(transporter.userId, { $set: userUpdates }, { session });
      }

      Object.assign(transporter, transporterUpdates);
      await transporter.save({ session });

      await session.commitTransaction();
      session.endSession();

      const populatedTransporter = await TransporterModel.findById(transporterId)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Transporter updated successfully",
        data: populatedTransporter,
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

      return next(new ErrorHandler(error.message || "Error updating transporter", 500));
    }
  }
);



//  TOGGLE BLOCK / ACTIVATE TRANSPORTER
export const toggleBlockTransporter = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const managerId = req.user?._id;
      const { companyId, transporterId } = req.params;

      if (!managerId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!transporterId || !mongoose.Types.ObjectId.isValid(transporterId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid transporter ID", 400));
      }

      const [transporter, manager, requestingUser] = await Promise.all([
        TransporterModel.findOne({ _id: transporterId, companyId }).session(session),
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
        userModel.findById(managerId).select("role").session(session),
      ]);

      if (!transporter) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Transporter not found", 404));
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedManager = manager && manager.isActive && manager.hasPermission("can_manage_users");

      if (!isAdmin && !isAuthorizedManager) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Not authorized to change this transporter's status", 403));
      }

      const newIsActive = !transporter.isActive;


      await Promise.all([
        transporter.set({ isActive: newIsActive }).save({ session }),
        userModel.findByIdAndUpdate(
          transporter.userId,
          { status: newIsActive ? "active" : "suspended" },
          { session }
        ),
      ]);

      await session.commitTransaction();
      session.endSession();

      const updatedTransporter = await TransporterModel.findById(transporterId)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: `Transporter ${newIsActive ? "activated" : "suspended"} successfully`,
        data: {
          transporter: updatedTransporter,
          isActive: newIsActive,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error toggling transporter status", 500));
    }
  }
);



//  GET TRANSPORTER BY ID
export const getTransporter = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const managerId = req.user?._id;
    const { companyId, transporterId } = req.params;

    if (!managerId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      return next(new ErrorHandler("Invalid company ID", 400));
    }

    if (!transporterId || !mongoose.Types.ObjectId.isValid(transporterId.toString())) {
      return next(new ErrorHandler("Invalid transporter ID", 400));
    }

    const [transporter, manager, requestingUser] = await Promise.all([
      TransporterModel.findOne({ _id: transporterId, companyId })
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .populate("currentVehicleId", "type brand model registrationNumber")
        .lean(),
      ManagerModel.findOne({ userId: managerId, companyId }).lean(),
      userModel.findById(managerId).select("role").lean(),
    ]);

    const isAdmin = requestingUser?.role === "admin";
    const isAuthorizedManager = manager && manager.isActive;

    if (!isAdmin && !isAuthorizedManager) {
      return next(new ErrorHandler("Not authorized to view this transporter", 403));
    }

    if (!transporter) {
      return next(new ErrorHandler("Transporter not found", 404));
    }

    return res.status(200).json({
      success: true,
      data: transporter,
    });
  }
);



//  GET ALL MY TRANSPORTERS (COMPANY)
export const getMyTransporters = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const managerId = req.user?._id;
    const { companyId } = req.params;

    if (!managerId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
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
      return next(new ErrorHandler("You are not an active manager of this company", 403));
    }

    const transporterQuery: mongoose.FilterQuery<typeof TransporterModel> = {
      companyId,
    };

    const { verificationStatus, availabilityStatus, isActive, currentBranchId, search } = req.query;

    if (verificationStatus && typeof verificationStatus === "string") {
      transporterQuery.verificationStatus = verificationStatus;
    }

    if (availabilityStatus && typeof availabilityStatus === "string") {
      transporterQuery.availabilityStatus = availabilityStatus;
    }

    if (isActive !== undefined) {
      transporterQuery.isActive = isActive === "true";
    }

    if (currentBranchId && typeof currentBranchId === "string") {
      if (mongoose.Types.ObjectId.isValid(currentBranchId)) {
        transporterQuery.currentBranchId = new mongoose.Types.ObjectId(currentBranchId);
      }
    }

    if (search && typeof search === "string") {
      const matchingUsers = await userModel.find({
        $or: [
          { firstName: { $regex: search, $options: "i" } },
          { lastName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ],
      }).select("_id").lean();
      
      const matchingUserIds = matchingUsers.map(user => user._id);
      
      if (matchingUserIds.length > 0) {
        transporterQuery.userId = { $in: matchingUserIds };
      } else {

        return res.status(200).json({
          success: true,
          count: 0,
          data: [],
        });
      }
    }

    const transporters = await TransporterModel.find(transporterQuery)
      .populate("userId", "firstName lastName email phone username imageUrl role status")
      .populate("currentBranchId", "name code address status")
      .populate("currentVehicleId", "type brand model registrationNumber")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: transporters.length,
      data: transporters,
    });
  }
);



interface ILocationBody {
  type: "Point";
  coordinates: [number, number];
}

interface IDestinationBody {
  recipientName: string;
  recipientPhone: string;
  alternativePhone?: string;
  address: string;
  city: string;
  state: string;
  postalCode?: string;
  location?: ILocationBody;
  notes?: string;
}

interface IDimensionsBody {
  length: number;
  width: number;
  height: number;
}


interface ICreatePackage {
  senderId: string;
  senderType: "freelancer" | "client";
  recipient: {
    clientId?: string;
    name?: string;
    phone?: string;
    email?: string;
  };
  
  weight: number;
  dimensions?: IDimensionsBody;
  isFragile?: boolean;
  type: "document" | "parcel" | "fragile" | "heavy" | "perishable" | "electronic" | "clothing";
  description?: string;
  declaredValue?: number;
  images?: string[];

  destinationBranchId?: string;

  destination: IDestinationBody;

  deliveryType: "home" | "branch_pickup";
  deliveryPriority?: "standard" | "express" | "same_day";

  totalPrice: number;
  paymentMethod?: "cash" | "card" | "cod" | "wallet" | "bank_transfer";
  estimatedDeliveryTime?: Date;
}


interface IUpdatePackage {
  weight?: number;
  dimensions?: IDimensionsBody;
  isFragile?: boolean;
  type?: "document" | "parcel" | "fragile" | "heavy" | "perishable" | "electronic" | "clothing";
  description?: string;
  declaredValue?: number;
  images?: string[];
  destinationBranchId?: string;
  destination?: IDestinationBody;
  deliveryType?: "home" | "branch_pickup";
  deliveryPriority?: "standard" | "express" | "same_day";
  totalPrice?: number;
  paymentMethod?: "cash" | "card" | "cod" | "wallet" | "bank_transfer";
  paymentStatus?: "pending" | "paid" | "partially_paid" | "refunded" | "failed";
  paidAt?: Date;
  estimatedDeliveryTime?: Date;
  assignedDelivererId?: string;
  assignedVehicleId?: string;
  nextAttemptDate?: Date;
  maxAttempts?: number;
  status?: PackageStatus;
}


interface IAddIssue {
  type: "delay" | "damage" | "lost" | "wrong_address" | "customer_unavailable" | "traffic" | "weather" | "other";
  description: string;
  priority?: "low" | "medium" | "high";
}

async function getOrCreateClient(
  recipientInfo: { clientId?: string; name?: string; phone?: string; email?: string },
  destination: IDestinationBody,
  session: mongoose.ClientSession
): Promise<mongoose.Types.ObjectId> {
  
  if (recipientInfo.clientId) {
    if (!mongoose.Types.ObjectId.isValid(recipientInfo.clientId)) {
      throw new Error("Invalid client id format");
    }
    
    const existingClient = await userModel.findOne({
      _id: recipientInfo.clientId,
      role: "client"
    }).session(session);
    
    if (!existingClient) {
      throw new Error("Client not found");
    }
    
    return existingClient._id;
  }
  

  if (!recipientInfo.phone) {
    throw new Error("Either clientId or recipient phone is required");
  }
  

  let client = await userModel.findOne({ 
    phone: recipientInfo.phone,
    role: "client" 
  }).session(session);
  
  if (client) {
    return client._id;
  }
  

  const recipientName = recipientInfo.name || destination.recipientName;
  
  if (!recipientName) {
    throw new Error("Recipient name is required to create new client");
  }
  
  const [firstName, ...lastNameParts] = recipientName.trim().split(' ');
  const lastName = lastNameParts.join(' ') || 'Client';
  

  const email = recipientInfo.email;
  
  const [newUser] = await userModel.create([{
    email,
    phone: recipientInfo.phone,
    firstName,
    lastName,
    role: 'client',
    status: 'active',
  }], { session });
  

  await clientModel.create([{
    userId: newUser._id,
    deliveryAddresses: [{
      label: 'Package Delivery Address',
      street: destination.address,
      city: destination.city,
      state: destination.state,
      isDefault: true,
    }],
    ...(destination.location && {
      currentLocation: {
        type: 'Point',
        coordinates: destination.location.coordinates,
        timestamp: new Date(),
      }
    }),
  }], { session });
  
  return newUser._id;
}

//  CREATE PACKAGE
// export const createPackage = catchAsyncError(
//   async (req: Request, res: Response, next: NextFunction) => {
//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//       const supervisorUserId = req.user?._id;
//       const { branchId } = req.params;

//       if (!supervisorUserId) {
//         await session.abortTransaction();
//         session.endSession();
//         return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
//       }

//       if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
//         await session.abortTransaction();
//         session.endSession();
//         return next(new ErrorHandler("Invalid branch ID", 400));
//       }

//       const {
//         clientId,
//         weight,
//         dimensions,
//         isFragile,
//         type,
//         description,
//         declaredValue,
//         images,
//         destinationBranchId,
//         destination,
//         deliveryType,
//         deliveryPriority,
//         totalPrice,
//         paymentMethod,
//         estimatedDeliveryTime,
//       } = req.body as ICreatePackage;

//       if (!clientId || !weight || !type || !destination || !deliveryType || !totalPrice) {
//         await session.abortTransaction();
//         session.endSession();
//         return next(
//           new ErrorHandler("clientId, weight, type, destination, deliveryType, and totalPrice are required", 400)
//         );
//       }

//       const [supervisor, branch, client] = await Promise.all([
//         SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
//         BranchModel.findById(branchId).session(session),
//         userModel.findOne({ _id: clientId, role: "client" }).session(session),
//       ]);

//       if (!supervisor || !supervisor.isActive) {
//         await session.abortTransaction();
//         session.endSession();
//         return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
//       }

//       if (!supervisor.hasPermission("can_manage_packages")) {
//         await session.abortTransaction();
//         session.endSession();
//         return next(new ErrorHandler("You don't have permission to manage packages", 403));
//       }

//       if (!branch) {
//         await session.abortTransaction();
//         session.endSession();
//         return next(new ErrorHandler("Branch not found", 404));
//       }

//       if (branch.status !== "active") {
//         await session.abortTransaction();
//         session.endSession();
//         return next(new ErrorHandler("Cannot create package for an inactive branch", 400));
//       }

//       if (!client) {
//         await session.abortTransaction();
//         session.endSession();
//         return next(new ErrorHandler("Client not found", 404));
//       }

//       if (deliveryType === "branch_pickup" && !destinationBranchId) {
//         await session.abortTransaction();
//         session.endSession();
//         return next(new ErrorHandler("Destination branch is required for branch pickup", 400));
//       }

//       if (destinationBranchId) {
//         const destinationBranch = await BranchModel.findById(destinationBranchId).session(session);
//         if (!destinationBranch) {
//           await session.abortTransaction();
//           session.endSession();
//           return next(new ErrorHandler("Destination branch not found", 404));
//         }
//       }

//       const trackingPrefix = "PKG";
//       const timestamp = Date.now().toString().slice(-6);
//       const random = Math.floor(1000 + Math.random() * 9000);
//       const trackingNumber = `${trackingPrefix}${timestamp}${random}`;

//       const packageData = await PackageModel.create(
//         [
//           {
//             trackingNumber,
//             companyId: branch.companyId,
//             clientId,
//             weight,
//             dimensions,
//             isFragile: isFragile || false,
//             type,
//             description,
//             declaredValue,
//             images,
//             originBranchId: branchId,
//             currentBranchId: branchId,
//             destinationBranchId,
//             destination,
//             status: "pending",
//             deliveryType,
//             deliveryPriority: deliveryPriority || "standard",
//             totalPrice,
//             paymentStatus: "pending",
//             paymentMethod,
//             paidAt: null,
//             maxAttempts: 3,
//             attemptCount: 0,
//             issues: [],
//             returnInfo: { isReturn: false },
//             trackingHistory: [
//               {
//                 status: "pending",
//                 branchId,
//                 userId: supervisorUserId,
//                 notes: "Package created",
//                 timestamp: new Date(),
//               },
//             ],
//             estimatedDeliveryTime,
//           },
//         ],
//         { session }
//       );

//       await BranchModel.findByIdAndUpdate(
//         branchId,
//         { $inc: { currentLoad: 1 } },
//         { session }
//       );

//       await session.commitTransaction();
//       session.endSession();

//       const populatedPackage = await PackageModel.findById(packageData[0]._id)
//         .populate("clientId", "firstName lastName email phone username")
//         .populate("originBranchId", "name code address")
//         .populate("currentBranchId", "name code address")
//         .populate("destinationBranchId", "name code address")
//         .populate("assignedDelivererId")
//         .populate("assignedVehicleId")
//         .lean();

//       return res.status(201).json({
//         success: true,
//         message: "Package created successfully",
//         data: populatedPackage,
//       });
//     } catch (error: any) {
//       await session.abortTransaction();
//       session.endSession();

//       if (error.name === "ValidationError") {
//         return next(
//           new ErrorHandler(
//             Object.values(error.errors)
//               .map((err: any) => err.message)
//               .join(", "),
//             400
//           )
//         );
//       }

//       if (error.code === 11000) {
//         return next(new ErrorHandler("Tracking number already exists, please try again", 400));
//       }

//       return next(new ErrorHandler(error.message || "Error creating package", 500));
//     }
//   }
// );


export const createPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {

      const supervisorUserId = req.user?._id;
      const { branchId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const {
        senderId,
        senderType,
        recipient,
        weight,
        dimensions,
        isFragile,
        type,
        description,
        declaredValue,
        images,
        destinationBranchId,
        destination,
        deliveryType,
        deliveryPriority,
        totalPrice,
        paymentMethod,
        estimatedDeliveryTime,
      } = req.body as ICreatePackage;


      if (!senderId || !senderType || !weight || !type || !destination || !deliveryType || !totalPrice) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "senderId, senderType, weight, type, destination, deliveryType, and totalPrice are required",
            400
          )
        );
      }

      if (!recipient || (!recipient.clientId && !recipient.phone)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Recipient info is required (either clientId or phone)", 400)
        );
      }


      if (!mongoose.Types.ObjectId.isValid(senderId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid sender ID", 400));
      }


      const [supervisor, branch, sender, freelancer] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        BranchModel.findById(branchId).session(session),
        userModel.findById(senderId).session(session),
        FreelancerModel.findOne({ userId: senderId }).session(session)
      ]);


      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_manage_packages")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage packages", 403));
      }


      if (!branch) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Branch not found", 404));
      }

      if (branch.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot create package for an inactive branch", 400));
      }


      if (!sender) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Sender not found", 404));
      }


      if(sender.role !== "freelancer"){
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Freelancer not found", 404));
      }

      if (!freelancer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Freelancer not found", 404));
      }

      if (freelancer.status !== 'active') {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Freelancer account is not active", 403));
      }

      if (freelancer.defaultOriginBranchId.toString() !== branchId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Package origin must be freelancer's default branch", 400));
      }
      

      if (deliveryType === "branch_pickup" && !destinationBranchId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Destination branch is required for branch pickup", 400));
      }

      if (destinationBranchId) {
        const destinationBranch = await BranchModel.findById(destinationBranchId).session(session);
        if (!destinationBranch) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Destination branch not found", 404));
        }
      }

      let clientId: mongoose.Types.ObjectId;

      try {
        clientId = await getOrCreateClient(recipient, destination, session);
      } catch (error: any) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler(error.message || "Error processing recipient info", 400));
      }

      const trackingPrefix = "PKG";
      const timestamp = Date.now().toString().slice(-6);
      const random = Math.floor(1000 + Math.random() * 9000);
      const trackingNumber = `${trackingPrefix}${timestamp}${random}`;


      const packageData = await PackageModel.create(
        [
          {
            trackingNumber,
            companyId: branch.companyId,
            senderId,
            senderType,
            clientId,           
            weight,
            dimensions,
            isFragile: isFragile || false,
            type,
            description,
            declaredValue,
            images,
            originBranchId: branchId,
            currentBranchId: branchId,
            destinationBranchId,
            destination,
            status: "pending",
            deliveryType,
            deliveryPriority: deliveryPriority || "standard",
            totalPrice,
            paymentStatus: "pending",
            paymentMethod,
            paidAt: null,
            maxAttempts: 3,
            attemptCount: 0,
            issues: [],
            returnInfo: { isReturn: false },
            trackingHistory: [
              {
                status: "pending",
                branchId,
                userId: supervisorUserId,
                notes: `Package created by supervisor for ${senderType}`,
                timestamp: new Date(),
              },
            ],
            estimatedDeliveryTime,
          },
        ],
        { session }
      );


      await BranchModel.findByIdAndUpdate(
        branchId,
        { $inc: { currentLoad: 1 } },
        { session }
      );

      // // Update freelancer statistics if sender is freelancer --- i will use it later
      // if (senderType === 'freelancer' && freelancer) {
      //   await FreelancerModel.findByIdAndUpdate(
      //     freelancer._id,
      //     {
      //       $inc: {
      //         'statistics.totalPackagesSent': 1,
      //         'statistics.packagesInTransit': 1,
      //         'statistics.totalSpent': totalPrice,
      //       },
      //       $set: { lastActiveAt: new Date() }
      //     },
      //     { session }
      //   );
      // }

      await session.commitTransaction();
      session.endSession();

      const populatedPackage = await PackageModel.findById(packageData[0]._id)
        .populate("senderId", "firstName lastName email phone role")
        .populate("clientId", "firstName lastName email phone")
        .populate("originBranchId", "name code address")
        .populate("currentBranchId", "name code address")
        .populate("destinationBranchId", "name code address")
        .populate("assignedDelivererId")
        .populate("assignedVehicleId")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Package created successfully",
        data: populatedPackage,
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
        return next(new ErrorHandler("Tracking number already exists, please try again", 400));
      }

      return next(new ErrorHandler(error.message || "Error creating package", 500));
    }
  }
);



//  UPDATE PACKAGE
export const updatePackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, packageId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid package ID", 400));
      }

      const body = req.body as IUpdatePackage;

      if (Object.keys(body).length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("No update data provided", 400));
      }

      const [packageDoc, supervisor] = await Promise.all([
        PackageModel.findOne({
          _id: packageId,
          $or: [{ originBranchId: branchId }, { currentBranchId: branchId }],
        }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
      ]);

      if (!packageDoc) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Package not found in this branch", 404));
      }

      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_manage_packages")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage packages", 403));
      }

      if (["delivered", "cancelled", "returned", "lost", "damaged"].includes(packageDoc.status)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler(`Cannot update package in ${packageDoc.status} status`, 400));
      }

      if (body.destinationBranchId) {
        const destinationBranch = await BranchModel.findById(body.destinationBranchId).session(session);
        if (!destinationBranch) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Destination branch not found", 404));
        }
      }

      if (body.assignedDelivererId) {
        const deliverer = await DelivererModel.findOne({
          _id: body.assignedDelivererId,
          branchId,
          isActive: true,
        }).session(session);

        if (!deliverer) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Deliverer not found or not active in this branch", 404));
        }

        if (deliverer.availabilityStatus !== "available") {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Deliverer is not available", 400));
        }
      }

      const packageUpdates: any = { ...body };

      if (body.paymentStatus === "paid" && !packageDoc.paidAt) {
        packageUpdates.paidAt = new Date();
      }

      // // ADDED , Handle freelancer statistics updates based on status changes --- we will use it later
      // if (body.status && body.status !== packageDoc.status && packageDoc.senderType === 'freelancer') {
      //   const freelancer = await FreelancerModel.findOne({ userId: packageDoc.senderId }).session(session);
        
      //   if (freelancer) {
      //     const statsUpdate: any = {};

      //     if (body.status === 'delivered') {
      //       statsUpdate.$inc = {
      //         ...statsUpdate.$inc,
      //         'statistics.packagesDelivered': 1,
      //       };
      //       if (['in_transit_to_branch', 'at_destination_branch', 'out_for_delivery'].includes(packageDoc.status)) {
      //         statsUpdate.$inc['statistics.packagesInTransit'] = -1;
      //       }
      //     }
          
      //     if (body.status === 'failed_delivery') {
      //       statsUpdate.$inc = {
      //         ...statsUpdate.$inc,
      //         'statistics.packagesFailed': 1,
      //       };
      //       if (['in_transit_to_branch', 'at_destination_branch', 'out_for_delivery'].includes(packageDoc.status)) {
      //         statsUpdate.$inc['statistics.packagesInTransit'] = -1;
      //       }
      //     }
          

      //     if (body.status === 'cancelled') {
      //       statsUpdate.$inc = {
      //         ...statsUpdate.$inc,
      //         'statistics.packagesCancelled': 1,
      //       };
      //       if (['in_transit_to_branch', 'at_destination_branch', 'out_for_delivery'].includes(packageDoc.status)) {
      //         statsUpdate.$inc['statistics.packagesInTransit'] = -1;
      //       }
      //     }
          
      //     if (Object.keys(statsUpdate).length > 0) {
      //       await FreelancerModel.findByIdAndUpdate(freelancer._id, statsUpdate, { session });
      //     }
      //   }
      // }

      await PackageModel.findByIdAndUpdate(
        packageId,
        { $set: packageUpdates },
        { session }
      );

      if (
        body.status &&
        body.status !== packageDoc.status &&
        !["delivered", "cancelled", "returned"].includes(body.status)
      ) {
        await PackageModel.findByIdAndUpdate(
          packageId,
          {
            $push: {
              trackingHistory: {
                status: body.status,
                branchId,
                userId: supervisorUserId,
                notes: `Status updated from ${packageDoc.status} to ${body.status}`,
                timestamp: new Date(),
              },
            },
          },
          { session }
        );
      }

      await session.commitTransaction();
      session.endSession();

      const updatedPackage = await PackageModel.findById(packageId)
        .populate("senderId", "firstName lastName email phone role")
        .populate("clientId", "firstName lastName email phone")
        .populate("originBranchId", "name code address")
        .populate("currentBranchId", "name code address")
        .populate("destinationBranchId", "name code address")
        .populate("assignedDelivererId")
        .populate("assignedVehicleId")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Package updated successfully",
        data: updatedPackage,
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

      return next(new ErrorHandler(error.message || "Error updating package", 500));
    }
  }
);



//  TOGGLE CANCEL / REACTIVATE PACKAGE
export const toggleCancelPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, packageId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid package ID", 400));
      }

      const [packageDoc, supervisor, requestingUser] = await Promise.all([
        PackageModel.findOne({
          _id: packageId,
          $or: [{ originBranchId: branchId }, { currentBranchId: branchId }],
        }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        userModel.findById(supervisorUserId).select("role").session(session),
      ]);

      if (!packageDoc) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Package not found", 404));
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedSupervisor =
        supervisor && supervisor.isActive && supervisor.hasPermission("can_manage_packages");

      if (!isAdmin && !isAuthorizedSupervisor) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Not authorized to change this package's status", 403));
      }

      if (packageDoc.status === "delivered") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot cancel a delivered package", 400));
      }

      if (packageDoc.status === "returned") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot cancel a returned package", 400));
      }

      const newStatus = packageDoc.status === "cancelled" ? "pending" : "cancelled";

      await PackageModel.findByIdAndUpdate(
        packageId,
        {
          $set: { status: newStatus },
          $push: {
            trackingHistory: {
              status: newStatus,
              branchId,
              userId: supervisorUserId,
              notes: `Package ${newStatus === "cancelled" ? "cancelled" : "reactivated"}`,
              timestamp: new Date(),
            },
          },
        },
        { session }
      );

      if (newStatus === "cancelled") {
        await BranchModel.findByIdAndUpdate(
          branchId,
          { $inc: { currentLoad: -1 } },
          { session }
        );
      }

      await session.commitTransaction();
      session.endSession();

      const updatedPackage = await PackageModel.findById(packageId)
        .populate("clientId", "firstName lastName email phone username")
        .populate("originBranchId", "name code address")
        .populate("currentBranchId", "name code address")
        .populate("destinationBranchId", "name code address")
        .lean();

      return res.status(200).json({
        success: true,
        message: `Package ${newStatus === "cancelled" ? "cancelled" : "reactivated"} successfully`,
        data: updatedPackage,
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error toggling package status", 500));
    }
  }
);

// GET PACKAGE BY ID (SUPERVISOR)
export const getPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId, packageId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
      return next(new ErrorHandler("Invalid package ID", 400));
    }

    const [packageDoc, supervisor, requestingUser] = await Promise.all([
      PackageModel.findOne({
        _id: packageId,
        $or: [{ originBranchId: branchId }, { currentBranchId: branchId }],
      })
        .populate("clientId", "firstName lastName email phone username imageUrl")
        .populate("originBranchId", "name code address status")
        .populate("currentBranchId", "name code address status")
        .populate("destinationBranchId", "name code address status")
        .populate({
          path: "assignedDelivererId",
          populate: {
            path: "userId",
            select: "firstName lastName email phone",
          },
        })
        .populate("assignedVehicleId", "type brand model registrationNumber")
        .lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
      userModel.findById(supervisorUserId).select("role").lean(),
    ]);

    const isAdmin = requestingUser?.role === "admin";
    const isAuthorizedSupervisor = supervisor && supervisor.isActive;

    if (!isAdmin && !isAuthorizedSupervisor) {
      return next(new ErrorHandler("Not authorized to view this package", 403));
    }

    if (!packageDoc) {
      return next(new ErrorHandler("Package not found", 404));
    }

    return res.status(200).json({
      success: true,
      data: packageDoc,
    });
  }
);

//GET MY BRANCH PACKAGES (SUPERVISOR)
export const getMyBranchPackages = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const [branch, supervisor] = await Promise.all([
      BranchModel.findById(branchId).lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
    ]);

    if (!branch) {
      return next(new ErrorHandler("Branch not found", 404));
    }

    if (!supervisor || !supervisor.isActive) {
      return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
    }

    const packageQuery: mongoose.FilterQuery<typeof PackageModel> = {
      $or: [
        { originBranchId: branchId },
        { currentBranchId: branchId },
      ],
    };

    const {
      status,
      clientId,
      deliveryType,
      deliveryPriority,
      paymentStatus,
      fromDate,
      toDate,
      search,
      page = "1",
      limit = "20",
    } = req.query;

    if (status && typeof status === "string") {
      packageQuery.status = status;
    }

    if (clientId && typeof clientId === "string" && mongoose.Types.ObjectId.isValid(clientId)) {
      packageQuery.clientId = clientId;
    }

    if (deliveryType && typeof deliveryType === "string") {
      packageQuery.deliveryType = deliveryType;
    }

    if (deliveryPriority && typeof deliveryPriority === "string") {
      packageQuery.deliveryPriority = deliveryPriority;
    }

    if (paymentStatus && typeof paymentStatus === "string") {
      packageQuery.paymentStatus = paymentStatus;
    }

    if (fromDate && toDate && typeof fromDate === "string" && typeof toDate === "string") {
      packageQuery.createdAt = {
        $gte: new Date(fromDate),
        $lte: new Date(toDate),
      };
    }

    if (search && typeof search === "string") {
      packageQuery.$or = packageQuery.$or || [];
      packageQuery.$or.push(
        { trackingNumber: { $regex: search, $options: "i" } },
        { "destination.recipientName": { $regex: search, $options: "i" } },
        { "destination.recipientPhone": { $regex: search, $options: "i" } }
      );
    }

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;

    const [packages, totalCount] = await Promise.all([
      PackageModel.find(packageQuery)
        .populate("clientId", "firstName lastName email phone username")
        .populate("originBranchId", "name code")
        .populate("currentBranchId", "name code")
        .populate("destinationBranchId", "name code")
        .populate({
          path: "assignedDelivererId",
          populate: {
            path: "userId",
            select: "firstName lastName",
          },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      PackageModel.countDocuments(packageQuery),
    ]);

    return res.status(200).json({
      success: true,
      count: packages.length,
      totalCount,
      currentPage: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
      data: packages,
    });
  }
);



//ADD PACKAGE PROBLEM 
export const addPackageIssue = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, packageId } = req.params;
      const { type, description, priority } = req.body as IAddIssue;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid package ID", 400));
      }

      if (!type || !description) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Issue type and description are required", 400));
      }

      const [packageDoc, supervisor] = await Promise.all([
        PackageModel.findOne({
          _id: packageId,
          $or: [{ originBranchId: branchId }, { currentBranchId: branchId }],
        }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
      ]);

      if (!packageDoc) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Package not found", 404));
      }

      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_handle_complaints")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to handle complaints", 403));
      }

      if (packageDoc.status === "delivered" || packageDoc.status === "cancelled") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler(`Cannot add issue to ${packageDoc.status} package`, 400));
      }

      const issue = {
        type,
        description,
        reportedBy: supervisorUserId,
        reportedAt: new Date(),
        resolved: false,
        priority: priority || "medium",
      };

      let statusUpdate: any = {
        $push: { issues: issue },
      };

      if (type === "damage") {
        statusUpdate.$set = { status: "damaged" };
      } else if (type === "lost") {
        statusUpdate.$set = { status: "lost" };
      } else if (type === "delay" || type === "customer_unavailable") {
        statusUpdate.$set = { status: "on_hold" };
      }

      statusUpdate.$push = {
        ...statusUpdate.$push,
        trackingHistory: {
          status: statusUpdate.$set?.status || packageDoc.status,
          branchId,
          userId: supervisorUserId,
          notes: `Issue reported: ${type} - ${description}`,
          timestamp: new Date(),
        },
      };

      await PackageModel.findByIdAndUpdate(packageId, statusUpdate, { session });

      await session.commitTransaction();
      session.endSession();

      const updatedPackage = await PackageModel.findById(packageId)
        .populate("clientId", "firstName lastName email phone username")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Issue reported successfully",
        data: updatedPackage,
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error reporting issue", 500));
    }
  }
);

//RESOLVE PACKAGE PROBLEM
export const resolvePackageIssue = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, packageId, issueIndex } = req.params;
      const { resolution } = req.body;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid package ID", 400));
      }

      if (!issueIndex || isNaN(parseInt(issueIndex as string))) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid issue index", 400));
      }

      if (!resolution) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Resolution description is required", 400));
      }

      const [packageDoc, supervisor] = await Promise.all([
        PackageModel.findOne({
          _id: packageId,
          $or: [{ originBranchId: branchId }, { currentBranchId: branchId }],
        }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
      ]);

      if (!packageDoc) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Package not found", 404));
      }

      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_handle_complaints")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to handle complaints", 403));
      }

      // 👇 FIX: cast to string and parse
      const index = parseInt(issueIndex as string, 10);
      
      if (!packageDoc.issues || index >= packageDoc.issues.length) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Issue not found", 404));
      }

      const issue = packageDoc.issues[index];
      if (issue.resolved) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Issue is already resolved", 400));
      }

      const updateQuery: any = {
        $set: {
          [`issues.${index}.resolved`]: true,
          [`issues.${index}.resolvedAt`]: new Date(),
          [`issues.${index}.resolution`]: resolution,
        },
        $push: {
          trackingHistory: {
            status: packageDoc.status,
            branchId,
            userId: supervisorUserId,
            notes: `Issue resolved: ${issue.type} - ${resolution}`,
            timestamp: new Date(),
          },
        },
      };

      const allIssuesResolved = packageDoc.issues.every((iss: any, i: number) => 
        i === index ? true : iss.resolved
      );

      if (allIssuesResolved && ["damaged", "lost", "on_hold"].includes(packageDoc.status)) {
        updateQuery.$set.status = "at_destination_branch";
      }

      await PackageModel.findByIdAndUpdate(packageId, updateQuery, { session });

      await session.commitTransaction();
      session.endSession();

      const updatedPackage = await PackageModel.findById(packageId)
        .populate("clientId", "firstName lastName email phone username")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Issue resolved successfully",
        data: updatedPackage,
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error resolving issue", 500));
    }
  }
);




interface ICreateFreelancer {
  email: string;
  phone: string;
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  // imageUrl?: string;

  businessName?: string;
  businessType?: 'individual' | 'small_business' | 'ecommerce' | 'other';
  preferredDeliveryType?: 'home' | 'branch_pickup';
}


interface IUpdateFreelancer {
  email?: string;
  phone?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  // imageUrl?: string;

  businessName?: string;
  businessType?: 'individual' | 'small_business' | 'ecommerce' | 'other';
  preferredDeliveryType?: 'home' | 'branch_pickup';
}



//  CREATE FREELANCER
export const createFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const {
        email,
        phone,
        username,
        password,
        firstName,
        lastName,
        // imageUrl,
        businessName,
        businessType,
        preferredDeliveryType,
      } = req.body as ICreateFreelancer;

      if (!email || !phone || !username || !password || !firstName || !lastName) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("email, phone, username, password, firstName, and lastName are required", 400)
        );
      }


      if (
        typeof email !== "string" ||
        typeof phone !== "string" ||
        typeof username !== "string" ||
        typeof password !== "string" ||
        typeof firstName !== "string" ||
        typeof lastName !== "string"
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("All required fields must be strings", 400));
      }


      const [supervisor, branch] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        BranchModel.findById(branchId).session(session),
      ]);

      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage freelancers", 403));
      }

      if (!branch) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Branch not found", 404));
      }

      if (branch.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot create freelancer for an inactive branch", 400));
      }


      const [existingEmail, existingPhone, existingUsername] = await Promise.all([
        userModel.findOne({ email }).session(session),
        userModel.findOne({ phone }).session(session),
        userModel.findOne({ username }).session(session),
      ]);

      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Email already exists", 400));
      }

      if (existingPhone) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Phone number already exists", 400));
      }

      if (existingUsername) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Username already exists", 400));
      }


      const user = await userModel.create(
        [
          {
            email,
            phone,
            username,
            passwordHash: password,
            firstName,
            lastName,
            // imageUrl,
            role: "freelancer",
            status: "pending",
          },
        ],
        { session }
      );

      const freelancer = await FreelancerModel.create(
        [
          {
            userId: user[0]._id,
            companyId: branch.companyId,
            defaultOriginBranchId: branchId,
            ...(businessName && { businessName }),
            ...(businessType && { businessType }),
            ...(preferredDeliveryType && { preferredDeliveryType }),
            status: "pending_verification",
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populatedFreelancer = await FreelancerModel.findById(freelancer[0]._id)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("defaultOriginBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Freelancer created successfully",
        data: populatedFreelancer,
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

      return next(new ErrorHandler(error.message || "Error creating freelancer", 500));
    }
  }
);



//  UPDATE FREELANCER
export const updateFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, freelancerId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!freelancerId || !mongoose.Types.ObjectId.isValid(freelancerId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid freelancer ID", 400));
      }

      const body = req.body as IUpdateFreelancer;

      if (Object.keys(body).length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("No update data provided", 400));
      }


      if (body.email !== undefined && typeof body.email !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("email must be a string", 400));
      }

      if (body.phone !== undefined && typeof body.phone !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("phone must be a string", 400));
      }

      if (body.username !== undefined && typeof body.username !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("username must be a string", 400));
      }


      const [freelancer, supervisor] = await Promise.all([
        FreelancerModel.findOne({ _id: freelancerId, defaultOriginBranchId: branchId }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
      ]);

      if (!freelancer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Freelancer not found in this branch", 404));
      }

      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage freelancers", 403));
      }


      const duplicateChecks: Promise<any>[] = [];

      if (body.email) {
        duplicateChecks.push(
          userModel.findOne({ email: body.email, _id: { $ne: freelancer.userId } }).session(session)
        );
      }

      if (body.phone) {
        duplicateChecks.push(
          userModel.findOne({ phone: body.phone, _id: { $ne: freelancer.userId } }).session(session)
        );
      }

      if (body.username) {
        duplicateChecks.push(
          userModel.findOne({ username: body.username, _id: { $ne: freelancer.userId } }).session(session)
        );
      }

      const duplicateResults = await Promise.all(duplicateChecks);

      if (duplicateResults.some((result) => result !== null)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Email, phone, or username already exists", 400));
      }


      const userUpdates: any = {};
      const freelancerUpdates: any = {};

      if (body.email) userUpdates.email = body.email;
      if (body.phone) userUpdates.phone = body.phone;
      if (body.username) userUpdates.username = body.username;
      if (body.firstName) userUpdates.firstName = body.firstName;
      if (body.lastName) userUpdates.lastName = body.lastName;
      // if (body.imageUrl !== undefined) userUpdates.imageUrl = body.imageUrl;

      if (body.businessName !== undefined) freelancerUpdates.businessName = body.businessName;
      if (body.businessType) freelancerUpdates.businessType = body.businessType;
      if (body.preferredDeliveryType) freelancerUpdates.preferredDeliveryType = body.preferredDeliveryType;

      if (Object.keys(userUpdates).length > 0) {
        await userModel.findByIdAndUpdate(freelancer.userId, { $set: userUpdates }, { session });
      }


      Object.assign(freelancer, freelancerUpdates);
      await freelancer.save({ session });

      await session.commitTransaction();
      session.endSession();

      const populatedFreelancer = await FreelancerModel.findById(freelancerId)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("defaultOriginBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Freelancer updated successfully",
        data: populatedFreelancer,
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

      return next(new ErrorHandler(error.message || "Error updating freelancer", 500));
    }
  }
);



//  TOGGLE BLOCK / ACTIVATE FREELANCER
export const toggleBlockFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, freelancerId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!freelancerId || !mongoose.Types.ObjectId.isValid(freelancerId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid freelancer ID", 400));
      }

      const [freelancer, supervisor, requestingUser] = await Promise.all([
        FreelancerModel.findOne({ _id: freelancerId, defaultOriginBranchId: branchId }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        userModel.findById(supervisorUserId).select("role").session(session),
      ]);

      if (!freelancer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Freelancer not found in this branch", 404));
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedSupervisor =
        supervisor && supervisor.isActive && supervisor.hasPermission("can_manage_deliverers");

      if (!isAdmin && !isAuthorizedSupervisor) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Not authorized to change this freelancer's status", 403));
      }


      let newStatus: 'active' | 'suspended';
      
      if (freelancer.status === 'active') {
        newStatus = 'suspended';
      } else if (freelancer.status === 'suspended' || freelancer.status === 'pending_verification') {
        newStatus = 'active';
      } else {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot toggle freelancer with current status", 400));
      }


      await Promise.all([
        freelancer.set({ status: newStatus }).save({ session }),
        userModel.findByIdAndUpdate(
          freelancer.userId,
          { status: newStatus === 'active' ? "active" : "suspended" },
          { session }
        ),
      ]);

      await session.commitTransaction();
      session.endSession();

      const updatedFreelancer = await FreelancerModel.findById(freelancerId)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("defaultOriginBranchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: `Freelancer ${newStatus === "active" ? "activated" : "suspended"} successfully`,
        data: {
          freelancer: updatedFreelancer,
          status: newStatus,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error toggling freelancer status", 500));
    }
  }
);



//  GET FREELANCER BY ID
export const getFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId, freelancerId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    if (!freelancerId || !mongoose.Types.ObjectId.isValid(freelancerId.toString())) {
      return next(new ErrorHandler("Invalid freelancer ID", 400));
    }

    const [freelancer, supervisor, requestingUser] = await Promise.all([
      FreelancerModel.findOne({ _id: freelancerId, defaultOriginBranchId: branchId })
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("defaultOriginBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
      userModel.findById(supervisorUserId).select("role").lean(),
    ]);

    const isAdmin = requestingUser?.role === "admin";
    const isAuthorizedSupervisor = supervisor && supervisor.isActive;

    if (!isAdmin && !isAuthorizedSupervisor) {
      return next(new ErrorHandler("Not authorized to view this freelancer", 403));
    }

    if (!freelancer) {
      return next(new ErrorHandler("Freelancer not found in this branch", 404));
    }

    return res.status(200).json({
      success: true,
      data: freelancer,
    });
  }
);



//  GET ALL FREELANCERS IN MY BRANCH
export const getMyFreelancers = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const [branch, supervisor] = await Promise.all([
      BranchModel.findById(branchId).lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
    ]);

    if (!branch) {
      return next(new ErrorHandler("Branch not found", 404));
    }

    if (!supervisor || !supervisor.isActive) {
      return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
    }

    const freelancerQuery: mongoose.FilterQuery<typeof FreelancerModel> = {
      defaultOriginBranchId: branchId,
    };


    const { status, businessType, search } = req.query;

    if (status && typeof status === "string") {
      freelancerQuery.status = status;
    }

    if (businessType && typeof businessType === "string") {
      freelancerQuery.businessType = businessType;
    }

    const freelancers = await FreelancerModel.find(freelancerQuery)
      .populate({
        path: "userId",
        select: "firstName lastName email phone username imageUrl role status",
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
      .populate("defaultOriginBranchId", "name code address status")
      .sort({ createdAt: -1 })
      .lean();

    const filtered = search ? freelancers.filter((f) => f.userId !== null) : freelancers;

    return res.status(200).json({
      success: true,
      count: filtered.length,
      data: filtered,
    });
  }
);




interface IAssignDeliverer {
  userId: string;
  branchId: string;
  currentLocation?: ILocationBody;
  documents?: IDelivererDocumentsBody;
}

export const assignDeliverer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const { branchId } = req.params;

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const { userId, currentLocation, documents } = req.body as IAssignDeliverer;

      if (!userId || !branchId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("userId and branchId are required", 400));
      }

      if (typeof userId !== "string" || typeof branchId !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("userId and branchId must be strings", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(branchId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid userId or branchId format", 400));
      }

      if (currentLocation) {
        if (
          currentLocation.type !== "Point" ||
          !Array.isArray(currentLocation.coordinates) ||
          currentLocation.coordinates.length !== 2 ||
          typeof currentLocation.coordinates[0] !== "number" ||
          typeof currentLocation.coordinates[1] !== "number"
        ) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Invalid location format. Expected GeoJSON Point", 400));
        }
      }

      const [supervisor, branch, userToAssign, existingDeliverer] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        BranchModel.findById(branchId).session(session),
        userModel.findById(userId).session(session),
        DelivererModel.findOne({ userId }).session(session),
      ]);

      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage deliverers", 403));
      }

      if (!branch) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Branch not found", 404));
      }

      if (branch.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot assign deliverer to an inactive branch", 400));
      }

      if (!userToAssign) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User not found", 404));
      }

      if(["admin", "manager", "supervisor", "transporter","freelancer"].includes(userToAssign.role) === true){
              return next(new ErrorHandler(`User cannot be assigned because he is already a ${userToAssign.role}`, 400));
        }

      if (existingDeliverer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User is already a deliverer", 400));
      }

      const existingFreelancer = await FreelancerModel.findOne({ userId }).session(session);
      if (existingFreelancer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User is already a freelancer, cannot assign as deliverer", 400));
      }

      const existingTransporter = await TransporterModel.findOne({ userId }).session(session);
      if (existingTransporter) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User is already a transporter, cannot assign as deliverer", 400));
      }

      if (userToAssign.role !== "deliverer") {
        userToAssign.role = "deliverer";
        userToAssign.status = "active";
        await userToAssign.save({ session });
      }

      const deliverer = await DelivererModel.create(
        [
          {
            userId,
            companyId: branch.companyId,
            branchId,
            ...(currentLocation && { currentLocation }),
            ...(documents && { documents }),
            availabilityStatus: "off_duty",
            verificationStatus: "approved",
            isActive: true,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populatedDeliverer = await DelivererModel.findById(deliverer[0]._id)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("branchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Deliverer assigned successfully",
        data: populatedDeliverer,
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
        return next(new ErrorHandler("Deliverer already exists for this user", 400));
      }

      return next(new ErrorHandler(error.message || "Error assigning deliverer", 500));
    }
  }
);






interface IAssignTransporter {
  userId: string;
  currentBranchId?: string;
  documents?: ITransporterDocumentsBody;
}

export const assignTransporter = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const managerId = req.user?._id;
      const { companyId } = req.params;

      if (!managerId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const { userId, currentBranchId, documents } = req.body as IAssignTransporter;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("userId is required", 400));
      }

      if (typeof userId !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("userId must be a string", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(userId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid userId format", 400));
      }

      if (currentBranchId && !mongoose.Types.ObjectId.isValid(currentBranchId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID format", 400));
      }

      const [manager, company, userToAssign, existingTransporter] = await Promise.all([
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
        CompanyModel.findById(companyId).session(session),
        userModel.findById(userId).session(session),
        TransporterModel.findOne({ userId }).session(session),
      ]);

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      if (!manager.hasPermission("can_manage_users")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage transporters", 403));
      }

      if (!company) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Company not found", 404));
      }

      if (company.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot assign transporter to an inactive company", 400));
      }

      if (!userToAssign) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User not found", 404));
      }

      if (existingTransporter) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User is already a transporter", 400));
      }

      const existingDeliverer = await DelivererModel.findOne({ userId }).session(session);
      if (existingDeliverer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User is already a deliverer, cannot assign as transporter", 400));
      }

      const existingFreelancer = await FreelancerModel.findOne({ userId }).session(session);
      if (existingFreelancer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User is already a freelancer, cannot assign as transporter", 400));
      }

      if (currentBranchId) {
        const branch = await BranchModel.findOne({ _id: currentBranchId, companyId }).session(session);
        if (!branch) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Branch not found in this company", 404));
        }
      }

      if (userToAssign.role !== "transporter") {
        userToAssign.role = "transporter";
        userToAssign.status = "active";
        await userToAssign.save({ session });
      }

      const transporter = await TransporterModel.create(
        [
          {
            userId,
            companyId,
            ...(currentBranchId && { currentBranchId: new mongoose.Types.ObjectId(currentBranchId) }),
            ...(documents && { documents }),
            availabilityStatus: "off_duty",
            verificationStatus: "approved",
            isActive: true,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populatedTransporter = await TransporterModel.findById(transporter[0]._id)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Transporter assigned successfully",
        data: populatedTransporter,
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
        return next(new ErrorHandler("Transporter already exists for this user", 400));
      }

      return next(new ErrorHandler(error.message || "Error assigning transporter", 500));
    }
  }
);




interface IAssignFreelancer {
  userId: string;
  businessName?: string;
  businessType?: 'individual' | 'small_business' | 'ecommerce' | 'other';
  preferredDeliveryType?: 'home' | 'branch_pickup';
}

export const assignFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const { userId, businessName, businessType, preferredDeliveryType } = req.body as IAssignFreelancer;

      if (!userId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("userId is required", 400));
      }

      if (typeof userId !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("userId must be a string", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(userId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid userId format", 400));
      }

      const [supervisor, branch, userToAssign, existingFreelancer] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        BranchModel.findById(branchId).session(session),
        userModel.findById(userId).session(session),
        FreelancerModel.findOne({ userId }).session(session),
      ]);

      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage freelancers", 403));
      }

      if (!branch) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Branch not found", 404));
      }

      if (branch.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot assign freelancer to an inactive branch", 400));
      }

      if (!userToAssign) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User not found", 404));
      }

      if (existingFreelancer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User is already a freelancer", 400));
      }

      const existingDeliverer = await DelivererModel.findOne({ userId }).session(session);
      if (existingDeliverer) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User is already a deliverer, cannot assign as freelancer", 400));
      }

      const existingTransporter = await TransporterModel.findOne({ userId }).session(session);
      if (existingTransporter) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User is already a transporter, cannot assign as freelancer", 400));
      }

      if (userToAssign.role !== "freelancer") {
        userToAssign.role = "freelancer";
        userToAssign.status = "active";
        await userToAssign.save({ session });
      }

      const freelancer = await FreelancerModel.create(
        [
          {
            userId,
            companyId: branch.companyId,
            defaultOriginBranchId: branchId,
            ...(businessName && { businessName }),
            ...(businessType && { businessType }),
            ...(preferredDeliveryType && { preferredDeliveryType }),
            status: "active",
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populatedFreelancer = await FreelancerModel.findById(freelancer[0]._id)
        .populate("userId", "firstName lastName email phone username imageUrl role status")
        .populate("defaultOriginBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Freelancer assigned successfully",
        data: populatedFreelancer,
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
        return next(new ErrorHandler("Freelancer already exists for this user", 400));
      }

      return next(new ErrorHandler(error.message || "Error assigning freelancer", 500));
    }
  }
);




// const PACKAGE_STATUSES: PackageStatus[] = [
//   "pending",
//   "accepted",
//   "at_origin_branch",
//   "in_transit_to_branch",
//   "at_destination_branch",
//   "out_for_delivery",
//   "delivered",
//   "failed_delivery",
//   "rescheduled",
//   "returned",
//   "cancelled",
//   "lost",
//   "damaged",
//   "on_hold",
// ];

// const DELIVERY_TYPES: DeliveryType[] = ["home", "branch_pickup"];

// const PACKAGE_TYPES: PackageType[] = [
//   "document",
//   "parcel",
//   "fragile",
//   "heavy",
//   "perishable",
//   "electronic",
//   "clothing",
// ];

// const PAYMENT_STATUSES: PaymentStatus[] = [
//   "pending",
//   "paid",
//   "partially_paid",
//   "refunded",
//   "failed",
// ];

// const DELIVERY_PRIORITIES = ["standard", "express", "same_day"] as const;

// const ALLOWED_SORT_FIELDS = [
//   "createdAt",
//   "updatedAt",
//   "totalPrice",
//   "weight",
//   "estimatedDeliveryTime",
//   "attemptCount",
//   "status",
// ] as const;


// //  QUERY INTERFACE


// /**
//  * Packages whose `currentBranchId` matches the requested branch,
//  * with optional filters that cover every caller scenario:
//  *
//  * Scenario A — branch_pickup at destination branch:
//  *   deliveryType=branch_pickup  &  status=at_destination_branch
//  *
//  * Scenario B — home delivery, ready to dispatch:
//  *   deliveryType=home  &  status=at_destination_branch
//  *   (also works with status=out_for_delivery to see already-dispatched ones)
//  *
//  * Scenario C — returned / cancelled / problem packages:
//  *   status=returned  (or  status=damaged,lost,on_hold  etc.)
//  *
//  * All scenarios support the full filter set below.
//  */
// interface IBranchPackagesQuery {
//   // Core filters
//   deliveryType?: string;
//   status?: string;            // single value  OR  comma-separated list
//   packageType?: string;       // single value  OR  comma-separated list
//   paymentStatus?: string;
//   deliveryPriority?: string;

//   // Date range on createdAt
//   fromDate?: string;          
//   toDate?: string;            

//   // Search
//   search?: string;            // trackingNumber prefix OR recipient name (regex)

//   // Flags
//   needsAttention?: string;    // "true" → failed_delivery | damaged | lost | on_hold
//   isOverdue?: string;         // "true" → estimatedDeliveryTime < now

//   // Pagination & sorting
//   page?: string;
//   limit?: string;
//   sortBy?: string;
//   sortOrder?: "asc" | "desc";
// }

// // ─────────────────────────────────────────────
// //  GET BRANCH PACKAGES
// // ─────────────────────────────────────────────

// /**
//  * GET /branches/:branchId/packages          ← supervisor (auto-scoped to their branch)
//  * GET /companies/:companyId/branches/:branchId/packages  ← manager (picks any branch)
//  *
//  * Both roles resolve to the same handler; authorization diverges inside.
//  */
// export const getBranchPackages = catchAsyncError(
//   async (req: Request, res: Response, next: NextFunction) => {
//     const callerId = req.user?._id;
//     const { branchId, companyId } = req.params;

//     // ── Auth ──────────────────────────────────────────────────────────────
//     if (!callerId) {
//       return next(
//         new ErrorHandler("Unauthorized, you are not authenticated.", 401),
//       );
//     }

//     // ── Param validation ──────────────────────────────────────────────────
//     if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
//       return next(new ErrorHandler("Invalid branch ID", 400));
//     }

//     if (companyId && !mongoose.Types.ObjectId.isValid(companyId.toString())) {
//       return next(new ErrorHandler("Invalid company ID", 400));
//     }

//     // ── Query param extraction ────────────────────────────────────────────
//     const {
//       deliveryType,
//       status,
//       packageType,
//       paymentStatus,
//       deliveryPriority,
//       fromDate,
//       toDate,
//       search,
//       needsAttention,
//       isOverdue,
//       page = "1",
//       limit = "20",
//       sortBy = "createdAt",
//       sortOrder = "desc",
//     } = req.query as IBranchPackagesQuery;

//     // ── Pagination & sort validation ──────────────────────────────────────
//     const pageNum = parseInt(page, 10);
//     const limitNum = parseInt(limit, 10);

//     if (isNaN(pageNum) || pageNum < 1) {
//       return next(new ErrorHandler("page must be a positive integer", 400));
//     }
//     if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
//       return next(new ErrorHandler("limit must be between 1 and 100", 400));
//     }
//     if (!ALLOWED_SORT_FIELDS.includes(sortBy as any)) {
//       return next(
//         new ErrorHandler(
//           `sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(", ")}`,
//           400,
//         ),
//       );
//     }
//     if (sortOrder && !["asc", "desc"].includes(sortOrder)) {
//       return next(new ErrorHandler("sortOrder must be 'asc' or 'desc'", 400));
//     }

//     // ── Filter validation ─────────────────────────────────────────────────

//     // deliveryType — single value
//     if (deliveryType !== undefined && !DELIVERY_TYPES.includes(deliveryType as DeliveryType)) {
//       return next(
//         new ErrorHandler(
//           `Invalid deliveryType. Must be one of: ${DELIVERY_TYPES.join(", ")}`,
//           400,
//         ),
//       );
//     }

//     // status — accept a comma-separated list so callers can do status=returned,cancelled
//     let statusFilter: PackageStatus[] | undefined;
//     if (status !== undefined) {
//       const raw = status.split(",").map((s) => s.trim());
//       const invalid = raw.filter((s) => !PACKAGE_STATUSES.includes(s as PackageStatus));
//       if (invalid.length) {
//         return next(
//           new ErrorHandler(
//             `Invalid status value(s): ${invalid.join(", ")}. Allowed: ${PACKAGE_STATUSES.join(", ")}`,
//             400,
//           ),
//         );
//       }
//       statusFilter = raw as PackageStatus[];
//     }

//     // packageType — comma-separated list
//     let packageTypeFilter: PackageType[] | undefined;
//     if (packageType !== undefined) {
//       const raw = packageType.split(",").map((t) => t.trim());
//       const invalid = raw.filter((t) => !PACKAGE_TYPES.includes(t as PackageType));
//       if (invalid.length) {
//         return next(
//           new ErrorHandler(
//             `Invalid packageType value(s): ${invalid.join(", ")}. Allowed: ${PACKAGE_TYPES.join(", ")}`,
//             400,
//           ),
//         );
//       }
//       packageTypeFilter = raw as PackageType[];
//     }

//     if (paymentStatus !== undefined && !PAYMENT_STATUSES.includes(paymentStatus as PaymentStatus)) {
//       return next(
//         new ErrorHandler(
//           `Invalid paymentStatus. Must be one of: ${PAYMENT_STATUSES.join(", ")}`,
//           400,
//         ),
//       );
//     }

//     if (deliveryPriority !== undefined && !DELIVERY_PRIORITIES.includes(deliveryPriority as any)) {
//       return next(
//         new ErrorHandler(
//           `Invalid deliveryPriority. Must be one of: ${DELIVERY_PRIORITIES.join(", ")}`,
//           400,
//         ),
//       );
//     }

//     let fromDateParsed: Date | undefined;
//     let toDateParsed: Date | undefined;

//     if (fromDate !== undefined) {
//       fromDateParsed = new Date(fromDate);
//       if (isNaN(fromDateParsed.getTime())) {
//         return next(new ErrorHandler("fromDate is not a valid date", 400));
//       }
//     }
//     if (toDate !== undefined) {
//       toDateParsed = new Date(toDate);
//       if (isNaN(toDateParsed.getTime())) {
//         return next(new ErrorHandler("toDate is not a valid date", 400));
//       }
//     }
//     if (fromDateParsed && toDateParsed && fromDateParsed > toDateParsed) {
//       return next(new ErrorHandler("fromDate must be before toDate", 400));
//     }

//     // ── Authorization — parallel DB checks ───────────────────────────────
//     const [callerUser, branch, supervisor, manager] = await Promise.all([
//       userModel.findById(callerId).select("role").lean(),
//       BranchModel.findById(branchId).lean(),
//       SupervisorModel.findOne({ userId: callerId, branchId }).lean(),
//       companyId
//         ? ManagerModel.findOne({ userId: callerId, companyId }).lean()
//         : Promise.resolve(null),
//     ]);

//     if (!branch) {
//       return next(new ErrorHandler("Branch not found", 404));
//     }

//     const isAdmin = callerUser?.role === "admin";

//     // Supervisor: must be assigned to exactly this branch
//     const isSupervisor =
//       supervisor &&
//       (supervisor as any).isActive;

//     // Manager: must be active, belong to the company that owns the branch,
//     // and have access to this specific branch
//     const isManager =
//       manager &&
//       (manager as any).isActive &&
//       (manager as any).canAccessBranch(new mongoose.Types.ObjectId(branchId.toString()));

//     if (!isAdmin && !isSupervisor && !isManager) {
//       return next(
//         new ErrorHandler(
//           "Not authorized to view packages for this branch",
//           403,
//         ),
//       );
//     }

//     // ── Build $match ──────────────────────────────────────────────────────
//     const matchStage: Record<string, any> = {
//       currentBranchId: new mongoose.Types.ObjectId(branchId.toString()),
//     };

//     // deliveryType
//     if (deliveryType) {
//       matchStage.deliveryType = deliveryType;
//     }

//     // status — single or multi
//     if (statusFilter) {
//       matchStage.status = statusFilter.length === 1
//         ? statusFilter[0]
//         : { $in: statusFilter };
//     }

//     // packageType — single or multi
//     if (packageTypeFilter) {
//       matchStage.type = packageTypeFilter.length === 1
//         ? packageTypeFilter[0]
//         : { $in: packageTypeFilter };
//     }

//     if (paymentStatus) matchStage.paymentStatus = paymentStatus;
//     if (deliveryPriority) matchStage.deliveryPriority = deliveryPriority;

//     // Date range
//     if (fromDateParsed || toDateParsed) {
//       matchStage.createdAt = {
//         ...(fromDateParsed && { $gte: fromDateParsed }),
//         ...(toDateParsed && { $lte: toDateParsed }),
//       };
//     }

//     // needsAttention flag: packages that need manual intervention
//     if (needsAttention === "true") {
//       matchStage.status = {
//         $in: ["failed_delivery", "damaged", "lost", "on_hold"],
//       };
//     }

//     // isOverdue flag: estimatedDeliveryTime has passed and not yet delivered
//     if (isOverdue === "true") {
//       matchStage.estimatedDeliveryTime = { $lt: new Date() };
//       matchStage.status = { $nin: ["delivered", "cancelled", "returned"] };
//     }

//     // Full-text search: trackingNumber prefix OR recipient name
//     if (search && search.trim().length > 0) {
//       const searchRegex = { $regex: search.trim(), $options: "i" };
//       matchStage.$or = [
//         { trackingNumber: searchRegex },
//         { "destination.recipientName": searchRegex },
//         { "destination.recipientPhone": searchRegex },
//       ];
//     }

//     // ── Aggregation pipeline ──────────────────────────────────────────────
//     const sortDirection = sortOrder === "asc" ? 1 : -1;
//     const skip = (pageNum - 1) * limitNum;

//     const pipeline: mongoose.PipelineStage[] = [
//       { $match: matchStage },

//       // ── Computed fields (mirror model virtuals) ───────────────────────
//       {
//         $addFields: {
//           isDelivered: { $eq: ["$status", "delivered"] },

//           isAtBranch: {
//             $in: ["$status", ["at_origin_branch", "at_destination_branch"]],
//           },

//           isInTransit: {
//             $in: [
//               "$status",
//               ["in_transit_to_branch", "out_for_delivery", "at_destination_branch"],
//             ],
//           },

//           needsAttentionFlag: {
//             $or: [
//               {
//                 $in: [
//                   "$status",
//                   ["failed_delivery", "damaged", "lost", "on_hold"],
//                 ],
//               },
//               {
//                 $gt: [
//                   {
//                     $size: {
//                       $filter: {
//                         input: { $ifNull: ["$issues", []] },
//                         as: "issue",
//                         cond: { $eq: ["$$issue.resolved", false] },
//                       },
//                     },
//                   },
//                   0,
//                 ],
//               },
//             ],
//           },

//           isOverdueFlag: {
//             $and: [
//               { $ifNull: ["$estimatedDeliveryTime", false] },
//               { $lt: ["$estimatedDeliveryTime", new Date()] },
//               { $not: { $in: ["$status", ["delivered", "cancelled", "returned"]] } },
//             ],
//           },

//           // For branch_pickup: package is at its pickup branch and ready
//           isReadyForPickup: {
//             $and: [
//               { $eq: ["$deliveryType", "branch_pickup"] },
//               { $eq: ["$status", "at_destination_branch"] },
//               { $eq: ["$paymentStatus", "paid"] },
//               { $eq: ["$returnInfo.isReturn", false] },
//             ],
//           },

//           // For home delivery: package is at the last branch before delivery
//           isReadyForDispatch: {
//             $and: [
//               { $eq: ["$deliveryType", "home"] },
//               { $eq: ["$status", "at_destination_branch"] },
//               { $eq: ["$paymentStatus", "paid"] },
//               { $eq: ["$returnInfo.isReturn", false] },
//             ],
//           },

//           // Delivery progress score (mirrors model virtual)
//           deliveryProgress: {
//             $switch: {
//               branches: [
//                 { case: { $eq: ["$status", "pending"] },               then: 0   },
//                 { case: { $eq: ["$status", "accepted"] },              then: 10  },
//                 { case: { $eq: ["$status", "at_origin_branch"] },      then: 20  },
//                 { case: { $eq: ["$status", "in_transit_to_branch"] },  then: 40  },
//                 { case: { $eq: ["$status", "at_destination_branch"] }, then: 60  },
//                 { case: { $eq: ["$status", "out_for_delivery"] },      then: 80  },
//                 { case: { $eq: ["$status", "delivered"] },             then: 100 },
//                 { case: { $eq: ["$status", "failed_delivery"] },       then: 80  },
//                 { case: { $eq: ["$status", "rescheduled"] },           then: 70  },
//                 { case: { $eq: ["$status", "returned"] },              then: 100 },
//                 { case: { $eq: ["$status", "on_hold"] },               then: 50  },
//               ],
//               default: 0,
//             },
//           },
//         },
//       },

//       // ── Lookups ───────────────────────────────────────────────────────
//       {
//         $lookup: {
//           from: "branches",
//           localField: "originBranchId",
//           foreignField: "_id",
//           as: "originBranch",
//           pipeline: [{ $project: { name: 1, code: 1, address: 1 } }],
//         },
//       },
//       { $unwind: { path: "$originBranch", preserveNullAndEmptyArrays: true } },

//       {
//         $lookup: {
//           from: "branches",
//           localField: "destinationBranchId",
//           foreignField: "_id",
//           as: "destinationBranch",
//           pipeline: [{ $project: { name: 1, code: 1, address: 1 } }],
//         },
//       },
//       { $unwind: { path: "$destinationBranch", preserveNullAndEmptyArrays: true } },

//       {
//         $lookup: {
//           from: "users",
//           localField: "senderId",
//           foreignField: "_id",
//           as: "sender",
//           pipeline: [
//             { $project: { firstName: 1, lastName: 1, email: 1, phone: 1 } },
//           ],
//         },
//       },
//       { $unwind: { path: "$sender", preserveNullAndEmptyArrays: true } },

//       {
//         $lookup: {
//           from: "users",
//           localField: "assignedDelivererId",
//           foreignField: "_id",
//           as: "assignedDeliverer",
//           pipeline: [
//             { $project: { firstName: 1, lastName: 1, phone: 1 } },
//           ],
//         },
//       },
//       { $unwind: { path: "$assignedDeliverer", preserveNullAndEmptyArrays: true } },

//       // ── Sort ──────────────────────────────────────────────────────────
//       { $sort: { [sortBy]: sortDirection } },

//       // ── Facet: data + totals + breakdown ─────────────────────────────
//       {
//         $facet: {
//           data: [
//             { $skip: skip },
//             { $limit: limitNum },
//             // Strip large embedded arrays from the list view
//             {
//               $project: {
//                 trackingHistory: 0,
//               },
//             },
//           ],

//           totalCount: [{ $count: "count" }],

//           // Count per PackageStatus
//           statusBreakdown: [
//             { $group: { _id: "$status", count: { $sum: 1 } } },
//           ],

//           // Count per deliveryType
//           deliveryTypeBreakdown: [
//             { $group: { _id: "$deliveryType", count: { $sum: 1 } } },
//           ],

//           // Actionable counters for the supervisor dashboard
//           actionableCounters: [
//             {
//               $group: {
//                 _id: null,
//                 readyForPickup:  { $sum: { $cond: ["$isReadyForPickup",  1, 0] } },
//                 readyForDispatch:{ $sum: { $cond: ["$isReadyForDispatch",1, 0] } },
//                 needsAttention:  { $sum: { $cond: ["$needsAttentionFlag",1, 0] } },
//                 overdue:         { $sum: { $cond: ["$isOverdueFlag",     1, 0] } },
//                 outForDelivery:  {
//                   $sum: {
//                     $cond: [{ $eq: ["$status", "out_for_delivery"] }, 1, 0],
//                   },
//                 },
//               },
//             },
//           ],
//         },
//       },
//     ];

//     const [result] = await PackageModel.aggregate(pipeline);

//     const total: number = result.totalCount[0]?.count ?? 0;
//     const totalPages = Math.ceil(total / limitNum);

//     // Reshape flat group arrays → plain objects
//     const statusBreakdown = Object.fromEntries(
//       (result.statusBreakdown as { _id: string; count: number }[]).map(
//         ({ _id, count }) => [_id, count],
//       ),
//     );

//     const deliveryTypeBreakdown = Object.fromEntries(
//       (result.deliveryTypeBreakdown as { _id: string; count: number }[]).map(
//         ({ _id, count }) => [_id, count],
//       ),
//     );

//     const counters = result.actionableCounters[0] ?? {
//       readyForPickup: 0,
//       readyForDispatch: 0,
//       needsAttention: 0,
//       overdue: 0,
//       outForDelivery: 0,
//     };
//     delete counters._id;

//     return res.status(200).json({
//       success: true,
//       data: result.data,
//       pagination: {
//         total,
//         page: pageNum,
//         limit: limitNum,
//         totalPages,
//         hasNextPage: pageNum < totalPages,
//         hasPrevPage: pageNum > 1,
//       },
//       summary: {
//         byStatus: statusBreakdown,
//         byDeliveryType: deliveryTypeBreakdown,
//         actionable: counters,
//       },
//     });
//   },
// );






//created another version just for the supervisor , with additional filters + show also the out_for_delivery packages separately (since they are still at the branch but already dispatched, so supervisors like to see them in a separate section)


const PACKAGE_STATUSES: PackageStatus[] = [
  "pending",
  "accepted",
  "at_origin_branch",
  "in_transit_to_branch",
  "at_destination_branch",
  "out_for_delivery",
  "delivered",
  "failed_delivery",
  "rescheduled",
  "returned",
  "cancelled",
  "lost",
  "damaged",
  "on_hold",
];

const DELIVERY_TYPES: DeliveryType[] = ["home", "branch_pickup"];

const PACKAGE_TYPES: PackageType[] = [
  "document",
  "parcel",
  "fragile",
  "heavy",
  "perishable",
  "electronic",
  "clothing",
];

const PAYMENT_STATUSES: PaymentStatus[] = [
  "pending",
  "paid",
  "partially_paid",
  "refunded",
  "failed",
];

const DELIVERY_PRIORITIES = ["standard", "express", "same_day"] as const;

const ALLOWED_SORT_FIELDS = [
  "createdAt",
  "updatedAt",
  "totalPrice",
  "weight",
  "estimatedDeliveryTime",
  "attemptCount",
  "status",
] as const;


//  QUERY INTERFACE

/**
 * All filters are optional and composable.
 *
 * Response shape depends on deliveryType:
 *
 *  deliveryType=home  (or no deliveryType filter)
 *    → data: { atBranch: { packages, pagination }, outForDelivery: { packages, pagination } }
 *      atBranch       — status: at_destination_branch  (physically waiting at branch)
 *      outForDelivery — status: out_for_delivery        (already dispatched, shown separately)
 *
 *  deliveryType=branch_pickup
 *    → data: [...] flat paginated array
 *
 * Passing status= alongside deliveryType=home still works:
 *   status=at_destination_branch → only atBranch has results, outForDelivery is empty
 *   status=out_for_delivery      → only outForDelivery has results
 */
interface IBranchPackagesQuery {
  deliveryType?: string;
  status?: string;          // single  OR  comma-separated: "returned,cancelled"
  packageType?: string;     // single  OR  comma-separated: "fragile,heavy"
  paymentStatus?: string;
  deliveryPriority?: string;
  fromDate?: string;       
  toDate?: string;         
  search?: string;          // trackingNumber prefix OR recipient name/phone
  needsAttention?: string;  // "true" → status ∈ {failed_delivery, damaged, lost, on_hold}
  isOverdue?: string;       // "true" → estimatedDeliveryTime < now AND not terminal
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}


//  SHARED PIPELINE STAGES


const COMPUTED_FIELDS_STAGE: mongoose.PipelineStage = {
  $addFields: {
    isAtBranch: {
      $in: ["$status", ["at_origin_branch", "at_destination_branch"]],
    },
    isInTransit: {
      $in: [
        "$status",
        ["in_transit_to_branch", "out_for_delivery", "at_destination_branch"],
      ],
    },
    needsAttentionFlag: {
      $or: [
        { $in: ["$status", ["failed_delivery", "damaged", "lost", "on_hold"]] },
        {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ["$issues", []] },
                  as: "issue",
                  cond: { $eq: ["$$issue.resolved", false] },
                },
              },
            },
            0,
          ],
        },
      ],
    },
    isOverdueFlag: {
      $and: [
        { $ifNull: ["$estimatedDeliveryTime", false] },
        { $lt: ["$estimatedDeliveryTime", new Date()] },
        { $not: { $in: ["$status", ["delivered", "cancelled", "returned"]] } },
      ],
    },
    isReadyForPickup: {
      $and: [
        { $eq: ["$deliveryType", "branch_pickup"] },
        { $eq: ["$status", "at_destination_branch"] },
        { $eq: ["$paymentStatus", "paid"] },
        { $eq: ["$returnInfo.isReturn", false] },
      ],
    },
    isReadyForDispatch: {
      $and: [
        { $eq: ["$deliveryType", "home"] },
        { $eq: ["$status", "at_destination_branch"] },
        { $eq: ["$paymentStatus", "paid"] },
        { $eq: ["$returnInfo.isReturn", false] },
      ],
    },
    deliveryProgress: {
      $switch: {
        branches: [
          { case: { $eq: ["$status", "pending"] },               then: 0   },
          { case: { $eq: ["$status", "accepted"] },              then: 10  },
          { case: { $eq: ["$status", "at_origin_branch"] },      then: 20  },
          { case: { $eq: ["$status", "in_transit_to_branch"] },  then: 40  },
          { case: { $eq: ["$status", "at_destination_branch"] }, then: 60  },
          { case: { $eq: ["$status", "out_for_delivery"] },      then: 80  },
          { case: { $eq: ["$status", "delivered"] },             then: 100 },
          { case: { $eq: ["$status", "failed_delivery"] },       then: 80  },
          { case: { $eq: ["$status", "rescheduled"] },           then: 70  },
          { case: { $eq: ["$status", "returned"] },              then: 100 },
          { case: { $eq: ["$status", "on_hold"] },               then: 50  },
        ],
        default: 0,
      },
    },
  },
};

const LOOKUP_STAGES: mongoose.PipelineStage[] = [
  {
    $lookup: {
      from: "branches",
      localField: "originBranchId",
      foreignField: "_id",
      as: "originBranch",
      pipeline: [{ $project: { name: 1, code: 1, address: 1 } }],
    },
  },
  { $unwind: { path: "$originBranch", preserveNullAndEmptyArrays: true } },

  {
    $lookup: {
      from: "branches",
      localField: "destinationBranchId",
      foreignField: "_id",
      as: "destinationBranch",
      pipeline: [{ $project: { name: 1, code: 1, address: 1 } }],
    },
  },
  { $unwind: { path: "$destinationBranch", preserveNullAndEmptyArrays: true } },

  {
    $lookup: {
      from: "users",
      localField: "senderId",
      foreignField: "_id",
      as: "sender",
      pipeline: [
        { $project: { firstName: 1, lastName: 1, email: 1, phone: 1 } },
      ],
    },
  },
  { $unwind: { path: "$sender", preserveNullAndEmptyArrays: true } },

  {
    $lookup: {
      from: "users",
      localField: "assignedDelivererId",
      foreignField: "_id",
      as: "assignedDeliverer",
      pipeline: [{ $project: { firstName: 1, lastName: 1, phone: 1 } }],
    },
  },
  { $unwind: { path: "$assignedDeliverer", preserveNullAndEmptyArrays: true } },
];

const PROJECT_STRIP_HISTORY: mongoose.PipelineStage.Project = {
  $project: { trackingHistory: 0 },
};


//  GET BRANCH PACKAGES


export const getBranchPackages = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      
      const supervisorUserId = req.user?._id;
    const { branchId } = req.params;


    if (!supervisorUserId) {
      return next(
        new ErrorHandler("Unauthorized, you are not authenticated.", 401),
      );
    }


    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }


    const {
      deliveryType,
      status,
      packageType,
      paymentStatus,
      deliveryPriority,
      fromDate,
      toDate,
      search,
      needsAttention,
      isOverdue,
      page = "1",
      limit = "20",
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query as IBranchPackagesQuery;


    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    if (isNaN(pageNum) || pageNum < 1) {
      return next(new ErrorHandler("page must be a positive integer", 400));
    }
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return next(new ErrorHandler("limit must be between 1 and 100", 400));
    }
    if (!ALLOWED_SORT_FIELDS.includes(sortBy as any)) {
      return next(
        new ErrorHandler(
          `sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(", ")}`,
          400,
        ),
      );
    }
    if (sortOrder && !["asc", "desc"].includes(sortOrder)) {
      return next(new ErrorHandler("sortOrder must be 'asc' or 'desc'", 400));
    }


    if (
      deliveryType !== undefined &&
      !DELIVERY_TYPES.includes(deliveryType as DeliveryType)
    ) {
      return next(
        new ErrorHandler(
          `Invalid deliveryType. Must be one of: ${DELIVERY_TYPES.join(", ")}`,
          400,
        ),
      );
    }

    let statusFilter: PackageStatus[] | undefined;
    if (status !== undefined) {
      const raw = status.split(",").map((s) => s.trim());
      const invalid = raw.filter(
        (s) => !PACKAGE_STATUSES.includes(s as PackageStatus),
      );
      if (invalid.length) {
        return next(
          new ErrorHandler(
            `Invalid status value(s): ${invalid.join(", ")}. Allowed: ${PACKAGE_STATUSES.join(", ")}`,
            400,
          ),
        );
      }
      statusFilter = raw as PackageStatus[];
    }

    let packageTypeFilter: PackageType[] | undefined;
    if (packageType !== undefined) {
      const raw = packageType.split(",").map((t) => t.trim());
      const invalid = raw.filter(
        (t) => !PACKAGE_TYPES.includes(t as PackageType),
      );
      if (invalid.length) {
        return next(
          new ErrorHandler(
            `Invalid packageType value(s): ${invalid.join(", ")}. Allowed: ${PACKAGE_TYPES.join(", ")}`,
            400,
          ),
        );
      }
      packageTypeFilter = raw as PackageType[];
    }

    if (
      paymentStatus !== undefined &&
      !PAYMENT_STATUSES.includes(paymentStatus as PaymentStatus)
    ) {
      return next(
        new ErrorHandler(
          `Invalid paymentStatus. Must be one of: ${PAYMENT_STATUSES.join(", ")}`,
          400,
        ),
      );
    }

    if (
      deliveryPriority !== undefined &&
      !DELIVERY_PRIORITIES.includes(deliveryPriority as any)
    ) {
      return next(
        new ErrorHandler(
          `Invalid deliveryPriority. Must be one of: ${DELIVERY_PRIORITIES.join(", ")}`,
          400,
        ),
      );
    }

    let fromDateParsed: Date | undefined;
    let toDateParsed: Date | undefined;

    if (fromDate !== undefined) {
      fromDateParsed = new Date(fromDate);
      if (isNaN(fromDateParsed.getTime())) {
        return next(new ErrorHandler("fromDate is not a valid date", 400));
      }
    }
    if (toDate !== undefined) {
      toDateParsed = new Date(toDate);
      if (isNaN(toDateParsed.getTime())) {
        return next(new ErrorHandler("toDate is not a valid date", 400));
      }
    }
    if (fromDateParsed && toDateParsed && fromDateParsed > toDateParsed) {
      return next(new ErrorHandler("fromDate must be before toDate", 400));
    }

    // ── Authorization ─────────────────────────────────────────────────────
    const [branch, supervisor] = await Promise.all([
      BranchModel.findById(branchId).lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
    ]);

    if (!branch) {
      return next(new ErrorHandler("Branch not found", 404));
    }

    if (!supervisor || !(supervisor as any).isActive) {
      return next(
        new ErrorHandler(
          "You are not an active supervisor of this branch",
          403,
        ),
      );
    }


    const baseMatch: Record<string, any> = {
      currentBranchId: new mongoose.Types.ObjectId(branchId.toString()),
    };

    if (deliveryType) baseMatch.deliveryType = deliveryType;

    if (statusFilter) {
      baseMatch.status =
        statusFilter.length === 1 ? statusFilter[0] : { $in: statusFilter };
    }

    if (packageTypeFilter) {
      baseMatch.type =
        packageTypeFilter.length === 1
          ? packageTypeFilter[0]
          : { $in: packageTypeFilter };
    }

    if (paymentStatus) baseMatch.paymentStatus = paymentStatus;
    if (deliveryPriority) baseMatch.deliveryPriority = deliveryPriority;

    if (fromDateParsed || toDateParsed) {
      baseMatch.createdAt = {
        ...(fromDateParsed && { $gte: fromDateParsed }),
        ...(toDateParsed && { $lte: toDateParsed }),
      };
    }

    // needsAttention and isOverdue override any explicit status filter
    if (needsAttention === "true") {
      baseMatch.status = {
        $in: ["failed_delivery", "damaged", "lost", "on_hold"],
      };
    }

    if (isOverdue === "true") {
      baseMatch.estimatedDeliveryTime = { $lt: new Date() };
      baseMatch.status = { $nin: ["delivered", "cancelled", "returned"] };
    }

    if (search && search.trim().length > 0) {
      const searchRegex = { $regex: search.trim(), $options: "i" };
      baseMatch.$or = [
        { trackingNumber: searchRegex },
        { "destination.recipientName": searchRegex },
        { "destination.recipientPhone": searchRegex },
      ];
    }

    const sortDirection = sortOrder === "asc" ? 1 : -1;
    const skip = (pageNum - 1) * limitNum;

    // ─────────────────────────────────────────────────────────────────────
    //  PATH A — home delivery: split response
    //
    //  Runs when deliveryType=home OR no deliveryType filter is given,
    //  because home packages need their own UI section ("already dispatched").
    //
    //  If the caller also passed a status filter we intersect it with each
    //  branch's own status so one section is simply empty — no extra errors.
    // ─────────────────────────────────────────────────────────────────────
    const isHomePath =
      deliveryType === "home" || deliveryType === undefined;

    if (isHomePath) {
      // Pull the caller's explicit status constraint (if any) so we can
      // intersect it per-branch, then remove it from the shared match so the
      // $facet branches can each add their own status condition.
      const callerStatuses: string[] | null = baseMatch.status
        ? baseMatch.status.$in
          ? baseMatch.status.$in
          : [baseMatch.status]
        : null;

      const sharedMatch: Record<string, any> = { ...baseMatch, deliveryType: "home" };
      delete sharedMatch.status; // each facet branch applies its own

      /**
       * Returns a $match stage for a given target status.
       * If the caller requested specific statuses and targetStatus is not among
       * them, the stage forces an empty result via an impossible condition.
       */
      const branchStatusMatch = (
        targetStatus: string,
      ): mongoose.PipelineStage.Match => ({
        $match:
          callerStatuses === null || callerStatuses.includes(targetStatus)
            ? { status: targetStatus }
            : { status: "__no_match__" },
      });

      const splitPipeline: mongoose.PipelineStage[] = [
        { $match: sharedMatch },
        COMPUTED_FIELDS_STAGE,
        ...LOOKUP_STAGES,
        { $sort: { [sortBy]: sortDirection } },
        {
          $facet: {
            // ── Group 1: waiting at the branch ──────────────────────────
            atBranch: [
              branchStatusMatch("at_destination_branch"),
              { $skip: skip },
              { $limit: limitNum },
              PROJECT_STRIP_HISTORY,
            ],
            atBranchCount: [
              branchStatusMatch("at_destination_branch"),
              { $count: "count" },
            ],

            // ── Group 2: already dispatched ─────────────────────────────
            outForDelivery: [
              branchStatusMatch("out_for_delivery"),
              { $skip: skip },
              { $limit: limitNum },
              PROJECT_STRIP_HISTORY,
            ],
            outForDeliveryCount: [
              branchStatusMatch("out_for_delivery"),
              { $count: "count" },
            ],

            // ── Summary across all matched home packages ─────────────────
            statusBreakdown: [
              { $group: { _id: "$status", count: { $sum: 1 } } },
            ],
            actionableCounters: [
              {
                $group: {
                  _id: null,
                  readyForDispatch: {
                    $sum: { $cond: ["$isReadyForDispatch", 1, 0] },
                  },
                  needsAttention: {
                    $sum: { $cond: ["$needsAttentionFlag", 1, 0] },
                  },
                  overdue: {
                    $sum: { $cond: ["$isOverdueFlag", 1, 0] },
                  },
                },
              },
            ],
          },
        },
      ];

      const [result] = await PackageModel.aggregate(splitPipeline);

      const atBranchTotal: number = result.atBranchCount[0]?.count ?? 0;
      const outForDeliveryTotal: number =
        result.outForDeliveryCount[0]?.count ?? 0;

      const statusBreakdown = Object.fromEntries(
        (result.statusBreakdown as { _id: string; count: number }[]).map(
          ({ _id, count }) => [_id, count],
        ),
      );

      const counters = result.actionableCounters[0] ?? {
        readyForDispatch: 0,
        needsAttention: 0,
        overdue: 0,
      };
      delete counters._id;

      return res.status(200).json({
        success: true,
        deliveryType: "home",
        data: {
          atBranch: {
            packages: result.atBranch,
            pagination: {
              total: atBranchTotal,
              page: pageNum,
              limit: limitNum,
              totalPages: Math.ceil(atBranchTotal / limitNum),
              hasNextPage: pageNum < Math.ceil(atBranchTotal / limitNum),
              hasPrevPage: pageNum > 1,
            },
          },
          outForDelivery: {
            packages: result.outForDelivery,
            pagination: {
              total: outForDeliveryTotal,
              page: pageNum,
              limit: limitNum,
              totalPages: Math.ceil(outForDeliveryTotal / limitNum),
              hasNextPage:
                pageNum < Math.ceil(outForDeliveryTotal / limitNum),
              hasPrevPage: pageNum > 1,
            },
          },
        },
        summary: {
          byStatus: statusBreakdown,
          actionable: counters,
        },
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    //  PATH B — branch_pickup: flat paginated response
    // ─────────────────────────────────────────────────────────────────────

    const flatPipeline: mongoose.PipelineStage[] = [
      { $match: baseMatch },
      COMPUTED_FIELDS_STAGE,
      ...LOOKUP_STAGES,
      { $sort: { [sortBy]: sortDirection } },
      {
        $facet: {
          data: [
            { $skip: skip },
            { $limit: limitNum },
            PROJECT_STRIP_HISTORY,
          ],
          totalCount: [{ $count: "count" }],
          statusBreakdown: [
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ],
          actionableCounters: [
            {
              $group: {
                _id: null,
                readyForPickup: {
                  $sum: { $cond: ["$isReadyForPickup", 1, 0] },
                },
                needsAttention: {
                  $sum: { $cond: ["$needsAttentionFlag", 1, 0] },
                },
                overdue: { $sum: { $cond: ["$isOverdueFlag", 1, 0] } },
              },
            },
          ],
        },
      },
    ];

    const [result] = await PackageModel.aggregate(flatPipeline);

    const total: number = result.totalCount[0]?.count ?? 0;
    const totalPages = Math.ceil(total / limitNum);

    const statusBreakdown = Object.fromEntries(
      (result.statusBreakdown as { _id: string; count: number }[]).map(
        ({ _id, count }) => [_id, count],
      ),
    );

    const counters = result.actionableCounters[0] ?? {
      readyForPickup: 0,
      needsAttention: 0,
      overdue: 0,
    };
    delete counters._id;

    return res.status(200).json({
      success: true,
      deliveryType: "branch_pickup",
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
        byStatus: statusBreakdown,
        actionable: counters,
      },
    });
  

    } catch (error:any) {

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

      return next(new ErrorHandler("Failed to fetch branch packages", 500));
      
      
    }
});





const NON_CANCELLABLE_STATUSES: PackageStatus[] = [
  "delivered", "returned", "lost",
];


const CANCELLABLE_STATUSES: PackageStatus[] = PACKAGE_STATUSES.filter(
  (s) => !NON_CANCELLABLE_STATUSES.includes(s) && s !== "cancelled",
);


const PACKAGE_LOOKUP_STAGES: mongoose.PipelineStage[] = [
  {
    $lookup: {
      from: "users",
      localField: "senderId",
      foreignField: "_id",
      as: "sender",
      pipeline: [
        { $project: { firstName: 1, lastName: 1, email: 1, phone: 1, role: 1 } },
      ],
    },
  },
  { $unwind: { path: "$sender", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "branches",
      localField: "originBranchId",
      foreignField: "_id",
      as: "originBranch",
      pipeline: [{ $project: { name: 1, code: 1, address: 1 } }],
    },
  },
  { $unwind: { path: "$originBranch", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "branches",
      localField: "currentBranchId",
      foreignField: "_id",
      as: "currentBranch",
      pipeline: [{ $project: { name: 1, code: 1, address: 1 } }],
    },
  },
  { $unwind: { path: "$currentBranch", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "branches",
      localField: "destinationBranchId",
      foreignField: "_id",
      as: "destinationBranch",
      pipeline: [{ $project: { name: 1, code: 1, address: 1 } }],
    },
  },
  { $unwind: { path: "$destinationBranch", preserveNullAndEmptyArrays: true } },
  { $project: { trackingHistory: 0 } },
];



function paginationMeta(total: number, page: number, limit: number) {
  const totalPages = Math.ceil(total / limit);
  return { total, page, limit, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 };
}


interface IParsedPagination {
  pageNum: number;
  limitNum: number;
  skip: number;
}

function parsePagination(
  page: string | undefined,
  limit: string | undefined,
  next: NextFunction,
): IParsedPagination | null {
  const pageNum = parseInt(page ?? "1", 10);
  const limitNum = parseInt(limit ?? "20", 10);

  if (isNaN(pageNum) || pageNum < 1) {
    next(new ErrorHandler("page must be a positive integer", 400));
    return null;
  }
  if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
    next(new ErrorHandler("limit must be between 1 and 100", 400));
    return null;
  }
  return { pageNum, limitNum, skip: (pageNum - 1) * limitNum };
}



export const cancelPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, packageId } = req.params;

      if (!supervisorUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid package ID", 400));
      }

      const { reason } = req.body as { reason?: string };

      if ((reason !== undefined && typeof reason !== "string") || (reason && reason.trim().length > 200)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("reason must be a string and must not exceed 200 characters.", 400));
      }

      const [packageDoc, supervisor] = await Promise.all([
        PackageModel.findOne({
          _id: packageId,
          $or: [{ originBranchId: branchId }, { currentBranchId: branchId }],
        }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
      ]);

      if (!packageDoc) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Package not found in this branch", 404));
      }

      if (!supervisor || !supervisor.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_manage_packages")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage packages", 403));
      }

      if (packageDoc.status === "cancelled") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Package is already cancelled", 400));
      }

      if (NON_CANCELLABLE_STATUSES.includes(packageDoc.status)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Cannot cancel a package with status '${packageDoc.status}'`,
            400,
          ),
        );
      }

      await Promise.all([
        PackageModel.findByIdAndUpdate(
          packageId,
          {
            $set: { status: "cancelled" },
            $push: {
              trackingHistory: {
                status: "cancelled",
                branchId,
                userId: supervisorUserId,
                notes: reason
                  ? `Package cancelled by supervisor. Reason: ${reason}`
                  : "Package cancelled by supervisor",
                timestamp: new Date(),
              },
            },
          },
          { session },
        ),
        BranchModel.findByIdAndUpdate(
          branchId,
          { $inc: { currentLoad: -1 } },
          { session },
        ),
      ]);

      await session.commitTransaction();
      session.endSession();

      const updatedPackage = await PackageModel.findById(packageId)
        .populate("senderId", "firstName lastName email phone role")
        .populate("originBranchId", "name code address")
        .populate("currentBranchId", "name code address")
        .populate("destinationBranchId", "name code address")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Package cancelled successfully",
        data: updatedPackage,
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

      return next(new ErrorHandler(error.message || "Error cancelling package", 500));
    }
  },
);






export const getPackagesByStatus = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {

      const supervisorUserId = req.user?._id;
    const { branchId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const { status, deliveryType, page, limit } = req.query as {
      status?: string;
      deliveryType?: string;
      page?: string;
      limit?: string;
    };

   
    if (!status) {
      return next(
        new ErrorHandler(
          `status is required. Allowed values: ${PACKAGE_STATUSES.join(", ")}`,
          400,
        ),
      );
    }

    const rawStatuses = status.split(",").map((s) => s.trim());
    const invalidStatuses = rawStatuses.filter(
      (s) => !PACKAGE_STATUSES.includes(s as PackageStatus),
    );

    if (invalidStatuses.length) {
      return next(
        new ErrorHandler(
          `Invalid status value(s): ${invalidStatuses.join(", ")}. Allowed: ${PACKAGE_STATUSES.join(", ")}`,
          400,
        ),
      );
    }

    if (
      deliveryType !== undefined &&
      !["home", "branch_pickup"].includes(deliveryType)
    ) {
      return next(
        new ErrorHandler(
          "deliveryType must be 'home' or 'branch_pickup'",
          400,
        ),
      );
    }

    const pagination = parsePagination(page, limit, next);
    if (!pagination) return;
    const { pageNum, limitNum, skip } = pagination;


    const [branch, supervisor] = await Promise.all([
      BranchModel.findById(branchId).lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
    ]);

    if (!branch) return next(new ErrorHandler("Branch not found", 404));

    if (!supervisor || !supervisor.isActive || supervisor.branchId.toString() !== branchId.toString()) {
      return next(
        new ErrorHandler("You are not an active supervisor of this branch", 403),
      );
    }


    const matchStage: Record<string, any> = {
      $or: [
        { originBranchId: new mongoose.Types.ObjectId(branchId.toString()) },
        { currentBranchId: new mongoose.Types.ObjectId(branchId.toString()) },
      ],
      status: rawStatuses.length === 1 ? rawStatuses[0] : { $in: rawStatuses },
    };

    if (deliveryType) matchStage.deliveryType = deliveryType;

    const [result] = await PackageModel.aggregate([
      { $match: matchStage },
      ...PACKAGE_LOOKUP_STAGES,
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limitNum }],
          totalCount: [{ $count: "count" }],
        },
      },
    ]);

    const total: number = result.totalCount[0]?.count ?? 0;

    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: paginationMeta(total, pageNum, limitNum),
    });
 
      
    } catch (error:any) {

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

      return next(new ErrorHandler("Failed to fetch packages by status", 500));

    }
 });




export const getPackagesByBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {

    const supervisorUserId = req.user?._id;
    const { branchId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const { isDestination, status, page, limit } = req.query as {
      isDestination?: string;
      status?: string;
      page?: string;
      limit?: string;
    };

    if (isDestination !== undefined && !["true", "false"].includes(isDestination)) {
      return next(new ErrorHandler("isDestination must be 'true' or 'false'", 400));
    }

    const queryByDestination = isDestination === "true";

    let statusFilter: string[] | undefined;
    if (status !== undefined) {
      const raw = status.split(",").map((s) => s.trim());
      const invalid = raw.filter((s) => !PACKAGE_STATUSES.includes(s as PackageStatus));
      if (invalid.length) {
        return next(
          new ErrorHandler(
            `Invalid status value(s): ${invalid.join(", ")}`,
            400,
          ),
        );
      }
      statusFilter = raw;
    }

    const pagination = parsePagination(page, limit, next);
    if (!pagination) return;
    const { pageNum, limitNum, skip } = pagination;


    const [branch, supervisor] = await Promise.all([
      BranchModel.findById(branchId).lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
    ]);

    if (!branch) return next(new ErrorHandler("Branch not found", 404));

    if ((!supervisor || !supervisor.isActive) || (supervisor.branchId.toString() !== branchId.toString())) {
      return next(
        new ErrorHandler("You are not an active supervisor of this branch", 403),
      );
    }

    const branchOid = new mongoose.Types.ObjectId(branchId.toString());

    const matchStage: Record<string, any> = queryByDestination
      ? { destinationBranchId: branchOid }   
      : { currentBranchId: branchOid };

    if (statusFilter) {
      matchStage.status =
        statusFilter.length === 1 ? statusFilter[0] : { $in: statusFilter };
    }

    const [result] = await PackageModel.aggregate([
      { $match: matchStage },
      ...PACKAGE_LOOKUP_STAGES,
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limitNum }],
          totalCount: [{ $count: "count" }],
          statusBreakdown: [
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ],
        },
      },
    ]);

    const total: number = result.totalCount[0]?.count ?? 0;

    const statusBreakdown = Object.fromEntries(
      (result.statusBreakdown as { _id: string; count: number }[]).map(
        ({ _id, count }) => [_id, count],
      ),
    );

    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: paginationMeta(total, pageNum, limitNum),
      summary: { byStatus: statusBreakdown },
    });

      
    } catch (error:any) {

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

      return next(new ErrorHandler("Failed to fetch packages by branch", 500));
      
    }
  }
);



export const getPackagesBySender = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {

    const supervisorUserId = req.user?._id;
    const { branchId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const { senderId, senderType, status, page, limit } = req.query as {
      senderId?: string;
      senderType?: string;
      status?: string;
      page?: string;
      limit?: string;
    };

    if (!senderId) {
      return next(new ErrorHandler("senderId is required", 400));
    }

    if (!mongoose.Types.ObjectId.isValid(senderId)) {
      return next(new ErrorHandler("Invalid senderId", 400));
    }

    const senderUser = await userModel.findById(senderId).select("firstName lastName email phone role").lean();

    if (
     !senderUser || senderUser.role !== "freelancer"
    ) {
      return next(
        new ErrorHandler("sender not found or is not a freelancer", 400),
      );
    }

    let statusFilter: string[] | undefined;
    if (status !== undefined) {
      const raw = status.split(",").map((s) => s.trim());
      const invalid = raw.filter((s) => !PACKAGE_STATUSES.includes(s as PackageStatus));
      if (invalid.length) {
        return next(
          new ErrorHandler(`Invalid status value(s): ${invalid.join(", ")}`, 400),
        );
      }
      statusFilter = raw;
    }

    const pagination = parsePagination(page, limit, next);
    if (!pagination) return;
    const { pageNum, limitNum, skip } = pagination;


    const senderOid = new mongoose.Types.ObjectId(senderId);
    const branchOid = new mongoose.Types.ObjectId(branchId.toString());

    const [branch, supervisor] = await Promise.all([
      BranchModel.findById(branchId).lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
    ]);

    if (!branch) return next(new ErrorHandler("Branch not found", 404));

    if (!supervisor || !supervisor.isActive) {
      return next(
        new ErrorHandler("You are not an active supervisor of this branch", 403),
      );
    }


    const matchStage: Record<string, any> = {
      senderId: senderOid,
      $or: [{ originBranchId: branchOid }, { currentBranchId: branchOid }],
    };

    if (senderType) matchStage.senderType = senderType;

    if (statusFilter) {
      matchStage.status =
        statusFilter.length === 1 ? statusFilter[0] : { $in: statusFilter };
    }

    const [result] = await PackageModel.aggregate([
      { $match: matchStage },
      ...PACKAGE_LOOKUP_STAGES,
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limitNum }],
          totalCount: [{ $count: "count" }],
          statusBreakdown: [
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ],
        },
      },
    ]);

    const total: number = result.totalCount[0]?.count ?? 0;

    const statusBreakdown = Object.fromEntries(
      (result.statusBreakdown as { _id: string; count: number }[]).map(
        ({ _id, count }) => [_id, count],
      ),
    );

    return res.status(200).json({
      success: true,
      sender: senderUser,
      data: result.data,
      pagination: paginationMeta(total, pageNum, limitNum),
      summary: { byStatus: statusBreakdown },
    });

      
    } catch (error:any) {

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

      return next(new ErrorHandler("Failed to fetch packages by sender", 500));

      
    }
  }
);


const phoneRegex: RegExp = /^(\+213|0)(5|6|7)[0-9]{8}$/;


export const getPackagesByReceiver = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      
    const supervisorUserId = req.user?._id;
    const { branchId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const { recipientPhone, recipientName, status, page, limit } = req.query as {
      recipientPhone?: string;
      recipientName?: string;
      status?: string;
      page?: string;
      limit?: string;
    };

    if (!recipientPhone && !recipientName) {
      return next(
        new ErrorHandler(
          "At least one of recipientPhone or recipientName is required",
          400,
        ),
      );
    }

    if (recipientPhone !== undefined && (typeof recipientPhone !== "string" ||  recipientPhone.trim().length === 0 || !phoneRegex.test(recipientPhone.trim()))) {
      return next(new ErrorHandler("recipientPhone is not valid", 400));
    }

    if ((recipientName !== undefined && ( typeof recipientName !== "string" || recipientName.trim().length === 0 || recipientName.trim().length > 50))) {
      return next(new ErrorHandler("recipientName is not valid", 400));
    }

    let statusFilter: string[] | undefined;
    if (status !== undefined) {
      const raw = status.split(",").map((s) => s.trim());
      const invalid = raw.filter((s) => !PACKAGE_STATUSES.includes(s as PackageStatus));
      if (invalid.length) {
        return next(
          new ErrorHandler(`Invalid status value(s): ${invalid.join(", ")}`, 400),
        );
      }
      statusFilter = raw;
    }

    const pagination = parsePagination(page, limit, next);
    if (!pagination) return;
    const { pageNum, limitNum, skip } = pagination;


    const [branch, supervisor] = await Promise.all([
      BranchModel.findById(branchId).lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
    ]);

    if (!branch) return next(new ErrorHandler("Branch not found", 404));

    if (!supervisor || !supervisor.isActive) {
      return next(
        new ErrorHandler("You are not an active supervisor of this branch", 403),
      );
    }


    const branchOid = new mongoose.Types.ObjectId(branchId.toString());

    const matchStage: Record<string, any> = {
      $or: [{ originBranchId: branchOid }, { currentBranchId: branchOid }],
    };

    if (recipientPhone && recipientName) {
      matchStage.$and = [
        { "destination.recipientPhone": recipientPhone.trim() },
        {
          "destination.recipientName": {
            $regex: recipientName.trim(),
            $options: "i",
          },
        },
      ];
    } else if (recipientPhone) {
      matchStage["destination.recipientPhone"] = recipientPhone.trim();
    } else if (recipientName) {
      matchStage["destination.recipientName"] = {
        $regex: recipientName.trim(),
        $options: "i",
      };
    }

    if (statusFilter) {
      matchStage.status =
        statusFilter.length === 1 ? statusFilter[0] : { $in: statusFilter };
    }

    const [result] = await PackageModel.aggregate([
      { $match: matchStage },
      ...PACKAGE_LOOKUP_STAGES,
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limitNum }],
          totalCount: [{ $count: "count" }],
          statusBreakdown: [
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ],
        },
      },
    ]);

    const total: number = result.totalCount[0]?.count ?? 0;

    const statusBreakdown = Object.fromEntries(
      (result.statusBreakdown as { _id: string; count: number }[]).map(
        ({ _id, count }) => [_id, count],
      ),
    );

    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: paginationMeta(total, pageNum, limitNum),
      summary: { byStatus: statusBreakdown },
    });

    } catch (error:any) {
      
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

      return next(new ErrorHandler("Failed to fetch packages by reciever", 500));
    }
  }
);




const READABLE_STATUS: Record<PackageStatus, string> = {
  pending:                "Created",
  accepted:               "Accepted",
  at_origin_branch:       "Arrived at Origin Branch",
  in_transit_to_branch:   "In Transit",
  at_destination_branch:  "Arrived at Destination Branch",
  out_for_delivery:       "Out for Delivery",
  delivered:              "Delivered",
  failed_delivery:        "Delivery Failed",
  rescheduled:            "Rescheduled",
  returned:               "Returned",
  cancelled:              "Cancelled",
  lost:                   "Lost",
  damaged:                "Damaged",
  on_hold:                "On Hold",
};


const HAPPY_PATH: PackageStatus[] = [
  "pending",
  "accepted",
  "at_origin_branch",
  "in_transit_to_branch",
  "at_destination_branch",
  "out_for_delivery",
  "delivered",
];

function deliveryProgress(status: PackageStatus): number {
  const idx = HAPPY_PATH.indexOf(status);
  if (idx !== -1) return Math.round((idx / (HAPPY_PATH.length - 1)) * 100);

  const exceptionMap: Partial<Record<PackageStatus, number>> = {
    failed_delivery: 80,
    rescheduled:     70,
    on_hold:         50,
    returned:        100,
    damaged:         100,
    lost:            0,
    cancelled:       0,
  };
  return exceptionMap[status] ?? 0;
}



export const getPackageHistory = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId, packageId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
      return next(new ErrorHandler("Invalid package ID", 400));
    }


    const { page, limit, fromDate, toDate } = req.query as {
      page?: string;
      limit?: string;
      fromDate?: string;
      toDate?: string;
    };

    const pageNum  = parseInt(page  ?? "1",  10);
    const limitNum = parseInt(limit ?? "20", 10);

    if (isNaN(pageNum)  || pageNum  < 1)          return next(new ErrorHandler("page must be a positive integer", 400));
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) return next(new ErrorHandler("limit must be between 1 and 100", 400));

    let fromDateParsed: Date | undefined;
    let toDateParsed:   Date | undefined;

    if (fromDate !== undefined) {
      fromDateParsed = new Date(fromDate);
      if (isNaN(fromDateParsed.getTime())) return next(new ErrorHandler("fromDate is not a valid date", 400));
    }
    if (toDate !== undefined) {
      toDateParsed = new Date(toDate);
      if (isNaN(toDateParsed.getTime())) return next(new ErrorHandler("toDate is not a valid date", 400));
    }
    if (fromDateParsed && toDateParsed && fromDateParsed > toDateParsed) {
      return next(new ErrorHandler("fromDate must be before toDate", 400));
    }


    const packageOid = new mongoose.Types.ObjectId(packageId.toString());
    const branchOid  = new mongoose.Types.ObjectId(branchId.toString());

    const [packageDoc, supervisor] = await Promise.all([
      PackageModel.findOne({
        _id: packageOid,
        currentBranchId: branchOid,
      })
        .select("trackingNumber status deliveryType destination companyId")
        .lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
    ]);

    if (!packageDoc) {
      return next(new ErrorHandler("Package not found in this branch", 404));
    }

    if (!supervisor || !supervisor.isActive || supervisor.branchId.toString() !== branchId.toString()) {
      return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
    }


    const historyMatch: Record<string, any> = { packageId: packageOid };

    if (fromDateParsed || toDateParsed) {
      historyMatch.timestamp = {
        ...(fromDateParsed && { $gte: fromDateParsed }),
        ...(toDateParsed   && { $lte: toDateParsed   }),
      };
    }

    const skip = (pageNum - 1) * limitNum;

    const [entries, total] = await Promise.all([
      PackageHistoryModel.find(historyMatch)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("handledBy", "firstName lastName role")
        .populate("branchId",  "name code"),
      PackageHistoryModel.countDocuments(historyMatch),
    ]);

    const totalPages = Math.ceil(total / limitNum);

    return res.status(200).json({
      success: true,
      package: {
        id:             packageDoc._id,
        trackingNumber: packageDoc.trackingNumber,
        status:         packageDoc.status,
        readableStatus: READABLE_STATUS[packageDoc.status] ?? packageDoc.status,
        deliveryType:   packageDoc.deliveryType,
        recipient:      packageDoc.destination.recipientName,
      },
      data: entries,
      pagination: {
        total,
        page:        pageNum,
        limit:       limitNum,
        totalPages,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
    });
  },
);





export const getPackageTracking = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId, packageId } = req.params;


    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
      return next(new ErrorHandler("Invalid package ID", 400));
    }

    const branchOid  = new mongoose.Types.ObjectId(branchId.toString());
    const packageOid = new mongoose.Types.ObjectId(packageId.toString());


    const [packageDoc, supervisor] = await Promise.all([
      PackageModel.findOne({ _id: packageOid, currentBranchId: branchOid })
        .select(
          "trackingNumber status deliveryType deliveryPriority " +
          "destination originBranchId currentBranchId destinationBranchId " +
          "estimatedDeliveryTime deliveredAt attemptCount maxAttempts " +
          "returnInfo trackingHistory createdAt"
        )
        .populate("originBranchId",      "name code")
        .populate("currentBranchId",     "name code")
        .populate("destinationBranchId", "name code")
        .lean(),
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
    ]);

    if (!packageDoc) {
      return next(new ErrorHandler("Package not found in this branch", 404));
    }

    if (!supervisor || !supervisor.isActive) {
      return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
    }


    // ── Shape the embedded trackingHistory into a timeline ────────────────
    //
    // Each entry in trackingHistory already has { status, notes, timestamp, branchId, userId }.
    // We sort oldest → newest and attach:
    //   • readableStatus  — human label
    //   • stepState       — "completed" | "active" | "pending"
    //   • isException     — true for failure/problem statuses
    //
    const EXCEPTION_STATUSES = new Set<PackageStatus>([
      "failed_delivery", "rescheduled", "returned",
      "cancelled", "lost", "damaged", "on_hold",
    ]);

    const history: any[] = (packageDoc.trackingHistory ?? [])
      .slice()                                  
      .sort((a: any, b: any) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

    const currentStatus = packageDoc.status as PackageStatus;

    const timeline = history.map((event: any, idx: number) => {
      const status = event.status as PackageStatus;
      const isLast  = idx === history.length - 1;

      return {
        status,
        readableStatus: READABLE_STATUS[status] ?? status,
        isException:    EXCEPTION_STATUSES.has(status),

        stepState: isLast ? "active" : "completed",
        timestamp: event.timestamp,
        notes:     event.notes   ?? null,
        location:  event.location ?? null,
        branchId:  event.branchId ?? null,
        handledBy: event.userId   ?? null,
      };
    });


    const expectedSteps = HAPPY_PATH.map((status) => {
      const reached = history.find((e: any) => e.status === status);
      const isCurrent = status === currentStatus;

      return {
        status,
        readableStatus: READABLE_STATUS[status],
        stepState: reached
          ? isCurrent ? "active" : "completed"
          : "pending",
        timestamp: reached?.timestamp ?? null,
      };
    });


    const latestEvent = history[history.length - 1];
    let lastUpdatedAgo: string | null = null;

    if (latestEvent) {
      const seconds = Math.floor(
        (Date.now() - new Date(latestEvent.timestamp).getTime()) / 1000,
      );
      if      (seconds < 60)   lastUpdatedAgo = "just now";
      else if (seconds < 3600) lastUpdatedAgo = `${Math.floor(seconds / 60)}m ago`;
      else if (seconds < 86400)lastUpdatedAgo = `${Math.floor(seconds / 3600)}h ago`;
      else                     lastUpdatedAgo = `${Math.floor(seconds / 86400)}d ago`;
    }

    return res.status(200).json({
      success: true,

      currentState: {
        status:           currentStatus,
        readableStatus:   READABLE_STATUS[currentStatus] ?? currentStatus,
        isException:      EXCEPTION_STATUSES.has(currentStatus),
        progress:         deliveryProgress(currentStatus),   // 0–100
        lastUpdatedAgo,
      },

      // ── Package summary ────────────────────────────────────────────────
      package: {
        trackingNumber:        packageDoc.trackingNumber,
        deliveryType:          packageDoc.deliveryType,
        deliveryPriority:      packageDoc.deliveryPriority,
        estimatedDeliveryTime: packageDoc.estimatedDeliveryTime ?? null,
        deliveredAt:           packageDoc.deliveredAt           ?? null,
        attemptCount:          packageDoc.attemptCount,
        maxAttempts:           packageDoc.maxAttempts,
        isReturn:              packageDoc.returnInfo?.isReturn  ?? false,
        recipient: {
          name:  packageDoc.destination.recipientName,
          phone: packageDoc.destination.recipientPhone,
          city:  packageDoc.destination.city,
          state: packageDoc.destination.state,
        },
        originBranch:      packageDoc.originBranchId,
        currentBranch:     packageDoc.currentBranchId,
        destinationBranch: packageDoc.destinationBranchId ?? null,
      },
      timeline,
      expectedSteps,
    });
  },
);






// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL HELPER
//  Write one PackageHistory audit record per package in a single insertMany.
//  This keeps every function's catch block clean — one shared call, not N saves.
// ─────────────────────────────────────────────────────────────────────────────

async function writeHistory(
  entries: {
    packageId: mongoose.Types.ObjectId;
    status: PackageStatus;
    handledBy: mongoose.Types.ObjectId;
    handlerRole: "transporter" | "deliverer";
    branchId?: mongoose.Types.ObjectId;
    notes?: string;
  }[],
  session: mongoose.ClientSession,
): Promise<void> {
  const now = new Date();
  await PackageHistoryModel.insertMany(
    entries.map((e) => ({ ...e, timestamp: now })),
    { session },
  );
}




//  TRANSPORTER — MARK PACKAGES IN TRANSIT
//  called when the transporter taps "Start Transport".
export const transporterMarkPackagesInTransit = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const transporterUserId = req.user?._id;
      const { routeId } = req.params;
      const { notes } = req.body as { notes?: string };

      if (!transporterUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid route ID", 400));
      }


      const [transporter, route] = await Promise.all([
        TransporterModel.findOne({ userId: transporterUserId }).session(session),
        RouteModel.findById(routeId).session(session),
      ]);

      if (!transporter || !transporter.isActive || transporter.isSuspended) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Transporter account is not active", 403));
      }

      if (transporter.verificationStatus !== "verified") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Transporter is not verified", 403));
      }

      if (!route) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Route not found", 404));
      }


      if (!route.assignedTransporterId?.equals(transporter._id)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not assigned to this route", 403));
      }

      if (route.status === "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Route is already active", 400));
      }

      if (!["planned", "assigned"].includes(route.status)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Cannot start a route with status '${route.status}'`,
            400,
          ),
        );
      }


      const allPackageIds: mongoose.Types.ObjectId[] = route.stops.flatMap(
        (stop) => stop.packageIds.map((id) => new mongoose.Types.ObjectId(id.toString())),
      );

      if (allPackageIds.length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Route has no packages assigned", 400));
      }

      const now = new Date();


      await PackageModel.updateMany(
        { _id: { $in: allPackageIds } },
        {
          $set: {
            status: "in_transit_to_branch",
            assignedTransporterId: transporter._id,
            currentRouteId: route._id,
          },
          $push: {
            trackingHistory: {
              status: "in_transit_to_branch",
              userId: transporterUserId,
              notes: notes || "Transporter started route — packages in transit",
              timestamp: now,
            },
          },
        },
        { session },
      );


      await writeHistory(
        allPackageIds.map((pid) => ({
          packageId: pid,
          status: "in_transit_to_branch" as PackageStatus,
          handledBy: new mongoose.Types.ObjectId(transporterUserId.toString()),
          handlerRole: "transporter" as const,
          notes: notes || "Transporter started route — packages in transit",
        })),
        session,
      );


      await Promise.all([
        RouteModel.findByIdAndUpdate(
          routeId,
          {
            $set: {
              status: "active",
              actualStart: now,
              currentStopIndex: 0,
            },
          },
          { session },
        ),
        TransporterModel.findByIdAndUpdate(
          transporter._id,
          {
            $set: {
              availabilityStatus: "on_route",
              currentRouteId: route._id,
              lastActiveAt: now,
            },
          },
          { session },
        ),
      ]);

      await session.commitTransaction();
      session.endSession();

      return res.status(200).json({
        success: true,
        message: `Route started — ${allPackageIds.length} package(s) marked in transit`,
        data: {
          routeId: route._id,
          routeNumber: route.routeNumber,
          totalPackages: allPackageIds.length,
          status: "in_transit_to_branch",
          startedAt: now,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error starting transport", 500));
    }
  },
);





// TRANSPORTER — MARK PACKAGES ARRIVED AT BRANCH
//  Called when the transporter physically arrives at a stop (branch).
//  For each package assigned to this stop:
//    • If package.destinationBranchId === this stop's branchId
//      → status: at_destination_branch  (final branch, ready for delivery)
//    • Otherwise
//      → status: in_transit_to_branch   (intermediate branch, will re-transit)
//  currentBranchId is updated to this stop's branchId for every package.


export const transporterMarkPackagesArrivedAtBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const transporterUserId = req.user?._id;
      const { routeId, stopId } = req.params;
      const { notes } = req.body as { notes?: string };

      if (!transporterUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid route ID", 400));
      }

      if (!stopId || !mongoose.Types.ObjectId.isValid(stopId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid stop ID", 400));
      }


      const [transporter, route] = await Promise.all([
        TransporterModel.findOne({ userId: transporterUserId }).session(session),
        RouteModel.findById(routeId).session(session),
      ]);

      if (!transporter || !transporter.isActive || transporter.isSuspended) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Transporter account is not active", 403));
      }

      if (!route) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Route not found", 404));
      }

      if (!route.assignedTransporterId?.equals(transporter._id)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not assigned to this route", 403));
      }

      if (route.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Route must be active to mark arrivals (current: ${route.status})`,
            400,
          ),
        );
      }


      const stopIndex = route.stops.findIndex(
        (s) => s._id?.toString() === stopId,
      );

      if (stopIndex === -1) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Stop not found in this route", 404));
      }

      const stop = route.stops[stopIndex];

      if (!stop.branchId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Stop has no branch associated", 400));
      }

      if (stop.status === "completed") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("This stop is already completed", 400));
      }

      if (stop.packageIds.length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("No packages assigned to this stop", 400));
      }

      const stopBranchOid = new mongoose.Types.ObjectId(stop.branchId.toString());
      const packageIds = stop.packageIds.map(
        (id) => new mongoose.Types.ObjectId(id.toString()),
      );
      const now = new Date();


      const packages = await PackageModel.find(
        { _id: { $in: packageIds } },
        { _id: 1, destinationBranchId: 1 },
      )
        .session(session)
        .lean();


      const finalPackageIds: mongoose.Types.ObjectId[] = [];
      const intermediatePackageIds: mongoose.Types.ObjectId[] = [];

      for (const pkg of packages) {
        const isFinal =
          pkg.destinationBranchId &&
          new mongoose.Types.ObjectId(pkg.destinationBranchId.toString()).equals(
            stopBranchOid,
          );

        if (isFinal) {
          finalPackageIds.push(pkg._id as mongoose.Types.ObjectId);
        } else {
          intermediatePackageIds.push(pkg._id as mongoose.Types.ObjectId);
        }
      }

      const historyEntries: Parameters<typeof writeHistory>[0] = [];


      if (finalPackageIds.length > 0) {
        await PackageModel.updateMany(
          { _id: { $in: finalPackageIds } },
          {
            $set: {
              status: "at_destination_branch",
              currentBranchId: stopBranchOid,
            },
            $push: {
              trackingHistory: {
                status: "at_destination_branch",
                branchId: stopBranchOid,
                userId: transporterUserId,
                notes:
                  notes ||
                  "Package arrived at destination branch — ready for delivery",
                timestamp: now,
              },
            },
          },
          { session },
        );

        finalPackageIds.forEach((pid) =>
          historyEntries.push({
            packageId: pid,
            status: "at_destination_branch",
            handledBy: new mongoose.Types.ObjectId(transporterUserId.toString()),
            handlerRole: "transporter",
            branchId: stopBranchOid,
            notes:
              notes || "Package arrived at destination branch — ready for delivery",
          }),
        );
      }


      if (intermediatePackageIds.length > 0) {
        await PackageModel.updateMany(
          { _id: { $in: intermediatePackageIds } },
          {
            $set: {
              status: "in_transit_to_branch",
              currentBranchId: stopBranchOid,
            },
            $push: {
              trackingHistory: {
                status: "in_transit_to_branch",
                branchId: stopBranchOid,
                userId: transporterUserId,
                notes:
                  notes ||
                  "Package arrived at intermediate branch — will continue to destination",
                timestamp: now,
              },
            },
          },
          { session },
        );

        intermediatePackageIds.forEach((pid) =>
          historyEntries.push({
            packageId: pid,
            status: "in_transit_to_branch",
            handledBy: new mongoose.Types.ObjectId(transporterUserId.toString()),
            handlerRole: "transporter",
            branchId: stopBranchOid,
            notes:
              notes ||
              "Package arrived at intermediate branch — will continue to destination",
          }),
        );
      }

      await writeHistory(historyEntries, session);


      const isLastStop = stopIndex === route.stops.length - 1;

      await RouteModel.findByIdAndUpdate(
        routeId,
        {
          $set: {
            [`stops.${stopIndex}.status`]: "completed",
            [`stops.${stopIndex}.actualArrival`]: now,
            [`stops.${stopIndex}.actualDeparture`]: now,
            currentStopIndex: stopIndex + 1,
            completedStops: route.completedStops + 1,

            ...(isLastStop && {
              status: "completed",
              actualEnd: now,
              actualTime:
                route.actualStart
                  ? Math.round(
                      (now.getTime() - new Date(route.actualStart).getTime()) /
                        60000,
                    )
                  : undefined,
            }),
          },
        },
        { session },
      );


      if (isLastStop) {
        await TransporterModel.findByIdAndUpdate(
          transporter._id,
          {
            $set: {
              availabilityStatus: "available",
              currentRouteId: undefined,
              lastActiveAt: now,
            },
            $inc: {
              totalTrips: 1,
              completedTrips: 1,
            },
          },
          { session },
        );
      }

      await session.commitTransaction();
      session.endSession();

      return res.status(200).json({
        success: true,
        message: `Arrived at branch — ${finalPackageIds.length} package(s) at destination, ${intermediatePackageIds.length} intermediate`,
        data: {
          routeId: route._id,
          stopId: stop._id,
          branchId: stopBranchOid,
          arrivedAt: now,
          packages: {
            atDestination: {
              count: finalPackageIds.length,
              status: "at_destination_branch",
              ids: finalPackageIds,
            },
            intermediate: {
              count: intermediatePackageIds.length,
              status: "in_transit_to_branch",
              ids: intermediatePackageIds,
            },
          },
          routeCompleted: isLastStop,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(
        new ErrorHandler(error.message || "Error marking packages arrived", 500),
      );
    }
  },
);





// DELIVERER — MARK PACKAGES OUT FOR DELIVERY
//
//  Called when a deliverer picks up one or more packages from the branch to
//  deliver to clients. Accepts a single packageId or an array (bulk).
//  Package must be at_destination_branch and deliveryType must be 'home'.

export const arrivedAtBranchOutForDelivery = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const delivererUserId = req.user?._id;
      const { branchId } = req.params;

      if (!delivererUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const { packageIds: rawIds, notes } = req.body as {
        packageIds?: string | string[];
        notes?: string;
      };

      if (!rawIds || (Array.isArray(rawIds) && rawIds.length === 0)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("packageIds is required", 400));
      }


      const idList: string[] = Array.isArray(rawIds) ? rawIds : [rawIds];

      const invalidIds = idList.filter(
        (id) => !mongoose.Types.ObjectId.isValid(id),
      );
      if (invalidIds.length) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Invalid package ID(s): ${invalidIds.join(", ")}`,
            400,
          ),
        );
      }

      const packageOids = idList.map((id) => new mongoose.Types.ObjectId(id));
      const branchOid = new mongoose.Types.ObjectId(branchId.toString());


      const [deliverer, packages] = await Promise.all([
        DelivererModel.findOne({ userId: delivererUserId, branchId }).session(
          session,
        ),
        PackageModel.find({ _id: { $in: packageOids } })
          .select("_id status deliveryType currentBranchId assignedDelivererId")
          .session(session)
          .lean(),
      ]);

      if (!deliverer || !deliverer.isActive || deliverer.isSuspended) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Deliverer account is not active in this branch", 403),
        );
      }

      if (deliverer.verificationStatus !== "verified") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Deliverer is not verified", 403));
      }

      if (deliverer.availabilityStatus === "off_duty") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Deliverer is off duty", 403));
      }


      if (packages.length !== packageOids.length) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "One or more packages not found",
            404,
          ),
        );
      }

      const invalidPackages: string[] = [];

      for (const pkg of packages) {
        if (pkg.status !== "at_destination_branch") {
          invalidPackages.push(
            `${pkg._id}: status must be 'at_destination_branch' (is '${pkg.status}')`,
          );
        } else if (pkg.deliveryType !== "home") {
          invalidPackages.push(
            `${pkg._id}: deliveryType must be 'home' (is '${pkg.deliveryType}') — branch_pickup packages are self-collected`,
          );
        } else if (
          !pkg.currentBranchId ||
          !new mongoose.Types.ObjectId(pkg.currentBranchId.toString()).equals(
            branchOid,
          )
        ) {
          invalidPackages.push(
            `${pkg._id}: package is not currently at this branch`,
          );
        }
      }

      if (invalidPackages.length) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Invalid package(s):\n${invalidPackages.join("\n")}`,
            400,
          ),
        );
      }

      const now = new Date();


      await PackageModel.updateMany(
        { _id: { $in: packageOids } },
        {
          $set: {
            status: "out_for_delivery",
            assignedDelivererId: deliverer._id,
            lastAttemptDate: now,
          },
          $push: {
            trackingHistory: {
              status: "out_for_delivery",
              branchId: branchOid,
              userId: delivererUserId,
              notes: notes || "Package picked up by deliverer — out for delivery",
              timestamp: now,
            },
          },
        },
        { session },
      );


      await writeHistory(
        packageOids.map((pid) => ({
          packageId: pid,
          status: "out_for_delivery" as PackageStatus,
          handledBy: new mongoose.Types.ObjectId(delivererUserId.toString()),
          handlerRole: "deliverer" as const,
          branchId: branchOid,
          notes: notes || "Package picked up by deliverer — out for delivery",
        })),
        session,
      );


      await DelivererModel.findByIdAndUpdate(
        deliverer._id,
        {
          $set: {
            availabilityStatus: "on_route",
            lastActiveAt: now,
          },
        },
        { session },
      );

      await session.commitTransaction();
      session.endSession();

      return res.status(200).json({
        success: true,
        message: `${packageOids.length} package(s) marked out for delivery`,
        data: {
          packageIds: packageOids,
          delivererId: deliverer._id,
          branchId: branchOid,
          status: "out_for_delivery",
          dispatchedAt: now,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(
        new ErrorHandler(error.message || "Error marking packages out for delivery", 500),
      );
    }
  },
);




// DELIVERER — MARK DELIVERY FAILED
//  Called when the deliverer could not deliver the package.
//  Increments attemptCount. If attemptCount >= maxAttempts the package
//  model's pre-save hook will automatically flip it to 'returned'.
//  Otherwise it stays 'failed_delivery' and nextAttemptDate is set (+1 day).


export const deliverPackageFail = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const delivererUserId = req.user?._id;
      const { branchId, packageId } = req.params;

      if (!delivererUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid package ID", 400));
      }

      const { reason, notes } = req.body as { reason?: string; notes?: string };

      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("reason is required — explain why delivery failed", 400),
        );
      }

      const branchOid = new mongoose.Types.ObjectId(branchId.toString());

 
      const [deliverer, packageDoc] = await Promise.all([
        DelivererModel.findOne({ userId: delivererUserId, branchId }).session(session),
        PackageModel.findOne({
          _id: packageId,
          assignedDelivererId: { $exists: true },
          currentBranchId: branchOid,
        }).session(session),
      ]);

      if (!deliverer || !deliverer.isActive || deliverer.isSuspended) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Deliverer account is not active in this branch", 403),
        );
      }

      if (!packageDoc) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Package not found or not assigned to this branch", 404));
      }


      if (!packageDoc.assignedDelivererId?.equals(deliverer._id)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("This package is not assigned to you", 403),
        );
      }

      if (packageDoc.status !== "out_for_delivery") {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Package must be 'out_for_delivery' to mark as failed (is '${packageDoc.status}')`,
            400,
          ),
        );
      }

      const now = new Date();
      const newAttemptCount = packageDoc.attemptCount + 1;
      const maxReached = newAttemptCount >= packageDoc.maxAttempts;

      // When max attempts are reached the pre-save hook flips status to 'returned'
      // and sets returnInfo i match that behaviour explicitly here so i can
      // write the correct history status and include it in the response.

      const newStatus: PackageStatus = maxReached
        ? "returned"
        : "failed_delivery";

      const nextAttemptDate = !maxReached
        ? new Date(now.getTime() + 24 * 60 * 60 * 1000)
        : undefined;

      const packageUpdate: Record<string, any> = {
        $set: {
          status: newStatus,
          attemptCount: newAttemptCount,
          lastAttemptDate: now,
          ...(nextAttemptDate && { nextAttemptDate }),
          ...(maxReached && {
            "returnInfo.isReturn": true,
            "returnInfo.reason": "Maximum delivery attempts exceeded",
            "returnInfo.returnDate": now,
          }),
        },
        $push: {
          trackingHistory: {
            status: newStatus,
            branchId: branchOid,
            userId: delivererUserId,
            notes: `Failed delivery — Reason: ${reason.trim()}${notes ? ` | ${notes}` : ""}`,
            timestamp: now,
          },
        },
      };

      await PackageModel.findByIdAndUpdate(packageId, packageUpdate, { session });

      await writeHistory(
        [
          {
            packageId: new mongoose.Types.ObjectId(packageId.toString()),
            status: newStatus,
            handledBy: new mongoose.Types.ObjectId(delivererUserId.toString()),
            handlerRole: "deliverer",
            branchId: branchOid,
            notes: `Failed delivery — Reason: ${reason.trim()}${notes ? ` | ${notes}` : ""}`,
          },
        ],
        session,
      );


      await DelivererModel.findByIdAndUpdate(
        deliverer._id,
        {
          $set: {
            availabilityStatus: "available",
            lastActiveAt: now,
          },
          $inc: {
            totalDeliveries: 1,
            failedDeliveries: 1,
          },
        },
        { session },
      );

      await session.commitTransaction();
      session.endSession();

      return res.status(200).json({
        success: true,
        message: maxReached
          ? `Package marked as returned — maximum attempts (${packageDoc.maxAttempts}) reached`
          : `Delivery failed — attempt ${newAttemptCount} of ${packageDoc.maxAttempts}`,
        data: {
          packageId,
          status: newStatus,
          attemptCount: newAttemptCount,
          maxAttempts: packageDoc.maxAttempts,
          maxAttemptsReached: maxReached,
          nextAttemptDate: nextAttemptDate ?? null,
          reason: reason.trim(),
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(
        new ErrorHandler(error.message || "Error marking delivery as failed", 500),
      );
    }
  },
);


// DELIVERER — RETURN PACKAGE TO BRANCH
//  Called when the deliverer physically brings the package back to the branch
//  after a failed delivery (or explicit return). Status → 'returned'.
//  currentBranchId stays the same (it's already this branch).

export const deliveryReturnPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const delivererUserId = req.user?._id;
      const { branchId, packageId } = req.params;

      if (!delivererUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid package ID", 400));
      }

      const { reason, notes } = req.body as {
        reason?: string;
        notes?: string;
      };

      const branchOid = new mongoose.Types.ObjectId(branchId.toString());


      const [deliverer, packageDoc] = await Promise.all([
        DelivererModel.findOne({ userId: delivererUserId, branchId }).session(session),
        PackageModel.findOne({
          _id: packageId,
          currentBranchId: branchOid,
        }).session(session),
      ]);

      if (!deliverer || !deliverer.isActive || deliverer.isSuspended) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Deliverer account is not active in this branch", 403),
        );
      }

      if (!packageDoc) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Package not found at this branch", 404),
        );
      }

      const returnableStatuses: PackageStatus[] = [
        "out_for_delivery",
        "failed_delivery",
      ];

      if (!returnableStatuses.includes(packageDoc.status)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Cannot return a package with status '${packageDoc.status}'. ` +
              `Only packages that are 'out_for_delivery' or 'failed_delivery' can be returned.`,
            400,
          ),
        );
      }


      if (
        packageDoc.assignedDelivererId &&
        !packageDoc.assignedDelivererId.equals(deliverer._id)
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("This package is not assigned to you", 403),
        );
      }

      const now = new Date();
      const returnReason =
        reason?.trim() ||
        (packageDoc.status === "failed_delivery"
          ? "Returned after failed delivery"
          : "Package returned to branch by deliverer");

      const noteText = [returnReason, notes?.trim()].filter(Boolean).join(" | ");

      await PackageModel.findByIdAndUpdate(
        packageId,
        {
          $set: {
            status: "returned",
            "returnInfo.isReturn": true,
            "returnInfo.reason": returnReason,
            "returnInfo.returnDate": now,

          },
          $push: {
            trackingHistory: {
              status: "returned",
              branchId: branchOid,
              userId: delivererUserId,
              notes: noteText,
              timestamp: now,
            },
          },
        },
        { session },
      );

      await writeHistory(
        [
          {
            packageId: new mongoose.Types.ObjectId(packageId.toString()),
            status: "returned",
            handledBy: new mongoose.Types.ObjectId(delivererUserId.toString()),
            handlerRole: "deliverer",
            branchId: branchOid,
            notes: noteText,
          },
        ],
        session,
      );


      await DelivererModel.findByIdAndUpdate(
        deliverer._id,
        {
          $set: {
            availabilityStatus: "available",
            lastActiveAt: now,
          },
        },
        { session },
      );

      await session.commitTransaction();
      session.endSession();

      return res.status(200).json({
        success: true,
        message: "Package returned to branch successfully",
        data: {
          packageId,
          status: "returned",
          currentBranchId: branchOid,
          returnedAt: now,
          reason: returnReason,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(
        new ErrorHandler(error.message || "Error returning package", 500),
      );
    }
  },
);





const LOCKED_STATUSES: RouteStatus[] = ["active", "paused", "completed", "cancelled"];


const ROUTE_POPULATE = [
  { path: "originBranchId",      select: "name code address wilaya" },
  { path: "destinationBranchId", select: "name code address wilaya" },
  { path: "assignedVehicleId",   select: "type registrationNumber brand modelName maxWeight maxVolume" },
  {
    path: "assignedTransporterId",
    populate: { path: "userId", select: "firstName lastName phone" },
  },
  {
    path: "assignedDelivererId",
    populate: { path: "userId", select: "firstName lastName phone" },
  },
] as const;


//  UPDATE ROUTE
//
//  What can be updated and when:
//    • name, scheduledStart, scheduledEnd, notes → any non-locked status
//    • cancellationReason                        → only when cancelling
//    • stops[].notes, stops[].contactPerson,
//      stops[].contactPhone, stops[].expectedArrival → planned / assigned only
//
//  What can NEVER be updated here:
//    • status  → use the dedicated deactivate endpoint (toggles to cancelled)
//    • assignedTransporterId / assignedDelivererId / assignedVehicleId
//      → use dedicated assign/release endpoints (not yet built — blocked here)
//    • stops[].packageIds → packages are added/removed via package controllers
//    • distance, estimatedTime, currentStopIndex → computed / runtime fields
//
//  Route must belong to this branch (originBranchId OR destinationBranchId).
//  Supervisor must be active and have can_manage_schedules permission.


export const updateRoute = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, routeId } = req.params;


      if (!supervisorUserId) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }
      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }
      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId.toString())) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("Invalid route ID", 400));
      }


      const body = req.body as {
        name?:          string;
        scheduledStart?: string;
        scheduledEnd?:   string;
        completionNotes?: string;
        stops?: {
          stopId:           string;
          notes?:           string;
          contactPerson?:   string;
          contactPhone?:    string;
          expectedArrival?: string;
        }[];
      };

      if (Object.keys(body).length === 0) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("No update data provided", 400));
      }


      const blocked = [
        "status", "assignedTransporterId", "assignedDelivererId",
        "assignedVehicleId", "distance", "estimatedTime",
        "currentStopIndex", "completedStops", "failedStops",
      ];
      const blockedFound = blocked.filter((f) => f in body);
      if (blockedFound.length) {
        await session.abortTransaction(); session.endSession();
        return next(
          new ErrorHandler(
            `Field(s) cannot be updated here: ${blockedFound.join(", ")}. ` +
            "Use the dedicated endpoint for each.",
            400,
          ),
        );
      }

      if (body.name !== undefined && typeof body.name !== "string") {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("name must be a string", 400));
      }

      let parsedStart: Date | undefined;
      let parsedEnd:   Date | undefined;

      if (body.scheduledStart !== undefined) {
        parsedStart = new Date(body.scheduledStart);
        if (isNaN(parsedStart.getTime())) {
          await session.abortTransaction(); session.endSession();
          return next(new ErrorHandler("scheduledStart is not a valid date", 400));
        }
      }
      if (body.scheduledEnd !== undefined) {
        parsedEnd = new Date(body.scheduledEnd);
        if (isNaN(parsedEnd.getTime())) {
          await session.abortTransaction(); session.endSession();
          return next(new ErrorHandler("scheduledEnd is not a valid date", 400));
        }
      }
      if (parsedStart && parsedEnd && parsedStart >= parsedEnd) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("scheduledStart must be before scheduledEnd", 400));
      }


      const branchOid = new mongoose.Types.ObjectId(branchId.toString());

      const [supervisor, route] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        RouteModel.findOne({
          _id: routeId,
          $or: [{ originBranchId: branchOid }, { destinationBranchId: branchOid }],
        }).session(session),
      ]);

      if (!supervisor || !supervisor.isActive || supervisor.branchId.toString() !== branchOid.toString()) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }
      if (!supervisor.hasPermission("can_manage_schedules")) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("You don't have permission to manage schedules", 403));
      }
      if (!route) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("Route not found in this branch", 404));
      }
      if (LOCKED_STATUSES.includes(route.status)) {
        await session.abortTransaction(); session.endSession();
        return next(
          new ErrorHandler(
            `Cannot edit a route with status '${route.status}'. ` +
            "Only planned and assigned routes can be modified.",
            400,
          ),
        );
      }


      const $set: Record<string, any> = {};

      if (body.name?.trim())        $set.name           = body.name.trim();
      if (parsedStart)              $set.scheduledStart = parsedStart;
      if (parsedEnd)                $set.scheduledEnd   = parsedEnd;
      if (body.completionNotes !== undefined) {
        $set.completionNotes = body.completionNotes?.trim() ?? null;
      }


      const effectiveStart = parsedStart ?? route.scheduledStart;
      const effectiveEnd   = parsedEnd   ?? route.scheduledEnd;
      if (effectiveStart >= effectiveEnd) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("scheduledStart must be before scheduledEnd", 400));
      }

      // ── Per-stop updates (dot-notation positional by _id) 
      if (body.stops && body.stops.length > 0) {
        for (const stopUpdate of body.stops) {
          if (!stopUpdate.stopId || !mongoose.Types.ObjectId.isValid(stopUpdate.stopId)) {
            await session.abortTransaction(); session.endSession();
            return next(new ErrorHandler(`Invalid stopId: ${stopUpdate.stopId}`, 400));
          }

          const stopOid = new mongoose.Types.ObjectId(stopUpdate.stopId);
          const stopIdx = route.stops.findIndex(
            (s) => s._id?.toString() === stopOid.toString(),
          );
          if (stopIdx === -1) {
            await session.abortTransaction(); session.endSession();
            return next(new ErrorHandler(`Stop ${stopUpdate.stopId} not found in this route`, 404));
          }

          if (stopUpdate.notes !== undefined)
            $set[`stops.${stopIdx}.notes`] = stopUpdate.notes?.trim() ?? null;
          if (stopUpdate.contactPerson !== undefined)
            $set[`stops.${stopIdx}.contactPerson`] = stopUpdate.contactPerson?.trim() ?? null;
          if (stopUpdate.contactPhone !== undefined)
            $set[`stops.${stopIdx}.contactPhone`] = stopUpdate.contactPhone?.trim() ?? null;
          if (stopUpdate.expectedArrival !== undefined) {
            const d = new Date(stopUpdate.expectedArrival);
            if (isNaN(d.getTime())) {
              await session.abortTransaction(); session.endSession();
              return next(new ErrorHandler(`Stop ${stopUpdate.stopId}: expectedArrival is not a valid date`, 400));
            }
            $set[`stops.${stopIdx}.expectedArrival`] = d;
          }
        }
      }

      if (Object.keys($set).length === 0) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("No valid fields to update", 400));
      }

      await RouteModel.findByIdAndUpdate(routeId, { $set }, { session });

      await session.commitTransaction();
      session.endSession();

      const updated = await RouteModel.findById(routeId)
        .populate(ROUTE_POPULATE as any)
        .lean();

      return res.status(200).json({
        success: true,
        message: "Route updated successfully",
        data: updated,
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error updating route", 500));
    }
  },
);




//  GET ROUTE BY ID

export const getRoute = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId, routeId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }
    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }
    if (!routeId || !mongoose.Types.ObjectId.isValid(routeId.toString())) {
      return next(new ErrorHandler("Invalid route ID", 400));
    }

    const branchOid = new mongoose.Types.ObjectId(branchId.toString());

    const [supervisor, route] = await Promise.all([
      SupervisorModel.findOne({ userId: supervisorUserId, branchId }).lean(),
      RouteModel.findOne({
        _id: routeId,
        $or: [{ originBranchId: branchOid }, { destinationBranchId: branchOid }],
      }).populate(ROUTE_POPULATE as any).lean(),
    ]);

    if (!supervisor || !supervisor.isActive || supervisor.branchId.toString() !== branchOid.toString()) {
      return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
    }
    if (!route) {
      return next(new ErrorHandler("Route not found in this branch", 404));
    }

    return res.status(200).json({
      success: true,
      data: route,
    });
  },
);


//  GET ROUTES (list for this branch)

export const getRoutes = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId } = req.params;

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }
    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    // Query params validation
    const VALID_STATUSES:  RouteStatus[] = ["planned", "assigned", "active", "paused", "completed", "cancelled"];
    const VALID_TYPES:     RouteType[]   = ["inter_branch", "local_delivery", "pickup_route", "return_route"];
    const VALID_SORT_BY    = ["scheduledStart", "createdAt", "status"];

    const {
      status,
      type,
      workerId,
      fromDate,
      toDate,
      search,
      sortBy    = "scheduledStart",
      sortOrder = "desc",
      page,
      limit,
    } = req.query as Record<string, string | undefined>;


    let statusFilter: RouteStatus[] | undefined;
    if (status) {
      const raw = status.split(",").map((s) => s.trim());
      const invalid = raw.filter((s) => !VALID_STATUSES.includes(s as RouteStatus));
      if (invalid.length) {
        return next(new ErrorHandler(`Invalid status value(s): ${invalid.join(", ")}`, 400));
      }
      statusFilter = raw as RouteStatus[];
    }

    if (type && !VALID_TYPES.includes(type as RouteType)) {
      return next(new ErrorHandler(`type must be one of: ${VALID_TYPES.join(", ")}`, 400));
    }

    if (workerId && !mongoose.Types.ObjectId.isValid(workerId)) {
      return next(new ErrorHandler("Invalid workerId", 400));
    }

    let fromDateParsed: Date | undefined;
    let toDateParsed:   Date | undefined;
    if (fromDate) {
      fromDateParsed = new Date(fromDate);
      if (isNaN(fromDateParsed.getTime()))
        return next(new ErrorHandler("fromDate is not a valid date", 400));
    }
    if (toDate) {
      toDateParsed = new Date(toDate);
      if (isNaN(toDateParsed.getTime()))
        return next(new ErrorHandler("toDate is not a valid date", 400));
    }
    if (fromDateParsed && toDateParsed && fromDateParsed > toDateParsed) {
      return next(new ErrorHandler("fromDate must be before toDate", 400));
    }

    if (!VALID_SORT_BY.includes(sortBy)) {
      return next(new ErrorHandler(`sortBy must be one of: ${VALID_SORT_BY.join(", ")}`, 400));
    }
    if (!["asc", "desc"].includes(sortOrder)) {
      return next(new ErrorHandler("sortOrder must be 'asc' or 'desc'", 400));
    }

    const pageNum  = parseInt(page  ?? "1",  10);
    const limitNum = parseInt(limit ?? "20", 10);
    if (isNaN(pageNum)  || pageNum  < 1)               return next(new ErrorHandler("page must be a positive integer", 400));
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) return next(new ErrorHandler("limit must be between 1 and 100", 400));


    const supervisor = await SupervisorModel.findOne({
      userId: supervisorUserId,
      branchId,
    }).lean();

    if (!supervisor || !supervisor.isActive) {
      return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
    }


    const branchOid = new mongoose.Types.ObjectId(branchId.toString());

    const matchStage: Record<string, any> = {
      $or: [
        { originBranchId:      branchOid },
        { destinationBranchId: branchOid },
      ],
    };

    if (statusFilter) {
      matchStage.status = statusFilter.length === 1
        ? statusFilter[0]
        : { $in: statusFilter };
    }
    if (type) matchStage.type = type;

    if (workerId) {
      const workerOid = new mongoose.Types.ObjectId(workerId);
      matchStage.$and = [
        {
          $or: [
            { assignedTransporterId: workerOid },
            { assignedDelivererId:   workerOid },
          ],
        },
      ];
    }

    if (fromDateParsed || toDateParsed) {
      matchStage.scheduledStart = {
        ...(fromDateParsed && { $gte: fromDateParsed }),
        ...(toDateParsed   && { $lte: toDateParsed   }),
      };
    }

    if (search) {
      const regex = { $regex: search.trim(), $options: "i" };
      const searchOr = [{ routeNumber: regex }, { name: regex }];
      // Merge with any existing $or without clobbering the branch filter
      matchStage.$and = [
        ...(matchStage.$and ?? []),
        { $or: searchOr },
      ];
    }

    const sortStage: Record<string, 1 | -1> = {
      [sortBy]: sortOrder === "asc" ? 1 : -1,
    };

    const skip = (pageNum - 1) * limitNum;


    const [result] = await RouteModel.aggregate([
      { $match: matchStage },
      {
        $facet: {
          data: [
            { $sort: sortStage },
            { $skip: skip },
            { $limit: limitNum },

            {
              $lookup: {
                from:         "branches",
                localField:   "originBranchId",
                foreignField: "_id",
                as:           "originBranch",
                pipeline:     [{ $project: { name: 1, code: 1, wilaya: 1 } }],
              },
            },
            { $unwind: { path: "$originBranch", preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from:         "branches",
                localField:   "destinationBranchId",
                foreignField: "_id",
                as:           "destinationBranch",
                pipeline:     [{ $project: { name: 1, code: 1, wilaya: 1 } }],
              },
            },
            { $unwind: { path: "$destinationBranch", preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from:         "vehicles",
                localField:   "assignedVehicleId",
                foreignField: "_id",
                as:           "assignedVehicle",
                pipeline:     [{ $project: { type: 1, registrationNumber: 1 } }],
              },
            },
            { $unwind: { path: "$assignedVehicle", preserveNullAndEmptyArrays: true } },

            { $project: { "stops.completedPackages": 0, "stops.failedPackages": 0, "stops.skippedPackages": 0, "stops.issues": 0, optimizedPath: 0 } },
          ],
          totalCount: [{ $count: "count" }],

          statusSummary: [
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ],

          typeSummary: [
            { $group: { _id: "$type", count: { $sum: 1 } } },
          ],
        },
      },
    ]);

    const total = result.totalCount[0]?.count ?? 0;
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
        page:        pageNum,
        limit:       limitNum,
        totalPages,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
      summary: {
        byStatus: statusSummary,
        byType:   typeSummary,
      },
    });
  },
);



//  TOGGLE DEACTIVATE ROUTE
//  PATCH /branches/:branchId/routes/:routeId/toggle-cancel
//  Soft-cancel: planned / assigned → cancelled  (and releases worker + vehicle)
//  Re-activate: cancelled          → planned    (worker + vehicle must still exist)
//  Hard delete is intentionally not provided — routes are audit trail.
//  Body: { reason?: string }


export const toggleCancelRoute = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, routeId } = req.params;
      const { reason } = req.body as { reason?: string };

      if (!supervisorUserId) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }
      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("Invalid branch ID", 400));
      }
      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId.toString())) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("Invalid route ID", 400));
      }

      const branchOid = new mongoose.Types.ObjectId(branchId.toString());

      const [supervisor, route] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        RouteModel.findOne({
          _id: routeId,
          $or: [{ originBranchId: branchOid }, { destinationBranchId: branchOid }],
        }).session(session),
      ]);

      if (!supervisor || !supervisor.isActive || supervisor.branchId.toString() !== branchOid.toString()) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }
      if (!supervisor.hasPermission("can_manage_schedules")) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("You don't have permission to manage schedules", 403));
      }
      if (!route) {
        await session.abortTransaction(); session.endSession();
        return next(new ErrorHandler("Route not found in this branch", 404));
      }


      if (["active", "paused", "completed"].includes(route.status)) {
        await session.abortTransaction(); session.endSession();
        return next(
          new ErrorHandler(
            `Cannot toggle a route with status '${route.status}'. ` +
            "Active routes must be managed through the driver's interface.",
            400,
          ),
        );
      }

      const isCancelling = route.status !== "cancelled";
      const newStatus: RouteStatus = isCancelling ? "cancelled" : "planned";


      const sideEffects: Promise<any>[] = [
        RouteModel.findByIdAndUpdate(
          routeId,
          {
            $set: {
              status: newStatus,
              ...(isCancelling && reason?.trim() && {
                cancellationReason: reason.trim(),
              }),

              ...(!isCancelling && { cancellationReason: undefined }),
            },
          },
          { session },
        ),
      ];

      if (isCancelling) {

        sideEffects.push(
          PackageModel.updateMany(
            { currentRouteId: routeId },
            { $set: { currentRouteId: null } },
            { session },
          ),
        );


        if (route.assignedTransporterId) {
          sideEffects.push(
            TransporterModel.findByIdAndUpdate(
              route.assignedTransporterId,
              { $set: { currentRouteId: null, availabilityStatus: "available" } },
              { session },
            ),
          );
        }

        if (route.assignedDelivererId) {
          sideEffects.push(
            DelivererModel.findByIdAndUpdate(
              route.assignedDelivererId,
              { $set: { currentRouteId: null, availabilityStatus: "available" } },
              { session },
            ),
          );
        }


        if (route.assignedVehicleId) {
          sideEffects.push(
            VehicleModel.findByIdAndUpdate(
              route.assignedVehicleId,
              { $set: { status: "available", assignedUserId: null, assignedUserRole: null } },
              { session },
            ),
          );
        }
      } else {
        // Re activating: re stamp packages with this routeId
        // Collect all packageIds from stops
        const allPackageIds = route.stops.flatMap((s) => s.packageIds);
        if (allPackageIds.length > 0) {
          sideEffects.push(
            PackageModel.updateMany(
              { _id: { $in: allPackageIds } },
              { $set: { currentRouteId: route._id } },
              { session },
            ),
          );
        }

        // Re mark transporter/deliverer with the route
        if (route.assignedTransporterId) {
          sideEffects.push(
            TransporterModel.findByIdAndUpdate(
              route.assignedTransporterId,
              { $set: { currentRouteId: route._id } },
              { session },
            ),
          );
        }
        if (route.assignedDelivererId) {
          sideEffects.push(
            DelivererModel.findByIdAndUpdate(
              route.assignedDelivererId,
              { $set: { currentRouteId: route._id } },
              { session },
            ),
          );
        }
        if (route.assignedVehicleId) {
          sideEffects.push(
            VehicleModel.findByIdAndUpdate(
              route.assignedVehicleId,
              { $set: { status: "in_use" } },
              { session },
            ),
          );
        }
      }

      await Promise.all(sideEffects);
      await session.commitTransaction();
      session.endSession();

      return res.status(200).json({
        success: true,
        message: isCancelling
          ? "Route cancelled successfully"
          : "Route reactivated successfully",
        data: {
          routeId,
          previousStatus: route.status,
          newStatus,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error toggling route status", 500));
    }
  },
);




const LIST_LOOKUP_STAGES: (
  | mongoose.PipelineStage.Lookup
  | mongoose.PipelineStage.Unwind
  | mongoose.PipelineStage.Project
)[] = [
  {
    $lookup: {
      from: "branches", localField: "originBranchId", foreignField: "_id",
      as: "originBranch", pipeline: [{ $project: { name: 1, code: 1, wilaya: 1 } }],
    },
  },
  { $unwind: { path: "$originBranch", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "branches", localField: "destinationBranchId", foreignField: "_id",
      as: "destinationBranch", pipeline: [{ $project: { name: 1, code: 1, wilaya: 1 } }],
    },
  },
  { $unwind: { path: "$destinationBranch", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "vehicles", localField: "assignedVehicleId", foreignField: "_id",
      as: "assignedVehicle", pipeline: [{ $project: { type: 1, registrationNumber: 1 } }],
    },
  },
  { $unwind: { path: "$assignedVehicle", preserveNullAndEmptyArrays: true } },
  {
    $project: {
      "stops.completedPackages": 0,
      "stops.failedPackages":    0,
      "stops.skippedPackages":   0,
      "stops.issues":            0,
      optimizedPath:             0,
    },
  },
];





//  GET ACTIVE ROUTES  (for this branch)
//  GET /branches/:branchId/routes/active
//  Returns all routes currently in motion  status: active or paused.
//  Sorted by scheduledStart ascending so the most urgent shows first.
//  Includes real-time progress fields: currentStop, nextStop, delayMinutes,
//  progressPercentage — computed in the aggregation, no extra queries.
//  Query params:
//    type          optional — inter_branch | local_delivery | pickup_route | return_route
//    workerId      optional — filter to one specific driver
//    branchSearch  optional — partial match on origin/destination branch name or code
//                             e.g. "Constantine" shows all active routes going there
 
export const getActiveRoutes = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId } = req.params;
 
    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }
    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }
 
    //query params
    // type to filter by route type
    // workerId  to filter to one specific driver (transporter or deliverer doc _id)
    // branchSearch to filter by origin/destination branch name or code (partial, case-insensitive)
    // and useful when a supervisor wants to see "all active routes going to Constantine"
    const { type, workerId, branchSearch } = req.query as {
      type?:         string;
      workerId?:     string;
      branchSearch?: string;
    };
 
    const VALID_TYPES: RouteType[] = ["inter_branch", "local_delivery", "pickup_route", "return_route"];
 
    if (type && !VALID_TYPES.includes(type as RouteType)) {
      return next(new ErrorHandler(`type must be one of: ${VALID_TYPES.join(", ")}`, 400));
    }
    if (workerId && !mongoose.Types.ObjectId.isValid(workerId)) {
      return next(new ErrorHandler("Invalid workerId", 400));
    }
 

    const supervisor = await SupervisorModel.findOne({
      userId: supervisorUserId,
      branchId,
    }).lean();
 
    if (!supervisor || !supervisor.isActive || supervisor.branchId.toString() !== branchId.toString()) {
      return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
    }
 

    const branchOid = new mongoose.Types.ObjectId(branchId.toString());
 
    const matchStage: Record<string, any> = {
      status: { $in: ["active", "paused"] },
      $or: [
        { originBranchId:      branchOid },
        { destinationBranchId: branchOid },
      ],
    };
 
    if (type) matchStage.type = type;
 
    if (workerId) {
      const workerOid = new mongoose.Types.ObjectId(workerId);
      matchStage.$and = [
        {
          $or: [
            { assignedTransporterId: workerOid },
            { assignedDelivererId:   workerOid },
          ],
        },
      ];
    }

    if (branchSearch?.trim()) {
      const query = mongoose.Types.ObjectId.isValid(branchSearch.trim())
        ? { _id: new mongoose.Types.ObjectId(branchSearch.trim()) }
        : { $or: [
              { name: { $regex: branchSearch.trim(), $options: "i" } },
              { code: { $regex: branchSearch.trim(), $options: "i" } },
          ] };
 
      const matchedBranch = await BranchModel.findOne(query).select("_id").lean();
 
      if (!matchedBranch) {
        return next(new ErrorHandler("No branch found matching the provided branchSearch", 404));
      }
 
      const searchOid = matchedBranch._id as mongoose.Types.ObjectId;
      matchStage.$and = [
        ...(matchStage.$and ?? []),
        {
          $or: [
            { originBranchId:      searchOid },
            { destinationBranchId: searchOid },
          ],
        },
      ];
    }
 

    const routes = await RouteModel.aggregate([
      { $match: matchStage },
      { $sort: { scheduledStart: 1 } },
      ...LIST_LOOKUP_STAGES,
      {
        $addFields: {

          currentStop: {
            $cond: {
              if:   { $lt: ["$currentStopIndex", { $size: "$stops" }] },
              then: { $arrayElemAt: ["$stops", "$currentStopIndex"] },
              else: null,
            },
          },

          nextStop: {
            $cond: {
              if:   { $lt: [{ $add: ["$currentStopIndex", 1] }, { $size: "$stops" }] },
              then: { $arrayElemAt: ["$stops", { $add: ["$currentStopIndex", 1] }] },
              else: null,
            },
          },
          // Minutes behind schedule ( — ) negative means ahead of schedule
          delayMinutes: {
            $cond: {
              if: "$scheduledEnd",
              then: {
                $round: [
                  { $divide: [{ $subtract: [new Date(), "$scheduledEnd"] }, 60000] },
                  0,
                ],
              },
              else: null,
            },
          },
          // 0-100 progress based on stops completed
          progressPercentage: {
            $cond: {
              if:   { $gt: [{ $size: "$stops" }, 0] },
              then: {
                $multiply: [
                  { $divide: ["$currentStopIndex", { $size: "$stops" }] },
                  100,
                ],
              },
              else: 0,
            },
          },
        },
      },
    ]);
 
    return res.status(200).json({
      success: true,
      count: routes.length,
      data:  routes,
    });
  },
);
 





// GET ROUTES BY BRANCH  (manager / admin scope — across all branches)
// GET /routes/by-branch
//  this function lets a supervisor (or admin) query
//  routes for a specific branch they choose 
//  useful when a supervisor manages multiple branches or for a manager-level dashboard.
// query params:
// branchId    required  — ObjectId of the branch to query
// status      optional  — comma-separated RouteStatus values
// type        optional  — inter_branch | local_delivery | pickup_route | return_route
// fromDate    optional  — ISO date string, defaults to 30 days ago
// toDate      optional  — ISO date string, defaults to end of tomorrow
// capped at end of tomorrow (no routes exist beyond that bcz they are generated at midnight by a cron job)
// page, limit optional  — default 1 / 20, max 100

 
export const getRoutesByBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
 
    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }
 
    const {
      branchId,
      status,
      type,
      fromDate,
      toDate,
      page,
      limit,
    } = req.query as Record<string, string | undefined>;
 

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("branchId query param is required and must be a valid ID", 400));
    }
 
    const VALID_STATUSES: RouteStatus[] = ["planned", "assigned", "active", "paused", "completed", "cancelled"];
    const VALID_TYPES:    RouteType[]   = ["inter_branch", "local_delivery", "pickup_route", "return_route"];
 
    let statusFilter: RouteStatus[] | undefined;
    if (status) {
      const raw = status.split(",").map((s) => s.trim());
      const invalid = raw.filter((s) => !VALID_STATUSES.includes(s as RouteStatus));
      if (invalid.length) {
        return next(new ErrorHandler(`Invalid status value(s): ${invalid.join(", ")}`, 400));
      }
      statusFilter = raw as RouteStatus[];
    }
 
    if (type && !VALID_TYPES.includes(type as RouteType)) {
      return next(new ErrorHandler(`type must be one of: ${VALID_TYPES.join(", ")}`, 400));
    }
 

    // Routes only exist up to tomorrow (scheduler generates one day ahead).
    // Cap toDate at end-of-tomorrow so querying future dates never returns
    // a confusing empty result when the user forgets this constraint.
    const now = new Date();
 
    const endOfTomorrow = new Date(now);
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
    endOfTomorrow.setUTCHours(23, 59, 59, 999);
 
    const defaultFromDate = new Date(now);
    defaultFromDate.setDate(defaultFromDate.getDate() - 30);
    defaultFromDate.setUTCHours(0, 0, 0, 0);
 
    let fromDateParsed: Date;
    let toDateParsed:   Date;
 
    if (fromDate) {
      fromDateParsed = new Date(fromDate);
      if (isNaN(fromDateParsed.getTime())) {
        return next(new ErrorHandler("fromDate is not a valid date", 400));
      }
      fromDateParsed.setUTCHours(0, 0, 0, 0);
    } else {
      fromDateParsed = defaultFromDate;
    }
 
    if (toDate) {
      toDateParsed = new Date(toDate);
      if (isNaN(toDateParsed.getTime())) {
        return next(new ErrorHandler("toDate is not a valid date", 400));
      }
      toDateParsed.setUTCHours(23, 59, 59, 999);
 
      // rmake it to end-of-tomorrow if the user enters the toDate in the far future
      // no error printing (not needed)
      
      if (toDateParsed > endOfTomorrow) {
        toDateParsed = endOfTomorrow;
      }
    } else {
      toDateParsed = endOfTomorrow;
    }
 
    if (fromDateParsed > toDateParsed) {
      return next(new ErrorHandler("fromDate must be before toDate", 400));
    }
 
    const pageNum  = parseInt(page  ?? "1",  10);
    const limitNum = parseInt(limit ?? "20", 10);
    if (isNaN(pageNum)  || pageNum  < 1)                   return next(new ErrorHandler("page must be a positive integer", 400));
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) return next(new ErrorHandler("limit must be between 1 and 100", 400));
 

    const supervisor = await SupervisorModel.findOne({
      userId:   supervisorUserId,
      isActive: true,
    }).lean();
 
    if (!supervisor) {
      return next(new ErrorHandler("You are not an active supervisor", 403));
    }

    const branchOid = new mongoose.Types.ObjectId(branchId.toString());
 
    const matchStage: Record<string, any> = {
      $or: [
        { originBranchId:      branchOid },
        { destinationBranchId: branchOid },
      ],
      companyId:      supervisor.companyId,
      scheduledStart: { $gte: fromDateParsed, $lte: toDateParsed },
    };
 
    if (statusFilter) {
      matchStage.status = statusFilter.length === 1
        ? statusFilter[0]
        : { $in: statusFilter };
    }
    if (type) matchStage.type = type;
 
    const skip = (pageNum - 1) * limitNum;
 

    const [result] = await RouteModel.aggregate([
      { $match: matchStage },
      {
        $facet: {
          data: [
            { $sort: { scheduledStart: -1 } },
            { $skip: skip },
            { $limit: limitNum },
            ...LIST_LOOKUP_STAGES,
          ],
          totalCount:    [{ $count: "count" }],
          statusSummary: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          typeSummary:   [{ $group: { _id: "$type",   count: { $sum: 1 } } }],
        },
      },
    ]);
 
    const total      = result.totalCount[0]?.count ?? 0;
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
      data:    result.data,
      pagination: {
        total,
        page:        pageNum,
        limit:       limitNum,
        totalPages,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
      summary: {
        byStatus: statusSummary,
        byType:   typeSummary,
      },
    });
  },
);




export const getMeSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
 
    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }
 
    const [user, supervisor] = await Promise.all([
      userModel.findById(userId)
        .select("firstName lastName email phone imageUrl role status createdAt")
        .lean(),
      SupervisorModel.findOne({ userId })
        .populate("branchId",  "name code address wilaya")
        .populate("companyId", "name logo status")
        .lean(),
    ]);
 
    if (!user) {
      return next(new ErrorHandler("User not found.", 404));
    }
    if (!supervisor || !supervisor.isActive) {
      return next(new ErrorHandler("Supervisor profile not found or inactive.", 404));
    }
 
    return res.status(200).json({
      success: true,
      data: {

        firstName:   user.firstName,
        lastName:    user.lastName,
        email:       user.email,
        phone:       user.phone,
        imageUrl:    user.imageUrl,
        role:        user.role,
        status:      user.status,


        permissions:  supervisor.permissions,
        workSchedule: supervisor.workSchedule,
        performance:  supervisor.performance,
        branch:       supervisor.branchId,  
        company:      supervisor.companyId,  
      },
    });
  },
);



//  UPDATE ME — SUPERVISOR
//  PATCH /supervisor/me

//  Updatable on User:           firstName, lastName, imageUrl
//  Updatable on SupervisorModel: workSchedule (one day at a time or full object)

//  workSchedule body format:
//    { workSchedule: { monday: { start: "09:00", end: "18:00", dayOff: false } } }
//  Any subset of days can be passed — unmentioned days stay unchanged.

//  Blocked: permissions, branchId, companyId, isActive, performance

 
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
type WeekDay   = typeof WEEKDAYS[number];
 
export const updateMeSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
 
    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }
 
    const blocked = ["permissions", "branchId", "companyId", "isActive", "performance"];
    const blockedFound = blocked.filter((f) => f in req.body);
    if (blockedFound.length) {
      return next(
        new ErrorHandler(
          `Field(s) cannot be self-updated: ${blockedFound.join(", ")}`,
          400,
        ),
      );
    }
 
    const [user, supervisor] = await Promise.all([
      userModel.findById(userId).lean(),
      SupervisorModel.findOne({ userId }).lean(),
    ]);
 
    if (!user)       return next(new ErrorHandler("User not found.", 404));
    if (!supervisor || !supervisor.isActive) {
      return next(new ErrorHandler("Supervisor profile not found or inactive.", 404));
    }
 

    const userUpdates = buildUserFieldUpdates(req.body, next);

    if (!userUpdates) return;
 

    const scheduleUpdates: Record<string, any> = {};
    const scheduleInput = req.body.workSchedule as Record<string, any> | undefined;
 
    if (scheduleInput !== undefined) {
      if (typeof scheduleInput !== "object" || Array.isArray(scheduleInput)) {
        return next(new ErrorHandler("workSchedule must be an object", 400));
      }
 
      const TIME_REGEX = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
 
      for (const day of Object.keys(scheduleInput)) {
        if (!WEEKDAYS.includes(day as WeekDay)) {
          return next(new ErrorHandler(`Invalid day: ${day}`, 400));
        }
 
        const dayData = scheduleInput[day];
 
        if (typeof dayData !== "object" || dayData === null) {
          return next(new ErrorHandler(`workSchedule.${day} must be an object`, 400));
        }
 
        // dayOff = true → zero out times, no further validation needed
        if (dayData.dayOff === true) {
          scheduleUpdates[`workSchedule.${day}.dayOff`]  = true;
          scheduleUpdates[`workSchedule.${day}.start`]   = "00:00";
          scheduleUpdates[`workSchedule.${day}.end`]     = "00:00";
          continue;
        }
 
        if (dayData.dayOff === false || dayData.dayOff === undefined) {
          // Validate start / end if provided
          const current = (supervisor.workSchedule as any)[day] ?? {};
          const start   = dayData.start ?? current.start;
          const end     = dayData.end   ?? current.end;
 
          if (dayData.start !== undefined && !TIME_REGEX.test(dayData.start)) {
            return next(new ErrorHandler(`workSchedule.${day}.start must be HH:MM`, 400));
          }
          if (dayData.end !== undefined && !TIME_REGEX.test(dayData.end)) {
            return next(new ErrorHandler(`workSchedule.${day}.end must be HH:MM`, 400));
          }
          if (start >= end) {
            return next(new ErrorHandler(`${day}: start time must be before end time`, 400));
          }
 
          if (dayData.start !== undefined) scheduleUpdates[`workSchedule.${day}.start`] = dayData.start;
          if (dayData.end   !== undefined) scheduleUpdates[`workSchedule.${day}.end`]   = dayData.end;
          if (dayData.dayOff === false)    scheduleUpdates[`workSchedule.${day}.dayOff`] = false;
        }
      }
    }
 
    const allUpdates = { ...userUpdates, ...scheduleUpdates };
 
    if (Object.keys(allUpdates).length === 0) {
      return next(new ErrorHandler("No valid fields to update.", 400));
    }
 

    await Promise.all([
      Object.keys(userUpdates).length > 0 &&
        userModel.findByIdAndUpdate(userId, { $set: userUpdates }, { runValidators: true }),
      Object.keys(scheduleUpdates).length > 0 &&
        SupervisorModel.findByIdAndUpdate(supervisor._id, { $set: scheduleUpdates }, { runValidators: true }),
    ]);
 
    // Fetch the refreshed profile to return
    const [updatedUser, updatedSupervisor] = await Promise.all([
      userModel.findById(userId)
        .select("firstName lastName email phone imageUrl role status")
        .lean(),
      SupervisorModel.findById(supervisor._id)
        .select("workSchedule permissions performance")
        .lean(),
    ]);
 
    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: {
        ...updatedUser,
        workSchedule: updatedSupervisor?.workSchedule,
        permissions:  updatedSupervisor?.permissions,
        performance:  updatedSupervisor?.performance,
      },
    });
  },
);

