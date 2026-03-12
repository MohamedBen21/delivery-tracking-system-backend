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
  imageUrl?: string;

  currentLocation?: ILocationBody;
  documents?: IDelivererDocumentsBody;
}

interface IUpdateDeliverer {
  email?: string;
  phone?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;

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
        imageUrl,
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
            imageUrl,
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
      if (body.imageUrl !== undefined) userUpdates.imageUrl = body.imageUrl;

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
  imageUrl?: string;

  documents?: ITransporterDocumentsBody;
}

interface IUpdateTransporter {

  email?: string;
  phone?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;

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
        imageUrl,
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
            imageUrl,
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
      if (body.imageUrl !== undefined) userUpdates.imageUrl = body.imageUrl;

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
  imageUrl?: string;

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
  imageUrl?: string;

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
        imageUrl,
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
            imageUrl,
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
      if (body.imageUrl !== undefined) userUpdates.imageUrl = body.imageUrl;

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