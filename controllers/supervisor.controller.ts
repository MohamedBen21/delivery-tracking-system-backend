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
import PackageModel, { PackageStatus } from "../models/package.model";


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
  clientId: string;
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

//  UPDATE PACKAGE
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
        clientId,
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

      if (!clientId || !weight || !type || !destination || !deliveryType || !totalPrice) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("clientId, weight, type, destination, deliveryType, and totalPrice are required", 400)
        );
      }

      const [supervisor, branch, client] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        BranchModel.findById(branchId).session(session),
        userModel.findOne({ _id: clientId, role: "client" }).session(session),
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

      if (!client) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Client not found", 404));
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

      const trackingPrefix = "PKG";
      const timestamp = Date.now().toString().slice(-6);
      const random = Math.floor(1000 + Math.random() * 9000);
      const trackingNumber = `${trackingPrefix}${timestamp}${random}`;

      const packageData = await PackageModel.create(
        [
          {
            trackingNumber,
            companyId: branch.companyId,
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
                notes: "Package created",
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

      await session.commitTransaction();
      session.endSession();

      const populatedPackage = await PackageModel.findById(packageData[0]._id)
        .populate("clientId", "firstName lastName email phone username")
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
        .populate("clientId", "firstName lastName email phone username")
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



