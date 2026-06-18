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
import PackageModel, { DeliveryType, IIssue, PackageStatus, PackageType, PaymentStatus } from "../models/package.model";
import FreelancerModel from "../models/freelancer.model";
import clientModel from "../models/client.model";
import PackageHistoryModel from "../models/package-history.model";
import RouteModel, { IRouteStop, RouteStatus, RouteType } from "../models/route.model";
import VehicleModel from "../models/vehicle.model";
import { deleteImage } from "../utils/Multer.util";
import { buildUserFieldUpdates } from "./manager.controller";
import PaymentModel from "../models/payment.model";
import { notifyAdminsNewEntityPending, sendDelivererAccountCreatedNotification, sendDelivererBlockStatusNotification, sendDeliveryFailedNotification, sendFreelancerAccountCreatedNotification, sendFreelancerBlockStatusNotification, sendPackageCancelledNotification, sendPackageCreatedNotification, sendPackageIssueReportedNotification, sendPackageIssueResolvedNotification, sendPackageReturnedToBranchNotification, sendPackageStatusUpdatedNotification, sendTransporterAccountCreatedNotification, sendTransporterBlockStatusNotification } from "../services/notification.service";
import ManifestModel, { ManifestPriority, ManifestStatus } from "../models/manifest.model";
import crypto from "crypto";
import QRCode from "qrcode";
import { generateCashReturnQr, getCashReturnInfo, verifyAndProcessCashReturn } from "../services/cashReturn.service";
import StopQrSessionModel from "../models/stopQrSession.model";
import CashierModel, { ICashier } from "../models/cashier.model";
import LoaderModel, { ILoader } from "../models/loader.model";
import { SocketService } from "../services/socket.service";
import DeliveryQrSession from "../models/deliveryQrSession.model";
import TransportationModel, { ITransportation, TransportationStatus } from "../models/transportation.model";


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
  // username: string;
  password: string;
  firstName: string;
  lastName: string;
  // imageUrl?: string;

  currentLocation?: ILocationBody;
  documents?: IDelivererDocumentsBody;
  currentVehicleId?: string;
}

interface IUpdateDeliverer {
  email?: string;
  phone?: string;
  // username?: string;
  firstName?: string;
  lastName?: string;
  // imageUrl?: string;

  currentLocation?: ILocationBody;
  documents?: IDelivererDocumentsBody;
  availabilityStatus?: "available" | "on_route" | "off_duty" | "on_break" | "maintenance";
  currentVehicleId?: string;
}




export const createDeliverer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    // const session = await mongoose.startSession();
    // session.startTransaction();

    // let transactionCommitted = false;

    try {
      const supervisorUserId = req.user?._id;
      const { branchId } = req.params;

      if (!supervisorUserId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const {
        email,
        phone,
        // username,
        password,
        firstName,
        lastName,
        // imageUrl,
        currentLocation,
        documents,
        currentVehicleId,
      } = req.body as ICreateDeliverer;

      if (!email || !phone || !password || !firstName || !lastName) {

        return next(
          new ErrorHandler("email, phone, password, firstName, and lastName are required", 400)
        );
      }

      if (
        typeof email !== "string" ||
        typeof phone !== "string" ||
        // typeof username !== "string" ||
        typeof password !== "string" ||
        typeof firstName !== "string" ||
        typeof lastName !== "string"
      ) {

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

          return next(new ErrorHandler("Invalid location format. Expected GeoJSON Point", 400));
        }
      }

      const [supervisor, branch] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId })
        // .session(session),
        ,
        BranchModel.findById(branchId)
        // .session(session),
      ]);

      console.log("Supervisor:", supervisor);

      if (!supervisor || !supervisor.isActive) {


        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {
        return next(new ErrorHandler("You don't have permission to manage deliverers", 403));
      }

      if (!branch) {

        return next(new ErrorHandler("Branch not found", 404));
      }

      if (branch.status !== "active") {

        return next(new ErrorHandler("Cannot create deliverer for an inactive branch", 400));
      }

      const normalizedPhone = userModel.normalizePhone(phone);

      const [existingEmail, existingPhone] = await Promise.all([
        userModel.findOne({ email }),
        // .session(session),
        userModel.findOne({ phone: normalizedPhone }),
        // .session(session),
        // userModel.findOne({ username }).session(session),
      ]);

      if (existingEmail) {

        return next(new ErrorHandler("Email already exists", 400));
      }

      if (existingPhone) {
        return next(new ErrorHandler("Phone number already exists", 400));
      }

      // if (existingUsername) {
      //   await session.abortTransaction();
      //   await session.endSession();
      //   return next(new ErrorHandler("Username already exists", 400));
      // }

      const user = await userModel.create(
        [
          {
            email,
            phone,
            // username,
            passwordHash: password,
            firstName,
            lastName,
            // imageUrl,
            role: "deliverer",
            // status: "pending",
            status: "active",
          },
        ],
        // { session }
      );

      const deliverer = await DelivererModel.create(
        [
          {
            userId: user[0]._id,
            companyId: branch.companyId,
            branchId,
            ...(currentLocation && { currentLocation }),
            ...(documents && { documents }),
            ...(currentVehicleId && { currentVehicleId }),
            availabilityStatus: "off_duty",
            verificationStatus: "verified",
            isActive: true,
          },
        ],
        // { session }
      );

      // await session.commitTransaction();
      // transactionCommitted = true;


      const branchName = branch?.name || "Branch";


      Promise.allSettled([

        sendDelivererAccountCreatedNotification(
          user[0]._id.toString(),
          firstName,
          lastName,
          deliverer[0]._id.toString(),
          branchName
        ),

        notifyAdminsNewEntityPending(
          deliverer[0]._id.toString(),
          "Deliverer",
          `${firstName} ${lastName}`
        )
      ]).catch(error => {

        console.error('Deliverer creation notifications failed:', error);

      });

      const populatedDeliverer = await DelivererModel.findById(deliverer[0]._id)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("branchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Deliverer created successfully",
        data: populatedDeliverer,
      });
    } catch (error: any) {

      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }

      return next(error);

    }
    // finally {

    //   if (!transactionCommitted) {
    //     await session.abortTransaction().catch(() => {});
    //   }
    //   await session.endSession();

    // }
  }
);




export const updateDeliverer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
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

      const body = req.body as IUpdateDeliverer;

      if (Object.keys(body).length === 0) {

        return next(new ErrorHandler("No update data provided", 400));
      }

      if (body.email !== undefined && typeof body.email !== "string") {
        return next(new ErrorHandler("email must be a string", 400));
      }

      if (body.phone !== undefined && typeof body.phone !== "string") {

        return next(new ErrorHandler("phone must be a string", 400));
      }

      // if (body.username !== undefined && typeof body.username !== "string") {

      //   return next(new ErrorHandler("username must be a string", 400));
      // }

      if (body.currentLocation) {
        if (
          body.currentLocation.type !== "Point" ||
          !Array.isArray(body.currentLocation.coordinates) ||
          body.currentLocation.coordinates.length !== 2 ||
          typeof body.currentLocation.coordinates[0] !== "number" ||
          typeof body.currentLocation.coordinates[1] !== "number"
        ) {

          return next(new ErrorHandler("Invalid location format. Expected GeoJSON Point", 400));
        }
      }

      const [deliverer, supervisor] = await Promise.all([
        DelivererModel.findOne({ _id: delivererId, branchId }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
      ]);

      if (!deliverer) {

        throw new ErrorHandler("Deliverer not found", 404);
      }

      if (!supervisor || !supervisor.isActive) {

        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {

        throw new ErrorHandler("You don't have permission to manage deliverers", 403);
      }


      const duplicateChecks: Promise<any>[] = [];

      if (body.email) {
        duplicateChecks.push(
          userModel.findOne({ email: body.email, _id: { $ne: deliverer.userId } }).session(session)
        );
      }

      if (body.phone) {

        const normalizedPhone = userModel.normalizePhone(body.phone);

        duplicateChecks.push(
          userModel.findOne({ phone: normalizedPhone, _id: { $ne: deliverer.userId } }).session(session)
        );
      }

      // if (body.username) {
      //   duplicateChecks.push(
      //     userModel.findOne({ username: body.username, _id: { $ne: deliverer.userId } }).session(session)
      //   );
      // }

      const duplicateResults = await Promise.all(duplicateChecks);

      if (duplicateResults.some((result) => result !== null)) {

        throw new ErrorHandler("Email or phone already exists", 400);
      }


      const userUpdates: any = {};
      const delivererUpdates: any = {};

      if (body.email) userUpdates.email = body.email;
      if (body.phone) userUpdates.phone = userModel.normalizePhone(body.phone);
      // if (body.username) userUpdates.username = body.username;
      if (body.firstName) userUpdates.firstName = body.firstName;
      if (body.lastName) userUpdates.lastName = body.lastName;
      // if (body.imageUrl !== undefined) userUpdates.imageUrl = body.imageUrl;

      if (body.currentLocation) delivererUpdates.currentLocation = body.currentLocation;
      if (body.currentVehicleId !== undefined) delivererUpdates.currentVehicleId = body.currentVehicleId;

      if (body.documents) {
        deliverer.documents = {
          ...deliverer.documents,
          ...body.documents,
        } as any;
      }

      if (body.availabilityStatus) delivererUpdates.availabilityStatus = body.availabilityStatus;


      if (Object.keys(userUpdates).length > 0) {
        await userModel.findByIdAndUpdate(deliverer.userId, { $set: userUpdates }, { session });
      }


      Object.assign(deliverer, delivererUpdates);
      await deliverer.save({ session });

      await session.commitTransaction();
      transactionCommitted = true;

      const populatedDeliverer = await DelivererModel.findById(delivererId)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("branchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Deliverer updated successfully",
        data: populatedDeliverer,
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




export const toggleBlockDeliverer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, delivererId } = req.params;
      const { suspensionReason } = req.body as { suspensionReason?: string };

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
        DelivererModel.findOne({ _id: delivererId, branchId }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        userModel.findById(supervisorUserId).select("role").session(session),
      ]);

      if (!deliverer) {

        throw new ErrorHandler("Deliverer not found", 404);
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedSupervisor =
        supervisor && supervisor.isActive && supervisor.hasPermission("can_manage_deliverers");

      if (!isAdmin && !isAuthorizedSupervisor) {

        throw new ErrorHandler("Not authorized to change this deliverer's status", 403);
      }


      const newIsActive = !deliverer.isActive;

      if (newIsActive) {

        deliverer.isActive = true;
        deliverer.isSuspended = false;
        deliverer.suspensionReason = "";
      } else {

        deliverer.isActive = false;
        deliverer.isSuspended = true;
        deliverer.suspensionReason = suspensionReason || "Suspended by supervisor";
      }

      await deliverer.save({ session });

      await userModel.findByIdAndUpdate(
        deliverer.userId,
        { status: newIsActive ? "active" : "suspended" },
        { session }
      );

      await session.commitTransaction();
      transactionCommitted = true;

      sendDelivererBlockStatusNotification(

        deliverer.userId.toString(),
        delivererId.toString(),
        !newIsActive
      ).catch(error => {

        console.error('Deliverer block status notification failed:', error);

      });

      const updatedDeliverer = await DelivererModel.findById(delivererId)
        .populate("userId", "firstName lastName email phone imageUrl role status")
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
        .populate("userId", "firstName lastName email phone imageUrl role status")
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




export const getMyDeliverers = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const supervisorUserId = req.user?._id;
    const { branchId } = req.params;

    const { pageSize = 10, pageNumber = 1 } = req.query

    if (!supervisorUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const branch = await BranchModel.findById(branchId).lean();

    if (!branch) {
      return next(new ErrorHandler("Branch not found", 404));
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
      .skip((Number(pageNumber) - 1) * Number(pageSize))
      .limit(Number(pageSize))
      .populate("userId", "firstName lastName email phone imageUrl role status")
      .populate("branchId", "name code address status")
      .sort({ createdAt: -1 })
      .lean();

    const count = await DelivererModel.countDocuments(delivererQuery);


    return res.status(200).json({
      success: true,
      count,
      data: deliverers,
      pagination: {
        pageSize: Number(pageSize),
        pageNumber: Number(pageNumber),
        totalPages: Math.ceil(count / Number(pageSize)),
      }
    });
  }
);






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
  // username: string;
  password: string;
  firstName: string;
  lastName: string;
  // imageUrl?: string;

  documents?: ITransporterDocumentsBody;
  currentVehicleId?: string;
}

interface IUpdateTransporter {

  email?: string;
  phone?: string;
  // username?: string;
  firstName?: string;
  lastName?: string;
  // imageUrl?: string;

  documents?: ITransporterDocumentsBody;
  availabilityStatus?: "available" | "on_route" | "off_duty" | "on_break" | "maintenance";
  currentBranchId?: string;
  currentVehicleId?: string;
}




export const createTransporter = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const userRole = req.user?.role;
      const { companyId } = req.params;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const {
        email,
        phone,
        // username,
        password,
        firstName,
        lastName,
        // imageUrl,
        documents,
        currentVehicleId,
      } = req.body as ICreateTransporter;

      if (!email || !phone || !password || !firstName || !lastName) {
        return next(
          new ErrorHandler("email, phone, password, firstName, and lastName are required", 400)
        );
      }

      if (
        typeof email !== "string" ||
        typeof phone !== "string" ||
        // typeof username !== "string" ||
        typeof password !== "string" ||
        typeof firstName !== "string" ||
        typeof lastName !== "string"
      ) {
        return next(new ErrorHandler("All required fields must be strings", 400));
      }


      let isAuthorized = false;
      let supervisor = null;
      let manager = null;

      if (userRole === "admin") {
        isAuthorized = true;
      } else if (userRole === "manager") {
        manager = await ManagerModel.findOne({ userId, companyId }).session(session);
        if (!manager || !manager.isActive) {
          throw new ErrorHandler("You are not an active manager of this company", 403);
        }
        if (!manager.hasPermission("can_manage_users")) {
          throw new ErrorHandler("You don't have permission to manage transporters", 403);
        }
        isAuthorized = true;
      } else if (userRole === "supervisor") {
        supervisor = await SupervisorModel.findOne({ userId, companyId }).session(session);
        if (!supervisor || !supervisor.isActive) {
          throw new ErrorHandler("You are not an active supervisor of this company", 403);
        }
        if (!supervisor.hasPermission("can_manage_deliverers")) {
          throw new ErrorHandler("You don't have permission to manage transporters", 403);
        }
        isAuthorized = true;
      }

      if (!isAuthorized) {
        throw new ErrorHandler("Not authorized to create transporters", 403);
      }

      const company = await CompanyModel.findById(companyId).session(session);

      if (!company) {
        throw new ErrorHandler("Company not found", 404);
      }

      if (company.status !== "active") {
        throw new ErrorHandler("Cannot create transporter for an inactive company", 400);
      }

      const normalizedPhone = userModel.normalizePhone(phone);

      const [existingEmail, existingPhone] = await Promise.all([
        userModel.findOne({ email }).session(session),
        userModel.findOne({ phone: normalizedPhone }).session(session),
        // userModel.findOne({ username }).session(session),
      ]);

      if (existingEmail) {
        throw new ErrorHandler("Email already exists", 400);
      }

      if (existingPhone) {
        throw new ErrorHandler("Phone number already exists", 400);
      }

      // if (existingUsername) {
      //   throw new ErrorHandler("Username already exists", 400);
      // }

      const user = await userModel.create(
        [
          {
            email,
            phone,
            // username,
            passwordHash: password,
            firstName,
            lastName,
            // imageUrl,
            role: "transporter",
            status: "active",
          },
        ],
        { session }
      );

      const transporter = await TransporterModel.create(
        [
          {
            userId: user[0]._id,
            companyId,
            currentBranchId: userRole === "supervisor" ? supervisor?.branchId : undefined,
            ...(documents && { documents }),
            ...(currentVehicleId && { currentVehicleId }),
            availabilityStatus: "off_duty",
            verificationStatus: "verified",
            isActive: true,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      transactionCommitted = true;

      Promise.allSettled([
        sendTransporterAccountCreatedNotification(
          user[0]._id.toString(),
          firstName,
          lastName,
          transporter[0]._id.toString(),
          company?.name || "Company"
        ),
        notifyAdminsNewEntityPending(
          transporter[0]._id.toString(),
          "Transporter",
          `${firstName} ${lastName}`
        )
      ]).catch(error => {
        console.error('Transporter creation notifications failed:', error);
      });

      const populatedTransporter = await TransporterModel.findById(transporter[0]._id)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Transporter created successfully",
        data: populatedTransporter,
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



export const updateTransporter = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const userRole = req.user?.role;
      const { companyId, transporterId } = req.params;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!transporterId || !mongoose.Types.ObjectId.isValid(transporterId.toString())) {
        return next(new ErrorHandler("Invalid transporter ID", 400));
      }

      const body = req.body as IUpdateTransporter;

      if (Object.keys(body).length === 0) {
        return next(new ErrorHandler("No update data provided", 400));
      }

      if (body.email !== undefined && typeof body.email !== "string") {
        return next(new ErrorHandler("email must be a string", 400));
      }

      if (body.phone !== undefined && typeof body.phone !== "string") {
        return next(new ErrorHandler("phone must be a string", 400));
      }

      // if (body.username !== undefined && typeof body.username !== "string") {
      //   return next(new ErrorHandler("username must be a string", 400));
      // }

      if (body.currentBranchId !== undefined && !mongoose.Types.ObjectId.isValid(body.currentBranchId)) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const transporter = await TransporterModel.findOne({ _id: transporterId, companyId }).session(session);

      if (!transporter) {
        throw new ErrorHandler("Transporter not found", 404);
      }


      let isAuthorized = false;
      let supervisor = null;

      if (userRole === "admin") {
        isAuthorized = true;
      } else if (userRole === "manager") {
        const manager = await ManagerModel.findOne({ userId, companyId }).session(session);
        if (!manager || !manager.isActive) {
          throw new ErrorHandler("You are not an active manager of this company", 403);
        }
        if (!manager.hasPermission("can_manage_users")) {
          throw new ErrorHandler("You don't have permission to manage transporters", 403);
        }
        isAuthorized = true;
      } else if (userRole === "supervisor") {
        supervisor = await SupervisorModel.findOne({ userId, companyId }).session(session);
        if (!supervisor || !supervisor.isActive) {
          throw new ErrorHandler("You are not an active supervisor of this company", 403);
        }
        if (!supervisor.hasPermission("can_manage_deliverers")) {
          throw new ErrorHandler("You don't have permission to manage transporters", 403);
        }

        if (transporter.currentBranchId?.toString() !== supervisor.branchId.toString()) {
          throw new ErrorHandler("You can only update transporters in your branch", 403);
        }

        if (body.currentBranchId) {
          throw new ErrorHandler("Supervisors cannot change transporter branch assignment", 403);
        }
        isAuthorized = true;
      }

      if (!isAuthorized) {
        throw new ErrorHandler("Not authorized to update this transporter", 403);
      }

      const duplicateChecks: Promise<any>[] = [];

      if (body.email) {
        duplicateChecks.push(
          userModel.findOne({ email: body.email, _id: { $ne: transporter.userId } }).session(session)
        );
      }

      if (body.phone) {
        const normalizedPhone = userModel.normalizePhone(body.phone);
        duplicateChecks.push(
          userModel.findOne({ phone: normalizedPhone, _id: { $ne: transporter.userId } }).session(session)
        );
      }

      // if (body.username) {
      //   duplicateChecks.push(
      //     userModel.findOne({ username: body.username, _id: { $ne: transporter.userId } }).session(session)
      //   );
      // }

      const duplicateResults = await Promise.all(duplicateChecks);

      if (duplicateResults.some((result) => result !== null)) {
        throw new ErrorHandler("Email or phone already exists", 400);
      }

      const userUpdates: any = {};
      const transporterUpdates: any = {};

      if (body.email) userUpdates.email = body.email;
      if (body.phone) userUpdates.phone = userModel.normalizePhone(body.phone);
      // if (body.username) userUpdates.username = body.username;
      if (body.firstName) userUpdates.firstName = body.firstName;
      if (body.lastName) userUpdates.lastName = body.lastName;
      // if (body.imageUrl !== undefined) userUpdates.imageUrl = body.imageUrl;

      if (body.documents) {
        transporter.documents = {
          ...transporter.documents,
          ...body.documents,
        } as any;
      }

      if (body.availabilityStatus) transporterUpdates.availabilityStatus = body.availabilityStatus;
      if (body.currentVehicleId !== undefined) transporterUpdates.currentVehicleId = body.currentVehicleId;
      if (body.currentBranchId !== undefined) transporterUpdates.currentBranchId = body.currentBranchId;


      if (body.currentBranchId !== undefined && (userRole === "admin" || userRole === "manager")) {
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
      transactionCommitted = true;

      const populatedTransporter = await TransporterModel.findById(transporterId)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Transporter updated successfully",
        data: populatedTransporter,
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


export const toggleBlockTransporter = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const userRole = req.user?.role;
      const { companyId, transporterId } = req.params;
      const { suspensionReason, suspensionEndDate } = req.body as {
        suspensionReason?: string;
        suspensionEndDate?: string;
      };

      if (!userId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!transporterId || !mongoose.Types.ObjectId.isValid(transporterId.toString())) {
        return next(new ErrorHandler("Invalid transporter ID", 400));
      }

      const transporter = await TransporterModel.findOne({ _id: transporterId, companyId }).session(session);

      if (!transporter) {
        throw new ErrorHandler("Transporter not found", 404);
      }


      let isAuthorized = false;

      if (userRole === "admin") {
        isAuthorized = true;
      } else if (userRole === "manager") {
        const manager = await ManagerModel.findOne({ userId, companyId }).session(session);
        if (!manager || !manager.isActive) {
          throw new ErrorHandler("You are not an active manager of this company", 403);
        }
        if (!manager.hasPermission("can_manage_users")) {
          throw new ErrorHandler("You don't have permission to manage transporters", 403);
        }
        isAuthorized = true;
      } else if (userRole === "supervisor") {
        const supervisor = await SupervisorModel.findOne({ userId, companyId }).session(session);
        if (!supervisor || !supervisor.isActive) {
          throw new ErrorHandler("You are not an active supervisor of this company", 403);
        }
        if (!supervisor.hasPermission("can_manage_deliverers")) {
          throw new ErrorHandler("You don't have permission to manage transporters", 403);
        }

        if (transporter.currentBranchId?.toString() !== supervisor.branchId.toString()) {
          throw new ErrorHandler("You can only manage transporters in your branch", 403);
        }
        isAuthorized = true;
      }

      if (!isAuthorized) {
        throw new ErrorHandler("Not authorized to change this transporter's status", 403);
      }

      const newIsActive = !transporter.isActive;

      if (newIsActive) {
        // Activating
        transporter.isActive = true;
        transporter.isSuspended = false;
        transporter.suspensionReason = "";
        transporter.suspensionEndDate = undefined;
      } else {
        // Suspending
        transporter.isActive = false;
        transporter.isOnline = false;
        transporter.isSuspended = true;
        transporter.suspensionReason = suspensionReason || "Suspended by " + userRole;
        transporter.suspensionEndDate = suspensionEndDate
          ? new Date(suspensionEndDate)
          : undefined;
      }

      await transporter.save({ session });

      await userModel.findByIdAndUpdate(
        transporter.userId,
        { status: newIsActive ? "active" : "suspended" },
        { session }
      );

      await session.commitTransaction();
      transactionCommitted = true;

      sendTransporterBlockStatusNotification(
        transporter.userId.toString(),
        transporterId.toString(),
        !newIsActive
      ).catch(error => {
        console.error('Transporter block status notification failed:', error);
      });

      const updatedTransporter = await TransporterModel.findById(transporterId)
        .populate("userId", "firstName lastName email phone imageUrl role status")
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



export const getTransporter = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const userRole = req.user?.role;
    const { companyId, transporterId } = req.params;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      return next(new ErrorHandler("Invalid company ID", 400));
    }

    if (!transporterId || !mongoose.Types.ObjectId.isValid(transporterId.toString())) {
      return next(new ErrorHandler("Invalid transporter ID", 400));
    }

    const transporter = await TransporterModel.findOne({ _id: transporterId, companyId })
      .populate("userId", "firstName lastName email phone imageUrl role status")
      .populate("companyId", "name businessType status")
      .populate("currentBranchId", "name code address status")
      .populate("currentVehicleId", "type brand model registrationNumber")
      .lean();

    if (!transporter) {
      return next(new ErrorHandler("Transporter not found", 404));
    }


    let isAuthorized = false;

    if (userRole === "admin") {
      isAuthorized = true;
    } else if (userRole === "manager") {
      const manager = await ManagerModel.findOne({ userId, companyId });
      isAuthorized = !!(manager && manager.isActive);
    } else if (userRole === "supervisor") {
      const supervisor = await SupervisorModel.findOne({ userId, companyId });
      if (supervisor && supervisor.isActive) {

        isAuthorized = transporter.currentBranchId?.toString() === supervisor.branchId.toString();
      }
    }

    if (!isAuthorized) {
      return next(new ErrorHandler("Not authorized to view this transporter", 403));
    }

    return res.status(200).json({
      success: true,
      data: transporter,
    });
  }
);



export const getMyTransporters = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    console.log("Fetching transporters for user:", req.user);
    const userId = req.user?._id;
    const userRole = req.user?.role;
    const { companyId } = req.params;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      return next(new ErrorHandler("Invalid company ID", 400));
    }

    const company = await CompanyModel.findById(companyId).lean();

    if (!company) {
      return next(new ErrorHandler("Company not found", 404));
    }

    let isAuthorized = false;
    let supervisor = null;

    if (userRole === "admin") {
      isAuthorized = true;
    } else if (userRole === "manager") {
      const manager = await ManagerModel.findOne({ userId, companyId });
      if (!manager || !manager.isActive) {
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }
      isAuthorized = true;
    } else if (userRole === "supervisor") {
      supervisor = await SupervisorModel.findOne({ userId, companyId });
      if (!supervisor || !supervisor.isActive) {
        return next(new ErrorHandler("You are not an active supervisor of this company", 403));
      }
      isAuthorized = true;
    }
    else if (userRole === "loader") {
      isAuthorized = true;
    }

    if (!isAuthorized) {
      return next(new ErrorHandler("Not authorized to view transporters", 403));
    }

    const transporterQuery: mongoose.FilterQuery<typeof TransporterModel> = {
      companyId,
    };


    if (supervisor) {
      transporterQuery.currentBranchId = supervisor.branchId;
    }

    const { pageNumber = 1, pageSize = 10, verificationStatus, availabilityStatus, isActive, currentBranchId, search } = req.query;

    if (verificationStatus && typeof verificationStatus === "string") {
      transporterQuery.verificationStatus = verificationStatus;
    }

    if (availabilityStatus && typeof availabilityStatus === "string") {
      transporterQuery.availabilityStatus = availabilityStatus;
    }

    if (isActive !== undefined) {
      transporterQuery.isActive = isActive === "true";
    }


    if (!supervisor && currentBranchId && typeof currentBranchId === "string") {
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
      .populate("userId", "firstName lastName email phone imageUrl role status")
      .populate("currentBranchId", "name code address status")
      .populate("currentVehicleId", "type brand model registrationNumber")
      .sort({ createdAt: -1 })
      .skip((Number(pageNumber) - 1) * Number(pageSize))
      .limit(Number(pageSize))
      .lean();

    const count = await TransporterModel.countDocuments(transporterQuery);

    return res.status(200).json({
      success: true,
      count,
      data: transporters,
      pagination: {
        pageSize: Number(pageSize),
        pageNumber: Number(pageNumber),
        totalPages: Math.ceil(count / Number(pageSize)),
      }
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


  const normalizedPhone = userModel.normalizePhone(recipientInfo.phone);

  let client = await userModel.findOne({

    phone: normalizedPhone,
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
    phone: normalizedPhone,
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

    let transactionCommitted = false;

    try {

      const supervisorUserId = req.user?._id;
      const { branchId } = req.params;

      if (!supervisorUserId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {

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
        return next(
          new ErrorHandler(
            "senderId, senderType, weight, type, destination, deliveryType, and totalPrice are required",
            400
          )
        );
      }

      if (!recipient || (!recipient.clientId && !recipient.phone)) {
        return next(
          new ErrorHandler("Recipient info is required (either clientId or phone)", 400)
        );
      }


      if (!mongoose.Types.ObjectId.isValid(senderId.toString())) {

        return next(new ErrorHandler("Invalid sender ID", 400));
      }


      const [supervisor, branch, sender, freelancer] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        BranchModel.findById(branchId).session(session),
        userModel.findById(senderId).session(session),
        FreelancerModel.findOne({ userId: senderId }).session(session)
      ]);


      if (!supervisor || !supervisor.isActive) {

        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }

      if (!supervisor.hasPermission("can_manage_packages")) {

        throw new ErrorHandler("You don't have permission to manage packages", 403);
      }


      if (!branch) {

        throw new ErrorHandler("Branch not found", 404);
      }

      if (branch.status !== "active") {
        throw new ErrorHandler("Cannot create package for an inactive branch", 400);
      }


      if (!sender) {

        throw new ErrorHandler("Sender not found", 404);
      }


      if (sender.role !== "freelancer") {
        throw new ErrorHandler("Freelancer not found", 404);
      }

      if (!freelancer) {

        throw new ErrorHandler("Freelancer not found", 404);
      }

      if (freelancer.status !== 'active') {
        throw new ErrorHandler("Freelancer account is not active", 403);
      }

      if (freelancer.defaultOriginBranchId.toString() !== branchId) {

        throw new ErrorHandler("Package origin must be freelancer's default branch", 400);
      }


      if (deliveryType === "branch_pickup" && !destinationBranchId) {

        throw new ErrorHandler("Destination branch is required for branch pickup", 400);
      }

      if (destinationBranchId) {
        const destinationBranch = await BranchModel.findById(destinationBranchId).session(session);
        if (!destinationBranch) {
          throw new ErrorHandler("Destination branch not found", 404);
        }
      }

      let clientId: mongoose.Types.ObjectId;

      try {
        clientId = await getOrCreateClient(recipient, destination, session);
      } catch (error: any) {
        throw new ErrorHandler(error.message || "Error processing recipient info", 400);
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



      if (deliveryType === 'home') {
        await PaymentModel.create(
          [{

            companyId: branch.companyId,
            packageId: packageData[0]._id,
            trackingNumber: trackingNumber,
            delivererId: undefined,
            branchId: branchId,
            clientId: clientId,
            collectionMethod: 'home_delivery',
            amount: totalPrice,
            paymentMethod: (paymentMethod as any) || 'cod',
            status: 'pending',
          }],

          { session }
        );
      } else if (deliveryType === 'branch_pickup') {
        await PaymentModel.create(

          [{
            companyId: branch.companyId,
            packageId: packageData[0]._id,
            trackingNumber: trackingNumber,
            branchId: branchId,
            processedById: supervisorUserId,
            clientId: clientId,
            collectionMethod: 'branch_pickup',
            amount: totalPrice,
            paymentMethod: (paymentMethod as any) || 'branch_payment',
            status: 'pending',
          }],

          { session }
        );
      }

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
      transactionCommitted = true;


      sendPackageCreatedNotification(

        senderId.toString(),
        senderType,
        packageData[0]._id.toString(),
        trackingNumber

      ).catch(error => {

        console.error('Package created notification failed:', error);

      });

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




export const updatePackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
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

      const body = req.body as IUpdatePackage;

      if (Object.keys(body).length === 0) {

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

        throw new ErrorHandler("Package not found in this branch", 404);
      }

      if (!supervisor || !supervisor.isActive) {

        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }

      if (!supervisor.hasPermission("can_manage_packages")) {

        throw new ErrorHandler("You don't have permission to manage packages", 403);
      }

      if (["delivered", "cancelled", "returned", "lost", "damaged"].includes(packageDoc.status)) {

        throw new ErrorHandler(`Cannot update package in ${packageDoc.status} status`, 400);
      }

      if (body.destinationBranchId) {
        const destinationBranch = await BranchModel.findById(body.destinationBranchId).session(session);
        if (!destinationBranch) {
          throw new ErrorHandler("Destination branch not found", 404);
        }
      }

      if (body.assignedDelivererId) {
        const deliverer = await DelivererModel.findOne({
          _id: body.assignedDelivererId,
          branchId,
          isActive: true,
        }).session(session);

        if (!deliverer) {

          throw new ErrorHandler("Deliverer not found or not active in this branch", 404);
        }

        if (deliverer.availabilityStatus !== "available") {

          throw new ErrorHandler("Deliverer is not available", 400);
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


      if (body.paymentStatus && body.paymentStatus !== packageDoc.paymentStatus) {
        const payment = await PaymentModel.findOne({ packageId: packageDoc._id }).session(session);

        if (payment) {
          switch (body.paymentStatus) {
            case 'paid':
              payment.status = 'collected';

              if (payment.collectionMethod === 'home_delivery' && body.assignedDelivererId) {
                payment.delivererId = new mongoose.Types.ObjectId(body.assignedDelivererId);
              }
              break;
            case 'pending':
              payment.status = 'pending';
              break;
            case 'refunded':
              payment.status = 'refunded';
              break;
            case 'failed':
              payment.status = 'disputed';
              break;
          }
          await payment.save({ session });
        }
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
      transactionCommitted = true;


      if (body.status && body.status !== packageDoc.status) {
        sendPackageStatusUpdatedNotification(

          packageDoc.senderId.toString(),
          packageDoc.senderType,
          packageId.toString(),
          packageDoc.trackingNumber,
          body.status,
          body.assignedDelivererId

        ).catch(error => {

          console.error('Package status update notification failed:', error);


        });
      }

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




export const toggleCancelPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
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
        }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        userModel.findById(supervisorUserId).select("role").session(session),
      ]);

      if (!packageDoc) {

        throw new ErrorHandler("Package not found", 404);
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedSupervisor =
        supervisor && supervisor.isActive && supervisor.hasPermission("can_manage_packages");

      if (!isAdmin && !isAuthorizedSupervisor) {

        throw new ErrorHandler("Not authorized to change this package's status", 403);
      }

      if (packageDoc.status === "delivered") {

        throw new ErrorHandler("Cannot cancel a delivered package", 400);
      }

      if (packageDoc.status === "returned") {

        throw new ErrorHandler("Cannot cancel a returned package", 400);
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


      const payment = await PaymentModel.findOne({ packageId: packageDoc._id }).session(session);

      if (payment) {
        if (newStatus === "cancelled") {
          payment.status = 'cancelled';
          await payment.save({ session });
        } else {

          payment.status = packageDoc.paymentStatus === 'paid' ? 'collected' : 'pending';
          await payment.save({ session });
        }
      }

      if (newStatus === "cancelled") {
        await BranchModel.findByIdAndUpdate(
          branchId,
          { $inc: { currentLoad: -1 } },
          { session }
        );
      } else {
        await BranchModel.findByIdAndUpdate(
          branchId,
          { $inc: { currentLoad: 1 } },
          { session }
        );
      }

      await session.commitTransaction();
      transactionCommitted = true;

      if (newStatus === "cancelled") {

        sendPackageCancelledNotification(

          packageDoc.senderId.toString(),
          packageDoc.senderType,
          packageId.toString(),
          packageDoc.trackingNumber

        ).catch(error => {

          console.error('Package cancelled notification failed:', error);

        });
      }

      const updatedPackage = await PackageModel.findById(packageId)
        .populate("clientId", "firstName lastName email phone")
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
        .populate("clientId", "firstName lastName email phone imageUrl")
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
      pageSize = 10,
      pageNumber = 1,
    } = req.query;

    if (status && typeof status === "string") {
      const raw = status.split(",").map((s) => s.trim());
      const invalid = raw.filter((s) => !PACKAGE_STATUSES.includes(s as PackageStatus));
      if (invalid.length) {
        return next(
          new ErrorHandler(`Invalid status value(s): ${invalid.join(", ")}`, 400),
        );
      }
      packageQuery.status = raw.length === 1 ? raw[0] : { $in: raw };
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



    const [packages, count] = await Promise.all([
      PackageModel.find(packageQuery)
        .populate("clientId", "firstName lastName email phone")
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
        .skip((Number(pageNumber) - 1) * (Number(pageSize) || 10))
        .limit(Number(pageSize))
        .lean(),
      PackageModel.countDocuments(packageQuery),
    ]);

    return res.status(200).json({
      success: true,
      count,
      pagination: {
        pageSize: Number(pageSize),
        pageNumber: Number(pageNumber),
        totalPages: Math.ceil(count / (Number(pageSize) || 10)),
      },
      data: packages,
    });
  }
);





export const addPackageIssue = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, packageId } = req.params;
      const { type, description, priority } = req.body as IAddIssue;

      if (!supervisorUserId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {

        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {

        return next(new ErrorHandler("Invalid package ID", 400));
      }

      if (!type || !description) {

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
        throw new ErrorHandler("Package not found", 404);
      }

      if (!supervisor || !supervisor.isActive) {

        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }

      if (!supervisor.hasPermission("can_handle_complaints")) {

        throw new ErrorHandler("You don't have permission to handle complaints", 403);
      }

      if (packageDoc.status === "delivered" || packageDoc.status === "cancelled") {

        throw new ErrorHandler(`Cannot add issue to ${packageDoc.status} package`, 400);
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
      transactionCommitted = true;


      sendPackageIssueReportedNotification(
        packageDoc.senderId.toString(),
        packageDoc.senderType,
        packageId.toString(),
        packageDoc.trackingNumber,
        type
      ).catch(error => {

        console.error('Package issue notification failed:', error);

      });

      const updatedPackage = await PackageModel.findById(packageId)
        .populate("clientId", "firstName lastName email phone")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Issue reported successfully",
        data: updatedPackage,
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





export const resolvePackageIssue = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, packageId, issueIndex } = req.params;
      const { resolution } = req.body;

      if (!supervisorUserId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {

        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {

        return next(new ErrorHandler("Invalid package ID", 400));
      }

      if (!issueIndex || isNaN(parseInt(issueIndex as string))) {

        return next(new ErrorHandler("Invalid issue index", 400));
      }

      if (!resolution) {

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

        throw new ErrorHandler("Package not found", 404);
      }

      if (!supervisor || !supervisor.isActive) {

        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }

      if (!supervisor.hasPermission("can_handle_complaints")) {

        throw new ErrorHandler("You don't have permission to handle complaints", 403);
      }


      const index = parseInt(issueIndex as string, 10);

      if (!packageDoc.issues || index >= packageDoc.issues.length) {

        throw new ErrorHandler("Issue not found", 404);
      }

      const issue = packageDoc.issues[index];
      if (issue.resolved) {

        throw new ErrorHandler("Issue is already resolved", 400);
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
      transactionCommitted = true;


      sendPackageIssueResolvedNotification(

        packageDoc.senderId.toString(),
        packageDoc.senderType,
        packageId.toString(),
        packageDoc.trackingNumber

      ).catch(error => {

        console.error('Package issue resolved notification failed:', error);

      });

      const updatedPackage = await PackageModel.findById(packageId)
        .populate("clientId", "firstName lastName email phone")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Issue resolved successfully",
        data: updatedPackage,
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




interface ICreateFreelancer {
  email: string;
  phone: string;
  // username: string;
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
  // username?: string;
  firstName?: string;
  lastName?: string;
  // imageUrl?: string;

  businessName?: string;
  businessType?: 'individual' | 'small_business' | 'ecommerce' | 'other';
  preferredDeliveryType?: 'home' | 'branch_pickup';
}





export const createFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const supervisorUserId = req.user?._id;
      const { branchId } = req.params;

      if (!supervisorUserId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {

        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const {
        email,
        phone,
        // username,
        password,
        firstName,
        lastName,
        // imageUrl,
        businessName,
        businessType,
        preferredDeliveryType,
      } = req.body as ICreateFreelancer;

      if (!email || !phone || !password || !firstName || !lastName) {

        return next(
          new ErrorHandler("email, phone, password, firstName, and lastName are required", 400)
        );
      }


      if (
        typeof email !== "string" ||
        typeof phone !== "string" ||
        // typeof username !== "string" ||
        typeof password !== "string" ||
        typeof firstName !== "string" ||
        typeof lastName !== "string"
      ) {

        return next(new ErrorHandler("All required fields must be strings", 400));
      }


      const [supervisor, branch] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        BranchModel.findById(branchId).session(session),
      ]);

      if (!supervisor || !supervisor.isActive) {

        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {

        throw new ErrorHandler("You don't have permission to manage freelancers", 403);
      }

      if (!branch) {

        throw new ErrorHandler("Branch not found", 404);
      }

      if (branch.status !== "active") {

        throw new ErrorHandler("Cannot create freelancer for an inactive branch", 400);
      }


      const normalizedPhone = userModel.normalizePhone(phone);

      const [existingEmail, existingPhone] = await Promise.all([
        userModel.findOne({ email }).session(session),

        userModel.findOne({ phone: normalizedPhone }).session(session),
        // userModel.findOne({ username }).session(session),
      ]);

      if (existingEmail) {
        throw new ErrorHandler("Email already exists", 400);
      }

      if (existingPhone) {
        throw new ErrorHandler("Phone number already exists", 400);
      }

      // if (existingUsername) {

      //   throw new ErrorHandler("Username already exists", 400);
      // }


      const user = await userModel.create(
        [
          {
            email,
            phone,
            // username,
            passwordHash: password,
            firstName,
            lastName,
            // imageUrl,
            role: "freelancer",
            // status: "pending",
            status: "active",
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
            // status: "pending_verification",
            status: "active",
          },
        ],
        { session }
      );

      await session.commitTransaction();
      transactionCommitted = true;


      Promise.allSettled([

        sendFreelancerAccountCreatedNotification(
          user[0]._id.toString(),
          firstName,
          lastName,
          freelancer[0]._id.toString()
        ),
        notifyAdminsNewEntityPending(
          freelancer[0]._id.toString(),
          "Freelancer",
          `${firstName} ${lastName}`
        )
      ]).catch(error => {

        console.error('Freelancer creation notifications failed:', error);

      });

      const populatedFreelancer = await FreelancerModel.findById(freelancer[0]._id)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("defaultOriginBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Freelancer created successfully",
        data: populatedFreelancer,
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



export const updateFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
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

      const body = req.body as IUpdateFreelancer;

      if (Object.keys(body).length === 0) {

        return next(new ErrorHandler("No update data provided", 400));
      }


      if (body.email !== undefined && typeof body.email !== "string") {

        return next(new ErrorHandler("email must be a string", 400));
      }

      if (body.phone !== undefined && typeof body.phone !== "string") {
        return next(new ErrorHandler("phone must be a string", 400));
      }

      // if (body.username !== undefined && typeof body.username !== "string") {

      //   return next(new ErrorHandler("username must be a string", 400));
      // }


      const [freelancer, supervisor] = await Promise.all([
        FreelancerModel.findOne({ _id: freelancerId, defaultOriginBranchId: branchId }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
      ]);

      if (!freelancer) {
        throw new ErrorHandler("Freelancer not found in this branch", 404);
      }

      if (!supervisor || !supervisor.isActive) {
        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {
        throw new ErrorHandler("You don't have permission to manage freelancers", 403);
      }


      const duplicateChecks: Promise<any>[] = [];

      if (body.email) {
        duplicateChecks.push(
          userModel.findOne({ email: body.email, _id: { $ne: freelancer.userId } }).session(session)
        );
      }

      if (body.phone) {

        const normalizedPhone = userModel.normalizePhone(body.phone);

        duplicateChecks.push(
          userModel.findOne({ phone: normalizedPhone, _id: { $ne: freelancer.userId } }).session(session)
        );
      }

      // if (body.username) {
      //   duplicateChecks.push(
      //     userModel.findOne({ username: body.username, _id: { $ne: freelancer.userId } }).session(session)
      //   );
      // }

      const duplicateResults = await Promise.all(duplicateChecks);

      if (duplicateResults.some((result) => result !== null)) {
        throw new ErrorHandler("Email or  phone already exists", 400);
      }


      const userUpdates: any = {};
      const freelancerUpdates: any = {};

      if (body.email) userUpdates.email = body.email;
      if (body.phone) userUpdates.phone = userModel.normalizePhone(body.phone);
      // if (body.username) userUpdates.username = body.username;
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
      transactionCommitted = true;

      const populatedFreelancer = await FreelancerModel.findById(freelancerId)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("defaultOriginBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Freelancer updated successfully",
        data: populatedFreelancer,
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



export const toggleBlockFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
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
        FreelancerModel.findOne({ _id: freelancerId, defaultOriginBranchId: branchId }).session(session),
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        userModel.findById(supervisorUserId).select("role").session(session),
      ]);

      if (!freelancer) {

        throw new ErrorHandler("Freelancer not found in this branch", 404);
      }

      const isAdmin = requestingUser?.role === "admin";
      const isAuthorizedSupervisor =
        supervisor && supervisor.isActive && supervisor.hasPermission("can_manage_deliverers");

      if (!isAdmin && !isAuthorizedSupervisor) {

        throw new ErrorHandler("Not authorized to change this freelancer's status", 403);
      }


      let newStatus: 'active' | 'suspended';

      if (freelancer.status === 'active') {
        newStatus = 'suspended';
      } else if (freelancer.status === 'suspended' || freelancer.status === 'pending_verification') {
        newStatus = 'active';
      } else {

        throw new ErrorHandler("Cannot toggle freelancer with current status", 400);
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
      transactionCommitted = true;


      sendFreelancerBlockStatusNotification(

        freelancer.userId.toString(),
        freelancerId.toString(),
        newStatus === 'suspended'
      ).catch(error => {

        console.error('Freelancer block status notification failed:', error);

      });

      const updatedFreelancer = await FreelancerModel.findById(freelancerId)
        .populate("userId", "firstName lastName email phone imageUrl role status")
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
        .populate("userId", "firstName lastName email phone imageUrl role status")
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



export const getMyFreelancers = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const { pageNumber = "1", pageSize = "10" } = req.query;
    const userId = req.user?._id;
    const { branchId } = req.params;

    if (!userId) {
      return next(
        new ErrorHandler(
          "Unauthorized, you are not authenticated.",
          401
        )
      );
    }

    if (
      !branchId ||
      !mongoose.Types.ObjectId.isValid(branchId.toString())
    ) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const [branch, supervisor, cashier, manager] =
      await Promise.all([
        BranchModel.findById(branchId).lean(),

        SupervisorModel.findOne({
          userId,
          branchId,
        }).lean(),

        CashierModel.findOne({
          userId,
          assignedBranchId: branchId,
        }).lean(),

        ManagerModel.findOne({
          userId,
        }).lean(),
      ]);

    if (!branch) {
      return next(new ErrorHandler("Branch not found", 404));
    }

    const hasAccess =
      !!manager ||
      (!!supervisor && supervisor.isActive) ||
      (!!cashier);

    if (!hasAccess) {
      return next(
        new ErrorHandler(
          "You are not authorized to access freelancers for this branch",
          403
        )
      );
    }

    const freelancerQuery: mongoose.FilterQuery<any> = {
      defaultOriginBranchId: branchId,
    };

    const { status, businessType, search } = req.query;

    if (status && typeof status === "string") {
      freelancerQuery.status = status;
    }

    console.log("Status filter:", freelancerQuery.status);

    if (businessType && typeof businessType === "string") {
      freelancerQuery.businessType = businessType;
    }

    const count = await FreelancerModel.countDocuments(freelancerQuery);

    const freelancers = await FreelancerModel.find(
      freelancerQuery
    )
      .skip((Number(pageNumber) - 1) * Number(pageSize))
      .limit(Number(pageSize))
      .populate({
        path: "userId",
        select:
          "firstName lastName email phone imageUrl role status",
        ...(search && typeof search === "string"
          ? {
            match: {
              $or: [
                {
                  firstName: {
                    $regex: search,
                    $options: "i",
                  },
                },
                {
                  lastName: {
                    $regex: search,
                    $options: "i",
                  },
                },
                {
                  email: {
                    $regex: search,
                    $options: "i",
                  },
                },
                {
                  phone: {
                    $regex: search,
                    $options: "i",
                  },
                },
              ],
            },
          }
          : {}),
      })
      .populate(
        "defaultOriginBranchId",
        "name code address status"
      )
      .sort({ createdAt: -1 })
      .lean();

    const filtered = search
      ? freelancers.filter(
        (freelancer) => freelancer.userId !== null
      )
      : freelancers;

    return res.status(200).json({
      success: true,
      count: filtered.length,
      data: filtered,
      pagination: {
        pageSize: Number(pageSize),
        pageNumber: Number(pageNumber),
        totalPages: Math.ceil(count / Number(pageSize))
      }
    });
  }
);



export const getAllFreelancersAdmin = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      pageNumber = "1",
      pageSize = "10",
      companyId,
      status,
      businessType,
      search,
    } = req.query;

    const skip = (Number(pageNumber) - 1) * Number(pageSize);

    // -------------------------
    // BASE QUERY
    // -------------------------
    const freelancerQuery: mongoose.FilterQuery<any> = {};

    // 🔥 MAIN FILTER: companyId
    if (companyId && mongoose.Types.ObjectId.isValid(companyId as string)) {
      freelancerQuery.companyId = companyId;
    }

    if (status && typeof status === "string") {
      freelancerQuery.status = status;
    }
    console.log("Status filter:", freelancerQuery.status);

    if (businessType && typeof businessType === "string") {
      freelancerQuery.businessType = businessType;
    }

    // -------------------------
    // USER SEARCH FILTER
    // -------------------------
    const userMatch =
      search && typeof search === "string"
        ? {
          $or: [
            { firstName: { $regex: search, $options: "i" } },
            { lastName: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { phone: { $regex: search, $options: "i" } },
          ],
        }
        : undefined;

    // -------------------------
    // QUERY
    // -------------------------
    const [freelancers, total] = await Promise.all([
      FreelancerModel.find(freelancerQuery)
        .populate({
          path: "userId",
          select:
            "firstName lastName email phone imageUrl role status",
          ...(userMatch ? { match: userMatch } : {}),
        })
        .populate({
          path: "companyId",
          select: "name email phone status businessType logoUrl",
        })
        .populate({
          path: "defaultOriginBranchId",
          select: "name code address status",
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(pageSize))
        .lean(),

      FreelancerModel.countDocuments(freelancerQuery),
    ]);

    // remove null users when search is used
    const filtered = search
      ? freelancers.filter((f) => f.userId !== null)
      : freelancers;

    return res.status(200).json({
      success: true,
      data: filtered,
      pagination: {
        pageSize: Number(pageSize),
        pageNumber: Number(pageNumber),
        totalPages: Math.ceil(total / Number(pageSize)),
      },
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

    let transactionCommitted = false;

    try {
      const supervisorUserId = req.user?._id;

      if (!supervisorUserId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const { branchId } = req.params;

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {

        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const { userId, currentLocation, documents } = req.body as IAssignDeliverer;

      if (!userId || !branchId) {

        return next(new ErrorHandler("userId and branchId are required", 400));
      }

      if (typeof userId !== "string" || typeof branchId !== "string") {

        return next(new ErrorHandler("userId and branchId must be strings", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(branchId)) {

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

        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {

        throw new ErrorHandler("You don't have permission to manage deliverers", 403);
      }

      if (!branch) {

        throw new ErrorHandler("Branch not found", 404);
      }

      if (branch.status !== "active") {

        throw new ErrorHandler("Cannot assign deliverer to an inactive branch", 400);
      }

      if (!userToAssign) {

        throw new ErrorHandler("User not found", 404);
      }

      if (["admin", "manager", "supervisor", "transporter", "freelancer"].includes(userToAssign.role) === true) {
        return next(new ErrorHandler(`User cannot be assigned because he is already a ${userToAssign.role}`, 400));
      }

      if (existingDeliverer) {
        throw new ErrorHandler("User is already a deliverer", 400);
      }

      const existingFreelancer = await FreelancerModel.findOne({ userId }).session(session);

      if (existingFreelancer) {
        throw new ErrorHandler("User is already a freelancer, cannot assign as deliverer", 400);
      }

      const existingTransporter = await TransporterModel.findOne({ userId }).session(session);

      if (existingTransporter) {
        throw new ErrorHandler("User is already a transporter, cannot assign as deliverer", 400);
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
      transactionCommitted = true;

      const populatedDeliverer = await DelivererModel.findById(deliverer[0]._id)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("branchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Deliverer assigned successfully",
        data: populatedDeliverer,
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






interface IAssignTransporter {
  userId: string;
  currentBranchId?: string;
  documents?: ITransporterDocumentsBody;
}

export const assignTransporter = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const managerId = req.user?._id;
      const { companyId } = req.params;

      if (!managerId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const { userId, currentBranchId, documents } = req.body as IAssignTransporter;

      if (!userId) {
        return next(new ErrorHandler("userId is required", 400));
      }

      if (typeof userId !== "string") {
        return next(new ErrorHandler("userId must be a string", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return next(new ErrorHandler("Invalid userId format", 400));
      }

      if (currentBranchId && !mongoose.Types.ObjectId.isValid(currentBranchId)) {
        return next(new ErrorHandler("Invalid branch ID format", 400));
      }

      const [manager, company, userToAssign, existingTransporter] = await Promise.all([
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
        CompanyModel.findById(companyId).session(session),
        userModel.findById(userId).session(session),
        TransporterModel.findOne({ userId }).session(session),
      ]);

      if (!manager || !manager.isActive) {
        throw new ErrorHandler("You are not an active manager of this company", 403);
      }

      if (!manager.hasPermission("can_manage_users")) {
        throw new ErrorHandler("You don't have permission to manage transporters", 403);
      }

      if (!company) {
        throw new ErrorHandler("Company not found", 404);
      }

      if (company.status !== "active") {
        throw new ErrorHandler("Cannot assign transporter to an inactive company", 400);
      }

      if (!userToAssign) {
        throw new ErrorHandler("User not found", 404);
      }

      if (existingTransporter) {
        throw new ErrorHandler("User is already a transporter", 400);
      }

      const existingDeliverer = await DelivererModel.findOne({ userId }).session(session);
      if (existingDeliverer) {
        throw new ErrorHandler("User is already a deliverer, cannot assign as transporter", 400);
      }

      const existingFreelancer = await FreelancerModel.findOne({ userId }).session(session);
      if (existingFreelancer) {
        throw new ErrorHandler("User is already a freelancer, cannot assign as transporter", 400);
      }

      if (currentBranchId) {
        const branch = await BranchModel.findOne({ _id: currentBranchId, companyId }).session(session);
        if (!branch) {
          throw new ErrorHandler("Branch not found in this company", 404);
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
      transactionCommitted = true;
      const populatedTransporter = await TransporterModel.findById(transporter[0]._id)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("companyId", "name businessType status")
        .populate("currentBranchId", "name code address status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Transporter assigned successfully",
        data: populatedTransporter,
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
    let transactionCommitted = false;

    try {
      const supervisorUserId = req.user?._id;
      const { branchId } = req.params;

      if (!supervisorUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const { userId, businessName, businessType, preferredDeliveryType } = req.body as IAssignFreelancer;

      if (!userId) {
        return next(new ErrorHandler("userId is required", 400));
      }

      if (typeof userId !== "string") {
        return next(new ErrorHandler("userId must be a string", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return next(new ErrorHandler("Invalid userId format", 400));
      }

      const [supervisor, branch, userToAssign, existingFreelancer] = await Promise.all([
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        BranchModel.findById(branchId).session(session),
        userModel.findById(userId).session(session),
        FreelancerModel.findOne({ userId }).session(session),
      ]);

      if (!supervisor || !supervisor.isActive) {
        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }

      if (!supervisor.hasPermission("can_manage_deliverers")) {
        throw new ErrorHandler("You don't have permission to manage freelancers", 403);
      }

      if (!branch) {
        throw new ErrorHandler("Branch not found", 404);
      }

      if (branch.status !== "active") {
        throw new ErrorHandler("Cannot assign freelancer to an inactive branch", 400);
      }

      if (!userToAssign) {
        throw new ErrorHandler("User not found", 404);
      }

      if (existingFreelancer) {
        throw new ErrorHandler("User is already a freelancer", 400);
      }

      const existingDeliverer = await DelivererModel.findOne({ userId }).session(session);
      if (existingDeliverer) {
        throw new ErrorHandler("User is already a deliverer, cannot assign as freelancer", 400);
      }

      const existingTransporter = await TransporterModel.findOne({ userId }).session(session);
      if (existingTransporter) {
        throw new ErrorHandler("User is already a transporter, cannot assign as freelancer", 400);
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
      transactionCommitted = true;
      const populatedFreelancer = await FreelancerModel.findById(freelancer[0]._id)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("defaultOriginBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Freelancer assigned successfully",
        data: populatedFreelancer,
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
  "failed_delivery_attempt",
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
  pageNumber?: string;
  pageSize?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}





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
          { case: { $eq: ["$status", "pending"] }, then: 0 },
          { case: { $eq: ["$status", "accepted"] }, then: 10 },
          { case: { $eq: ["$status", "at_origin_branch"] }, then: 20 },
          { case: { $eq: ["$status", "in_transit_to_branch"] }, then: 40 },
          { case: { $eq: ["$status", "at_destination_branch"] }, then: 60 },
          { case: { $eq: ["$status", "out_for_delivery"] }, then: 80 },
          { case: { $eq: ["$status", "delivered"] }, then: 100 },
          { case: { $eq: ["$status", "failed_delivery"] }, then: 80 },
          { case: { $eq: ["$status", "rescheduled"] }, then: 70 },
          { case: { $eq: ["$status", "returned"] }, then: 100 },
          { case: { $eq: ["$status", "on_hold"] }, then: 50 },
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





export const getBranchPackages = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      console.log("getBranchPackages called with query:", req.query);

      const { branchId } = req.params;




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
        pageNumber = "1",
        pageSize = "10",
        sortBy = "createdAt",
        sortOrder = "desc",
      } = req.query as IBranchPackagesQuery;


      const pageNum = parseInt(pageNumber, 10);
      const limitNum = parseInt(pageSize, 10);

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


      const branch = await BranchModel.findById(branchId).lean();

      if (!branch) {
        return next(new ErrorHandler("Branch not found", 404));
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


      if (needsAttention === "true") {
        baseMatch.status = {
          $in: ["failed_delivery", "failed_delivery_attempt", "damaged", "lost", "on_hold"],
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

      const pipeline: mongoose.PipelineStage[] = [
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
            totalCount: [
              { $count: "count" },
            ],
            statusBreakdown: [
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ],
            actionableCounters: [
              {
                $group: {
                  _id: null,
                  readyForDispatch: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            "$isReadyForDispatch",
                            "$isReadyForPickup",
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  needsAttention: {
                    $sum: {
                      $cond: ["$needsAttentionFlag", 1, 0],
                    },
                  },
                  overdue: {
                    $sum: {
                      $cond: ["$isOverdueFlag", 1, 0],
                    },
                  },
                },
              },
            ],
          },
        },
      ];

      const [result] = await PackageModel.aggregate(pipeline);

      const totalCount = result.totalCount[0]?.count ?? 0;
      const totalPages = Math.ceil(totalCount / limitNum);

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
        data: result.data,
        pagination: {
          pageNumber: pageNum,
          pageSize: limitNum,
          totalPages,
        },
        summary: {
          byStatus: statusBreakdown,
          actionable: counters,
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

    let transactionCommitted = false;

    try {
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

      const { reason } = req.body as { reason?: string };

      if ((reason !== undefined && typeof reason !== "string") || (reason && reason.trim().length > 200)) {
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
        throw new ErrorHandler("Package not found in this branch", 404);
      }

      if (!supervisor || !supervisor.isActive) {

        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }

      if (!supervisor.hasPermission("can_manage_packages")) {

        throw new ErrorHandler("You don't have permission to manage packages", 403);
      }

      if (packageDoc.status === "cancelled") {

        throw new ErrorHandler("Package is already cancelled", 400);
      }

      if (NON_CANCELLABLE_STATUSES.includes(packageDoc.status)) {
        throw new ErrorHandler(
          `Cannot cancel a package with status '${packageDoc.status}'`,
          400,
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
        PaymentModel.findOneAndUpdate(
          { packageId: packageDoc._id },
          { $set: { status: 'cancelled' } },
          { session }
        ),
      ]);

      await session.commitTransaction();
      transactionCommitted = true;


      sendPackageCancelledNotification(

        packageDoc.senderId.toString(),
        packageDoc.senderType,
        packageId.toString(),
        packageDoc.trackingNumber,
        reason

      ).catch(error => {

        console.error('Package cancelled notification failed:', error);

      });

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

      if (recipientPhone !== undefined && (typeof recipientPhone !== "string" || recipientPhone.trim().length === 0 || !phoneRegex.test(recipientPhone.trim()))) {
        return next(new ErrorHandler("recipientPhone is not valid", 400));
      }

      if ((recipientName !== undefined && (typeof recipientName !== "string" || recipientName.trim().length === 0 || recipientName.trim().length > 50))) {
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

      return next(new ErrorHandler("Failed to fetch packages by reciever", 500));
    }
  }
);




const READABLE_STATUS: Record<PackageStatus, string> = {
  pending: "Created",
  accepted: "Accepted",
  at_origin_branch: "Arrived at Origin Branch",
  in_transit_to_branch: "In Transit",
  at_destination_branch: "Arrived at Destination Branch",
  out_for_delivery: "Out for Delivery",
  delivered: "Delivered",
  failed_delivery: "Delivery Failed",

  cashier_claimed: 'Claimed at Counter',
  manifested: 'Assigned to Manifest',

  failed_delivery_attempt: "Failed Delivery Attempt",
  rescheduled: "Rescheduled",
  returned: "Returned",
  cancelled: "Cancelled",
  lost: "Lost",
  damaged: "Damaged",
  on_hold: "On Hold",
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
    rescheduled: 70,
    on_hold: 50,
    returned: 100,
    damaged: 100,
    lost: 0,
    cancelled: 0,
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

    const { page, limit, fromDate, toDate } = req.query;
    const pageNum = parseInt(page as string ?? "1", 10);
    const limitNum = parseInt(limit as string ?? "20", 10);

    if (isNaN(pageNum) || pageNum < 1) {
      return next(new ErrorHandler("page must be a positive integer", 400));
    }
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return next(new ErrorHandler("limit must be between 1 and 100", 400));
    }

    let fromDateParsed: Date | undefined;
    let toDateParsed: Date | undefined;

    if (fromDate) {
      fromDateParsed = new Date(fromDate as string);
      if (isNaN(fromDateParsed.getTime())) {
        return next(new ErrorHandler("fromDate is not a valid date", 400));
      }
    }
    if (toDate) {
      toDateParsed = new Date(toDate as string);
      if (isNaN(toDateParsed.getTime())) {
        return next(new ErrorHandler("toDate is not a valid date", 400));
      }
    }
    if (fromDateParsed && toDateParsed && fromDateParsed > toDateParsed) {
      return next(new ErrorHandler("fromDate must be before toDate", 400));
    }

    const packageOid = new mongoose.Types.ObjectId(packageId.toString());
    const branchOid = new mongoose.Types.ObjectId(branchId.toString());

    // Fetch package with .lean()
    const packageDoc = await PackageModel.findOne({
      _id: packageOid,
      currentBranchId: branchOid,
    }).select("trackingNumber status deliveryType destination companyId")
      .lean();

    if (!packageDoc) {
      return next(new ErrorHandler("Package not found in this branch", 404));
    }


    const historyMatch: Record<string, any> = { packageId: packageOid };
    if (fromDateParsed || toDateParsed) {
      historyMatch.timestamp = {
        ...(fromDateParsed && { $gte: fromDateParsed }),
        ...(toDateParsed && { $lte: toDateParsed }),
      };
    }

    const skip = (pageNum - 1) * limitNum;


    const entries = await PackageHistoryModel.find(historyMatch)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate({
        path: "handledBy",
        select: "firstName lastName role",
        options: { lean: true }
      })
      .populate({
        path: "branchId",
        select: "name code",
        options: { lean: true }
      })
      .lean();

    const total = await PackageHistoryModel.countDocuments(historyMatch);

    const totalPages = Math.ceil(total / limitNum);

    const READABLE_STATUS_MAP: Record<string, string> = {
      'pending': 'Created',
      'accepted': 'Accepted',
      'at_origin_branch': 'Arrived at Origin Branch',
      'in_transit_to_branch': 'In Transit',
      'at_destination_branch': 'Arrived at Destination Branch',
      'out_for_delivery': 'Out for Delivery',
      'delivered': 'Delivered',
      'failed_delivery': 'Delivery Failed',
      'cashier_claimed': 'Claimed at Counter',
      'manifested': 'Assigned to Manifest',
      'failed_delivery_attempt': 'Failed Delivery Attempt',
      'rescheduled': 'Rescheduled',
      'returned': 'Returned',
      'cancelled': 'Cancelled',
      'lost': 'Lost',
      'damaged': 'Damaged',
      'on_hold': 'On Hold',
    };

    return res.status(200).json({
      success: true,
      package: {
        id: packageDoc._id,
        trackingNumber: packageDoc.trackingNumber,
        status: packageDoc.status,
        readableStatus: READABLE_STATUS_MAP[packageDoc.status] ?? packageDoc.status,
        deliveryType: packageDoc.deliveryType,
        recipient: packageDoc.destination?.recipientName || 'N/A',
        description: packageDoc.description ?? null,
      },
      data: entries,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
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

    const branchOid = new mongoose.Types.ObjectId(branchId.toString());
    const packageOid = new mongoose.Types.ObjectId(packageId.toString());


    const [packageDoc, supervisor] = await Promise.all([
      PackageModel.findOne({ _id: packageOid, currentBranchId: branchOid })
        .select(
          "trackingNumber status deliveryType deliveryPriority " +
          "destination originBranchId currentBranchId destinationBranchId " +
          "estimatedDeliveryTime deliveredAt attemptCount maxAttempts " +
          "returnInfo trackingHistory createdAt"
        )
        .populate("originBranchId", "name code")
        .populate("currentBranchId", "name code")
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
      const isLast = idx === history.length - 1;

      return {
        status,
        readableStatus: READABLE_STATUS[status] ?? status,
        isException: EXCEPTION_STATUSES.has(status),

        stepState: isLast ? "active" : "completed",
        timestamp: event.timestamp,
        notes: event.notes ?? null,
        location: event.location ?? null,
        branchId: event.branchId ?? null,
        handledBy: event.userId ?? null,
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
      if (seconds < 60) lastUpdatedAgo = "just now";
      else if (seconds < 3600) lastUpdatedAgo = `${Math.floor(seconds / 60)}m ago`;
      else if (seconds < 86400) lastUpdatedAgo = `${Math.floor(seconds / 3600)}h ago`;
      else lastUpdatedAgo = `${Math.floor(seconds / 86400)}d ago`;
    }

    return res.status(200).json({
      success: true,

      currentState: {
        status: currentStatus,
        readableStatus: READABLE_STATUS[currentStatus] ?? currentStatus,
        isException: EXCEPTION_STATUSES.has(currentStatus),
        progress: deliveryProgress(currentStatus),   // 0–100
        lastUpdatedAgo,
      },


      package: {
        trackingNumber: packageDoc.trackingNumber,
        deliveryType: packageDoc.deliveryType,
        deliveryPriority: packageDoc.deliveryPriority,
        estimatedDeliveryTime: packageDoc.estimatedDeliveryTime ?? null,
        deliveredAt: packageDoc.deliveredAt ?? null,
        attemptCount: packageDoc.attemptCount,
        maxAttempts: packageDoc.maxAttempts,
        isReturn: packageDoc.returnInfo?.isReturn ?? false,
        recipient: {
          name: packageDoc.destination.recipientName,
          phone: packageDoc.destination.recipientPhone,
          city: packageDoc.destination.city,
          state: packageDoc.destination.state,
        },
        originBranch: packageDoc.originBranchId,
        currentBranch: packageDoc.currentBranchId,
        destinationBranch: packageDoc.destinationBranchId ?? null,
      },
      timeline,
      expectedSteps,
    });
  },
);







//  Write one PackageHistory audit record per package in a single insertMany.
//  This keeps every function's catch block clean — one shared call, not N saves.

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





function manifestIdsFromRoute(route: any): mongoose.Types.ObjectId[] {
  return route.stops.flatMap(
    (stop: any) =>
      (stop.manifestIds ?? []).map(
        (id: any) => new mongoose.Types.ObjectId(id.toString()),
      ),
  );
}

function manifestIdsFromStop(stop: any): mongoose.Types.ObjectId[] {
  return (stop.manifestIds ?? []).map(
    (id: any) => new mongoose.Types.ObjectId(id.toString()),
  );
}




export const transporterMarkManifestsInTransit = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const transporterUserId = req.user?._id;
      const { routeId } = req.params;
      const { notes } = req.body as { notes?: string };

      if (!transporterUserId) {
        return next(new ErrorHandler('Unauthorized, you are not authenticated.', 401));
      }
      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId.toString())) {
        return next(new ErrorHandler('Invalid route ID', 400));
      }

      const [transporter, route] = await Promise.all([
        TransporterModel.findOne({ userId: transporterUserId }).session(session),
        RouteModel.findById(routeId).session(session),
      ]);

      if (!transporter || !transporter.isActive || transporter.isSuspended) {
        throw new ErrorHandler('Transporter account is not active', 403);
      }
      if (transporter.verificationStatus !== 'verified') {
        throw new ErrorHandler('Transporter is not verified', 403);
      }
      if (!route) {
        throw new ErrorHandler('Route not found', 404);
      }
      if (!route.assignedTransporterId?.equals(transporter._id)) {
        throw new ErrorHandler('You are not assigned to this route', 403);
      }
      if (route.status === 'active') {
        throw new ErrorHandler('Route is already active', 400);
      }
      if (!['planned', 'assigned'].includes(route.status)) {
        throw new ErrorHandler(
          `Cannot start a route with status '${route.status}'`,
          400,
        );
      }


      const isManifestRoute = route.type === 'hub_to_hub' || route.type === 'hub_to_branch';

      if (isManifestRoute) {

        const allManifestIds = manifestIdsFromRoute(route);

        if (allManifestIds.length === 0) {
          throw new ErrorHandler('Route has no manifests assigned', 400);
        }


        const manifests = await ManifestModel.find({
          _id: { $in: allManifestIds },
        }).session(session);

        const notReady = manifests.filter(
          (m) => !['sealed', 'loaded'].includes(m.status),
        );
        if (notReady.length > 0) {
          throw new ErrorHandler(
            `${notReady.length} manifest(s) are not sealed/loaded yet: ` +
            notReady.map((m) => m.manifestCode).join(', '),
            400,
          );
        }

        const now = new Date();


        for (const manifest of manifests) {
          await manifest.markDeparted(transporterUserId, session);
        }


        await Promise.all([
          RouteModel.findByIdAndUpdate(
            routeId,
            {
              $set: {
                status: 'active',
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
                availabilityStatus: 'on_route',
                currentRouteId: route._id,
                lastActiveAt: now,
              },
            },
            { session },
          ),
        ]);

        await session.commitTransaction();
        transactionCommitted = true;

        return res.status(200).json({
          success: true,
          message: `Trip started — ${allManifestIds.length} manifest(s) now in transit`,
          data: {
            routeId: route._id,
            routeNumber: route.routeNumber,
            routeType: route.type,
            totalManifests: allManifestIds.length,
            status: 'in_transit',
            startedAt: now,
          },
        });

      } else {

        const allPackageIds: mongoose.Types.ObjectId[] = route.stops.flatMap(
          (stop: any) =>
            (stop.packageIds || []).map(
              (id: any) => new mongoose.Types.ObjectId(id.toString()),
            ),
        );

        if (allPackageIds.length === 0) {
          throw new ErrorHandler('Route has no packages assigned', 400);
        }

        const now = new Date();

        const PackageModel = (await import('../models/package.model')).default;
        await PackageModel.updateMany(
          { _id: { $in: allPackageIds } },
          {
            $set: {
              status: 'in_transit_to_branch',
              assignedTransporterId: transporter._id,
              currentRouteId: route._id,
            },
            $push: {
              trackingHistory: {
                status: 'in_transit_to_branch',
                userId: transporterUserId,
                notes: notes || 'Transporter started route — packages in transit',
                timestamp: now,
              },
            },
          },
          { session },
        );

        await writeHistory(
          allPackageIds.map((pid) => ({
            packageId: pid,
            status: 'in_transit_to_branch' as PackageStatus,
            handledBy: new mongoose.Types.ObjectId(transporterUserId.toString()),
            handlerRole: 'transporter' as const,
            notes: notes || 'Transporter started route — packages in transit',
          })),
          session,
        );

        await Promise.all([
          RouteModel.findByIdAndUpdate(
            routeId,
            {
              $set: {
                status: 'active',
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
                availabilityStatus: 'on_route',
                currentRouteId: route._id,
                lastActiveAt: now,
              },
            },
            { session },
          ),
        ]);

        await session.commitTransaction();
        transactionCommitted = true;

        return res.status(200).json({
          success: true,
          message: `Route started — ${allPackageIds.length} package(s) marked in transit`,
          data: {
            routeId: route._id,
            routeNumber: route.routeNumber,
            totalPackages: allPackageIds.length,
            status: 'in_transit_to_branch',
            startedAt: now,
          },
        });
      }

    } catch (error: any) {
      if (error.name === 'ValidationError') {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(', '),
            400,
          ),
        );
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




export const transporterMarkArrivedAtStop = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const transporterUserId = req.user?._id;
      const { routeId, stopId } = req.params;
      const { notes } = req.body as { notes?: string };

      if (!transporterUserId) {
        return next(new ErrorHandler('Unauthorized, you are not authenticated.', 401));
      }
      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId.toString())) {
        return next(new ErrorHandler('Invalid route ID', 400));
      }
      if (!stopId || !mongoose.Types.ObjectId.isValid(stopId.toString())) {
        return next(new ErrorHandler('Invalid stop ID', 400));
      }

      const [transporter, route] = await Promise.all([
        TransporterModel.findOne({ userId: transporterUserId }).session(session),
        RouteModel.findById(routeId).session(session),
      ]);

      if (!transporter || !transporter.isActive || transporter.isSuspended) {
        throw new ErrorHandler('Transporter account is not active', 403);
      }
      if (!route) {
        throw new ErrorHandler('Route not found', 404);
      }
      if (!route.assignedTransporterId?.equals(transporter._id)) {
        throw new ErrorHandler('You are not assigned to this route', 403);
      }
      if (route.status !== 'active') {
        throw new ErrorHandler(
          `Route must be active to mark arrivals (current: ${route.status})`,
          400,
        );
      }


      const stopIndex = route.stops.findIndex(
        (s: any) => s._id?.toString() === stopId,
      );
      if (stopIndex === -1) {
        throw new ErrorHandler('Stop not found in this route', 404);
      }

      const stop = route.stops[stopIndex];

      if (stop.status === 'completed') {
        throw new ErrorHandler('This stop is already completed', 400);
      }

      const isManifestRoute = route.type === 'hub_to_hub' || route.type === 'hub_to_branch';
      const now = new Date();
      const isLastStop = stopIndex === route.stops.length - 1;

      let resultMessage = '';
      let resultData: any = {};

      if (isManifestRoute) {

        const stopManifestIds = manifestIdsFromStop(stop);

        if (stopManifestIds.length === 0) {
          throw new ErrorHandler('No manifests assigned to this stop', 400);
        }

        const stopBranchOid = stop.branchId
          ? new mongoose.Types.ObjectId(stop.branchId.toString())
          : null;


        for (const manifestId of stopManifestIds) {
          const manifest = await ManifestModel.findById(manifestId).session(session);
          if (manifest) {
            await manifest.markArrived(transporterUserId, session);
          }
        }

        resultMessage = `Arrived at stop — ${stopManifestIds.length} manifest(s) marked arrived`;
        resultData = {
          routeId: route._id,
          stopId: stop._id,
          branchId: stopBranchOid,
          arrivedAt: now,
          manifestsArrived: stopManifestIds.length,
          routeCompleted: isLastStop,
        };

      } else {

        if (!stop.branchId) {
          throw new ErrorHandler('Stop has no branch associated', 400);
        }
        if ((stop.packageIds || []).length === 0) {
          throw new ErrorHandler('No packages assigned to this stop', 400);
        }

        const PackageModel = (await import('../models/package.model')).default;
        const stopBranchOid = new mongoose.Types.ObjectId(stop.branchId.toString());
        const packageIds = (stop.packageIds || []).map(
          (id: any) => new mongoose.Types.ObjectId(id.toString()),
        );

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
            new mongoose.Types.ObjectId(
              pkg.destinationBranchId.toString(),
            ).equals(stopBranchOid);
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
                status: 'at_destination_branch',
                currentBranchId: stopBranchOid,
              },
              $push: {
                trackingHistory: {
                  status: 'at_destination_branch',
                  branchId: stopBranchOid,
                  userId: transporterUserId,
                  notes: notes || 'Package arrived at destination branch — ready for delivery',
                  timestamp: now,
                },
              },
            },
            { session },
          );
          finalPackageIds.forEach((pid) =>
            historyEntries.push({
              packageId: pid,
              status: 'at_destination_branch',
              handledBy: new mongoose.Types.ObjectId(transporterUserId.toString()),
              handlerRole: 'transporter',
              branchId: stopBranchOid,
              notes: notes || 'Package arrived at destination branch — ready for delivery',
            }),
          );
        }

        if (intermediatePackageIds.length > 0) {
          await PackageModel.updateMany(
            { _id: { $in: intermediatePackageIds } },
            {
              $set: {
                status: 'in_transit_to_branch',
                currentBranchId: stopBranchOid,
              },
              $push: {
                trackingHistory: {
                  status: 'in_transit_to_branch',
                  branchId: stopBranchOid,
                  userId: transporterUserId,
                  notes: notes || 'Package arrived at intermediate branch — will continue to destination',
                  timestamp: now,
                },
              },
            },
            { session },
          );
          intermediatePackageIds.forEach((pid) =>
            historyEntries.push({
              packageId: pid,
              status: 'in_transit_to_branch',
              handledBy: new mongoose.Types.ObjectId(transporterUserId.toString()),
              handlerRole: 'transporter',
              branchId: stopBranchOid,
              notes: notes || 'Package arrived at intermediate branch — will continue to destination',
            }),
          );
        }

        await writeHistory(historyEntries, session);

        resultMessage = `Arrived at branch — ${finalPackageIds.length} package(s) at destination, ` +
          `${intermediatePackageIds.length} intermediate`;
        resultData = {
          routeId: route._id,
          stopId: stop._id,
          branchId: stopBranchOid,
          arrivedAt: now,
          packages: {
            atDestination: {
              count: finalPackageIds.length,
              status: 'at_destination_branch',
              ids: finalPackageIds,
            },
            intermediate: {
              count: intermediatePackageIds.length,
              status: 'in_transit_to_branch',
              ids: intermediatePackageIds,
            },
          },
          routeCompleted: isLastStop,
        };
      }


      await RouteModel.findByIdAndUpdate(
        routeId,
        {
          $set: {
            [`stops.${stopIndex}.status`]: 'completed',
            [`stops.${stopIndex}.actualArrival`]: now,
            [`stops.${stopIndex}.actualDeparture`]: now,
            currentStopIndex: stopIndex + 1,
            completedStops: route.completedStops + 1,

            ...(isLastStop && {
              status: 'completed',
              actualEnd: now,
              actualTime: route.actualStart
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
        const releaseUpdate: Record<string, any> = {
          availabilityStatus: 'available',
          currentRouteId: undefined,
          lastActiveAt: now,
        };


        const isHubToHubRoute = route.type === 'hub_to_hub';
        if (isHubToHubRoute && stop.branchId) {
          releaseUpdate.currentBranchId = new mongoose.Types.ObjectId(stop.branchId.toString());
        }

        await TransporterModel.findByIdAndUpdate(
          transporter._id,
          {
            $set: releaseUpdate,
            $inc: {
              totalTrips: 1,
              completedTrips: 1,
            },
          },
          { session },
        );
      }

      await session.commitTransaction();
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message: resultMessage + (isLastStop ? ' — route complete' : ''),
        data: resultData,
      });

    } catch (error: any) {
      if (error.name === 'ValidationError') {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(', '),
            400,
          ),
        );
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




export const transporterMarkPackagesInTransit = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const transporterUserId = req.user?._id;
      const { routeId } = req.params;
      const { notes } = req.body as { notes?: string };

      if (!transporterUserId) {
        return next(new ErrorHandler('Unauthorized, you are not authenticated.', 401));
      }
      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId.toString())) {
        return next(new ErrorHandler('Invalid route ID', 400));
      }

      const [transporter, route] = await Promise.all([
        TransporterModel.findOne({ userId: transporterUserId }).session(session),
        RouteModel.findById(routeId).session(session),
      ]);

      if (!transporter || !transporter.isActive || transporter.isSuspended) {
        throw new ErrorHandler('Transporter account is not active', 403);
      }
      if (transporter.verificationStatus !== 'verified') {
        throw new ErrorHandler('Transporter is not verified', 403);
      }
      if (!route) {
        throw new ErrorHandler('Route not found', 404);
      }
      if (!route.assignedTransporterId?.equals(transporter._id)) {
        throw new ErrorHandler('You are not assigned to this route', 403);
      }
      if (route.status === 'active') {
        throw new ErrorHandler('Route is already active', 400);
      }
      if (!['planned', 'assigned'].includes(route.status)) {
        throw new ErrorHandler(
          `Cannot start a route with status '${route.status}'`,
          400,
        );
      }

      const allPackageIds: mongoose.Types.ObjectId[] = route.stops.flatMap(
        (stop: any) =>
          (stop.packageIds || []).map(
            (id: any) => new mongoose.Types.ObjectId(id.toString()),
          ),
      );

      if (allPackageIds.length === 0) {
        throw new ErrorHandler('Route has no packages assigned', 400);
      }

      const now = new Date();

      await (await import('../models/package.model')).default.updateMany(
        { _id: { $in: allPackageIds } },
        {
          $set: {
            status: 'in_transit_to_branch',
            assignedTransporterId: transporter._id,
            currentRouteId: route._id,
          },
          $push: {
            trackingHistory: {
              status: 'in_transit_to_branch',
              userId: transporterUserId,
              notes: notes || 'Transporter started route — packages in transit',
              timestamp: now,
            },
          },
        },
        { session },
      );

      await writeHistory(
        allPackageIds.map((pid) => ({
          packageId: pid,
          status: 'in_transit_to_branch' as PackageStatus,
          handledBy: new mongoose.Types.ObjectId(transporterUserId.toString()),
          handlerRole: 'transporter' as const,
          notes: notes || 'Transporter started route — packages in transit',
        })),
        session,
      );

      await Promise.all([
        RouteModel.findByIdAndUpdate(
          routeId,
          {
            $set: {
              status: 'active',
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
              availabilityStatus: 'on_route',
              currentRouteId: route._id,
              lastActiveAt: now,
            },
          },
          { session },
        ),
      ]);

      await session.commitTransaction();
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message: `Route started — ${allPackageIds.length} package(s) marked in transit`,
        data: {
          routeId: route._id,
          routeNumber: route.routeNumber,
          totalPackages: allPackageIds.length,
          status: 'in_transit_to_branch',
          startedAt: now,
        },
      });

    } catch (error: any) {
      if (error.name === 'ValidationError') {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(', '),
            400,
          ),
        );
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


export const transporterMarkPackagesArrivedAtBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const transporterUserId = req.user?._id;
      const { routeId, stopId } = req.params;
      const { notes } = req.body as { notes?: string };

      if (!transporterUserId) {
        return next(new ErrorHandler('Unauthorized, you are not authenticated.', 401));
      }
      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId.toString())) {
        return next(new ErrorHandler('Invalid route ID', 400));
      }
      if (!stopId || !mongoose.Types.ObjectId.isValid(stopId.toString())) {
        return next(new ErrorHandler('Invalid stop ID', 400));
      }

      const [transporter, route] = await Promise.all([
        TransporterModel.findOne({ userId: transporterUserId }).session(session),
        RouteModel.findById(routeId).session(session),
      ]);

      if (!transporter || !transporter.isActive || transporter.isSuspended) {
        throw new ErrorHandler('Transporter account is not active', 403);
      }
      if (!route) {
        throw new ErrorHandler('Route not found', 404);
      }
      if (!route.assignedTransporterId?.equals(transporter._id)) {
        throw new ErrorHandler('You are not assigned to this route', 403);
      }
      if (route.status !== 'active') {
        throw new ErrorHandler(
          `Route must be active to mark arrivals (current: ${route.status})`,
          400,
        );
      }

      const stopIndex = route.stops.findIndex(
        (s: any) => s._id?.toString() === stopId,
      );
      if (stopIndex === -1) {
        throw new ErrorHandler('Stop not found in this route', 404);
      }

      const stop = route.stops[stopIndex];

      if (!stop.branchId) {
        throw new ErrorHandler('Stop has no branch associated', 400);
      }
      if (stop.status === 'completed') {
        throw new ErrorHandler('This stop is already completed', 400);
      }
      if ((stop.packageIds || []).length === 0) {
        throw new ErrorHandler('No packages assigned to this stop', 400);
      }

      const PackageModel = (await import('../models/package.model')).default;
      const stopBranchOid = new mongoose.Types.ObjectId(stop.branchId.toString());
      const packageIds = (stop.packageIds || []).map(
        (id: any) => new mongoose.Types.ObjectId(id.toString()),
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
          new mongoose.Types.ObjectId(
            pkg.destinationBranchId.toString(),
          ).equals(stopBranchOid);
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
              status: 'at_destination_branch',
              currentBranchId: stopBranchOid,
            },
            $push: {
              trackingHistory: {
                status: 'at_destination_branch',
                branchId: stopBranchOid,
                userId: transporterUserId,
                notes: notes || 'Package arrived at destination branch — ready for delivery',
                timestamp: now,
              },
            },
          },
          { session },
        );
        finalPackageIds.forEach((pid) =>
          historyEntries.push({
            packageId: pid,
            status: 'at_destination_branch',
            handledBy: new mongoose.Types.ObjectId(transporterUserId.toString()),
            handlerRole: 'transporter',
            branchId: stopBranchOid,
            notes: notes || 'Package arrived at destination branch — ready for delivery',
          }),
        );
      }

      if (intermediatePackageIds.length > 0) {
        await PackageModel.updateMany(
          { _id: { $in: intermediatePackageIds } },
          {
            $set: {
              status: 'in_transit_to_branch',
              currentBranchId: stopBranchOid,
            },
            $push: {
              trackingHistory: {
                status: 'in_transit_to_branch',
                branchId: stopBranchOid,
                userId: transporterUserId,
                notes: notes || 'Package arrived at intermediate branch — will continue to destination',
                timestamp: now,
              },
            },
          },
          { session },
        );
        intermediatePackageIds.forEach((pid) =>
          historyEntries.push({
            packageId: pid,
            status: 'in_transit_to_branch',
            handledBy: new mongoose.Types.ObjectId(transporterUserId.toString()),
            handlerRole: 'transporter',
            branchId: stopBranchOid,
            notes: notes || 'Package arrived at intermediate branch — will continue to destination',
          }),
        );
      }

      await writeHistory(historyEntries, session);

      const isLastStop = stopIndex === route.stops.length - 1;

      await RouteModel.findByIdAndUpdate(
        routeId,
        {
          $set: {
            [`stops.${stopIndex}.status`]: 'completed',
            [`stops.${stopIndex}.actualArrival`]: now,
            [`stops.${stopIndex}.actualDeparture`]: now,
            currentStopIndex: stopIndex + 1,
            completedStops: route.completedStops + 1,
            ...(isLastStop && {
              status: 'completed',
              actualEnd: now,
              actualTime: route.actualStart
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
              availabilityStatus: 'available',
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
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message:
          `Arrived at branch — ${finalPackageIds.length} package(s) at destination, ` +
          `${intermediatePackageIds.length} intermediate`,
        data: {
          routeId: route._id,
          stopId: stop._id,
          branchId: stopBranchOid,
          arrivedAt: now,
          packages: {
            atDestination: {
              count: finalPackageIds.length,
              status: 'at_destination_branch',
              ids: finalPackageIds,
            },
            intermediate: {
              count: intermediatePackageIds.length,
              status: 'in_transit_to_branch',
              ids: intermediatePackageIds,
            },
          },
          routeCompleted: isLastStop,
        },
      });

    } catch (error: any) {
      if (error.name === 'ValidationError') {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(', '),
            400,
          ),
        );
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






export const arrivedAtBranchOutForDelivery = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const delivererUserId = req.user?._id;
      const { branchId } = req.params;

      if (!delivererUserId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {

        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const { packageIds: rawIds, notes } = req.body as {
        packageIds?: string | string[];
        notes?: string;
      };

      if (!rawIds || (Array.isArray(rawIds) && rawIds.length === 0)) {

        return next(new ErrorHandler("packageIds is required", 400));
      }


      const idList: string[] = Array.isArray(rawIds) ? rawIds : [rawIds];

      const invalidIds = idList.filter(
        (id) => !mongoose.Types.ObjectId.isValid(id),
      );
      if (invalidIds.length) {

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

        throw new ErrorHandler("Deliverer account is not active in this branch", 403);
      }

      if (deliverer.verificationStatus !== "verified") {

        throw new ErrorHandler("Deliverer is not verified", 403);
      }

      if (deliverer.availabilityStatus === "off_duty") {

        throw new ErrorHandler("Deliverer is off duty", 403);
      }


      if (packages.length !== packageOids.length) {

        throw new ErrorHandler("One or more packages not found", 404);
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

        throw new ErrorHandler(
          `Invalid package(s):\n${invalidPackages.join("\n")}`,
          400,
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
      transactionCommitted = true;

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







export const deliverPackageFail = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const delivererUserId = req.user?._id;
      const { branchId, packageId } = req.params;

      if (!delivererUserId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {

        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {

        return next(new ErrorHandler("Invalid package ID", 400));
      }

      const { reason, notes } = req.body as { reason?: string; notes?: string };

      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {

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

        throw new ErrorHandler("Deliverer account is not active in this branch", 403);
      }

      if (!packageDoc) {

        throw new ErrorHandler("Package not found or not assigned to this branch", 404);
      }


      if (!packageDoc.assignedDelivererId?.equals(deliverer._id)) {

        throw new ErrorHandler("This package is not assigned to you", 403);
      }

      if (packageDoc.status !== "out_for_delivery") {

        throw new ErrorHandler(
          `Package must be 'out_for_delivery' to mark as failed (is '${packageDoc.status}')`,
          400,
        );
      }

      const now = new Date();
      const newAttemptCount = packageDoc.attemptCount + 1;
      const maxReached = newAttemptCount >= packageDoc.maxAttempts;



      const newStatus: PackageStatus = maxReached
        ? "failed_delivery"
        : "failed_delivery_attempt";

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

      await Promise.all([
        PackageModel.findByIdAndUpdate(packageId, packageUpdate, { session }),
        PaymentModel.findOneAndUpdate(
          { packageId: packageDoc._id },

          { $set: { status: maxReached ? 'failed' : 'pending' } },
          { session }
        ),
      ]);

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
      transactionCommitted = true;


      sendDeliveryFailedNotification(

        packageDoc.senderId.toString(),
        packageDoc.senderType,
        packageId.toString(),
        packageDoc.trackingNumber,
        newAttemptCount,
        packageDoc.maxAttempts,
        reason.trim(),
        branchId.toString(),
        nextAttemptDate

      ).catch(error => {

        console.error('Delivery failed notification failed:', error);

      });

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




export const deliveryReturnPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const delivererUserId = req.user?._id;
      const { branchId, packageId } = req.params;

      if (!delivererUserId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {

        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {

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

        throw new ErrorHandler("Deliverer account is not active in this branch", 403);
      }

      if (!packageDoc) {

        throw new ErrorHandler("Package not found at this branch", 404);
      }

      const returnableStatuses: PackageStatus[] = [
        "out_for_delivery",
        "failed_delivery",
      ];

      if (!returnableStatuses.includes(packageDoc.status)) {

        throw new ErrorHandler(
          `Cannot return a package with status '${packageDoc.status}'. ` +
          `Only packages that are 'out_for_delivery' or 'failed_delivery' can be returned.`,
          400,
        );
      }


      if (
        packageDoc.assignedDelivererId &&
        !packageDoc.assignedDelivererId.equals(deliverer._id)
      ) {

        throw new ErrorHandler("This package is not assigned to you", 403);
      }

      const now = new Date();
      const returnReason =
        reason?.trim() ||
        (packageDoc.status === "failed_delivery"
          ? "Returned after failed delivery"
          : "Package returned to branch by deliverer");

      const noteText = [returnReason, notes?.trim()].filter(Boolean).join(" | ");

      await Promise.all([
        PackageModel.findByIdAndUpdate(
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
        ),
        PaymentModel.findOneAndUpdate(
          { packageId: packageDoc._id },
          { $set: { status: 'cancelled' } },
          { session }
        ),
      ]);

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
      transactionCommitted = true;



      sendPackageReturnedToBranchNotification(
        packageDoc.senderId.toString(),
        packageDoc.senderType,
        packageId.toString(),
        packageDoc.trackingNumber,
        returnReason,
        branchId.toString(),
      ).catch(error => {

        console.error('Package returned notification failed:', error);

      });

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





const LOCKED_STATUSES: RouteStatus[] = ["active", "paused", "completed", "cancelled"];


const ROUTE_POPULATE = [
  { path: "originBranchId", select: "name code address wilaya" },
  { path: "destinationBranchId", select: "name code address wilaya" },
  { path: "assignedVehicleId", select: "type registrationNumber brand modelName maxWeight maxVolume" },
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

    let transactionCommitted = false;

    try {
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


      const body = req.body as {
        name?: string;
        scheduledStart?: string;
        scheduledEnd?: string;
        completionNotes?: string;
        stops?: {
          stopId: string;
          notes?: string;
          contactPerson?: string;
          contactPhone?: string;
          expectedArrival?: string;
        }[];
      };

      if (Object.keys(body).length === 0) {

        return next(new ErrorHandler("No update data provided", 400));
      }


      const blocked = [
        "status", "assignedTransporterId", "assignedDelivererId",
        "assignedVehicleId", "distance", "estimatedTime",
        "currentStopIndex", "completedStops", "failedStops",
      ];
      const blockedFound = blocked.filter((f) => f in body);
      if (blockedFound.length) {

        return next(
          new ErrorHandler(
            `Field(s) cannot be updated here: ${blockedFound.join(", ")}. ` +
            "Use the dedicated endpoint for each.",
            400,
          ),
        );
      }

      if (body.name !== undefined && typeof body.name !== "string") {

        return next(new ErrorHandler("name must be a string", 400));
      }

      let parsedStart: Date | undefined;
      let parsedEnd: Date | undefined;

      if (body.scheduledStart !== undefined) {
        parsedStart = new Date(body.scheduledStart);
        if (isNaN(parsedStart.getTime())) {

          return next(new ErrorHandler("scheduledStart is not a valid date", 400));
        }
      }
      if (body.scheduledEnd !== undefined) {
        parsedEnd = new Date(body.scheduledEnd);
        if (isNaN(parsedEnd.getTime())) {

          return next(new ErrorHandler("scheduledEnd is not a valid date", 400));
        }
      }
      if (parsedStart && parsedEnd && parsedStart >= parsedEnd) {

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

        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }
      if (!supervisor.hasPermission("can_manage_schedules")) {

        throw new ErrorHandler("You don't have permission to manage schedules", 403);
      }
      if (!route) {

        throw new ErrorHandler("Route not found in this branch", 404);
      }
      if (LOCKED_STATUSES.includes(route.status)) {
        throw new ErrorHandler(
          `Cannot edit a route with status '${route.status}'. ` +
          "Only planned and assigned routes can be modified.",
          400,
        );
      }


      const $set: Record<string, any> = {};

      if (body.name?.trim()) $set.name = body.name.trim();
      if (parsedStart) $set.scheduledStart = parsedStart;
      if (parsedEnd) $set.scheduledEnd = parsedEnd;
      if (body.completionNotes !== undefined) {
        $set.completionNotes = body.completionNotes?.trim() ?? null;
      }


      const effectiveStart = parsedStart ?? route.scheduledStart;
      const effectiveEnd = parsedEnd ?? route.scheduledEnd;
      if (effectiveStart >= effectiveEnd) {
        throw new ErrorHandler("scheduledStart must be before scheduledEnd", 400);
      }


      if (body.stops && body.stops.length > 0) {
        for (const stopUpdate of body.stops) {
          if (!stopUpdate.stopId || !mongoose.Types.ObjectId.isValid(stopUpdate.stopId)) {
            throw new ErrorHandler(`Invalid stopId: ${stopUpdate.stopId}`, 400);
          }

          const stopOid = new mongoose.Types.ObjectId(stopUpdate.stopId);
          const stopIdx = route.stops.findIndex(
            (s) => s._id?.toString() === stopOid.toString(),
          );
          if (stopIdx === -1) {
            throw new ErrorHandler(`Stop ${stopUpdate.stopId} not found in this route`, 404);
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
              throw new ErrorHandler(`Stop ${stopUpdate.stopId}: expectedArrival is not a valid date`, 400);
            }
            $set[`stops.${stopIdx}.expectedArrival`] = d;
          }
        }
      }

      if (Object.keys($set).length === 0) {
        throw new ErrorHandler("No valid fields to update", 400);
      }

      await RouteModel.findByIdAndUpdate(routeId, { $set }, { session });

      await session.commitTransaction();
      transactionCommitted = true;
      const updated = await RouteModel.findById(routeId)
        .populate(ROUTE_POPULATE as any)
        .lean();

      return res.status(200).json({
        success: true,
        message: "Route updated successfully",
        data: updated,
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




export const getRoutes = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const userRole = req.user?.role as string;
    const { branchId } = req.params;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }
    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }


    const VALID_STATUSES: RouteStatus[] = [
      "planned", "assigned", "active", "paused", "completed", "cancelled"
    ];
    const VALID_TYPES: RouteType[] = [
      "inter_branch", "local_delivery", "pickup_route", "return_route",
      "hub_to_hub", "hub_to_branch"
    ];
    const VALID_SORT_BY = ["scheduledStart", "createdAt", "status"];

    const {
      status,
      type,
      workerId,
      fromDate,
      toDate,
      search,
      sortBy = "scheduledStart",
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
    let toDateParsed: Date | undefined;
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

    const pageNum = parseInt(page ?? "1", 10);
    const limitNum = parseInt(limit ?? "20", 10);
    if (isNaN(pageNum) || pageNum < 1) return next(new ErrorHandler("page must be a positive integer", 400));
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) return next(new ErrorHandler("limit must be between 1 and 100", 400));


    const branchOid = new mongoose.Types.ObjectId(branchId.toString());

    let delivererId: mongoose.Types.ObjectId | null = null;
    let transporterId: mongoose.Types.ObjectId | null = null;
    let supervisorId: mongoose.Types.ObjectId | null = null;

    if (userRole === "supervisor" || userRole === "admin" || userRole === "manager") {

      const supervisor = await SupervisorModel.findOne({
        userId,
        branchId: branchOid,
      }).lean();

      if (!supervisor || !supervisor.isActive) {
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }
      supervisorId = supervisor._id;
    } else if (userRole === "deliverer") {

      const deliverer = await DelivererModel.findOne({
        userId,
        branchId: branchOid,
      }).lean();

      if (!deliverer) {
        return next(new ErrorHandler("You are not assigned to this branch as a deliverer", 403));
      }
      if (!deliverer.isActive) {
        return next(new ErrorHandler("Your deliverer account is not active", 403));
      }
      if (deliverer.isSuspended) {
        return next(new ErrorHandler("Your deliverer account is suspended", 403));
      }
      delivererId = deliverer._id;
    } else if (userRole === "transporter") {

      const transporter = await TransporterModel.findOne({ userId }).lean();

      if (!transporter) {
        return next(new ErrorHandler("Transporter profile not found", 404));
      }
      if (!transporter.isActive) {
        return next(new ErrorHandler("Your transporter account is not active", 403));
      }
      if (transporter.isSuspended) {
        return next(new ErrorHandler("Your transporter account is suspended", 403));
      }



      const branchOidStr = branchOid.toString();
      let hasAccess = false;

      if (transporter.transporterType === "hub_to_hub") {

        if (transporter.assignedLine) {
          hasAccess = transporter.assignedLine.some(
            (id) => id.toString() === branchOidStr
          );
        }
      } else if (transporter.transporterType === "hub_to_branch") {

        if (transporter.assignedBranches) {
          hasAccess = transporter.assignedBranches.some(
            (id) => id.toString() === branchOidStr
          );
        }
        if (!hasAccess && transporter.currentBranchId) {
          hasAccess = transporter.currentBranchId.toString() === branchOidStr;
        }
      } else {

        if (transporter.currentBranchId) {
          hasAccess = transporter.currentBranchId.toString() === branchOidStr;
        }
      }

      if (!hasAccess) {
        return next(new ErrorHandler("You are not authorized to view routes for this branch", 403));
      }

      transporterId = transporter._id;
    } else {
      return next(new ErrorHandler("You are not authorized to view routes for this branch", 403));
    }


    const matchStage: Record<string, any> = {};


    if (delivererId) {
      matchStage.assignedDelivererId = delivererId;
    } else if (transporterId) {
      matchStage.assignedTransporterId = transporterId;
    } else {
      matchStage.$or = [
        { originBranchId: branchOid },
        { destinationBranchId: branchOid },
      ];
    }

    if (statusFilter) {
      matchStage.status = statusFilter.length === 1
        ? statusFilter[0]
        : { $in: statusFilter };
    }
    if (type) matchStage.type = type;

    if (workerId) {
      const workerOid = new mongoose.Types.ObjectId(workerId);
      matchStage.$and = [
        ...(matchStage.$and ?? []),
        {
          $or: [
            { assignedTransporterId: workerOid },
            { assignedDelivererId: workerOid },
          ],
        },
      ];
    }

    if (fromDateParsed || toDateParsed) {
      matchStage.scheduledStart = {
        ...(fromDateParsed && { $gte: fromDateParsed }),
        ...(toDateParsed && { $lte: toDateParsed }),
      };
    }

    if (search) {
      const regex = { $regex: search.trim(), $options: "i" };
      const searchOr = [{ routeNumber: regex }, { name: regex }];
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
                from: "branches",
                localField: "originBranchId",
                foreignField: "_id",
                as: "originBranch",
                pipeline: [{ $project: { name: 1, code: 1, wilaya: 1 } }],
              },
            },
            { $unwind: { path: "$originBranch", preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from: "branches",
                localField: "destinationBranchId",
                foreignField: "_id",
                as: "destinationBranch",
                pipeline: [{ $project: { name: 1, code: 1, wilaya: 1 } }],
              },
            },
            { $unwind: { path: "$destinationBranch", preserveNullAndEmptyArrays: true } },


            {
              $lookup: {
                from: "vehicles",
                localField: "assignedVehicleId",
                foreignField: "_id",
                as: "assignedVehicle",
                pipeline: [{ $project: { type: 1, registrationNumber: 1 } }],
              },
            },
            { $unwind: { path: "$assignedVehicle", preserveNullAndEmptyArrays: true } },


            {
              $lookup: {
                from: "deliverers",
                localField: "assignedDelivererId",
                foreignField: "_id",
                as: "assignedDeliverer",
                pipeline: [{ $project: { userId: 1, rating: 1, availabilityStatus: 1 } }],
              },
            },
            { $unwind: { path: "$assignedDeliverer", preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from: "users",
                localField: "assignedDeliverer.userId",
                foreignField: "_id",
                as: "assignedDelivererUser",
                pipeline: [{ $project: { firstName: 1, lastName: 1, phone: 1, avatar: 1 } }],
              },
            },
            { $unwind: { path: "$assignedDelivererUser", preserveNullAndEmptyArrays: true } },


            {
              $lookup: {
                from: "transporters",
                localField: "assignedTransporterId",
                foreignField: "_id",
                as: "assignedTransporter",
                pipeline: [{ $project: { userId: 1, rating: 1, availabilityStatus: 1, transporterType: 1 } }],
              },
            },
            { $unwind: { path: "$assignedTransporter", preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from: "users",
                localField: "assignedTransporter.userId",
                foreignField: "_id",
                as: "assignedTransporterUser",
                pipeline: [{ $project: { firstName: 1, lastName: 1, phone: 1, avatar: 1 } }],
              },
            },
            { $unwind: { path: "$assignedTransporterUser", preserveNullAndEmptyArrays: true } },


            {
              $project: {
                "stops.completedPackages": 0,
                "stops.failedPackages": 0,
                "stops.skippedPackages": 0,
                "stops.issues": 0,
                optimizedPath: 0
              }
            },
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






export const toggleCancelRoute = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;

    try {
      const supervisorUserId = req.user?._id;
      const { branchId, routeId } = req.params;
      const { reason } = req.body as { reason?: string };

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
        SupervisorModel.findOne({ userId: supervisorUserId, branchId }).session(session),
        RouteModel.findOne({
          _id: routeId,
          $or: [{ originBranchId: branchOid }, { destinationBranchId: branchOid }],
        }).session(session),
      ]);

      if (!supervisor || !supervisor.isActive || supervisor.branchId.toString() !== branchOid.toString()) {
        throw new ErrorHandler("You are not an active supervisor of this branch", 403);
      }
      if (!supervisor.hasPermission("can_manage_schedules")) {
        throw new ErrorHandler("You don't have permission to manage schedules", 403);
      }
      if (!route) {
        throw new ErrorHandler("Route not found in this branch", 404);
      }


      if (["active", "paused", "completed"].includes(route.status)) {

        throw new ErrorHandler(
          `Cannot toggle a route with status '${route.status}'. ` +
          "Active routes must be managed through the driver's interface.",
          400,
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
      transactionCommitted = true;

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
        "stops.failedPackages": 0,
        "stops.skippedPackages": 0,
        "stops.issues": 0,
        optimizedPath: 0,
      },
    },
  ];







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
      type?: string;
      workerId?: string;
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
        { originBranchId: branchOid },
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
            { assignedDelivererId: workerOid },
          ],
        },
      ];
    }

    if (branchSearch?.trim()) {
      const query = mongoose.Types.ObjectId.isValid(branchSearch.trim())
        ? { _id: new mongoose.Types.ObjectId(branchSearch.trim()) }
        : {
          $or: [
            { name: { $regex: branchSearch.trim(), $options: "i" } },
            { code: { $regex: branchSearch.trim(), $options: "i" } },
          ]
        };

      const matchedBranch = await BranchModel.findOne(query).select("_id").lean();

      if (!matchedBranch) {
        return next(new ErrorHandler("No branch found matching the provided branchSearch", 404));
      }

      const searchOid = matchedBranch._id as mongoose.Types.ObjectId;
      matchStage.$and = [
        ...(matchStage.$and ?? []),
        {
          $or: [
            { originBranchId: searchOid },
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
              if: { $lt: ["$currentStopIndex", { $size: "$stops" }] },
              then: { $arrayElemAt: ["$stops", "$currentStopIndex"] },
              else: null,
            },
          },

          nextStop: {
            $cond: {
              if: { $lt: [{ $add: ["$currentStopIndex", 1] }, { $size: "$stops" }] },
              then: { $arrayElemAt: ["$stops", { $add: ["$currentStopIndex", 1] }] },
              else: null,
            },
          },

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

          progressPercentage: {
            $cond: {
              if: { $gt: [{ $size: "$stops" }, 0] },
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
      data: routes,
    });
  },
);









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
    const VALID_TYPES: RouteType[] = ["inter_branch", "local_delivery", "pickup_route", "return_route"];

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



    const now = new Date();

    const endOfTomorrow = new Date(now);
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
    endOfTomorrow.setUTCHours(23, 59, 59, 999);

    const defaultFromDate = new Date(now);
    defaultFromDate.setDate(defaultFromDate.getDate() - 30);
    defaultFromDate.setUTCHours(0, 0, 0, 0);

    let fromDateParsed: Date;
    let toDateParsed: Date;

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



      if (toDateParsed > endOfTomorrow) {
        toDateParsed = endOfTomorrow;
      }
    } else {
      toDateParsed = endOfTomorrow;
    }

    if (fromDateParsed > toDateParsed) {
      return next(new ErrorHandler("fromDate must be before toDate", 400));
    }

    const pageNum = parseInt(page ?? "1", 10);
    const limitNum = parseInt(limit ?? "20", 10);
    if (isNaN(pageNum) || pageNum < 1) return next(new ErrorHandler("page must be a positive integer", 400));
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) return next(new ErrorHandler("limit must be between 1 and 100", 400));


    const supervisor = await SupervisorModel.findOne({
      userId: supervisorUserId,
      isActive: true,
    }).lean();

    if (!supervisor) {
      return next(new ErrorHandler("You are not an active supervisor", 403));
    }

    const branchOid = new mongoose.Types.ObjectId(branchId.toString());

    const matchStage: Record<string, any> = {
      $or: [
        { originBranchId: branchOid },
        { destinationBranchId: branchOid },
      ],
      companyId: supervisor.companyId,
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
          totalCount: [{ $count: "count" }],
          statusSummary: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          typeSummary: [{ $group: { _id: "$type", count: { $sum: 1 } } }],
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
        .populate("branchId", "name code address wilaya")
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

        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        imageUrl: user.imageUrl,
        role: user.role,
        status: user.status,


        permissions: supervisor.permissions,
        workSchedule: supervisor.workSchedule,
        performance: supervisor.performance,
        branch: supervisor.branchId,
        company: supervisor.companyId,
      },
    });
  },
);






const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
type WeekDay = typeof WEEKDAYS[number];

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

    if (!user) return next(new ErrorHandler("User not found.", 404));
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


        if (dayData.dayOff === true) {
          scheduleUpdates[`workSchedule.${day}.dayOff`] = true;
          scheduleUpdates[`workSchedule.${day}.start`] = "00:00";
          scheduleUpdates[`workSchedule.${day}.end`] = "00:00";
          continue;
        }

        if (dayData.dayOff === false || dayData.dayOff === undefined) {

          const current = (supervisor.workSchedule as any)[day] ?? {};
          const start = dayData.start ?? current.start;
          const end = dayData.end ?? current.end;

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
          if (dayData.end !== undefined) scheduleUpdates[`workSchedule.${day}.end`] = dayData.end;
          if (dayData.dayOff === false) scheduleUpdates[`workSchedule.${day}.dayOff`] = false;
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
        permissions: updatedSupervisor?.permissions,
        performance: updatedSupervisor?.performance,
      },
    });
  },
);




export const searchPackages = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {

      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit as string) || 20),
      );
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;


      const rawSearch = (req.query.q as string)?.trim() ?? "";


      const matchStage: Record<string, any> = {};


      if (req.query.companyId) {
        if (!mongoose.Types.ObjectId.isValid(req.query.companyId as string)) {
          return next(new ErrorHandler("Invalid companyId.", 400));
        }
        matchStage.companyId = new mongoose.Types.ObjectId(
          req.query.companyId as string,
        );
      }


      if (req.query.clientId) {
        if (!mongoose.Types.ObjectId.isValid(req.query.clientId as string)) {
          return next(new ErrorHandler("Invalid clientId.", 400));
        }
        matchStage.clientId = new mongoose.Types.ObjectId(
          req.query.clientId as string,
        );
      }


      const VALID_STATUSES: PackageStatus[] = [
        "pending", "accepted", "at_origin_branch", "in_transit_to_branch",
        "at_destination_branch", "out_for_delivery", "delivered", 'failed_delivery_attempt',
        "failed_delivery", "rescheduled", "returned", "cancelled",
        "lost", "damaged", "on_hold",
      ];

      if (req.query.status) {
        const s = req.query.status as string;
        if (!VALID_STATUSES.includes(s as PackageStatus)) {
          return next(new ErrorHandler(`Invalid status: ${s}`, 400));
        }
        matchStage.status = s;
      }


      const VALID_TYPES: PackageType[] = [
        "document", "parcel", "fragile", "heavy",
        "perishable", "electronic", "clothing",
      ];

      if (req.query.type) {
        const t = req.query.type as string;
        if (!VALID_TYPES.includes(t as PackageType)) {
          return next(new ErrorHandler(`Invalid package type: ${t}`, 400));
        }
        matchStage.type = t;
      }


      const VALID_PAYMENT_STATUSES: PaymentStatus[] = [
        "pending", "paid", "partially_paid", "refunded", "failed",
      ];

      if (req.query.paymentStatus) {
        const ps = req.query.paymentStatus as string;
        if (!VALID_PAYMENT_STATUSES.includes(ps as PaymentStatus)) {
          return next(new ErrorHandler(`Invalid paymentStatus: ${ps}`, 400));
        }
        matchStage.paymentStatus = ps;
      }


      const VALID_PRIORITIES = ["standard", "express", "same_day"];

      if (req.query.deliveryPriority) {

        const dp = req.query.deliveryPriority as string;
        if (!VALID_PRIORITIES.includes(dp)) {

          return next(new ErrorHandler(`Invalid deliveryPriority: ${dp}`, 400));
        }
        matchStage.deliveryPriority = dp;
      }


      const VALID_DELIVERY_TYPES: DeliveryType[] = ["home", "branch_pickup"];

      if (req.query.deliveryType) {

        const dt = req.query.deliveryType as string;
        if (!VALID_DELIVERY_TYPES.includes(dt as DeliveryType)) {

          return next(new ErrorHandler(`Invalid deliveryType: ${dt}`, 400));
        }
        matchStage.deliveryType = dt;
      }


      if (req.query.isFragile !== undefined) {
        matchStage.isFragile = req.query.isFragile === "true";
      }


      if (req.query.isReturn !== undefined) {
        matchStage["returnInfo.isReturn"] = req.query.isReturn === "true";
      }


      if (req.query.hasIssues !== undefined) {

        if (req.query.hasIssues === "true") {
          matchStage["issues"] = { $elemMatch: { resolved: false } };
        } else {
          matchStage["issues"] = {
            $not: { $elemMatch: { resolved: false } },
          };
        }
      }


      if (req.query.needsAttention === "true") {
        matchStage.status = {
          $in: ["failed_delivery", "damaged", "lost", "on_hold"],
        };
      }


      if (req.query.minWeight || req.query.maxWeight) {
        matchStage.weight = {
          ...(req.query.minWeight && {
            $gte: parseFloat(req.query.minWeight as string),
          }),
          ...(req.query.maxWeight && {
            $lte: parseFloat(req.query.maxWeight as string),
          }),
        };
      }


      if (req.query.minVolume || req.query.maxVolume) {
        matchStage.volume = {
          ...(req.query.minVolume && {
            $gte: parseFloat(req.query.minVolume as string),
          }),
          ...(req.query.maxVolume && {
            $lte: parseFloat(req.query.maxVolume as string),
          }),
        };
      }


      if (req.query.minLength || req.query.maxLength) {
        matchStage["dimensions.length"] = {
          ...(req.query.minLength && {
            $gte: parseFloat(req.query.minLength as string),
          }),
          ...(req.query.maxLength && {
            $lte: parseFloat(req.query.maxLength as string),
          }),
        };
      }


      if (req.query.minWidth || req.query.maxWidth) {
        matchStage["dimensions.width"] = {
          ...(req.query.minWidth && {
            $gte: parseFloat(req.query.minWidth as string),
          }),
          ...(req.query.maxWidth && {
            $lte: parseFloat(req.query.maxWidth as string),
          }),
        };
      }


      if (req.query.minHeight || req.query.maxHeight) {
        matchStage["dimensions.height"] = {
          ...(req.query.minHeight && {
            $gte: parseFloat(req.query.minHeight as string),
          }),
          ...(req.query.maxHeight && {
            $lte: parseFloat(req.query.maxHeight as string),
          }),
        };
      }


      if (req.query.city) {
        matchStage["destination.city"] = new RegExp(
          req.query.city as string,
          "i",
        );
      }

      if (req.query.state) {
        matchStage["destination.state"] = new RegExp(
          req.query.state as string,
          "i",
        );
      }


      if (req.query.originBranchId) {

        if (!mongoose.Types.ObjectId.isValid(req.query.originBranchId as string)) {
          return next(new ErrorHandler("Invalid originBranchId.", 400));
        }
        matchStage.originBranchId = new mongoose.Types.ObjectId(
          req.query.originBranchId as string,
        );
      }

      if (req.query.currentBranchId) {
        if (!mongoose.Types.ObjectId.isValid(req.query.currentBranchId as string)) {
          return next(new ErrorHandler("Invalid currentBranchId.", 400));
        }
        matchStage.currentBranchId = new mongoose.Types.ObjectId(
          req.query.currentBranchId as string,
        );
      }


      if (req.query.assignedDelivererId) {
        if (!mongoose.Types.ObjectId.isValid(req.query.assignedDelivererId as string)) {
          return next(new ErrorHandler("Invalid assignedDelivererId.", 400));
        }
        matchStage.assignedDelivererId = new mongoose.Types.ObjectId(
          req.query.assignedDelivererId as string,
        );
      }


      const pipeline: any[] = [


        { $match: matchStage },


        {
          $addFields: {
            _estimatedTimeRemaining: {
              $cond: {
                if: {
                  $and: [
                    { $ifNull: ["$estimatedDeliveryTime", false] },
                    { $ne: ["$status", "delivered"] },
                  ],
                },
                then: {
                  $max: [
                    0,
                    {
                      $round: [
                        {
                          $divide: [
                            {
                              $subtract: [
                                "$estimatedDeliveryTime",
                                new Date(),
                              ],
                            },
                            3600000,
                          ],
                        },
                        0,
                      ],
                    },
                  ],
                },
                else: null,
              },
            },


            _isOverdue: {
              $cond: {
                if: {
                  $and: [
                    { $ifNull: ["$estimatedDeliveryTime", false] },
                    { $ne: ["$status", "delivered"] },
                    { $lt: ["$estimatedDeliveryTime", new Date()] },
                  ],
                },
                then: true,
                else: false,
              },
            },
          },
        },


        ...(req.query.isOverdue !== undefined
          ? [
            {
              $match: {
                _isOverdue: req.query.isOverdue === "true",
              },
            },
          ]
          : []),


        ...(rawSearch
          ? [
            {
              $match: {
                $or: [

                  {
                    trackingNumber: {
                      $regex: rawSearch,
                      $options: "i",
                    },
                  },

                  {
                    "destination.recipientName": {
                      $regex: rawSearch,
                      $options: "i",
                    },
                  },

                  {
                    "destination.recipientPhone": {
                      $regex: rawSearch,
                      $options: "i",
                    },
                  },

                  {
                    "destination.alternativePhone": {
                      $regex: rawSearch,
                      $options: "i",
                    },
                  },
                ],
              },
            },


            {
              $addFields: {
                _searchScore: {
                  $add: [

                    {
                      $cond: [
                        {
                          $regexMatch: {
                            input: "$trackingNumber",
                            regex: `^${rawSearch}$`,
                            options: "i",
                          },
                        },
                        10,
                        0,
                      ],
                    },

                    {
                      $cond: [
                        {
                          $regexMatch: {
                            input: "$trackingNumber",
                            regex: `^${rawSearch}`,
                            options: "i",
                          },
                        },
                        5,
                        0,
                      ],
                    },

                    {
                      $cond: [
                        {
                          $regexMatch: {
                            input: { $toLower: "$destination.recipientName" },
                            regex: `^${rawSearch.toLowerCase()}`,
                          },
                        },
                        3,
                        0,
                      ],
                    },
                  ],
                },
              },
            },
          ]
          : [

            { $addFields: { _searchScore: 0 } },
          ]),

        // sort
        //    Primary:   search relevance (desc)
        //    Secondary: estimatedTimeRemaining ASC
        //               → packages expiring soonest bubble to the top
        //               → null (delivered / no estimate) sink to the bottom
        {
          $sort: {
            _searchScore: -1,
            _estimatedTimeRemaining: 1,
            createdAt: -1,
          },
        },


        {
          $facet: {
            metadata: [{ $count: "total" }],
            data: [
              { $skip: skip },
              { $limit: limit },

              {
                $project: {
                  _estimatedTimeRemaining: 0,
                  _isOverdue: 0,
                  _searchScore: 0,
                },
              },
            ],
          },
        },
      ];


      const [result] = await PackageModel.aggregate(pipeline);

      const total: number = result.metadata[0]?.total ?? 0;
      const packages: any[] = result.data ?? [];


      const formattedPackages = packages.map((pkg) => ({
        id: pkg._id,
        trackingNumber: pkg.trackingNumber,
        status: pkg.status,
        type: pkg.type,
        isFragile: pkg.isFragile,


        senderId: pkg.senderId,
        senderType: pkg.senderType,
        clientId: pkg.clientId ?? null,


        weight: pkg.weight,
        volume: pkg.volume ?? null,
        dimensions: pkg.dimensions ?? null,


        destination: {
          recipientName: pkg.destination.recipientName,
          recipientPhone: pkg.destination.recipientPhone,
          alternativePhone: pkg.destination.alternativePhone ?? null,
          address: pkg.destination.address,
          city: pkg.destination.city,
          state: pkg.destination.state,
          postalCode: pkg.destination.postalCode ?? null,
          notes: pkg.destination.notes ?? null,

          coordinates: pkg.deliveryType === "home" && pkg.destination.location?.coordinates
            ? {
              type: pkg.destination.location.type || "Point",
              coordinates: pkg.destination.location.coordinates,
            }
            : null,
        },

        description: pkg.description ?? null,
        deliveryType: pkg.deliveryType,
        deliveryPriority: pkg.deliveryPriority,
        estimatedDeliveryTime: pkg.estimatedDeliveryTime ?? null,

        totalPrice: pkg.totalPrice,
        paymentStatus: pkg.paymentStatus,
        paymentMethod: pkg.paymentMethod ?? null,


        assignedDelivererId: pkg.assignedDelivererId ?? null,
        assignedTransporterId: pkg.assignedTransporterId ?? null,
        assignedVehicleId: pkg.assignedVehicleId ?? null,


        attemptCount: pkg.attemptCount,
        maxAttempts: pkg.maxAttempts,
        nextAttemptDate: pkg.nextAttemptDate ?? null,


        returnInfo: pkg.returnInfo,


        unresolvedIssuesCount: (pkg.issues as any[]).filter(
          (i) => !i.resolved,
        ).length,


        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
        deliveredAt: pkg.deliveredAt ?? null,
      }));

      res.status(200).json({
        success: true,
        data: {
          packages: formattedPackages,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
          hasMore: total > skip + limit,
          query: rawSearch || null,
        },
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400,
          ),
        );
      }
      return next(new ErrorHandler(error.message || "Error searching packages.", 500));
    }
  },
);




export const getPackagesPaginated = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit as string) || 20),
      );
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;

      const filter: Record<string, any> = {};

      const toObjectId = (val: string) => new mongoose.Types.ObjectId(val);
      const isValidId = (val: string) => mongoose.Types.ObjectId.isValid(val);


      const user = (req as any).user;
      const userRole = user?.role;
      const userId = user?._id;

      let assignedDelivererId: mongoose.Types.ObjectId | null = null;


      if (req.query.companyId) {
        if (!isValidId(req.query.companyId as string))
          return next(new ErrorHandler("Invalid companyId.", 400));
        filter.companyId = toObjectId(req.query.companyId as string);
      }


      if (userRole === 'deliverer') {

        const deliverer = await DelivererModel.findOne({ userId: userId });
        if (!deliverer) {
          return next(new ErrorHandler("Deliverer profile not found.", 404));
        }


        filter.assignedDelivererId = deliverer._id;
        assignedDelivererId = deliverer._id;
      }


      if (req.query.assignedDelivererId && userRole !== 'deliverer') {
        if (!isValidId(req.query.assignedDelivererId as string))
          return next(new ErrorHandler("Invalid assignedDelivererId.", 400));
        assignedDelivererId = toObjectId(req.query.assignedDelivererId as string);
        filter.assignedDelivererId = assignedDelivererId;
      }


      if (req.query.clientId) {
        if (!isValidId(req.query.clientId as string))
          return next(new ErrorHandler("Invalid clientId.", 400));
        filter.clientId = toObjectId(req.query.clientId as string);
      }

      if (req.query.originBranchId) {
        if (!isValidId(req.query.originBranchId as string))
          return next(new ErrorHandler("Invalid originBranchId.", 400));
        filter.originBranchId = toObjectId(req.query.originBranchId as string);
      }

      if (req.query.currentBranchId) {
        if (!isValidId(req.query.currentBranchId as string))
          return next(new ErrorHandler("Invalid currentBranchId.", 400));
        filter.currentBranchId = toObjectId(req.query.currentBranchId as string);
      }


      const VALID_STATUSES: PackageStatus[] = [
        "pending", "accepted", "at_origin_branch", "in_transit_to_branch",
        "at_destination_branch", "out_for_delivery", "delivered",
        "failed_delivery", "failed_delivery_attempt", "rescheduled", "returned", "cancelled",
        "lost", "damaged", "on_hold",
      ];
      if (req.query.status) {
        const s = req.query.status as string;
        if (!VALID_STATUSES.includes(s as PackageStatus))
          return next(new ErrorHandler(`Invalid status: ${s}.`, 400));
        filter.status = s;
      }


      const VALID_TYPES: PackageType[] = [
        "document", "parcel", "fragile", "heavy",
        "perishable", "electronic", "clothing",
      ];
      if (req.query.type) {
        const t = req.query.type as string;
        if (!VALID_TYPES.includes(t as PackageType))
          return next(new ErrorHandler(`Invalid package type: ${t}.`, 400));
        filter.type = t;
      }


      const VALID_PAYMENT_STATUSES: PaymentStatus[] = [
        "pending", "paid", "partially_paid", "refunded", "failed",
      ];
      if (req.query.paymentStatus && req.query.paymentStatus !== "") {
        const ps = req.query.paymentStatus as string;
        if (!VALID_PAYMENT_STATUSES.includes(ps as PaymentStatus))
          return next(new ErrorHandler(`Invalid paymentStatus: ${ps}.`, 400));
        filter.paymentStatus = ps;
      }


      const VALID_PRIORITIES = ["standard", "express", "same_day"];
      if (req.query.deliveryPriority && req.query.deliveryPriority !== "") {
        const dp = req.query.deliveryPriority as string;
        if (!VALID_PRIORITIES.includes(dp))
          return next(new ErrorHandler(`Invalid deliveryPriority: ${dp}.`, 400));
        filter.deliveryPriority = dp;
      }


      const VALID_DELIVERY_TYPES: DeliveryType[] = ["home", "branch_pickup"];
      if (req.query.deliveryType) {
        const dt = req.query.deliveryType as string;
        if (!VALID_DELIVERY_TYPES.includes(dt as DeliveryType))
          return next(new ErrorHandler(`Invalid deliveryType: ${dt}.`, 400));
        filter.deliveryType = dt;
      }


      if (req.query.isFragile !== undefined && req.query.isFragile !== "") {
        filter.isFragile = req.query.isFragile === "true";
      }

      if (req.query.isReturn !== undefined) {
        filter["returnInfo.isReturn"] = req.query.isReturn === "true";
      }

      if (req.query.hasIssues !== undefined) {
        filter.issues =
          req.query.hasIssues === "true"
            ? { $elemMatch: { resolved: false } }
            : { $not: { $elemMatch: { resolved: false } } };
      }


      const applyRange = (
        field: string,
        minKey: string,
        maxKey: string,
      ) => {
        const min = req.query[minKey]
          ? parseFloat(req.query[minKey] as string)
          : null;
        const max = req.query[maxKey]
          ? parseFloat(req.query[maxKey] as string)
          : null;
        if (min !== null || max !== null) {
          filter[field] = {
            ...(min !== null && !isNaN(min) && { $gte: min }),
            ...(max !== null && !isNaN(max) && { $lte: max }),
          };
        }
      };

      applyRange("weight", "minWeight", "maxWeight");
      applyRange("volume", "minVolume", "maxVolume");
      applyRange("dimensions.length", "minLength", "maxLength");
      applyRange("dimensions.width", "minWidth", "maxWidth");
      applyRange("dimensions.height", "minHeight", "maxHeight");


      if (req.query.city) {
        filter["destination.city"] = new RegExp(req.query.city as string, "i");
      }
      if (req.query.state) {
        filter["destination.state"] = new RegExp(req.query.state as string, "i");
      }


      let delivererStats: any = null;
      if (assignedDelivererId) {
        const deliverer = await DelivererModel.findById(assignedDelivererId)
          .lean({ virtuals: true });

        if (deliverer) {

          const packageStats = await PackageModel.aggregate([
            {
              $match: {
                assignedDelivererId: assignedDelivererId,
              },
            },
            {
              $group: {
                _id: null,
                totalPackages: { $sum: 1 },
                deliveredPackages: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "delivered"] }, 1, 0],
                  },
                },
                failedPackages: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          "$status",
                          ["failed_delivery", "failed_delivery_attempt", "cancelled", "returned"],
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                inProgressPackages: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          "$status",
                          ["out_for_delivery", "at_destination_branch"],
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                pendingPackages: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          "$status",
                          ["pending", "accepted", "at_origin_branch", "in_transit_to_branch"],
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                totalCollected: {
                  $sum: {
                    $cond: [
                      { $eq: ["$paymentStatus", "paid"] },
                      "$totalPrice",
                      0,
                    ],
                  },
                },
                totalCOD: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$status", "delivered"] },
                          { $eq: ["$paymentMethod", "cod"] },
                        ],
                      },
                      "$totalPrice",
                      0,
                    ],
                  },
                },
              },
            },
          ]);

          const stats = packageStats[0] || {
            totalPackages: 0,
            deliveredPackages: 0,
            failedPackages: 0,
            inProgressPackages: 0,
            pendingPackages: 0,
            totalCollected: 0,
            totalCOD: 0,
          };

          delivererStats = {
            id: deliverer._id,
            userId: deliverer.userId,
            branchId: deliverer.branchId,
            companyId: deliverer.companyId,
            availabilityStatus: deliverer.availabilityStatus,
            verificationStatus: deliverer.verificationStatus,
            isActive: deliverer.isActive,
            isOnline: deliverer.isOnline,
            isSuspended: deliverer.isSuspended,
            isVerified: deliverer.isVerified,
            isAvailable: deliverer.isAvailable,
            isOnDuty: deliverer.isOnDuty,
            rating: deliverer.rating,
            successRate: deliverer.successRate,
            totalDeliveries: deliverer.totalDeliveries,
            successfulDeliveries: deliverer.successfulDeliveries,
            failedDeliveries: deliverer.failedDeliveries,
            todayDeliveriesCount: deliverer.todayDeliveriesCount,
            todayEarnings: deliverer.todayEarnings,
            todayCollectedAmount: deliverer.todayCollectedAmount,
            commission: deliverer.commission,
            totalEarnings: deliverer.totalEarnings,
            pendingBranchReturn: deliverer.pendingBranchReturn,
            performance: {
              averageDeliveryTime: deliverer.performance?.averageDeliveryTime ?? 0,
              onTimeDeliveryRate: deliverer.performance?.onTimeDeliveryRate ?? 0,
              customerSatisfaction: deliverer.performance?.customerSatisfaction ?? 0,
              totalDistanceCovered: deliverer.performance?.totalDistanceCovered ?? 0,
            },
            packageStats: {
              totalAssigned: stats.totalPackages,
              delivered: stats.deliveredPackages,
              failed: stats.failedPackages,
              inProgress: stats.inProgressPackages,
              pending: stats.pendingPackages,
              totalCollected: stats.totalCollected,
              totalCOD: stats.totalCOD,
            },
            documentStatus: deliverer.documentStatus,
            hasValidLicense: deliverer.hasValidLicense,
            canAcceptDeliveries: deliverer.canAcceptDeliveries,
            currentVehicleId: deliverer.currentVehicleId ?? null,
            currentRouteId: deliverer.currentRouteId ?? null,
            suspensionReason: deliverer.suspensionReason ?? null,
            lastActiveAt: deliverer.lastActiveAt,
          };
        }
      }


      const [total, packages] = await Promise.all([
        PackageModel.countDocuments(filter),
        PackageModel.find(filter)
          .skip(skip)
          .limit(limit)
          .sort({ createdAt: -1 })
          .lean({ virtuals: true }),
      ]);


      let filteredPackages = packages as any[];
      if (req.query.isOverdue !== undefined) {
        const wantOverdue = req.query.isOverdue === "true";
        filteredPackages = filteredPackages.filter((pkg) => pkg.isOverdue === wantOverdue);
      }


      const sortBy = (req.query.sortBy as string) || "createdAt";
      const order = req.query.order === "desc" ? -1 : 1;

      switch (sortBy) {
        case "estimatedTimeRemaining":
          filteredPackages.sort((a, b) => {
            const aVal = a.estimatedTimeRemaining ?? Infinity;
            const bVal = b.estimatedTimeRemaining ?? Infinity;
            return (aVal - bVal) * order;
          });
          break;
        case "weight":
          filteredPackages.sort((a, b) => (a.weight - b.weight) * order);
          break;
        case "totalPrice":
          filteredPackages.sort((a, b) => (a.totalPrice - b.totalPrice) * order);
          break;
        case "createdAt":
          filteredPackages.sort(
            (a, b) =>
              (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * order,
          );
          break;
        case "attemptCount":
          filteredPackages.sort((a, b) => (a.attemptCount - b.attemptCount) * order);
          break;
        default:
          if (order === -1) filteredPackages.reverse();
      }


      const formattedPackages = filteredPackages.map((pkg) => ({
        id: pkg._id,
        trackingNumber: pkg.trackingNumber,
        status: pkg.status,
        type: pkg.type,
        isFragile: pkg.isFragile,
        senderId: pkg.senderId,
        senderType: pkg.senderType,
        clientId: pkg.clientId ?? null,
        weight: pkg.weight,
        volume: pkg.volume ?? null,
        dimensions: pkg.dimensions ?? null,
        destination: {
          recipientName: pkg.destination.recipientName,
          recipientPhone: pkg.destination.recipientPhone,
          alternativePhone: pkg.destination.alternativePhone ?? null,
          address: pkg.destination.address,
          city: pkg.destination.city,
          state: pkg.destination.state,
          postalCode: pkg.destination.postalCode ?? null,
          notes: pkg.destination.notes ?? null,
          coordinates: pkg.deliveryType === "home" && pkg.destination.location?.coordinates
            ? {
              type: pkg.destination.location.type || "Point",
              coordinates: pkg.destination.location.coordinates,
            }
            : null,
        },
        deliveryType: pkg.deliveryType,
        deliveryPriority: pkg.deliveryPriority,
        estimatedDeliveryTime: pkg.estimatedDeliveryTime ?? null,
        estimatedTimeRemaining: pkg.estimatedTimeRemaining ?? null,
        isOverdue: pkg.isOverdue,
        deliveryProgress: pkg.deliveryProgress,
        canBeDelivered: pkg.canBeDelivered,
        needsAttention: pkg.needsAttention,
        isInTransit: pkg.isInTransit,
        isAtBranch: pkg.isAtBranch,
        totalPrice: pkg.totalPrice,
        paymentStatus: pkg.paymentStatus,
        paymentMethod: pkg.paymentMethod ?? null,
        paidAt: pkg.paidAt ?? null,
        assignedDelivererId: pkg.assignedDelivererId ?? null,
        assignedVehicleId: pkg.assignedVehicleId ?? null,
        attemptCount: pkg.attemptCount,
        maxAttempts: pkg.maxAttempts,
        lastAttemptDate: pkg.lastAttemptDate ?? null,
        nextAttemptDate: pkg.nextAttemptDate ?? null,
        returnInfo: pkg.returnInfo,
        unresolvedIssuesCount: (pkg.issues as IIssue[]).filter(
          (i) => !i.resolved,
        ).length,
        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
        deliveredAt: pkg.deliveredAt ?? null,
      }));


      const responseData: any = {
        packages: formattedPackages,
        pagination: {
          total: filteredPackages.length,
          page,
          limit,
          pages: Math.ceil(filteredPackages.length / limit),
          hasMore: filteredPackages.length > skip + limit,
        },
        filters: {
          status: req.query.status ?? null,
          type: req.query.type ?? null,
          paymentStatus: req.query.paymentStatus ?? null,
          deliveryPriority: req.query.deliveryPriority ?? null,
          deliveryType: req.query.deliveryType ?? null,
          isFragile: req.query.isFragile ?? null,
          isOverdue: req.query.isOverdue ?? null,
          isReturn: req.query.isReturn ?? null,
          hasIssues: req.query.hasIssues ?? null,
          minWeight: req.query.minWeight ?? null,
          maxWeight: req.query.maxWeight ?? null,
          minVolume: req.query.minVolume ?? null,
          maxVolume: req.query.maxVolume ?? null,
          minLength: req.query.minLength ?? null,
          maxLength: req.query.maxLength ?? null,
          minWidth: req.query.minWidth ?? null,
          maxWidth: req.query.maxWidth ?? null,
          minHeight: req.query.minHeight ?? null,
          maxHeight: req.query.maxHeight ?? null,
          city: req.query.city ?? null,
          state: req.query.state ?? null,
          clientId: req.query.clientId ?? null,
          companyId: req.query.companyId ?? null,
          originBranchId: req.query.originBranchId ?? null,
          currentBranchId: req.query.currentBranchId ?? null,
          assignedDelivererId: req.query.assignedDelivererId ?? null,
          sortBy: sortBy,
          order: req.query.order ?? "asc",
        },
      };


      if (delivererStats) {
        responseData.delivererStats = delivererStats;
      }

      res.status(200).json({
        success: true,
        data: responseData,
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400,
          ),
        );
      }
      return next(
        new ErrorHandler(error.message || "Error fetching packages.", 500),
      );
    }
  },
);




export const toggleOnlineStatus = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const role = req.user?.role;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!role || (role !== "transporter" && role !== "deliverer")) {
      return next(
        new ErrorHandler(
          "Only transporter or deliverer can access this functionality",
          403,
        ),
      );
    }

    if (role === "transporter") {
      const transporter = await TransporterModel.findOne({ userId });
      if (!transporter) {
        return next(new ErrorHandler("Transporter profile not found.", 404));
      }

      transporter.isOnline = !transporter.isOnline;
      transporter.lastActiveAt = new Date();
      await transporter.save();

      return res.status(200).json({
        success: true,
        message: `Transporter is now ${transporter.isOnline ? "online" : "offline"}`,
        isOnline: transporter.isOnline,
      });
    }

    const deliverer = await DelivererModel.findOne({ userId });
    if (!deliverer) {
      return next(new ErrorHandler("Deliverer profile not found.", 404));
    }

    deliverer.isOnline = !deliverer.isOnline;
    deliverer.lastActiveAt = new Date();
    await deliverer.save();

    return res.status(200).json({
      success: true,
      message: `Deliverer is now ${deliverer.isOnline ? "online" : "offline"}`,
      isOnline: deliverer.isOnline,
    });
  },
);





async function resolveDelivererId(
  userId: mongoose.Types.ObjectId,
  next: NextFunction,
): Promise<mongoose.Types.ObjectId | null> {
  const deliverer = await DelivererModel.findOne({ userId }).select("_id").lean();
  if (!deliverer) {
    next(new ErrorHandler("Deliverer profile not found for this user.", 404));
    return null;
  }
  return deliverer._id as mongoose.Types.ObjectId;
}




export const getMyDeliveries = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {

    if (!req.user?._id) {
      return next(new ErrorHandler("Authentication required.", 401));
    }

    const userId = req.user._id;
    const delivererId = await resolveDelivererId(userId, next);
    if (!delivererId) return;

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const skip = (page - 1) * limit;

    const rawSearch = (req.query.q as string)?.trim() ?? "";

    const matchStage: Record<string, any> = {
      assignedDelivererId: delivererId,
    };

    const VALID_STATUSES: PackageStatus[] = [
      "pending", "accepted", "at_origin_branch", "in_transit_to_branch",
      "at_destination_branch", "out_for_delivery", "delivered",
      "failed_delivery", "failed_delivery_attempt", "rescheduled",
      "returned", "cancelled", "lost", "damaged", "on_hold",
    ];

    const FAILED_STATUS_GROUP = ["failed_delivery", "cancelled", "returned"];

    if (req.query.status) {
      const s = req.query.status as string;


      if (s.toLowerCase() === "failed") {
        matchStage.status = { $in: FAILED_STATUS_GROUP };
      } else {

        if (!VALID_STATUSES.includes(s as PackageStatus)) {
          return next(new ErrorHandler(`Invalid status: ${s}`, 400));
        }
        matchStage.status = s;
      }
    }


    if (req.query.statuses) {
      const rawStatuses = (req.query.statuses as string).split(",").map(s => s.trim());
      const expandedStatuses: string[] = [];

      for (const status of rawStatuses) {
        if (status.toLowerCase() === "failed") {
          expandedStatuses.push(...FAILED_STATUS_GROUP);
        } else {
          if (!VALID_STATUSES.includes(status as PackageStatus)) {
            return next(new ErrorHandler(`Invalid status: ${status}`, 400));
          }
          expandedStatuses.push(status);
        }
      }


      const uniqueStatuses = [...new Set(expandedStatuses)];
      matchStage.status = uniqueStatuses.length === 1 ? uniqueStatuses[0] : { $in: uniqueStatuses };
    }

    const VALID_DELIVERY_TYPES: DeliveryType[] = ["home", "branch_pickup"];

    if (req.query.deliveryType) {
      const dt = req.query.deliveryType as string;
      if (!VALID_DELIVERY_TYPES.includes(dt as DeliveryType)) {
        return next(new ErrorHandler(`Invalid deliveryType: ${dt}`, 400));
      }
      matchStage.deliveryType = dt;
    }

    const VALID_PAYMENT_STATUSES: PaymentStatus[] = [
      "pending", "paid", "partially_paid", "refunded", "failed",
    ];

    if (req.query.paymentStatus) {
      const ps = req.query.paymentStatus as string;
      if (!VALID_PAYMENT_STATUSES.includes(ps as PaymentStatus)) {
        return next(new ErrorHandler(`Invalid paymentStatus: ${ps}`, 400));
      }
      matchStage.paymentStatus = ps;
    }

    const VALID_PRIORITIES = ["standard", "express", "same_day"];

    if (req.query.deliveryPriority) {
      const dp = req.query.deliveryPriority as string;
      if (!VALID_PRIORITIES.includes(dp)) {
        return next(new ErrorHandler(`Invalid deliveryPriority: ${dp}`, 400));
      }
      matchStage.deliveryPriority = dp;
    }

    if (req.query.hasIssues !== undefined) {
      if (req.query.hasIssues === "true") {
        matchStage.issues = { $elemMatch: { resolved: false } };
      } else {
        matchStage.issues = { $not: { $elemMatch: { resolved: false } } };
      }
    }

    if (req.query.needsAttention === "true") {
      matchStage.status = {
        $in: ["failed_delivery", "failed_delivery_attempt", "damaged", "lost", "on_hold"],
      };
    }

    if (req.query.city) {
      matchStage["destination.city"] = new RegExp(req.query.city as string, "i");
    }
    if (req.query.state) {
      matchStage["destination.state"] = new RegExp(req.query.state as string, "i");
    }

    if (req.query.fromDate || req.query.toDate) {
      matchStage.createdAt = {
        ...(req.query.fromDate && { $gte: new Date(req.query.fromDate as string) }),
        ...(req.query.toDate && { $lte: new Date(req.query.toDate as string) }),
      };
    }

    if (req.query.deliveredFrom || req.query.deliveredTo) {
      matchStage.deliveredAt = {
        ...(req.query.deliveredFrom && { $gte: new Date(req.query.deliveredFrom as string) }),
        ...(req.query.deliveredTo && { $lte: new Date(req.query.deliveredTo as string) }),
      };
    }

    const pipeline: any[] = [

      { $match: matchStage },

      {
        $addFields: {
          _estimatedTimeRemaining: {
            $cond: {
              if: {
                $and: [
                  { $ifNull: ["$estimatedDeliveryTime", false] },
                  { $ne: ["$status", "delivered"] },
                ],
              },
              then: {
                $max: [
                  0,
                  {
                    $round: [
                      {
                        $divide: [
                          { $subtract: ["$estimatedDeliveryTime", new Date()] },
                          3600000,
                        ],
                      },
                      0,
                    ],
                  },
                ],
              },
              else: null,
            },
          },

          _isOverdue: {
            $cond: {
              if: {
                $and: [
                  { $ifNull: ["$estimatedDeliveryTime", false] },
                  { $ne: ["$status", "delivered"] },
                  { $lt: ["$estimatedDeliveryTime", new Date()] },
                ],
              },
              then: true,
              else: false,
            },
          },
        },
      },

      ...(req.query.isOverdue !== undefined
        ? [{ $match: { _isOverdue: req.query.isOverdue === "true" } }]
        : []),

      ...(rawSearch
        ? [
          {
            $match: {
              $or: [
                { trackingNumber: { $regex: rawSearch, $options: "i" } },
                { "destination.recipientName": { $regex: rawSearch, $options: "i" } },
                { "destination.recipientPhone": { $regex: rawSearch, $options: "i" } },
                { "destination.alternativePhone": { $regex: rawSearch, $options: "i" } },
              ],
            },
          },

          {
            $addFields: {
              _searchScore: {
                $add: [
                  {
                    $cond: [
                      { $regexMatch: { input: "$trackingNumber", regex: `^${rawSearch}$`, options: "i" } },
                      10, 0,
                    ],
                  },
                  {
                    $cond: [
                      { $regexMatch: { input: "$trackingNumber", regex: `^${rawSearch}`, options: "i" } },
                      5, 0,
                    ],
                  },
                  {
                    $cond: [
                      {
                        $regexMatch: {
                          input: { $toLower: "$destination.recipientName" },
                          regex: `^${rawSearch.toLowerCase()}`,
                        },
                      },
                      3, 0,
                    ],
                  },
                ],
              },
            },
          },
        ]
        : [{ $addFields: { _searchScore: 0 } }]),

      {
        $sort: {
          _searchScore: -1,
          _estimatedTimeRemaining: 1,
          createdAt: -1,
        },
      },

      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _estimatedTimeRemaining: 0,
                _isOverdue: 0,
                _searchScore: 0,
                trackingHistory: 0,
              },
            },
          ],
        },
      },
    ];

    const [result] = await PackageModel.aggregate(pipeline);

    const total: number = result.metadata[0]?.total ?? 0;
    const packages: any[] = result.data ?? [];

    const formattedDeliveries = packages.map((pkg) => ({
      id: pkg._id,
      trackingNumber: pkg.trackingNumber,
      status: pkg.status,
      type: pkg.type,
      isFragile: pkg.isFragile,

      destination: {
        recipientName: pkg.destination.recipientName,
        recipientPhone: pkg.destination.recipientPhone,
        alternativePhone: pkg.destination.alternativePhone ?? null,
        address: pkg.destination.address,
        city: pkg.destination.city,
        state: pkg.destination.state,
        postalCode: pkg.destination.postalCode ?? null,
        coordinates: pkg.destination.location?.coordinates ?? null,
        notes: pkg.destination.notes ?? null,
      },

      deliveryType: pkg.deliveryType,
      deliveryPriority: pkg.deliveryPriority,
      estimatedDeliveryTime: pkg.estimatedDeliveryTime ?? null,

      totalPrice: pkg.totalPrice,
      paymentStatus: pkg.paymentStatus,
      paymentMethod: pkg.paymentMethod ?? null,

      attemptCount: pkg.attemptCount,
      maxAttempts: pkg.maxAttempts,
      nextAttemptDate: pkg.nextAttemptDate ?? null,

      isReturn: pkg.returnInfo?.isReturn ?? false,

      unresolvedIssuesCount: (pkg.issues as any[]).filter((i) => !i.resolved).length,

      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
      deliveredAt: pkg.deliveredAt ?? null,
    }));

    res.status(200).json({
      success: true,
      data: {
        deliveries: formattedDeliveries,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: total > skip + limit,
        query: rawSearch || null,
      },
    });
  },
);

export const getMyDeliveryById = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {

    if (!req.user?._id) {
      return next(new ErrorHandler("Authentication required.", 401));
    }


    const { packageId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(packageId.toString())) {
      return next(new ErrorHandler("Invalid package ID.", 400));
    }

    const userId = req.user?._id;
    const delivererId = await resolveDelivererId(userId, next);
    if (!delivererId) return;



    const pkg = await PackageModel.findOne({
      _id: new mongoose.Types.ObjectId(packageId.toString()),
      assignedDelivererId: delivererId,
    }).lean();

    if (!pkg) {
      return next(
        new ErrorHandler(
          "Delivery not found or not assigned to you.",
          404,
        ),
      );
    }


    const detail = {
      id: pkg._id,
      trackingNumber: pkg.trackingNumber,
      status: pkg.status,
      type: pkg.type,
      isFragile: pkg.isFragile,
      description: pkg.description ?? null,
      images: pkg.images ?? [],



      weight: pkg.weight,
      volume: pkg.volume ?? null,
      dimensions: pkg.dimensions ?? null,


      destination: {
        recipientName: pkg.destination.recipientName,
        recipientPhone: pkg.destination.recipientPhone,
        alternativePhone: pkg.destination.alternativePhone ?? null,
        address: pkg.destination.address,
        city: pkg.destination.city,
        state: pkg.destination.state,
        postalCode: pkg.destination.postalCode ?? null,
        coordinates: pkg.destination.location?.coordinates ?? null,
        notes: pkg.destination.notes ?? null,
      },


      deliveryType: pkg.deliveryType,
      deliveryPriority: pkg.deliveryPriority,
      estimatedDeliveryTime: pkg.estimatedDeliveryTime ?? null,
      destinationBranchId: pkg.destinationBranchId ?? null,


      totalPrice: pkg.totalPrice,
      paymentStatus: pkg.paymentStatus,
      paymentMethod: pkg.paymentMethod ?? null,
      paidAt: pkg.paidAt ?? null,


      assignedDelivererId: pkg.assignedDelivererId,
      assignedTransporterId: pkg.assignedTransporterId ?? null,
      assignedVehicleId: pkg.assignedVehicleId ?? null,
      currentRouteId: pkg.currentRouteId ?? null,


      attemptCount: pkg.attemptCount,
      maxAttempts: pkg.maxAttempts,
      lastAttemptDate: pkg.lastAttemptDate ?? null,
      nextAttemptDate: pkg.nextAttemptDate ?? null,


      returnInfo: {
        isReturn: pkg.returnInfo?.isReturn ?? false,
        reason: pkg.returnInfo?.reason ?? null,
        returnDate: pkg.returnInfo?.returnDate ?? null,
        refundAmount: pkg.returnInfo?.refundAmount ?? null,
        refundStatus: pkg.returnInfo?.refundStatus ?? null,
        returnNotes: pkg.returnInfo?.returnNotes ?? null,
      },


      issues: (pkg.issues ?? []).map((issue: any) => ({
        type: issue.type,
        description: issue.description,
        reportedBy: issue.reportedBy,
        reportedAt: issue.reportedAt,
        resolved: issue.resolved,
        resolvedAt: issue.resolvedAt ?? null,
        resolution: issue.resolution ?? null,
        priority: issue.priority ?? null,
      })),
      unresolvedIssuesCount: (pkg.issues ?? []).filter((i: any) => !i.resolved).length,


      trackingHistory: (pkg.trackingHistory ?? [])
        .slice()
        .sort(
          (a: any, b: any) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        )
        .map((event: any) => ({
          status: event.status,
          location: event.location ?? null,
          branchId: event.branchId ?? null,
          notes: event.notes ?? null,
          timestamp: event.timestamp,
        })),


      deliveryOtp: pkg.deliveryOtp
        ? {
          code: pkg.deliveryOtp.code,
          expiresAt: pkg.deliveryOtp.expiresAt,
          verified: pkg.deliveryOtp.verified,
          verifiedAt: pkg.deliveryOtp.verifiedAt ?? null,
        }
        : null,


      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
      deliveredAt: pkg.deliveredAt ?? null,
    };

    res.status(200).json({
      success: true,
      data: { delivery: detail },
    });
  },
);




export const getManifestsPaginated = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit as string) || 20),
      );
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;

      const filter: Record<string, any> = {};

      const toObjectId = (val: string) => new mongoose.Types.ObjectId(val);
      const isValidId = (val: string) => mongoose.Types.ObjectId.isValid(val);


      if (req.query.companyId) {
        if (!isValidId(req.query.companyId as string))
          return next(new ErrorHandler("Invalid companyId.", 400));
        filter.companyId = toObjectId(req.query.companyId as string);
      }

      if (req.query.originBranchId) {
        if (!isValidId(req.query.originBranchId as string))
          return next(new ErrorHandler("Invalid originBranchId.", 400));
        filter.originBranchId = toObjectId(req.query.originBranchId as string);
      }

      if (req.query.destinationBranchId) {
        if (!isValidId(req.query.destinationBranchId as string))
          return next(new ErrorHandler("Invalid destinationBranchId.", 400));
        filter.destinationBranchId = toObjectId(req.query.destinationBranchId as string);
      }

      if (req.query.branchId) {

        if (!isValidId(req.query.branchId as string))
          return next(new ErrorHandler("Invalid branchId.", 400));
        const branchOid = toObjectId(req.query.branchId as string);
        filter.$or = [
          { originBranchId: branchOid },
          { destinationBranchId: branchOid },
        ];
      }

      if (req.query.createdBy) {
        if (!isValidId(req.query.createdBy as string))
          return next(new ErrorHandler("Invalid createdBy.", 400));
        filter.createdBy = toObjectId(req.query.createdBy as string);
      }


      let transporterId: mongoose.Types.ObjectId | null = null;

      if (req.query.transporterId) {
        if (!isValidId(req.query.transporterId as string))
          return next(new ErrorHandler("Invalid transporterId.", 400));
        transporterId = toObjectId(req.query.transporterId as string);
        filter["transportLeg.transporterId"] = transporterId;
      }

      if (req.query.vehicleId) {
        if (!isValidId(req.query.vehicleId as string))
          return next(new ErrorHandler("Invalid vehicleId.", 400));
        filter["transportLeg.vehicleId"] = toObjectId(req.query.vehicleId as string);
      }


      const VALID_STATUSES: ManifestStatus[] = [
        "open", "sealed", "loaded", "in_transit",
        "arrived", "unloading", "closed", "discrepancy", "cancelled",
      ];

      if (req.query.status) {
        const s = req.query.status as string;
        if (!VALID_STATUSES.includes(s as ManifestStatus))
          return next(new ErrorHandler(`Invalid status: ${s}.`, 400));
        filter.status = s;
      }


      if (req.query.statuses) {
        const statuses = (req.query.statuses as string).split(",").map(s => s.trim());
        const invalid = statuses.filter(s => !VALID_STATUSES.includes(s as ManifestStatus));
        if (invalid.length > 0)
          return next(new ErrorHandler(`Invalid statuses: ${invalid.join(", ")}.`, 400));
        filter.status = { $in: statuses };
      }


      const VALID_PRIORITIES: ManifestPriority[] = ["standard", "express", "urgent"];
      if (req.query.priority) {
        const p = req.query.priority as string;
        if (!VALID_PRIORITIES.includes(p as ManifestPriority))
          return next(new ErrorHandler(`Invalid priority: ${p}.`, 400));
        filter.priority = p;
      }


      if (req.query.manifestCode) {
        filter.manifestCode = new RegExp(req.query.manifestCode as string, "i");
      }

      if (req.query.search) {
        const searchRe = new RegExp(req.query.search as string, "i");
        filter.$or = [
          ...(filter.$or || []),
          { manifestCode: searchRe },
          { internalReference: searchRe },
          { notes: searchRe },
          { "packages.trackingNumber": searchRe },
        ];
      }


      if (req.query.containsPackageId) {
        if (!isValidId(req.query.containsPackageId as string))
          return next(new ErrorHandler("Invalid containsPackageId.", 400));
        filter["packages.packageId"] = toObjectId(req.query.containsPackageId as string);
      }


      if (req.query.hasDiscrepancy !== undefined) {
        if (req.query.hasDiscrepancy === "true") {
          filter.$or = [
            ...(filter.$or || []),
            { status: "discrepancy" },
            { discrepancy: { $ne: null } },
          ];
        } else {
          filter.status = { $nin: ["discrepancy"] };
          filter.discrepancy = null;
        }
      }


      if (req.query.isSealed !== undefined) {
        if (req.query.isSealed === "true") {
          filter.status = { $in: ["sealed", "loaded", "in_transit", "arrived", "unloading", "closed"] };
        } else {
          filter.status = { $in: ["open", "cancelled"] };
        }
      }


      if (req.query.isInTransit !== undefined) {
        filter.status = req.query.isInTransit === "true" ? "in_transit" : { $ne: "in_transit" };
      }



      if (req.query.minWeight || req.query.maxWeight) {
        const min = req.query.minWeight ? parseFloat(req.query.minWeight as string) : null;
        const max = req.query.maxWeight ? parseFloat(req.query.maxWeight as string) : null;
        filter.totalDeclaredWeight = {
          ...(min !== null && !isNaN(min) && { $gte: min }),
          ...(max !== null && !isNaN(max) && { $lte: max }),
        };
      }


      if (req.query.minPackageCount || req.query.maxPackageCount) {
        const min = req.query.minPackageCount ? parseInt(req.query.minPackageCount as string) : null;
        const max = req.query.maxPackageCount ? parseInt(req.query.maxPackageCount as string) : null;
        filter.packageCount = {
          ...(min !== null && !isNaN(min) && { $gte: min }),
          ...(max !== null && !isNaN(max) && { $lte: max }),
        };
      }


      if (req.query.createdFrom || req.query.createdTo) {
        filter.createdAt = {
          ...(req.query.createdFrom && { $gte: new Date(req.query.createdFrom as string) }),
          ...(req.query.createdTo && { $lte: new Date(req.query.createdTo as string) }),
        };
      }

      if (req.query.departedFrom || req.query.departedTo) {
        filter.departedAt = {
          ...(req.query.departedFrom && { $gte: new Date(req.query.departedFrom as string) }),
          ...(req.query.departedTo && { $lte: new Date(req.query.departedTo as string) }),
        };
      }

      if (req.query.arrivedFrom || req.query.arrivedTo) {
        filter.arrivedAt = {
          ...(req.query.arrivedFrom && { $gte: new Date(req.query.arrivedFrom as string) }),
          ...(req.query.arrivedTo && { $lte: new Date(req.query.arrivedTo as string) }),
        };
      }


      let transporterStats: any = null;
      if (transporterId) {
        const transporter = await TransporterModel.findById(transporterId)
          .lean({ virtuals: true });

        if (transporter) {

          const manifestStats = await ManifestModel.aggregate([
            {
              $match: {
                "transportLeg.transporterId": transporterId,
              },
            },
            {
              $group: {
                _id: null,
                totalManifests: { $sum: 1 },
                inTransitManifests: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "in_transit"] }, 1, 0],
                  },
                },
                arrivedManifests: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "arrived"] }, 1, 0],
                  },
                },
                closedManifests: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "closed"] }, 1, 0],
                  },
                },
                discrepancyManifests: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "discrepancy"] }, 1, 0],
                  },
                },
                loadedManifests: {
                  $sum: {
                    $cond: [{ $in: ["$status", ["sealed", "loaded"]] }, 1, 0],
                  },
                },
                totalPackagesTransported: {
                  $sum: "$packageCount",
                },
                totalWeightTransported: {
                  $sum: "$totalDeclaredWeight",
                },

                todayManifests: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ["$departedAt", new Date(new Date().setHours(0, 0, 0, 0))] },
                          { $lt: ["$departedAt", new Date(new Date().setHours(23, 59, 59, 999))] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ]);

          const stats = manifestStats[0] || {
            totalManifests: 0,
            inTransitManifests: 0,
            arrivedManifests: 0,
            closedManifests: 0,
            discrepancyManifests: 0,
            loadedManifests: 0,
            totalPackagesTransported: 0,
            totalWeightTransported: 0,
            todayManifests: 0,
          };

          transporterStats = {

            id: transporter._id,
            userId: transporter.userId,
            companyId: transporter.companyId,


            transporterType: transporter.transporterType ?? null,
            isHubTransporter: transporter.isHubTransporter,
            isHubToHub: transporter.isHubToHub,
            isHubToBranch: transporter.isHubToBranch,
            assignedLine: transporter.assignedLine ?? null,
            assignedBranches: transporter.assignedBranches ?? null,


            availabilityStatus: transporter.availabilityStatus,
            verificationStatus: transporter.verificationStatus,
            isActive: transporter.isActive,
            isOnline: transporter.isOnline,
            isSuspended: transporter.isSuspended,
            isVerified: transporter.isVerified,
            isAvailable: transporter.isAvailable,
            isOnDuty: transporter.isOnDuty,


            rating: transporter.rating,
            completionRate: transporter.completionRate,
            todayCompletionRate: transporter.todayCompletionRate,
            efficiencyScore: transporter.efficiencyScore,


            totalTrips: transporter.totalTrips,
            completedTrips: transporter.completedTrips,
            cancelledTrips: transporter.cancelledTrips,


            totalManifestsTransported: transporter.totalManifestsTransported,
            currentActiveManifests: transporter.currentActiveManifests,


            todayTransportedCount: transporter.todayTransportedCount,
            todayAssignedManifests: transporter.todayAssignedManifests,
            todayCompletedTrips: transporter.todayCompletedTrips,
            todayTotalWeight: transporter.todayTotalWeight,


            totalDistance: transporter.totalDistance,
            totalDeliveryTime: transporter.totalDeliveryTime,
            averageDeliveryTime: transporter.averageDeliveryTime,


            manifestStats: {
              totalAssigned: stats.totalManifests,
              loaded: stats.loadedManifests,
              inTransit: stats.inTransitManifests,
              arrived: stats.arrivedManifests,
              closed: stats.closedManifests,
              discrepancy: stats.discrepancyManifests,
              totalPackagesTransported: stats.totalPackagesTransported,
              totalWeightTransported: stats.totalWeightTransported,
              todayManifests: stats.todayManifests,
            },


            documentStatus: transporter.documentStatus,
            hasValidLicense: transporter.hasValidLicense,
            canAcceptJobs: transporter.canAcceptJobs,


            currentBranchId: transporter.currentBranchId ?? null,
            currentVehicleId: transporter.currentVehicleId ?? null,
            currentRouteId: transporter.currentRouteId ?? null,


            suspensionReason: transporter.suspensionReason ?? null,
            suspensionEndDate: transporter.suspensionEndDate ?? null,
            lastActiveAt: transporter.lastActiveAt,
            createdAt: transporter.createdAt,
            updatedAt: transporter.updatedAt,
          };
        }
      }

      const sortBy = (req.query.sortBy as string) || "createdAt";
      const order = req.query.order === "asc" ? 1 : -1;

      const sortMap: Record<string, any> = {
        createdAt: { createdAt: order },
        updatedAt: { updatedAt: order },
        totalDeclaredWeight: { totalDeclaredWeight: order },
        packageCount: { packageCount: order },
        manifestCode: { manifestCode: order },
        departedAt: { departedAt: order },
        arrivedAt: { arrivedAt: order },
        status: { status: order },
        priority: { priority: order },
      };

      const sort = sortMap[sortBy] || { createdAt: -1 };


      const [total, manifests] = await Promise.all([
        ManifestModel.countDocuments(filter),
        ManifestModel.find(filter)
          .populate("originBranchId", "name code address.city")
          .populate("destinationBranchId", "name code address.city")
          .populate("createdBy", "name email")
          .populate("transportLeg.transporterId", "name email phone")
          .populate("transportLeg.vehicleId", "registrationNumber type")
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean({ virtuals: true }),
      ]);



      const formattedManifests = manifests.map((m: any) => ({
        id: m._id,
        manifestCode: m.manifestCode,
        companyId: m.companyId,
        originBranch: m.originBranchId
          ? {
            id: m.originBranchId._id,
            name: m.originBranchId.name,
            code: m.originBranchId.code,
            city: m.originBranchId.address?.city,
          }
          : null,
        destinationBranch: m.destinationBranchId
          ? {
            id: m.destinationBranchId._id,
            name: m.destinationBranchId.name,
            code: m.destinationBranchId.code,
            city: m.destinationBranchId.address?.city,
            coordinates: m.destinationBranchId.location?.coordinates,
          }
          : null,
        status: m.status,
        priority: m.priority,
        createdBy: m.createdBy
          ? { id: m.createdBy._id, name: m.createdBy.name, email: m.createdBy.email }
          : null,
        sealInfo: m.sealInfo
          ? {
            sealedBy: m.sealInfo.sealedBy,
            sealedAt: m.sealInfo.sealedAt,
            sealNumber: m.sealInfo.sealNumber,
            totalWeight: m.sealInfo.totalWeight,
            packageCount: m.sealInfo.packageCount,
            notes: m.sealInfo.notes ?? null,
          }
          : null,
        transportLeg: m.transportLeg
          ? {
            vehicle: m.transportLeg.vehicleId
              ? {
                id: m.transportLeg.vehicleId._id,
                registrationNumber: m.transportLeg.vehicleId.registrationNumber,
                type: m.transportLeg.vehicleId.type,
              }
              : null,
            transporter: m.transportLeg.transporterId
              ? {
                id: m.transportLeg.transporterId._id,
                name: m.transportLeg.transporterId.name,
                email: m.transportLeg.transporterId.email,
                phone: m.transportLeg.transporterId.phone,
              }
              : null,
            assignedAt: m.transportLeg.assignedAt,
            departedAt: m.transportLeg.departedAt ?? null,
            arrivedAt: m.transportLeg.arrivedAt ?? null,
            estimatedArrival: m.transportLeg.estimatedArrival ?? null,
          }
          : null,
        totalDeclaredWeight: m.totalDeclaredWeight,
        packageCount: m.packageCount,
        packages: (m.packages || []).map((p: any) => ({
          packageId: p.packageId,
          trackingNumber: p.trackingNumber,
          weight: p.weight,
          sequence: p.sequence,
          entryStatus: p.entryStatus,
          scannedInAt: p.scannedInAt,
          scannedOutAt: p.scannedOutAt ?? null,
          remanifestId: p.remanifestId ?? null,
          notes: p.notes ?? null,
        })),
        hasDiscrepancy: m.hasDiscrepancy,
        discrepancy: m.discrepancy
          ? {
            reportedBy: m.discrepancy.reportedBy,
            reportedAt: m.discrepancy.reportedAt,
            expectedCount: m.discrepancy.expectedCount,
            actualCount: m.discrepancy.actualCount,
            missingPackageIds: m.discrepancy.missingPackageIds,
            extraPackageIds: m.discrepancy.extraPackageIds,
            notes: m.discrepancy.notes,
            resolvedBy: m.discrepancy.resolvedBy ?? null,
            resolvedAt: m.discrepancy.resolvedAt ?? null,
            resolution: m.discrepancy.resolution ?? null,
          }
          : null,
        isSealed: m.isSealed,
        isInTransit: m.isInTransit,
        isClosed: m.isClosed,
        unloadedCount: m.unloadedCount,
        remainingCount: m.remainingCount,
        durationMinutes: m.durationMinutes ?? null,
        internalReference: m.internalReference ?? null,
        notes: m.notes ?? null,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        sealedAt: m.sealedAt ?? null,
        closedAt: m.closedAt ?? null,
        departedAt: m.departedAt ?? null,
        arrivedAt: m.arrivedAt ?? null,
        estimatedArrival: m.estimatedArrival ?? null,
      }));


      const responseData: any = {
        manifests: formattedManifests,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          hasMore: page * limit < total,
        },
        filters: {
          status: req.query.status ?? null,
          statuses: req.query.statuses ?? null,
          priority: req.query.priority ?? null,
          isSealed: req.query.isSealed ?? null,
          isInTransit: req.query.isInTransit ?? null,
          hasDiscrepancy: req.query.hasDiscrepancy ?? null,
          minWeight: req.query.minWeight ?? null,
          maxWeight: req.query.maxWeight ?? null,
          minPackageCount: req.query.minPackageCount ?? null,
          maxPackageCount: req.query.maxPackageCount ?? null,
          manifestCode: req.query.manifestCode ?? null,
          search: req.query.search ?? null,
          containsPackageId: req.query.containsPackageId ?? null,
          companyId: req.query.companyId ?? null,
          originBranchId: req.query.originBranchId ?? null,
          destinationBranchId: req.query.destinationBranchId ?? null,
          branchId: req.query.branchId ?? null,
          createdBy: req.query.createdBy ?? null,
          transporterId: req.query.transporterId ?? null,
          vehicleId: req.query.vehicleId ?? null,
          createdFrom: req.query.createdFrom ?? null,
          createdTo: req.query.createdTo ?? null,
          departedFrom: req.query.departedFrom ?? null,
          departedTo: req.query.departedTo ?? null,
          arrivedFrom: req.query.arrivedFrom ?? null,
          arrivedTo: req.query.arrivedTo ?? null,
          sortBy,
          order: req.query.order ?? "desc",
        },
      };


      if (transporterStats) {
        responseData.transporterStats = transporterStats;
      }

      res.status(200).json({
        success: true,
        data: responseData,
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400,
          ),
        );
      }
      return next(
        new ErrorHandler(error.message || "Error fetching manifests.", 500),
      );
    }
  },
);














export const getTodayDeliveries = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const delivererUserId = req.user?._id;
      if (!delivererUserId) {
        return next(new ErrorHandler("Unauthorized — user not found.", 401));
      }


      const deliverer = await DelivererModel.findOne({ userId: delivererUserId }).lean();
      if (!deliverer) {
        return next(new ErrorHandler("Deliverer profile not found.", 404));
      }


      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);


      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;


      const filter: Record<string, any> = {
        assignedDelivererId: deliverer._id,

        $or: [
          { estimatedDeliveryTime: { $gte: todayStart, $lte: todayEnd } },
          { updatedAt: { $gte: todayStart, $lte: todayEnd } },
          { deliveredAt: { $gte: todayStart, $lte: todayEnd } },
          { nextAttemptDate: { $gte: todayStart, $lte: todayEnd } },
        ],
      };


      const VALID_STATUSES: PackageStatus[] = [
        "out_for_delivery", "delivered", "failed_delivery",
        "failed_delivery_attempt", "at_destination_branch", "returned", "cancelled",
      ];

      if (req.query.status) {
        const s = req.query.status as string;
        if (!VALID_STATUSES.includes(s as PackageStatus))
          return next(new ErrorHandler(`Invalid status: ${s}.`, 400));
        filter.status = s;
      }


      if (req.query.statuses) {
        const statuses = (req.query.statuses as string).split(",").map(s => s.trim());
        const invalid = statuses.filter(s => !VALID_STATUSES.includes(s as PackageStatus));
        if (invalid.length > 0)
          return next(new ErrorHandler(`Invalid statuses: ${invalid.join(", ")}.`, 400));
        filter.status = { $in: statuses };
      }


      const VALID_PRIORITIES = ["standard", "express", "same_day"];
      if (req.query.deliveryPriority) {
        const dp = req.query.deliveryPriority as string;
        if (!VALID_PRIORITIES.includes(dp))
          return next(new ErrorHandler(`Invalid deliveryPriority: ${dp}.`, 400));
        filter.deliveryPriority = dp;
      }


      const VALID_TYPES: PackageType[] = [
        "document", "parcel", "fragile", "heavy", "perishable", "electronic", "clothing",
      ];

      if (req.query.type) {
        const t = req.query.type as string;
        if (!VALID_TYPES.includes(t as PackageType))
          return next(new ErrorHandler(`Invalid type: ${t}.`, 400));
        filter.type = t;
      }


      if (req.query.paymentStatus) {
        const VALID_PAYMENT = ["pending", "paid", "partially_paid", "refunded", "failed"];
        const ps = req.query.paymentStatus as string;
        if (!VALID_PAYMENT.includes(ps))
          return next(new ErrorHandler(`Invalid paymentStatus: ${ps}.`, 400));
        filter.paymentStatus = ps;
      }


      if (req.query.isFragile !== undefined) {
        filter.isFragile = req.query.isFragile === "true";
      }


      if (req.query.city) {
        filter["destination.city"] = new RegExp(req.query.city as string, "i");
      }


      const sortBy = (req.query.sortBy as string) || "estimatedDeliveryTime";
      const order = req.query.order === "desc" ? -1 : 1;
      const sortMap: Record<string, any> = {
        estimatedDeliveryTime: { estimatedDeliveryTime: order },
        createdAt: { createdAt: order },
        weight: { weight: order },
        totalPrice: { totalPrice: order },
        attemptCount: { attemptCount: order },
      };
      const sort = sortMap[sortBy] || { estimatedDeliveryTime: 1 };


      const [total, packages] = await Promise.all([
        PackageModel.countDocuments(filter),
        PackageModel.find(filter)
          .populate("currentRouteId", "routeNumber status estimatedTime")
          .populate("currentBranchId", "name code address")
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean({ virtuals: true }),
      ]);


      const stats = {
        total: packages.length,
        delivered: packages.filter(p => p.status === "delivered").length,
        failed: packages.filter(p => ["failed_delivery", "failed_delivery_attempt"].includes(p.status)).length,
        pending: packages.filter(p => ["out_for_delivery", "at_destination_branch"].includes(p.status)).length,
        returned: packages.filter(p => p.status === "returned").length,
        cancelled: packages.filter(p => p.status === "cancelled").length,
        totalWeight: packages.reduce((sum, p) => sum + (p.weight || 0), 0),
        totalPrice: packages.reduce((sum, p) => sum + (p.totalPrice || 0), 0),
      };


      const formattedPackages = packages.map((pkg: any) => ({
        id: pkg._id,
        trackingNumber: pkg.trackingNumber,
        status: pkg.status,
        type: pkg.type,
        isFragile: pkg.isFragile,
        deliveryType: pkg.deliveryType,
        deliveryPriority: pkg.deliveryPriority,

        destination: {
          recipientName: pkg.destination?.recipientName,
          recipientPhone: pkg.destination?.recipientPhone,
          address: pkg.destination?.address,
          city: pkg.destination?.city,
          state: pkg.destination?.state,
        },

        weight: pkg.weight,
        totalPrice: pkg.totalPrice,
        paymentStatus: pkg.paymentStatus,
        paymentMethod: pkg.paymentMethod ?? null,

        estimatedDeliveryTime: pkg.estimatedDeliveryTime ?? null,
        deliveredAt: pkg.deliveredAt ?? null,
        isOverdue: (pkg as any).isOverdue ?? false,

        attemptCount: pkg.attemptCount,
        maxAttempts: pkg.maxAttempts,
        nextAttemptDate: pkg.nextAttemptDate ?? null,

        currentRoute: pkg.currentRouteId
          ? {
            id: pkg.currentRouteId._id,
            routeNumber: pkg.currentRouteId.routeNumber,
            status: pkg.currentRouteId.status,
          }
          : null,
        currentBranch: pkg.currentBranchId
          ? {
            id: pkg.currentBranchId._id,
            name: pkg.currentBranchId.name,
            code: pkg.currentBranchId.code,
          }
          : null,

        deliveryProgress: (pkg as any).deliveryProgress,
        needsAttention: (pkg as any).needsAttention,
        canBeDelivered: (pkg as any).canBeDelivered,

        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
      }));

      res.status(200).json({
        success: true,
        data: {
          date: todayStart.toISOString().split("T")[0],
          stats,
          packages: formattedPackages,
          pagination: {
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
            hasMore: page * limit < total,
          },
          filters: {
            status: req.query.status ?? null,
            statuses: req.query.statuses ?? null,
            deliveryPriority: req.query.deliveryPriority ?? null,
            type: req.query.type ?? null,
            paymentStatus: req.query.paymentStatus ?? null,
            isFragile: req.query.isFragile ?? null,
            city: req.query.city ?? null,
            sortBy,
            order: req.query.order ?? "asc",
          },
        },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error fetching today's deliveries.", 500));
    }
  },
);






export const getDeliveryHistory = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const delivererUserId = req.user?._id;
      if (!delivererUserId) {
        return next(new ErrorHandler("Unauthorized — user not found.", 401));
      }

      const deliverer = await DelivererModel.findOne({ userId: delivererUserId }).lean();
      if (!deliverer) {
        return next(new ErrorHandler("Deliverer profile not found.", 404));
      }

      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;

      const filter: Record<string, any> = {
        assignedDelivererId: deliverer._id,
      };

      type PeriodFilter = "today" | "yesterday" | "last7days" | "last30days" | "last6months" | "custom";

      const period = req.query.period ? (req.query.period as PeriodFilter) : "all";

      // ── Resolve "delivered" date window via PackageHistoryModel ────────────
      // Maps packageId -> most recent 'delivered' timestamp within the window
      // (or overall, if period === "all" but we still need it for sorting).
      let deliveredAtByPackageId: Map<string, Date> | null = null;
      let deliveredDateRange: { $gte?: Date; $lte?: Date } | null = null;

      if (period !== "all") {
        const now = new Date();
        let startDate: Date;
        let endDate: Date;

        switch (period) {
          case "today":
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000 - 1);
            deliveredDateRange = { $gte: startDate, $lte: endDate };
            break;

          case "yesterday":
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000 - 1);
            deliveredDateRange = { $gte: startDate, $lte: endDate };
            break;

          case "last7days":
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            startDate.setHours(0, 0, 0, 0);
            deliveredDateRange = { $gte: startDate };
            break;

          case "last30days":
            startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            startDate.setHours(0, 0, 0, 0);
            deliveredDateRange = { $gte: startDate };
            break;

          case "last6months":
            startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
            startDate.setHours(0, 0, 0, 0);
            deliveredDateRange = { $gte: startDate };
            break;

          case "custom":
            if (req.query.startDate && req.query.endDate) {
              const customStart = new Date(req.query.startDate as string);
              const customEnd = new Date(req.query.endDate as string);
              customEnd.setHours(23, 59, 59, 999);
              deliveredDateRange = { $gte: customStart, $lte: customEnd };
            }
            break;
        }

        if (deliveredDateRange) {
          const historyMatch: Record<string, any> = {
            status: "delivered",
            timestamp: deliveredDateRange,
          };

          const deliveredEntries = await PackageHistoryModel.find(historyMatch)
            .select("packageId timestamp")
            .lean();

          deliveredAtByPackageId = new Map();
          const deliveredPackageIds: mongoose.Types.ObjectId[] = [];

          for (const entry of deliveredEntries) {
            const key = entry.packageId.toString();

            const existing = deliveredAtByPackageId.get(key);
            if (!existing || entry.timestamp > existing) {
              deliveredAtByPackageId.set(key, entry.timestamp);
            }
            deliveredPackageIds.push(entry.packageId);
          }

          // Restrict the package query to only packages delivered in this
          // window. If nothing was delivered in the window, force an
          // empty result set rather than falling through to "all packages".
          filter._id = { $in: deliveredPackageIds.length > 0 ? deliveredPackageIds : [new mongoose.Types.ObjectId()] };
        }
      }

      // Additional filters - these work independently
      if (req.query.status) {
        filter.status = req.query.status as string;
      }

      if (req.query.statuses) {
        filter.status = { $in: (req.query.statuses as string).split(",").map(s => s.trim()) };
      }

      if (req.query.deliveryType) {
        filter.deliveryType = req.query.deliveryType as string;
      }

      if (req.query.deliveryPriority) {
        filter.deliveryPriority = req.query.deliveryPriority as string;
      }

      if (req.query.city) {
        filter["destination.city"] = new RegExp(req.query.city as string, "i");
      }

      if (req.query.search) {
        filter.trackingNumber = new RegExp(req.query.search as string, "i");
      }

      const minWeight = req.query.minWeight ? parseFloat(req.query.minWeight as string) : undefined;
      const maxWeight = req.query.maxWeight ? parseFloat(req.query.maxWeight as string) : undefined;

      if (minWeight !== undefined && !isNaN(minWeight)) {
        filter.weight = { ...filter.weight, $gte: minWeight };
      }

      if (maxWeight !== undefined && !isNaN(maxWeight)) {
        filter.weight = { ...filter.weight, $lte: maxWeight };
      }

      // ── Sorting ──────────────────────────────────────────────────────────
      // "deliveredAt" is not a real field on IPackage, so it can't be passed
      // to Mongo's .sort(). If requested (or as the default), we fetch
      // unsorted/paginated by another stable field, then re-sort the page
      // in-memory using deliveredAtByPackageId (loaded above if period !==
      // "all"; loaded on-demand below otherwise).
      const sortBy = (req.query.sortBy as string) || "deliveredAt";
      const order = req.query.order === "desc" ? -1 : 1;

      const dbSortMap: Record<string, any> = {
        createdAt: { createdAt: order },
        weight: { weight: order },
        totalPrice: { totalPrice: order },
        attemptCount: { attemptCount: order },
      };

      const sortingByDeliveredAt = sortBy === "deliveredAt";

      const sort = sortingByDeliveredAt
        ? { createdAt: -1 }
        : (dbSortMap[sortBy] || { createdAt: -1 });

      const [total, packagesRaw] = await Promise.all([
        PackageModel.countDocuments(filter),
        PackageModel.find(filter)
          .populate("currentRouteId", "routeNumber status")
          .populate("currentBranchId", "name code")
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean({ virtuals: true }),
      ]);

      let packages = packagesRaw;

      // If sorting by deliveredAt and we don't already have the map (i.e.
      // period === "all"), fetch delivered timestamps just for this page's
      // packageIds.
      if (sortingByDeliveredAt) {
        if (!deliveredAtByPackageId) {
          deliveredAtByPackageId = new Map();
          const pageIds = packages.map((p: any) => p._id);
          if (pageIds.length > 0) {
            const entries = await PackageHistoryModel.find({
              packageId: { $in: pageIds },
              status: "delivered",
            })
              .select("packageId timestamp")
              .lean();

            for (const entry of entries) {
              const key = entry.packageId.toString();
              const existing = deliveredAtByPackageId.get(key);
              if (!existing || entry.timestamp > existing) {
                deliveredAtByPackageId.set(key, entry.timestamp);
              }
            }
          }
        }

        packages = [...packages].sort((a: any, b: any) => {
          const aTime = deliveredAtByPackageId!.get(a._id.toString())?.getTime() ?? 0;
          const bTime = deliveredAtByPackageId!.get(b._id.toString())?.getTime() ?? 0;
          return order === -1 ? bTime - aTime : aTime - bTime;
        });
      }

      // ── Stats - Apply the SAME filters as the main query ─────────────────────
      let statsFilter: Record<string, any> = {
        assignedDelivererId: deliverer._id,
      };

      // Apply the same delivered-date-window filter to stats for consistency
      if (period !== "all" && filter._id) {
        statsFilter._id = filter._id;
      }

      // ✅ CRITICAL FIX: Copy all relevant filters from main filter to stats
      if (filter.status) {
        statsFilter.status = filter.status;
      }

      if (filter.deliveryType) {
        statsFilter.deliveryType = filter.deliveryType;
      }

      if (filter.deliveryPriority) {
        statsFilter.deliveryPriority = filter.deliveryPriority;
      }

      if (filter["destination.city"]) {
        statsFilter["destination.city"] = filter["destination.city"];
      }

      if (filter.weight) {
        statsFilter.weight = filter.weight;
      }

      if (filter.trackingNumber) {
        statsFilter.trackingNumber = filter.trackingNumber;
      }

      const allPackagesForStats = await PackageModel.find(statsFilter).lean();

      const stats = {
        totalLifetime: allPackagesForStats.length,
        totalDelivered: allPackagesForStats.filter(p => p.status === "delivered").length,
        totalFailed: allPackagesForStats.filter(p =>
          ["failed_delivery", "failed_delivery_attempt"].includes(p.status)
        ).length,
        totalReturned: allPackagesForStats.filter(p => p.status === "returned").length,
        totalCancelled: allPackagesForStats.filter(p => p.status === "cancelled").length,
        successRate: allPackagesForStats.length > 0
          ? Math.round((allPackagesForStats.filter(p => p.status === "delivered").length / allPackagesForStats.length) * 100)
          : 0,
        totalWeightDelivered: allPackagesForStats
          .filter(p => p.status === "delivered")
          .reduce((sum, p) => sum + (p.weight || 0), 0),
        totalRevenue: allPackagesForStats
          .filter(p => p.status === "delivered")
          .reduce((sum, p) => sum + (p.totalPrice || 0), 0),
      };

      const formattedPackages = packages.map((pkg: any) => ({
        id: pkg._id,
        trackingNumber: pkg.trackingNumber,
        status: pkg.status,
        type: pkg.type,
        isFragile: pkg.isFragile,
        deliveryType: pkg.deliveryType,
        deliveryPriority: pkg.deliveryPriority,

        destination: {
          recipientName: pkg.destination?.recipientName,
          recipientPhone: pkg.destination?.recipientPhone,
          address: pkg.destination?.address,
          city: pkg.destination?.city,
          state: pkg.destination?.state,
          coordinates: pkg.deliveryType === "home" && pkg.destination.location?.coordinates
            ? {
              type: pkg.destination.location.type || "Point",
              coordinates: pkg.destination.location.coordinates,
            }
            : null,
        },

        description: pkg.description ?? null,
        weight: pkg.weight,
        totalPrice: pkg.totalPrice,
        paymentStatus: pkg.paymentStatus,
        paymentMethod: pkg.paymentMethod ?? null,

        estimatedDeliveryTime: pkg.estimatedDeliveryTime ?? null,
        deliveredAt: deliveredAtByPackageId?.get(pkg._id.toString()) ?? null,
        isOverdue: (pkg as any).isOverdue ?? false,

        attemptCount: pkg.attemptCount,
        maxAttempts: pkg.maxAttempts,
        nextAttemptDate: pkg.nextAttemptDate ?? null,

        currentRoute: pkg.currentRouteId
          ? { id: pkg.currentRouteId._id, routeNumber: pkg.currentRouteId.routeNumber, status: pkg.currentRouteId.status }
          : null,
        currentBranch: pkg.currentBranchId
          ? { id: pkg.currentBranchId._id, name: pkg.currentBranchId.name, code: pkg.currentBranchId.code }
          : null,

        returnInfo: pkg.returnInfo?.isReturn
          ? { reason: pkg.returnInfo.reason, returnDate: pkg.returnInfo.returnDate }
          : null,

        deliveryProgress: (pkg as any).deliveryProgress,
        needsAttention: (pkg as any).needsAttention,

        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
      }));

      res.status(200).json({
        success: true,
        data: {
          period: period === "all" ? "all_time" : period,
          stats,
          packages: formattedPackages,
          pagination: {
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
            hasMore: page * limit < total,
          },
          filters: {
            period,
            status: req.query.status ?? null,
            statuses: req.query.statuses ?? null,
            deliveryPriority: req.query.deliveryPriority ?? null,
            deliveryType: req.query.deliveryType ?? null,
            city: req.query.city ?? null,
            search: req.query.search ?? null,
            sortBy,
            order: req.query.order ?? "desc",
          },
        },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error fetching delivery history.", 500));
    }
  },
);







export const getTodayManifests = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const transporterUserId = req.user?._id;
      if (!transporterUserId) {
        return next(new ErrorHandler("Unauthorized — user not found.", 401));
      }


      const transporter = await TransporterModel.findOne({ userId: transporterUserId }).lean();
      if (!transporter) {
        return next(new ErrorHandler("Transporter profile not found.", 404));
      }

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;


      const filter: Record<string, any> = {
        'transportLeg.transporterId': transporter._id,

        $or: [
          { 'transportLeg.assignedAt': { $gte: todayStart, $lte: todayEnd } },
          { createdAt: { $gte: todayStart, $lte: todayEnd } },
          { updatedAt: { $gte: todayStart, $lte: todayEnd } },
          { departedAt: { $gte: todayStart, $lte: todayEnd } },
          { arrivedAt: { $gte: todayStart, $lte: todayEnd } },
        ],
      };

      const VALID_STATUSES: ManifestStatus[] = [
        'open', 'sealed', 'loaded', 'in_transit',
        'arrived', 'unloading', 'closed', 'discrepancy', 'cancelled'
      ];


      if (req.query.status) {
        const s = req.query.status as string;
        if (!VALID_STATUSES.includes(s as ManifestStatus)) {
          return next(new ErrorHandler(`Invalid status: ${s}.`, 400));
        }
        filter.status = s;
      }

      if (req.query.statuses) {
        const statuses = (req.query.statuses as string).split(",").map(s => s.trim());
        const invalid = statuses.filter(s => !VALID_STATUSES.includes(s as ManifestStatus));
        if (invalid.length > 0) {
          return next(new ErrorHandler(`Invalid statuses: ${invalid.join(", ")}.`, 400));
        }
        filter.status = { $in: statuses };
      }


      const VALID_PRIORITIES = ["standard", "express", "urgent"];
      if (req.query.priority) {
        const p = req.query.priority as string;
        if (!VALID_PRIORITIES.includes(p)) {
          return next(new ErrorHandler(`Invalid priority: ${p}.`, 400));
        }
        filter.priority = p;
      }


      if (req.query.originBranchId) {
        filter.originBranchId = req.query.originBranchId;
      }

      if (req.query.destinationBranchId) {
        filter.destinationBranchId = req.query.destinationBranchId;
      }


      const sortBy = (req.query.sortBy as string) || 'transportLeg.assignedAt';
      const order = req.query.order === "desc" ? -1 : 1;
      const sortMap: Record<string, any> = {
        'transportLeg.assignedAt': { 'transportLeg.assignedAt': order },
        createdAt: { createdAt: order },
        departedAt: { departedAt: order },
        arrivedAt: { arrivedAt: order },
        packageCount: { packageCount: order },
        totalDeclaredWeight: { totalDeclaredWeight: order },
      };
      const sort = sortMap[sortBy] || { 'transportLeg.assignedAt': -1 };


      const [total, manifests] = await Promise.all([
        ManifestModel.countDocuments(filter),
        ManifestModel.find(filter)
          .populate("originBranchId", "name code address")
          .populate("destinationBranchId", "name code address")
          .populate("transportLeg.vehicleId", "licensePlate model registrationNumber")
          .populate("createdBy", "firstName lastName email")
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean({ virtuals: true }),
      ]);


      const stats = {
        total: manifests.length,
        inTransit: manifests.filter(m => m.status === "in_transit").length,
        arrived: manifests.filter(m => m.status === "arrived").length,
        loaded: manifests.filter(m => m.status === "loaded").length,
        unloading: manifests.filter(m => m.status === "unloading").length,
        closed: manifests.filter(m => m.status === "closed").length,
        cancelled: manifests.filter(m => m.status === "cancelled").length,
        discrepancy: manifests.filter(m => m.status === "discrepancy").length,
        totalPackages: manifests.reduce((sum, m) => sum + (m.packageCount || 0), 0),
        totalWeight: manifests.reduce((sum, m) => sum + (m.totalDeclaredWeight || 0), 0),
      };


      const formattedManifests = manifests.map((manifest: any) => ({
        id: manifest._id,
        manifestCode: manifest.manifestCode,
        status: manifest.status,
        priority: manifest.priority,

        originBranch: manifest.originBranchId ? {
          id: manifest.originBranchId._id,
          name: manifest.originBranchId.name,
          code: manifest.originBranchId.code,
          address: manifest.originBranchId.address,
        } : null,

        destinationBranch: manifest.destinationBranchId ? {
          id: manifest.destinationBranchId._id,
          name: manifest.destinationBranchId.name,
          code: manifest.destinationBranchId.code,
          address: manifest.destinationBranchId.address,
        } : null,

        transportLeg: manifest.transportLeg ? {
          vehicle: manifest.transportLeg.vehicleId ? {
            id: manifest.transportLeg.vehicleId._id,
            licensePlate: manifest.transportLeg.vehicleId.licensePlate,
            model: manifest.transportLeg.vehicleId.model,
          } : null,
          assignedAt: manifest.transportLeg.assignedAt,
          departedAt: manifest.transportLeg.departedAt,
          arrivedAt: manifest.transportLeg.arrivedAt,
          estimatedArrival: manifest.transportLeg.estimatedArrival,
        } : null,

        packageCount: manifest.packageCount,
        totalDeclaredWeight: manifest.totalDeclaredWeight,

        unloadedCount: manifest.unloadedCount,
        remainingCount: manifest.remainingCount,

        sealedAt: manifest.sealedAt ?? null,
        departedAt: manifest.departedAt ?? null,
        arrivedAt: manifest.arrivedAt ?? null,
        closedAt: manifest.closedAt ?? null,

        durationMinutes: manifest.durationMinutes ?? null,
        hasDiscrepancy: manifest.hasDiscrepancy,
        isSealed: manifest.isSealed,
        isInTransit: manifest.isInTransit,
        isClosed: manifest.isClosed,

        notes: manifest.notes ?? null,
        internalReference: manifest.internalReference ?? null,

        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
      }));

      res.status(200).json({
        success: true,
        data: {
          date: todayStart.toISOString().split("T")[0],
          stats,
          manifests: formattedManifests,
          pagination: {
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
            hasMore: page * limit < total,
          },
          filters: {
            status: req.query.status ?? null,
            statuses: req.query.statuses ?? null,
            priority: req.query.priority ?? null,
            originBranchId: req.query.originBranchId ?? null,
            destinationBranchId: req.query.destinationBranchId ?? null,
            sortBy,
            order: req.query.order ?? "asc",
          },
        },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error fetching today's manifests.", 500));
    }
  },
);








export const getManifestHistory = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const transporterUserId = req.user?._id;
      if (!transporterUserId) {
        return next(new ErrorHandler("Unauthorized — user not found.", 401));
      }

      const transporter = await TransporterModel.findOne({ userId: transporterUserId }).lean();
      if (!transporter) {
        return next(new ErrorHandler("Transporter profile not found.", 404));
      }

      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;

      const filter: Record<string, any> = {
        'transportLeg.transporterId': transporter._id,
      };

      type PeriodFilter = "today" | "yesterday" | "last7days" | "last30days" | "last6months" | "custom" | "all";
      const period = req.query.period ? (req.query.period as PeriodFilter) : "all";

      if (period !== "all") {
        const now = new Date();
        let startDate: Date;

        switch (period) {
          case "today":
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            filter.$or = [
              { 'transportLeg.assignedAt': { $gte: startDate } },
              { createdAt: { $gte: startDate } },
              { updatedAt: { $gte: startDate } },
            ];
            break;
          case "yesterday":
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            filter.$or = [
              { 'transportLeg.assignedAt': { $gte: startDate, $lt: new Date(startDate.getTime() + 24 * 60 * 60 * 1000) } },
              { departedAt: { $gte: startDate, $lt: new Date(startDate.getTime() + 24 * 60 * 60 * 1000) } },
              { arrivedAt: { $gte: startDate, $lt: new Date(startDate.getTime() + 24 * 60 * 60 * 1000) } },
            ];
            break;
          case "last7days":
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            startDate.setHours(0, 0, 0, 0);
            filter.$or = [
              { 'transportLeg.assignedAt': { $gte: startDate } },
              { createdAt: { $gte: startDate } },
              { departedAt: { $gte: startDate } },
              { arrivedAt: { $gte: startDate } },
            ];
            break;
          case "last30days":
            startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            startDate.setHours(0, 0, 0, 0);
            filter.$or = [
              { 'transportLeg.assignedAt': { $gte: startDate } },
              { createdAt: { $gte: startDate } },
              { departedAt: { $gte: startDate } },
              { arrivedAt: { $gte: startDate } },
            ];
            break;
          case "last6months":
            startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
            filter.$or = [
              { 'transportLeg.assignedAt': { $gte: startDate } },
              { createdAt: { $gte: startDate } },
              { departedAt: { $gte: startDate } },
              { arrivedAt: { $gte: startDate } },
            ];
            break;
          case "custom":
            if (req.query.startDate && req.query.endDate) {
              filter.$or = [
                { 'transportLeg.assignedAt': { $gte: new Date(req.query.startDate as string), $lte: new Date(req.query.endDate as string) } },
                { createdAt: { $gte: new Date(req.query.startDate as string), $lte: new Date(req.query.endDate as string) } },
                { departedAt: { $gte: new Date(req.query.startDate as string), $lte: new Date(req.query.endDate as string) } },
                { arrivedAt: { $gte: new Date(req.query.startDate as string), $lte: new Date(req.query.endDate as string) } },
              ];
            }
            break;
        }
      }


      if (req.query.status) {
        filter.status = req.query.status as string;
      }

      if (req.query.statuses) {
        filter.status = { $in: (req.query.statuses as string).split(",").map(s => s.trim()) };
      }


      if (req.query.priority) {
        filter.priority = req.query.priority as string;
      }


      if (req.query.originBranchId) {
        filter.originBranchId = req.query.originBranchId;
      }

      if (req.query.destinationBranchId) {
        filter.destinationBranchId = req.query.destinationBranchId;
      }


      if (req.query.search) {
        filter.manifestCode = new RegExp(req.query.search as string, "i");
      }


      const sortBy = (req.query.sortBy as string) || 'transportLeg.assignedAt';
      const order = req.query.order === "desc" ? -1 : 1;
      const sortMap: Record<string, any> = {
        'transportLeg.assignedAt': { 'transportLeg.assignedAt': order },
        createdAt: { createdAt: order },
        departedAt: { departedAt: order },
        arrivedAt: { arrivedAt: order },
        closedAt: { closedAt: order },
        packageCount: { packageCount: order },
        totalDeclaredWeight: { totalDeclaredWeight: order },
      };
      const sort = sortMap[sortBy] || { 'transportLeg.assignedAt': -1 };


      const [total, manifests] = await Promise.all([
        ManifestModel.countDocuments(filter),
        ManifestModel.find(filter)
          .populate("originBranchId", "name code address city")
          .populate("destinationBranchId", "name code address city")
          .populate("transportLeg.vehicleId", "licensePlate model registrationNumber")
          .populate("createdBy", "firstName lastName email")
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean({ virtuals: true }),
      ]);


      const allManifests = await ManifestModel.find({
        'transportLeg.transporterId': transporter._id,
      }).lean();

      const stats = {
        totalLifetime: allManifests.length,
        totalCompleted: allManifests.filter(m => m.status === "closed").length,
        totalInTransit: allManifests.filter(m => m.status === "in_transit").length,
        totalArrived: allManifests.filter(m => m.status === "arrived").length,
        totalCancelled: allManifests.filter(m => m.status === "cancelled").length,
        totalDiscrepancy: allManifests.filter(m => m.status === "discrepancy").length,
        completionRate: allManifests.length > 0
          ? Math.round((allManifests.filter(m => m.status === "closed").length / allManifests.length) * 100)
          : 0,
        totalPackagesTransported: allManifests
          .filter(m => m.status === "closed")
          .reduce((sum, m) => sum + (m.packageCount || 0), 0),
        totalWeightTransported: allManifests
          .filter(m => m.status === "closed")
          .reduce((sum, m) => sum + (m.totalDeclaredWeight || 0), 0),
        averageTripDuration: (() => {
          const completedTrips = allManifests.filter(m => m.departedAt && m.arrivedAt);
          if (completedTrips.length === 0) return 0;
          const totalDuration = completedTrips.reduce((sum, m) => {
            const duration = m.arrivedAt!.getTime() - m.departedAt!.getTime();
            return sum + duration;
          }, 0);
          return Math.round(totalDuration / completedTrips.length / 60000); // minutes
        })(),
      };


      const formattedManifests = manifests.map((manifest: any) => ({
        id: manifest._id,
        manifestCode: manifest.manifestCode,
        status: manifest.status,
        priority: manifest.priority,

        originBranch: manifest.originBranchId ? {
          id: manifest.originBranchId._id,
          name: manifest.originBranchId.name,
          code: manifest.originBranchId.code,
          city: manifest.originBranchId.city,
        } : null,

        destinationBranch: manifest.destinationBranchId ? {
          id: manifest.destinationBranchId._id,
          name: manifest.destinationBranchId.name,
          code: manifest.destinationBranchId.code,
          city: manifest.destinationBranchId.city,
        } : null,

        transportLeg: manifest.transportLeg ? {
          vehicle: manifest.transportLeg.vehicleId ? {
            id: manifest.transportLeg.vehicleId._id,
            licensePlate: manifest.transportLeg.vehicleId.licensePlate,
            model: manifest.transportLeg.vehicleId.model,
          } : null,
          assignedAt: manifest.transportLeg.assignedAt,
          departedAt: manifest.transportLeg.departedAt,
          arrivedAt: manifest.transportLeg.arrivedAt,
          estimatedArrival: manifest.transportLeg.estimatedArrival,
        } : null,

        packageCount: manifest.packageCount,
        totalDeclaredWeight: manifest.totalDeclaredWeight,

        unloadedCount: manifest.unloadedCount,
        remainingCount: manifest.remainingCount,

        sealInfo: manifest.sealInfo ? {
          sealedBy: manifest.sealInfo.sealedBy,
          sealedAt: manifest.sealInfo.sealedAt,
          sealNumber: manifest.sealInfo.sealNumber,
        } : null,

        discrepancy: manifest.discrepancy ? {
          reportedAt: manifest.discrepancy.reportedAt,
          expectedCount: manifest.discrepancy.expectedCount,
          actualCount: manifest.discrepancy.actualCount,
          missingCount: manifest.discrepancy.missingPackageIds?.length || 0,
          resolved: !!manifest.discrepancy.resolvedAt,
        } : null,

        sealedAt: manifest.sealedAt ?? null,
        departedAt: manifest.departedAt ?? null,
        arrivedAt: manifest.arrivedAt ?? null,
        closedAt: manifest.closedAt ?? null,

        durationMinutes: manifest.durationMinutes ?? null,
        hasDiscrepancy: manifest.hasDiscrepancy,
        isSealed: manifest.isSealed,
        isInTransit: manifest.isInTransit,
        isClosed: manifest.isClosed,

        notes: manifest.notes ?? null,
        internalReference: manifest.internalReference ?? null,
        createdBy: manifest.createdBy ? {
          id: manifest.createdBy._id,
          name: `${manifest.createdBy.firstName} ${manifest.createdBy.lastName}`,
          email: manifest.createdBy.email,
        } : null,

        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
      }));

      res.status(200).json({
        success: true,
        data: {
          period: period === "all" ? "all_time" : period,
          stats,
          manifests: formattedManifests,
          pagination: {
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
            hasMore: page * limit < total,
          },
          filters: {
            period,
            status: req.query.status ?? null,
            statuses: req.query.statuses ?? null,
            priority: req.query.priority ?? null,
            originBranchId: req.query.originBranchId ?? null,
            destinationBranchId: req.query.destinationBranchId ?? null,
            search: req.query.search ?? null,
            sortBy,
            order: req.query.order ?? "desc",
          },
        },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error fetching manifest history.", 500));
    }
  },
);





export const generateCashReturnQrCode = catchAsyncError(async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user._id;
  const userRole = (req as any).user.role;
  const { delivererId } = req.body;

  if (!delivererId) {
    return next(new ErrorHandler("delivererId is required.", 400));
  }


  let branchId: string;

  if (userRole === "supervisor") {
    const supervisor = await SupervisorModel.findOne({ userId }).lean();
    if (!supervisor) {
      return next(new ErrorHandler("Supervisor profile not found.", 404));
    }
    branchId = supervisor.branchId.toString();
  } else {

    branchId = req.body.branchId;
    if (!branchId) {
      return next(new ErrorHandler("branchId is required for managers/admins.", 400));
    }
  }

  const { code, qrUrl, session } = await generateCashReturnQr(
    delivererId,
    branchId,
    userId,
  );

  res.status(200).json({
    success: true,
    message: "Cash return QR generated. Show this to the deliverer.",
    data: {
      qrCode: code,
      qrUrl,
      amount: session.amount,
      todayEarnings: session.todayEarnings,
      todayDeliveries: session.todayDeliveries,
      expiresAt: session.expiresAt,
    },
  });
});



export const scanCashReturnQrCode = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const delivererUserId = (req as any).user._id;
    const { code } = req.body;

    if (!code) {
      return next(new ErrorHandler("QR code is required.", 400));
    }

    const summary = await verifyAndProcessCashReturn(code, delivererUserId.toString());

    res.status(200).json({
      success: true,
      message: `Cash returned successfully. ${summary.amountReturned} DA returned to branch.`,
      data: {
        amountReturned: summary.amountReturned,
        todayEarnings: summary.todayEarnings,
        todayDeliveries: summary.todayDeliveries,
        todayCollected: summary.todayCollected,
        message: `You earned ${summary.todayEarnings} DA from ${summary.todayDeliveries} deliveries today.`,
      },
    });
  });



export const viewCashReturnQrPage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const { code } = req.params;

    const session = await getCashReturnInfo(code.toString());

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Cash return session not found or expired.",
      });
    }

    if (session.verified) {
      return res.json({
        success: false,
        message: "This cash return has already been processed.",
      });
    }

    if (new Date() > session.expiresAt) {
      return res.json({
        success: false,
        message: "This QR code has expired. Please request a new one.",
      });
    }


    const deliverer = await DelivererModel.findById(session.delivererId)
      .populate("userId", "firstName lastName")
      .lean();

    const delivererName = deliverer
      ? `${(deliverer.userId as any)?.firstName || ""} ${(deliverer.userId as any)?.lastName || ""}`
      : "Unknown";

    res.status(200).json({
      success: true,
      data: {
        delivererName,
        amount: session.amount,
        todayDeliveries: session.todayDeliveries,
        todayEarnings: session.todayEarnings,
        todayCollected: session.todayCollected,
        expiresAt: session.expiresAt,
        code,
      },
    });
  });


export const getPendingCashReturnSummary = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    const userId = (req as any).user._id;

    const deliverer = await DelivererModel.findOne({ userId }).lean();
    if (!deliverer) {
      return next(new ErrorHandler("Deliverer profile not found.", 404));
    }

    res.status(200).json({
      success: true,
      data: {
        pendingBranchReturn: deliverer.pendingBranchReturn,
        todayEarnings: deliverer.todayEarnings,
        todayDeliveriesCount: deliverer.todayDeliveriesCount,
        todayCollectedAmount: deliverer.todayCollectedAmount,
        totalEarnings: deliverer.totalEarnings,
        commission: deliverer.commission,
        message:
          deliverer.pendingBranchReturn > 0
            ? `You have ${deliverer.pendingBranchReturn} DA to return to the branch.`
            : "No pending cash to return. Great job!",
      },
    });
  });




export const getMyTransporterStats = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {

    try {

      const userId = req.user?._id;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized.", 401));
      }

      const transporter = await TransporterModel.findOne({ userId })
        .populate("currentBranchId", "name code")
        .populate("currentVehicleId", "registrationNumber type")
        .populate("currentRouteId", "routeNumber status type")
        .populate("assignedLine", "name code")
        .populate("assignedBranches", "name code")
        .lean({ virtuals: true });

      if (!transporter) {
        return next(new ErrorHandler("Transporter profile not found.", 404));
      }

      res.status(200).json({
        success: true,
        data: {

          today: {
            transportedCount: transporter.todayTransportedCount,
            assignedManifests: transporter.todayAssignedManifests,
            completedTrips: transporter.todayCompletedTrips,
            activeManifests: transporter.currentActiveManifests,
            totalWeight: transporter.todayTotalWeight,
          },


          lifetime: {
            totalTrips: transporter.totalTrips,
            completedTrips: transporter.completedTrips,
            cancelledTrips: transporter.cancelledTrips,
            totalManifests: transporter.totalManifestsTransported,
            totalDistance: transporter.totalDistance,
            totalDeliveryTime: transporter.totalDeliveryTime,
            averageDeliveryTime: transporter.averageDeliveryTime,
            completionRate: (transporter as any).completionRate,
            rating: transporter.rating,
          },


          current: {
            branch: transporter.currentBranchId || null,
            vehicle: transporter.currentVehicleId || null,
            route: transporter.currentRouteId || null,
            availabilityStatus: transporter.availabilityStatus,
            isOnline: transporter.isOnline,
            isOnDuty: (transporter as any).isOnDuty,
          },


          hub: {
            type: transporter.transporterType || "legacy",
            assignedLine: transporter.assignedLine || null,
            assignedBranches: transporter.assignedBranches || null,
          },
        },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error fetching stats.", 500));
    }
  }
);







interface IGenerateStopQrBody {
  routeId: string;
  stopIndex: number;
}

export const generateStopQr = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const userRole = req.user?.role;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized.", 401));
      }

      const { routeId, stopIndex } = req.body as IGenerateStopQrBody;

      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId)) {
        return next(new ErrorHandler("Valid routeId is required.", 400));
      }

      if (stopIndex === undefined || stopIndex < 0) {
        return next(new ErrorHandler("Valid stopIndex is required.", 400));
      }


      let branchId: string;

      if (userRole === "supervisor") {
        const supervisor = await SupervisorModel.findOne({ userId }).session(session).lean();
        if (!supervisor) {
          throw new ErrorHandler("Supervisor profile not found.", 404);
        }
        branchId = supervisor.branchId.toString();
      } else if (userRole === "manager" || userRole === "admin") {
        branchId = req.body.branchId;
        if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
          throw new ErrorHandler("branchId is required for managers/admins.", 400);
        }
      } else {
        throw new ErrorHandler("Only supervisors, managers, and admins can generate stop QR codes.", 403);
      }


      const route = await RouteModel.findById(routeId).session(session);
      if (!route) {
        throw new ErrorHandler("Route not found.", 404);
      }

      if (route.status !== "active") {
        throw new ErrorHandler(`Route must be active. Current status: ${route.status}.`, 400);
      }

      const stop = route.stops[stopIndex];
      if (!stop) {
        throw new ErrorHandler(`Stop ${stopIndex} not found in this route.`, 404);
      }


      if (!stop.branchId || stop.branchId.toString() !== branchId) {
        throw new ErrorHandler("This stop does not belong to your branch.", 403);
      }

      if (!["arrived", "in_progress"].includes(stop.status)) {
        throw new ErrorHandler(
          `Transporter has not arrived yet. Stop status: ${stop.status}.`,
          400,
        );
      }


      await StopQrSessionModel.updateMany(
        {
          routeId,
          stopIndex,
          verified: false,
          expiresAt: { $gt: new Date() },
        },
        { $set: { expiresAt: new Date() } },
        { session },
      );


      const code = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const isLastStop = stopIndex === route.stops.length - 1;

      const isHubRoute = route.type === "hub_to_hub" || route.type === "hub_to_branch";
      const manifestCount = isHubRoute ? (stop.manifestIds || []).length : 0;
      const packageCount = !isHubRoute ? (stop.packageIds || []).length : 0;

      const qrSession = await StopQrSessionModel.create(
        [
          {
            routeId,
            stopIndex,
            stopId: stop._id,
            transporterId: route.assignedTransporterId,
            branchId,
            manifestCount,
            packageCount,
            isLastStop,
            code,
            expiresAt,
            verified: false,
          },
        ],
        { session },
      );

      await session.commitTransaction();
      transactionCommitted = true;

      res.status(200).json({
        success: true,
        message: "Stop QR generated successfully.",
        data: {
          sessionId: qrSession[0]._id,
          qrCode: code,
          expiresAt,
          routeId,
          stopIndex,
          stopId: stop._id,
          branchId,
          manifestCount,
          packageCount,
          isLastStop,
          qrUrl: `${process.env.CLIENT_APP_URL}/stop-qr/${code}`,
        },
      });
    } catch (error: any) {
      return next(error);
    } finally {
      if (!transactionCommitted && session.inTransaction()) {
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  },
);





interface IScanStopQrBody {
  code: string;
  coordinates: [number, number];
  completedManifestIds?: string[];
  discrepancyManifestIds?: string[];
  notes?: string;
}

export const scanStopQr = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const userId = req.user?._id;
      const userRole = req.user?.role;

      if (!userId) {
        return next(new ErrorHandler("Unauthorized.", 401));
      }

      if (userRole !== "transporter") {
        return next(new ErrorHandler("Only transporters can scan stop QR codes.", 403));
      }

      const { code, coordinates, completedManifestIds, discrepancyManifestIds, notes } =
        req.body as IScanStopQrBody;

      if (!code) {
        return next(new ErrorHandler("QR code is required.", 400));
      }

      if (!coordinates || coordinates.length !== 2) {
        return next(new ErrorHandler("Valid coordinates [lng, lat] are required.", 400));
      }


      const qrSession = await StopQrSessionModel.findOne({ code }).session(session);
      if (!qrSession) {
        throw new ErrorHandler("Invalid QR code. Session not found.", 404);
      }

      if (qrSession.verified) {
        throw new ErrorHandler("This QR code has already been used.", 400);
      }

      if (new Date() > qrSession.expiresAt) {
        throw new ErrorHandler("QR code has expired. Please request a new one.", 400);
      }


      const transporter = await TransporterModel.findOne({ userId }).session(session).lean();
      if (!transporter) {
        throw new ErrorHandler("Transporter profile not found.", 404);
      }

      if (qrSession.transporterId.toString() !== transporter._id.toString()) {
        throw new ErrorHandler("This QR code is for a different transporter.", 403);
      }


      const route = await RouteModel.findById(qrSession.routeId).session(session);
      if (!route) {
        throw new ErrorHandler("Route not found.", 404);
      }

      if (route.status !== "active") {
        throw new ErrorHandler(`Route is not active. Status: ${route.status}.`, 400);
      }

      if (qrSession.stopIndex !== route.currentStopIndex) {
        throw new ErrorHandler(
          `Expected stop ${route.currentStopIndex}, got ${qrSession.stopIndex}.`,
          400,
        );
      }

      const stop = route.stops[qrSession.stopIndex];
      if (!stop) {
        throw new ErrorHandler("Stop not found in route.", 404);
      }


      qrSession.verified = true;
      qrSession.verifiedAt = new Date();
      qrSession.verifiedBy = new mongoose.Types.ObjectId(userId.toString());
      await qrSession.save({ session });


      const now = new Date();
      const isLastStop = qrSession.isLastStop;


      stop.actualArrival = stop.actualArrival || now;
      stop.actualDeparture = now;


      if (completedManifestIds?.length) {
        stop.completedManifests = completedManifestIds.map(
          (id) => new mongoose.Types.ObjectId(id),
        );
      }
      if (discrepancyManifestIds?.length) {
        stop.discrepancyManifests = discrepancyManifestIds.map(
          (id) => new mongoose.Types.ObjectId(id),
        );
      }

      await route.completeStop(qrSession.stopIndex, [], [], notes);


      const isHubRoute = route.type === "hub_to_hub" || route.type === "hub_to_branch";

      if (isHubRoute && qrSession.manifestCount > 0) {
        const stopManifestIds = (stop.manifestIds || []).map(
          (id: any) => new mongoose.Types.ObjectId(id.toString()),
        );

        if (stopManifestIds.length > 0) {
          await ManifestModel.updateMany(
            {
              _id: { $in: stopManifestIds },
              status: "in_transit",
            },
            {
              $set: {
                status: "arrived",
                arrivedAt: now,
                "transportLeg.arrivedAt": now,
              },
            },
            { session },
          );

          for (const manifestId of stopManifestIds) {
            const manifest = await ManifestModel.findById(manifestId).session(session);
            if (manifest) {
              await manifest.markArrived(
                new mongoose.Types.ObjectId(userId.toString()),
                session,
              );
            }
          }
        }
      }


      let routeCompleted = false;

      if (isLastStop) {
        await route.completeRoute(notes);

        const transporterDoc = await TransporterModel.findById(transporter._id).session(session);
        if (transporterDoc) {

          if (route.type === "hub_to_hub" && stop.branchId) {
            transporterDoc.currentBranchId = stop.branchId;
          }

          transporterDoc.availabilityStatus = "available";
          transporterDoc.currentRouteId = undefined;
          transporterDoc.lastActiveAt = now;
          transporterDoc.totalTrips += 1;
          transporterDoc.completedTrips += 1;


          const loadCount = isHubRoute ? qrSession.manifestCount : qrSession.packageCount;
          transporterDoc.todayTransportedCount += loadCount;
          transporterDoc.totalManifestsTransported += isHubRoute ? loadCount : 0;
          transporterDoc.todayCompletedTrips += 1;
          transporterDoc.currentActiveManifests = Math.max(
            0,
            transporterDoc.currentActiveManifests - loadCount,
          );

          await transporterDoc.save({ session });
        }

        routeCompleted = true;
      } else {

        const transporterDoc = await TransporterModel.findById(transporter._id).session(session);
        if (transporterDoc) {
          const loadCount = isHubRoute ? qrSession.manifestCount : qrSession.packageCount;
          transporterDoc.todayTransportedCount += loadCount;
          transporterDoc.totalManifestsTransported += isHubRoute ? loadCount : 0;
          transporterDoc.currentActiveManifests = Math.max(
            0,
            transporterDoc.currentActiveManifests - loadCount,
          );
          transporterDoc.lastActiveAt = now;
          await transporterDoc.save({ session });
        }
      }

      await session.commitTransaction();
      transactionCommitted = true;

      res.status(200).json({
        success: true,
        message: routeCompleted
          ? "Stop verified and route completed successfully."
          : "Stop verified successfully. Transporter can proceed to next stop.",
        data: {
          routeId: qrSession.routeId,
          stopIndex: qrSession.stopIndex,
          stopId: qrSession.stopId,
          branchId: qrSession.branchId,
          isLastStop,
          routeCompleted,
          verifiedAt: now,
          nextStopIndex: routeCompleted ? null : route.currentStopIndex,
        },
      });
    } catch (error: any) {
      return next(error);
    } finally {
      if (!transactionCommitted && session.inTransaction()) {
        await session.abortTransaction().catch(() => { });
      }
      await session.endSession();
    }
  },
);




export const getStopQrInfo = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = req.params;

      const qrSession = await StopQrSessionModel.findOne({ code })
        .populate("transporterId", "userId")
        .populate("branchId", "name code")
        .populate("routeId", "routeNumber type")
        .lean();

      if (!qrSession) {
        return res.status(404).json({
          success: false,
          message: "QR session not found.",
        });
      }

      if (qrSession.verified) {
        return res.status(200).json({
          success: false,
          verified: true,
          message: "This stop has already been verified.",
          data: {
            verifiedAt: qrSession.verifiedAt,
          },
        });
      }

      if (new Date() > qrSession.expiresAt) {
        return res.status(200).json({
          success: false,
          expired: true,
          message: "This QR code has expired.",
          data: {
            expiredAt: qrSession.expiresAt,
          },
        });
      }

      res.status(200).json({
        success: true,
        data: {
          sessionId: qrSession._id,
          code: qrSession.code,
          routeNumber: (qrSession.routeId as any)?.routeNumber,
          routeType: (qrSession.routeId as any)?.type,
          branchName: (qrSession.branchId as any)?.name,
          stopIndex: qrSession.stopIndex,
          manifestCount: qrSession.manifestCount,
          packageCount: qrSession.packageCount,
          isLastStop: qrSession.isLastStop,
          expiresAt: qrSession.expiresAt,
        },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error fetching QR info.", 500));
    }
  },
);







export const getMyRoutes = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const userRole = req.user?.role;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }


    let isTransporter = false;
    let isDeliverer = false;
    let transporter = null;
    let deliverer = null;

    if (userRole === "transporter") {
      transporter = await TransporterModel
        .findOne({ userId })
        .select("_id companyId currentBranchId transporterType assignedLine assignedBranches availabilityStatus isActive isSuspended")
        .lean();

      if (!transporter) {
        return next(new ErrorHandler("Transporter profile not found.", 404));
      }
      if (!transporter.isActive || transporter.isSuspended) {
        return next(new ErrorHandler("Transporter account is not active.", 403));
      }
      isTransporter = true;
    } else if (userRole === "deliverer") {
      deliverer = await DelivererModel
        .findOne({ userId })
        .select("_id companyId branchId availabilityStatus isActive isSuspended")
        .lean();

      if (!deliverer) {
        return next(new ErrorHandler("Deliverer profile not found.", 404));
      }
      if (!deliverer.isActive || deliverer.isSuspended) {
        return next(new ErrorHandler("Deliverer account is not active.", 403));
      }
      isDeliverer = true;
    } else {
      return next(new ErrorHandler("Only transporters and deliverers can access this endpoint.", 403));
    }

    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setUTCHours(23, 59, 59, 999);


    let query: any = {
      status: { $in: ["assigned", "active", "paused"] },
      $or: [
        { scheduledStart: { $gte: dayStart, $lte: dayEnd } },
        { actualStart: { $gte: dayStart, $lte: dayEnd } },
      ],
    };

    if (isTransporter) {
      query.assignedTransporterId = transporter!._id;
    } else if (isDeliverer) {
      query.assignedDelivererId = deliverer!._id;
    }

    const routes = await RouteModel
      .find(query)
      .select(
        "_id routeNumber type status " +
        "originBranchId destinationBranchId " +
        "assignedVehicleId " +
        "stops " +
        "distance estimatedTime distanceSource " +
        "totalManifests " +
        "scheduledStart scheduledEnd actualStart actualEnd " +
        "currentStopIndex completedStops "
      )
      .sort({ scheduledStart: 1 })
      .lean();

    if (routes.length === 0) {
      const baseResponse: any = {
        success: true,
        message: "No routes assigned for today.",
        data: {
          role: userRole,
          routes: [],
          totalRoutes: 0,
          canStartFirst: false,
        },
      };

      if (isTransporter) {
        baseResponse.data.transporterId = transporter!._id;
        baseResponse.data.transporterType = transporter!.transporterType ?? "legacy";
      } else if (isDeliverer) {
        baseResponse.data.delivererId = deliverer!._id;
        baseResponse.data.branchId = deliverer!.branchId;
      }

      return res.status(200).json(baseResponse);
    }


    const branchIds = new Set<string>();
    for (const r of routes) {
      if (r.originBranchId) branchIds.add(r.originBranchId.toString());
      if (r.destinationBranchId) branchIds.add(r.destinationBranchId.toString());

      for (const stop of (r.stops as any[])) {
        if (stop.branchId) branchIds.add(stop.branchId.toString());
      }
    }

    const branches = await BranchModel
      .find({ _id: { $in: Array.from(branchIds) } })
      .select("_id name code address.city")
      .lean();

    const branchMap = new Map(
      branches.map((b) => [
        b._id.toString(),
        { name: (b as any).name, code: (b as any).code, city: (b as any).address?.city ?? "" },
      ])
    );


    const activeOrPausedIdx = routes.findIndex(
      (r) => r.status === "active" || r.status === "paused"
    );
    const currentRouteIndex = activeOrPausedIdx !== -1
      ? activeOrPausedIdx
      : routes.findIndex((r) => r.status === "assigned");

    const shapedRoutes = routes.map((r, idx) => {
      const origin = r.originBranchId
        ? branchMap.get(r.originBranchId.toString())
        : null;
      const destination = r.destinationBranchId
        ? branchMap.get(r.destinationBranchId.toString())
        : null;


      const isHubRoute = r.type === "hub_to_hub" || r.type === "hub_to_branch";
      const totalManifests = (r.stops as any[]).reduce(
        (sum: number, s: any) => sum + (s.manifestIds?.length ?? 0), 0
      );
      const totalPackages = (r.stops as any[]).reduce(
        (sum: number, s: any) => sum + (s.packageIds?.length ?? 0), 0
      );

      const isCurrentRoute = idx === currentRouteIndex;
      const isLocked = idx > currentRouteIndex && currentRouteIndex !== -1;


      const stops = (r.stops as any[]).map((s) => ({
        stopId: s._id,
        order: s.order,
        branchId: s.branchId,
        branchName: s.branchId ? branchMap.get(s.branchId.toString())?.name : undefined,
        address: s.address,
        location: s.location?.coordinates,
        status: s.status,
        manifestIds: s.manifestIds ?? [],
        packageIds: s.packageIds ?? [],
        manifestCount: s.manifestIds?.length ?? 0,
        packageCount: s.packageIds?.length ?? 0,
        expectedArrival: s.expectedArrival,
        actualArrival: s.actualArrival,
        action: s.action,
        ...(s.clientId && { clientId: s.clientId }),
        ...(s.recipientName && { recipientName: s.recipientName }),
        ...(s.recipientPhone && { recipientPhone: s.recipientPhone }),
      }));

      const originLabel = origin ? `${origin.name} (${origin.code})` : "—";
      const destinationLabel = destination ? `${destination.name} (${destination.code})` : "—";


      let statusLabel: string;
      let actionHint: string | null = null;

      if (r.status === "active") {
        statusLabel = "In progress";
        actionHint = "Tap to view route progress";
      } else if (r.status === "paused") {
        statusLabel = "Paused";
        actionHint = "Tap to resume";
      } else if (isCurrentRoute) {
        statusLabel = "Assigned — ready to start";
        actionHint = "Tap to start";
      } else if (isLocked) {
        const prevRoute = routes[idx - 1];
        statusLabel = "Assigned";
        actionHint = `Complete ${prevRoute?.routeNumber ?? "previous route"} first`;
      } else {
        statusLabel = "Assigned";
      }

      return {
        routeId: r._id,
        routeNumber: r.routeNumber,
        routeType: r.type,
        status: r.status,
        statusLabel,
        actionHint,
        isCurrentRoute,
        isLocked,

        originBranchId: r.originBranchId,
        destinationBranchId: r.destinationBranchId,
        originLabel,
        destinationLabel,
        originCity: origin?.city ?? "",
        destinationCity: destination?.city ?? "",

        totalManifests,
        totalPackages,
        loadUnit: totalManifests > 0 ? "manifests" : "packages",

        distanceKm: r.distance,
        distanceSource: r.distanceSource,
        estimatedTimeMinutes: r.estimatedTime,
        estimatedTimeLabel: formatMinutes(r.estimatedTime),

        currentStopIndex: r.currentStopIndex,
        completedStops: r.completedStops,
        totalStops: (r.stops as any[]).length,
        progressPercent: (r.stops as any[]).length > 0
          ? Math.round((r.currentStopIndex / (r.stops as any[]).length) * 100)
          : 0,

        scheduledStart: r.scheduledStart,
        scheduledEnd: r.scheduledEnd,
        actualStart: r.actualStart ?? null,
        actualEnd: r.actualEnd ?? null,

        stops,
      };
    });

    const totalManifestsToday = shapedRoutes.reduce((s, r) => s + r.totalManifests, 0);
    const totalPackagesToday = shapedRoutes.reduce((s, r) => s + r.totalPackages, 0);
    const totalDistanceToday = shapedRoutes.reduce((s, r) => s + (r.distanceKm ?? 0), 0);
    const activeRoute = shapedRoutes.find(
      (r) => r.status === "active" || r.status === "paused"
    ) ?? null;

    const responseData: any = {
      role: userRole,
      totalRoutes: shapedRoutes.length,
      totalLoad: isTransporter ? totalManifestsToday : totalPackagesToday,
      loadUnit: isTransporter ? "manifests" : "packages",
      totalDistanceToday: parseFloat(totalDistanceToday.toFixed(1)),
      activeRoute,
      currentRouteIndex,
      canStartFirst: currentRouteIndex === 0 && routes[0]?.status === "assigned",
      routes: shapedRoutes,
    };

    if (isTransporter) {
      responseData.transporterId = transporter!._id;
      responseData.transporterType = transporter!.transporterType ?? "legacy";
    } else if (isDeliverer) {
      responseData.delivererId = deliverer!._id;
      responseData.branchId = deliverer!.branchId;
      responseData.availabilityStatus = deliverer!.availabilityStatus;
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  }
);


function formatMinutes(minutes: number): string {
  if (!minutes || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}




function _formatMinutes(minutes: number): string {
  if (!minutes || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}






const PERMISSIONS = {
  MANAGE_DELIVERERS: "can_manage_deliverers",
  MANAGE_USERS: "can_manage_users",
  MANAGE_CASHIERS: "can_manage_cashiers",
  MANAGE_LOADERS: "can_manage_loaders",
} as const;




async function getRequestingUserRole(
  userId: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
): Promise<string | undefined> {
  const query = userModel.findById(userId).select("role");
  if (session) query.session(session);
  const user = await query.lean();
  return user?.role;
}


async function assertSupervisorOrAdmin(
  requestingUserId: mongoose.Types.ObjectId,
  branchId: string,
  permission: string,
  session: mongoose.ClientSession
): Promise<void> {
  const [role, supervisor] = await Promise.all([
    getRequestingUserRole(requestingUserId, session),
    SupervisorModel.findOne({ userId: requestingUserId, branchId }).session(session),
  ]);

  if (role === "admin") return;

  if (!supervisor || !supervisor.isActive) {
    throw new ErrorHandler("You are not an active supervisor of this branch", 403);
  }

  if (!supervisor.hasPermission(permission as any)) {
    throw new ErrorHandler("You don't have permission to perform this action", 403);
  }
}

/**
 * Generates an auto-incrementing-style employee code that is unique in the DB.
 * Format: PREFIX-BRANCHCODE-NNNNNN (e.g. CSH-ALG-000042)
 * Falls back to a random suffix after 20 collision attempts.
 */
export async function generateEmployeeCode(
  prefix: "CSH" | "LDR",
  branchCode: string,
  Model: typeof CashierModel | typeof LoaderModel
): Promise<string> {
  const tag = branchCode.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5) || "BR";


  for (let attempt = 0; attempt < 20; attempt++) {
    const random = Math.floor(100000 + Math.random() * 900000);
    const code = `${prefix}-${tag}-${random}`;

    const existing = await (Model as any).findOne({ employeeCode: code }).lean();
    if (!existing) return code;
  }


  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(1000 + Math.random() * 9000);
  const fallbackCode = `${prefix}-${tag}-${timestamp}${random}`;

  const existing = await (Model as any).findOne({ employeeCode: fallbackCode }).lean();
  if (!existing) return fallbackCode;

  throw new ErrorHandler("Failed to generate a unique employee code, please try again", 500);
}



interface ICreateCashier {
  email: string;
  phone: string;
  password: string;
  firstName: string;
  lastName: string;
  counterNumber?: number;
  notes?: string;
}

interface IUpdateCashier {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  counterNumber?: number;
  notes?: string;
  // password?: string;
}


export const createCashier = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    console.log("hello")
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const requestingUserId = req.user?._id;
      const { branchId } = req.params;

      if (!requestingUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const {
        email,
        phone,
        password,
        firstName,
        lastName,
        counterNumber,
        notes,
      } = req.body as ICreateCashier;


      if (!email || !phone || !password || !firstName || !lastName) {
        return next(
          new ErrorHandler(
            "email, phone, password, firstName, and lastName are required",
            400
          )
        );
      }
      console.log(req.body)
      console.log("hello 4")
      if (
        typeof email !== "string" ||
        typeof phone !== "string" ||
        typeof password !== "string" ||
        typeof firstName !== "string" ||
        typeof lastName !== "string"
      ) {
        return next(new ErrorHandler("All required fields must be strings", 400));
      }

      if (counterNumber !== undefined && (typeof counterNumber !== "number" || counterNumber < 1 || counterNumber > 999)) {
        return next(new ErrorHandler("counterNumber must be a number between 1 and 999", 400));
      }


      const branch = await BranchModel.findById(branchId).session(session);

      await assertSupervisorOrAdmin(requestingUserId, branchId.toString(), PERMISSIONS.MANAGE_DELIVERERS, session);
      console.log("hello 3")
      if (!branch) {
        throw new ErrorHandler("Branch not found", 404);
      }

      if (branch.status !== "active") {
        throw new ErrorHandler("Cannot create cashier for an inactive branch", 400);
      }


      let normalizedPhone: string;
      try {
        normalizedPhone = userModel.normalizePhone(phone);
      } catch (error: any) {
        throw new ErrorHandler(error.message, 400);
      }

      const [existingEmail, existingPhone] = await Promise.all([
        userModel.findOne({ email }).session(session),
        userModel.findOne({ phone: normalizedPhone }).session(session),
      ]);

      if (existingEmail) throw new ErrorHandler("Email already exists", 400);
      if (existingPhone) throw new ErrorHandler("Phone number already exists", 400);
      console.log("hello 2")
      // ── employee code ────────────────────────────────────────────────────
      const employeeCode = await generateEmployeeCode("CSH", branch.code || branch.name, CashierModel);


      console.log("before create user")
      const [user] = await userModel.create(
        [
          {
            email,
            phone: normalizedPhone,
            passwordHash: password,
            firstName,
            lastName,
            role: "cashier",
            status: "active",
          },
        ],
        { session }
      );
      console.log("after create user")
      const [cashier] = await CashierModel.create(
        [
          {
            userId: user._id,
            companyId: branch.companyId,
            assignedBranchId: branchId,
            employeeCode,
            status: "active",
            ...(counterNumber !== undefined && { counterNumber }),
            ...(notes && { notes }),
          },
        ],
        { session }
      );
      await session.commitTransaction();
      transactionCommitted = true;

      const populated = await CashierModel.findById(cashier._id)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("assignedBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Cashier created successfully",
        data: populated,
      });
    } catch (error: any) {
      console.log(error)
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(", "),
            400
          )
        );
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


export const updateCashier = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const requestingUserId = req.user?._id;
      const { branchId, cashierId } = req.params;

      if (!requestingUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!cashierId || !mongoose.Types.ObjectId.isValid(cashierId.toString())) {
        return next(new ErrorHandler("Invalid cashier ID", 400));
      }

      const body = req.body as IUpdateCashier;

      if (Object.keys(body).length === 0) {
        return next(new ErrorHandler("No update data provided", 400));
      }


      if (body.email !== undefined && typeof body.email !== "string") {
        return next(new ErrorHandler("email must be a string", 400));
      }

      if (body.phone !== undefined && typeof body.phone !== "string") {
        return next(new ErrorHandler("phone must be a string", 400));
      }

      // if (body.password !== undefined && typeof body.password !== "string") {
      //   return next(new ErrorHandler("password must be a string", 400));
      // }

      if (
        body.counterNumber !== undefined &&
        (typeof body.counterNumber !== "number" || body.counterNumber < 1 || body.counterNumber > 99)
      ) {
        return next(new ErrorHandler("counterNumber must be a number between 1 and 99", 400));
      }


      const cashier = await CashierModel.findOne({ _id: cashierId, assignedBranchId: branchId }).session(session);

      await assertSupervisorOrAdmin(requestingUserId, branchId.toString(), PERMISSIONS.MANAGE_DELIVERERS, session);

      if (!cashier) {
        throw new ErrorHandler("Cashier not found in this branch", 404);
      }

      const duplicateChecks: Promise<any>[] = [];

      if (body.email) {
        duplicateChecks.push(
          userModel.findOne({ email: body.email, _id: { $ne: cashier.userId } }).session(session)
        );
      }

      if (body.phone) {
        let normalizedPhone: string;
        try {
          normalizedPhone = userModel.normalizePhone(body.phone);
        } catch (error: any) {
          throw new ErrorHandler(error.message, 400);
        }
        duplicateChecks.push(
          userModel.findOne({ phone: normalizedPhone, _id: { $ne: cashier.userId } }).session(session)
        );
      }

      const duplicateResults = await Promise.all(duplicateChecks);
      if (duplicateResults.some((r) => r !== null)) {
        throw new ErrorHandler("Email or phone already exists", 400);
      }


      const userUpdates: Record<string, any> = {};
      const cashierUpdates: Record<string, any> = {};

      if (body.email) userUpdates.email = body.email;
      if (body.phone) {
        userUpdates.phone = userModel.normalizePhone(body.phone);
      }
      // if (body.password) userUpdates.passwordHash = body.password;
      if (body.firstName) userUpdates.firstName = body.firstName;
      if (body.lastName) userUpdates.lastName = body.lastName;

      if (body.counterNumber !== undefined) cashierUpdates.counterNumber = body.counterNumber;
      if (body.notes !== undefined) cashierUpdates.notes = body.notes;

      if (Object.keys(userUpdates).length > 0) {
        await userModel.findByIdAndUpdate(cashier.userId, { $set: userUpdates }, { session });
      }

      Object.assign(cashier, cashierUpdates);
      await cashier.save({ session });

      await session.commitTransaction();
      transactionCommitted = true;

      const populated = await CashierModel.findById(cashierId)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("assignedBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Cashier updated successfully",
        data: populated,
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(", "),
            400
          )
        );
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



export const toggleBlockCashier = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const requestingUserId = req.user?._id;
      const { branchId, cashierId } = req.params;

      if (!requestingUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!cashierId || !mongoose.Types.ObjectId.isValid(cashierId.toString())) {
        return next(new ErrorHandler("Invalid cashier ID", 400));
      }

      const [cashier, requestingRole] = await Promise.all([
        CashierModel.findOne({ _id: cashierId, assignedBranchId: branchId }).session(session),
        getRequestingUserRole(requestingUserId, session),
      ]);

      if (!cashier) {
        throw new ErrorHandler("Cashier not found in this branch", 404);
      }


      let isAuthorized = requestingRole === "admin";

      if (!isAuthorized && requestingRole === "manager") {
        const manager = await ManagerModel.findOne({
          userId: requestingUserId,
          companyId: cashier.companyId,
        }).session(session);
        isAuthorized = !!(manager && manager.isActive && manager.hasPermission(PERMISSIONS.MANAGE_USERS));
      }

      if (!isAuthorized && requestingRole === "supervisor") {
        const supervisor = await SupervisorModel.findOne({
          userId: requestingUserId,
          branchId,
        }).session(session);
        isAuthorized = !!(
          supervisor &&
          supervisor.isActive &&
          supervisor.hasPermission(PERMISSIONS.MANAGE_DELIVERERS)
        );
      }

      if (!isAuthorized) {
        throw new ErrorHandler("Not authorized to change this cashier's status", 403);
      }


      let newStatus: "active" | "suspended";

      if (cashier.status === "active") {
        newStatus = "suspended";
      } else if (cashier.status === "suspended" || cashier.status === "inactive") {
        newStatus = "active";
      } else {
        throw new ErrorHandler("Cannot toggle cashier with current status", 400);
      }

      cashier.status = newStatus;
      await cashier.save({ session });

      await userModel.findByIdAndUpdate(
        cashier.userId,
        { status: newStatus === "active" ? "active" : "suspended" },
        { session }
      );

      await session.commitTransaction();
      transactionCommitted = true;

      const updated = await CashierModel.findById(cashierId)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("assignedBranchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: `Cashier ${newStatus === "active" ? "activated" : "suspended"} successfully`,
        data: { cashier: updated, status: newStatus },
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(", "),
            400
          )
        );
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


export const getCashier = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const requestingUserId = req.user?._id;
    const { branchId, cashierId } = req.params;

    if (!requestingUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    if (!cashierId || !mongoose.Types.ObjectId.isValid(cashierId.toString())) {
      return next(new ErrorHandler("Invalid cashier ID", 400));
    }

    const [cashier, requestingUser] = await Promise.all([
      CashierModel.findOne({ _id: cashierId, assignedBranchId: branchId })
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("assignedBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean(),
      userModel.findById(requestingUserId).select("role").lean(),
    ]);

    if (!cashier) {
      return next(new ErrorHandler("Cashier not found in this branch", 404));
    }


    const isAdmin = requestingUser?.role === "admin";
    let isAuthorized = isAdmin;

    if (!isAuthorized && requestingUser?.role === "supervisor") {
      const supervisor = await SupervisorModel.findOne({ userId: requestingUserId, branchId }).lean();
      isAuthorized = !!(supervisor && supervisor.isActive);
    }

    if (!isAuthorized && requestingUser?.role === "manager") {
      const manager = await ManagerModel.findOne({
        userId: requestingUserId,
        companyId: (cashier as any).companyId?._id ?? (cashier as any).companyId,
      }).lean();
      isAuthorized = !!(manager && manager.isActive);
    }

    if (!isAuthorized) {
      return next(new ErrorHandler("Not authorized to view this cashier", 403));
    }

    return res.status(200).json({ success: true, data: cashier });
  }
);




export const getMyCashiers = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const requestingUserId = req.user?._id;
    const { branchId } = req.params;

    const { pageNumber = 1, pageSize = 10 } = req.query;

    if (!requestingUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const [branch, requestingUser] = await Promise.all([
      BranchModel.findById(branchId).lean(),
      userModel.findById(requestingUserId).select("role").lean(),
    ]);

    if (!branch) {
      return next(new ErrorHandler("Branch not found", 404));
    }


    const isAdmin = requestingUser?.role === "admin";
    let isAuthorized = isAdmin;

    if (!isAuthorized && requestingUser?.role === "supervisor") {
      const supervisor = await SupervisorModel.findOne({ userId: requestingUserId, branchId }).lean();
      if (!supervisor || !supervisor.isActive) {
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }
      isAuthorized = true;
    }

    if (!isAuthorized && requestingUser?.role === "manager") {
      const manager = await ManagerModel.findOne({
        userId: requestingUserId,
        companyId: branch.companyId,
      }).lean();
      if (!manager || !manager.isActive) {
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }
      isAuthorized = true;
    }

    if (!isAuthorized) {
      return next(new ErrorHandler("Not authorized to view cashiers of this branch", 403));
    }



    const cashierQuery: mongoose.FilterQuery<ICashier> = {
      assignedBranchId: branchId,
    };

    const { status, isCheckedIn, search } = req.query;

    if (status && typeof status === "string") {
      cashierQuery.status = status;
    }


    if (isCheckedIn !== undefined) {
      if (isCheckedIn === "true") {
        cashierQuery["currentShift.status"] = "active";
      } else if (isCheckedIn === "false") {
        cashierQuery.$or = [
          { currentShift: null },
          { "currentShift.status": { $ne: "active" } },
        ];
      }
    }

    if (search && typeof search === "string") {

      const matchingUsers = await userModel
        .find({
          $or: [
            { firstName: { $regex: search, $options: "i" } },
            { lastName: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        })
        .select("_id")
        .lean();

      const matchingUserIds = matchingUsers.map((u) => u._id);

      cashierQuery.$or = [
        ...(matchingUserIds.length > 0 ? [{ userId: { $in: matchingUserIds } }] : []),
        { employeeCode: { $regex: search, $options: "i" } },
      ];


      if (matchingUserIds.length === 0 && !/^CSH-/i.test(search)) {
        return res.status(200).json({ success: true, count: 0, data: [] });
      }
    }

    const count = await CashierModel.countDocuments(cashierQuery);

    const cashiers = await CashierModel.find(cashierQuery)
      .skip((Number(pageNumber) - 1) * Number(pageSize))
      .limit(Number(pageSize))
      .populate("userId", "firstName lastName email phone imageUrl role status")
      .populate("assignedBranchId", "name code address status")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count,
      data: cashiers,
      pagination: {
        pageNumber: Number(pageNumber),
        pageSize: Number(pageSize),
        totalPages: Math.ceil(count / Number(pageSize)),
      },
    });
  }
);





interface ICreateLoader {
  email: string;
  phone: string;
  password: string;
  firstName: string;
  lastName: string;
  notes?: string;
}

interface IUpdateLoader {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  temporaryBranchId?: string | null;
  notes?: string;
  // password?: string;
}


export const createLoader = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const requestingUserId = req.user?._id;
      const { branchId } = req.params;

      if (!requestingUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      const {
        email,
        phone,
        password,
        firstName,
        lastName,
        notes,
      } = req.body as ICreateLoader;


      if (!email || !phone || !password || !firstName || !lastName) {
        return next(
          new ErrorHandler(
            "email, phone, password, firstName, and lastName are required",
            400
          )
        );
      }

      if (
        typeof email !== "string" ||
        typeof phone !== "string" ||
        typeof password !== "string" ||
        typeof firstName !== "string" ||
        typeof lastName !== "string"
      ) {
        return next(new ErrorHandler("All required fields must be strings", 400));
      }


      await assertSupervisorOrAdmin(requestingUserId, branchId.toString(), PERMISSIONS.MANAGE_DELIVERERS, session);

      const branch = await BranchModel.findById(branchId).session(session);

      if (!branch) {
        throw new ErrorHandler("Branch not found", 404);
      }

      if (branch.status !== "active") {
        throw new ErrorHandler("Cannot create loader for an inactive branch", 400);
      }


      let normalizedPhone: string;
      try {
        normalizedPhone = userModel.normalizePhone(phone);
      } catch (error: any) {
        throw new ErrorHandler(error.message, 400);
      }

      const [existingEmail, existingPhone] = await Promise.all([
        userModel.findOne({ email }).session(session),
        userModel.findOne({ phone: normalizedPhone }).session(session),
      ]);

      if (existingEmail) throw new ErrorHandler("Email already exists", 400);
      if (existingPhone) throw new ErrorHandler("Phone number already exists", 400);


      const employeeCode = await generateEmployeeCode("LDR", branch.code || branch.name, LoaderModel);


      const [user] = await userModel.create(
        [
          {
            email,
            phone: normalizedPhone,
            passwordHash: password,
            firstName,
            lastName,
            role: "loader",
            status: "active",
          },
        ],
        { session }
      );

      const [loader] = await LoaderModel.create(
        [
          {
            userId: user._id,
            companyId: branch.companyId,
            assignedBranchId: branchId,
            employeeCode,
            status: "active",
            ...(notes && { notes }),
          },
        ],
        { session }
      );

      await session.commitTransaction();
      transactionCommitted = true;

      const populated = await LoaderModel.findById(loader._id)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("assignedBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Loader created successfully",
        data: populated,
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(", "),
            400
          )
        );
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




export const updateLoader = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const requestingUserId = req.user?._id;
      const { branchId, loaderId } = req.params;

      if (!requestingUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!loaderId || !mongoose.Types.ObjectId.isValid(loaderId.toString())) {
        return next(new ErrorHandler("Invalid loader ID", 400));
      }

      const body = req.body as IUpdateLoader;

      if (Object.keys(body).length === 0) {
        return next(new ErrorHandler("No update data provided", 400));
      }


      if (body.email !== undefined && typeof body.email !== "string") {
        return next(new ErrorHandler("email must be a string", 400));
      }

      if (body.phone !== undefined && typeof body.phone !== "string") {
        return next(new ErrorHandler("phone must be a string", 400));
      }

      // if (body.password !== undefined && typeof body.password !== "string") {
      //   return next(new ErrorHandler("password must be a string", 400));
      // }

      if (
        body.temporaryBranchId !== undefined &&
        body.temporaryBranchId !== null &&
        !mongoose.Types.ObjectId.isValid(body.temporaryBranchId)
      ) {
        return next(new ErrorHandler("Invalid temporaryBranchId", 400));
      }


      const loader = await LoaderModel.findOne({
        _id: loaderId,
        assignedBranchId: branchId,
      }).session(session);

      await assertSupervisorOrAdmin(requestingUserId, branchId.toString(), PERMISSIONS.MANAGE_DELIVERERS, session);

      if (!loader) {
        throw new ErrorHandler("Loader not found in this branch", 404);
      }


      if (body.temporaryBranchId) {
        const tempBranch = await BranchModel.findById(body.temporaryBranchId).session(session);
        if (!tempBranch) {
          throw new ErrorHandler("Temporary branch not found", 404);
        }
      }


      const duplicateChecks: Promise<any>[] = [];

      if (body.email) {
        duplicateChecks.push(
          userModel.findOne({ email: body.email, _id: { $ne: loader.userId } }).session(session)
        );
      }

      if (body.phone) {
        let normalizedPhone: string;
        try {
          normalizedPhone = userModel.normalizePhone(body.phone);
        } catch (error: any) {
          throw new ErrorHandler(error.message, 400);
        }
        duplicateChecks.push(
          userModel.findOne({ phone: normalizedPhone, _id: { $ne: loader.userId } }).session(session)
        );
      }

      const duplicateResults = await Promise.all(duplicateChecks);
      if (duplicateResults.some((r) => r !== null)) {
        throw new ErrorHandler("Email or phone already exists", 400);
      }


      const userUpdates: Record<string, any> = {};
      const loaderUpdates: Record<string, any> = {};

      if (body.email) userUpdates.email = body.email;
      if (body.phone) {
        userUpdates.phone = userModel.normalizePhone(body.phone);
      }
      // if (body.password) userUpdates.passwordHash = body.password;
      if (body.firstName) userUpdates.firstName = body.firstName;
      if (body.lastName) userUpdates.lastName = body.lastName;

      if (body.notes !== undefined) loaderUpdates.notes = body.notes;

      if (body.temporaryBranchId !== undefined) {
        loaderUpdates.temporaryBranchId = body.temporaryBranchId
          ? new mongoose.Types.ObjectId(body.temporaryBranchId)
          : null;
      }

      if (Object.keys(userUpdates).length > 0) {
        await userModel.findByIdAndUpdate(loader.userId, { $set: userUpdates }, { session });
      }

      Object.assign(loader, loaderUpdates);
      await loader.save({ session });

      await session.commitTransaction();
      transactionCommitted = true;

      const populated = await LoaderModel.findById(loaderId)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("assignedBranchId", "name code address status")
        .populate("temporaryBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Loader updated successfully",
        data: populated,
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(", "),
            400
          )
        );
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



export const toggleBlockLoader = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const requestingUserId = req.user?._id;
      const { branchId, loaderId } = req.params;

      if (!requestingUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!loaderId || !mongoose.Types.ObjectId.isValid(loaderId.toString())) {
        return next(new ErrorHandler("Invalid loader ID", 400));
      }

      const [loader, requestingRole] = await Promise.all([
        LoaderModel.findOne({ _id: loaderId, assignedBranchId: branchId }).session(session),
        getRequestingUserRole(requestingUserId, session),
      ]);

      if (!loader) {
        throw new ErrorHandler("Loader not found in this branch", 404);
      }


      let isAuthorized = requestingRole === "admin";

      if (!isAuthorized && requestingRole === "manager") {
        const manager = await ManagerModel.findOne({
          userId: requestingUserId,
          companyId: loader.companyId,
        }).session(session);
        isAuthorized = !!(manager && manager.isActive && manager.hasPermission(PERMISSIONS.MANAGE_USERS));
      }

      if (!isAuthorized && requestingRole === "supervisor") {
        const supervisor = await SupervisorModel.findOne({
          userId: requestingUserId,
          branchId,
        }).session(session);
        isAuthorized = !!(
          supervisor &&
          supervisor.isActive &&
          supervisor.hasPermission(PERMISSIONS.MANAGE_DELIVERERS)
        );
      }

      if (!isAuthorized) {
        throw new ErrorHandler("Not authorized to change this loader's status", 403);
      }


      let newStatus: "active" | "suspended";

      if (loader.status === "active") {
        newStatus = "suspended";
      } else if (loader.status === "suspended" || loader.status === "inactive") {
        newStatus = "active";
      } else {
        throw new ErrorHandler("Cannot toggle loader with current status", 400);
      }

      loader.status = newStatus;
      await loader.save({ session });

      await userModel.findByIdAndUpdate(
        loader.userId,
        { status: newStatus === "active" ? "active" : "suspended" },
        { session }
      );

      await session.commitTransaction();
      transactionCommitted = true;

      const updated = await LoaderModel.findById(loaderId)
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("assignedBranchId", "name code address status")
        .lean();

      return res.status(200).json({
        success: true,
        message: `Loader ${newStatus === "active" ? "activated" : "suspended"} successfully`,
        data: { loader: updated, status: newStatus },
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(", "),
            400
          )
        );
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




export const getLoader = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const requestingUserId = req.user?._id;
    const { branchId, loaderId } = req.params;

    if (!requestingUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    if (!loaderId || !mongoose.Types.ObjectId.isValid(loaderId.toString())) {
      return next(new ErrorHandler("Invalid loader ID", 400));
    }

    const [loader, requestingUser] = await Promise.all([
      LoaderModel.findOne({ _id: loaderId, assignedBranchId: branchId })
        .populate("userId", "firstName lastName email phone imageUrl role status")
        .populate("assignedBranchId", "name code address status")
        .populate("temporaryBranchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean(),
      userModel.findById(requestingUserId).select("role").lean(),
    ]);

    if (!loader) {
      return next(new ErrorHandler("Loader not found in this branch", 404));
    }

    const isAdmin = requestingUser?.role === "admin";
    let isAuthorized = isAdmin;

    if (!isAuthorized && requestingUser?.role === "supervisor") {
      const supervisor = await SupervisorModel.findOne({ userId: requestingUserId, branchId }).lean();
      isAuthorized = !!(supervisor && supervisor.isActive);
    }

    if (!isAuthorized && requestingUser?.role === "manager") {
      const manager = await ManagerModel.findOne({
        userId: requestingUserId,
        companyId: (loader as any).companyId?._id ?? (loader as any).companyId,
      }).lean();
      isAuthorized = !!(manager && manager.isActive);
    }

    if (!isAuthorized) {
      return next(new ErrorHandler("Not authorized to view this loader", 403));
    }

    return res.status(200).json({ success: true, data: loader });
  }
);




export const getMyLoaders = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const requestingUserId = req.user?._id;
    const { branchId } = req.params;

    const { pageNumber = 1, pageSize = 10 } = req.query;

    if (!requestingUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    const [branch, requestingUser] = await Promise.all([
      BranchModel.findById(branchId).lean(),
      userModel.findById(requestingUserId).select("role").lean(),
    ]);

    if (!branch) {
      return next(new ErrorHandler("Branch not found", 404));
    }


    const isAdmin = requestingUser?.role === "admin";
    let isAuthorized = isAdmin;

    if (!isAuthorized && requestingUser?.role === "supervisor") {
      const supervisor = await SupervisorModel.findOne({ userId: requestingUserId, branchId }).lean();
      if (!supervisor || !supervisor.isActive) {
        return next(new ErrorHandler("You are not an active supervisor of this branch", 403));
      }
      isAuthorized = true;
    }

    if (!isAuthorized && requestingUser?.role === "manager") {
      const manager = await ManagerModel.findOne({
        userId: requestingUserId,
        companyId: branch.companyId,
      }).lean();
      if (!manager || !manager.isActive) {
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }
      isAuthorized = true;
    }

    if (!isAuthorized) {
      return next(new ErrorHandler("Not authorized to view loaders of this branch", 403));
    }


    const loaderQuery: mongoose.FilterQuery<ILoader> = {
      $or: [
        { assignedBranchId: branchId },
        { temporaryBranchId: branchId },
      ],
    };

    const { status, isCheckedIn, search } = req.query;

    if (status && typeof status === "string") {
      loaderQuery.status = status;
    }

    if (isCheckedIn !== undefined) {
      if (isCheckedIn === "true") {
        loaderQuery["currentShift.status"] = "active";
      } else if (isCheckedIn === "false") {
        loaderQuery.$and = [
          ...(loaderQuery.$and || []),
          {
            $or: [
              { currentShift: null },
              { "currentShift.status": { $ne: "active" } },
            ],
          },
        ];
      }
    }

    if (search && typeof search === "string") {
      const matchingUsers = await userModel
        .find({
          $or: [
            { firstName: { $regex: search, $options: "i" } },
            { lastName: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        })
        .select("_id")
        .lean();

      const matchingUserIds = matchingUsers.map((u) => u._id);

      const searchOrClauses: any[] = [
        { employeeCode: { $regex: search, $options: "i" } },
      ];
      if (matchingUserIds.length > 0) {
        searchOrClauses.push({ userId: { $in: matchingUserIds } });
      }

      loaderQuery.$and = [
        ...(loaderQuery.$and || []),
        { $or: searchOrClauses },
      ];

      if (matchingUserIds.length === 0 && !/^LDR-/i.test(search)) {
        return res.status(200).json({ success: true, count: 0, data: [] });
      }
    }

    const count = await LoaderModel.countDocuments(loaderQuery);

    const loaders = await LoaderModel.find(loaderQuery)
      .skip((Number(pageNumber) - 1) * Number(pageSize))
      .limit(Number(pageSize))
      .populate("userId", "firstName lastName email phone imageUrl role status")
      .populate("assignedBranchId", "name code address status")
      .populate("temporaryBranchId", "name code address status")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count,
      data: loaders,
      pagination: {
        pageNumber: Number(pageNumber),
        pageSize: Number(pageSize),
        totalPages: Math.ceil(count / Number(pageSize)),
      },
    });
  }
);




export const deleteCashier = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const requestingUserId = req.user?._id;
      const { branchId, cashierId } = req.params;

      if (!requestingUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!cashierId || !mongoose.Types.ObjectId.isValid(cashierId.toString())) {
        return next(new ErrorHandler("Invalid cashier ID", 400));
      }

      const [cashier, branch, requestingUser] = await Promise.all([
        CashierModel.findOne({ _id: cashierId, assignedBranchId: branchId }).session(session),
        BranchModel.findById(branchId).session(session),
        userModel.findById(requestingUserId).select("role").session(session),
      ]);

      if (!cashier) {
        throw new ErrorHandler("Cashier not found", 404);
      }

      if (!branch) {
        throw new ErrorHandler("Branch not found", 404);
      }

      const isAdmin = requestingUser?.role === "admin";
      let isAuthorized = isAdmin;

      if (!isAuthorized && requestingUser?.role === "supervisor") {
        const supervisor = await SupervisorModel.findOne({ userId: requestingUserId, branchId }).session(session);
        if (!supervisor || !supervisor.isActive) {
          throw new ErrorHandler("You are not an active supervisor of this branch", 403);
        }
        isAuthorized = true;
      }

      if (!isAuthorized && requestingUser?.role === "manager") {
        const manager = await ManagerModel.findOne({
          userId: requestingUserId,
          companyId: branch.companyId,
        }).session(session);
        if (!manager || !manager.isActive) {
          throw new ErrorHandler("You are not an active manager of this company", 403);
        }
        isAuthorized = true;
      }

      if (!isAuthorized) {
        throw new ErrorHandler("Not authorized to delete this cashier", 403);
      }


      if (cashier.currentShift && cashier.currentShift.status === "active") {
        throw new ErrorHandler("Cannot delete a cashier that is currently checked in", 400);
      }


      await userModel.findByIdAndDelete(cashier.userId, { session });
      await CashierModel.findByIdAndDelete(cashierId, { session });

      await session.commitTransaction();
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message: "Cashier deleted successfully",
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400
          )
        );
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



export const deleteLoader = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
      const requestingUserId = req.user?._id;
      const { branchId, loaderId } = req.params;

      if (!requestingUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
        return next(new ErrorHandler("Invalid branch ID", 400));
      }

      if (!loaderId || !mongoose.Types.ObjectId.isValid(loaderId.toString())) {
        return next(new ErrorHandler("Invalid loader ID", 400));
      }

      const [loader, branch, requestingUser] = await Promise.all([
        LoaderModel.findOne({
          _id: loaderId,
          $or: [
            { assignedBranchId: branchId },
            { temporaryBranchId: branchId }
          ]
        }).session(session),
        BranchModel.findById(branchId).session(session),
        userModel.findById(requestingUserId).select("role").session(session),
      ]);

      if (!loader) {
        throw new ErrorHandler("Loader not found in this branch", 404);
      }

      if (!branch) {
        throw new ErrorHandler("Branch not found", 404);
      }

      const isAdmin = requestingUser?.role === "admin";
      let isAuthorized = isAdmin;

      if (!isAuthorized && requestingUser?.role === "supervisor") {
        const supervisor = await SupervisorModel.findOne({ userId: requestingUserId, branchId }).session(session);
        if (!supervisor || !supervisor.isActive) {
          throw new ErrorHandler("You are not an active supervisor of this branch", 403);
        }
        isAuthorized = true;
      }

      if (!isAuthorized && requestingUser?.role === "manager") {
        const manager = await ManagerModel.findOne({
          userId: requestingUserId,
          companyId: branch.companyId,
        }).session(session);
        if (!manager || !manager.isActive) {
          throw new ErrorHandler("You are not an active manager of this company", 403);
        }
        isAuthorized = true;
      }

      if (!isAuthorized) {
        throw new ErrorHandler("Not authorized to delete this loader", 403);
      }


      if (loader.currentShift && loader.currentShift.status === "active") {
        throw new ErrorHandler("Cannot delete a loader that is currently checked in", 400);
      }


      await userModel.findByIdAndDelete(loader.userId, { session });
      await LoaderModel.findByIdAndDelete(loaderId, { session });

      await session.commitTransaction();
      transactionCommitted = true;

      return res.status(200).json({
        success: true,
        message: "Loader deleted successfully",
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400
          )
        );
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





//get the only route not completed or cancelled , fi had l7ala lekhra rje3 array fargha
export const getPackagesPaginatedFromRoute = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit as string) || 20),
      );
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;

      const filter: Record<string, any> = {};

      const toObjectId = (val: string) => new mongoose.Types.ObjectId(val);
      const isValidId = (val: string) => mongoose.Types.ObjectId.isValid(val);


      const user = (req as any).user;
      const userRole = user?.role;
      const userId = user?._id;

      let assignedDelivererId: mongoose.Types.ObjectId | null = null;
      let routePackageIds: mongoose.Types.ObjectId[] | null = null;
      let packageStopOrderMap: Map<string, { stopIndex: number; orderInStop: number }> | null = null;


      if (req.query.companyId) {
        if (!isValidId(req.query.companyId as string))
          return next(new ErrorHandler("Invalid companyId.", 400));
        filter.companyId = toObjectId(req.query.companyId as string);
      }


      if (userRole === 'deliverer') {

        const deliverer = await DelivererModel.findOne({ userId: userId });
        if (!deliverer) {
          return next(new ErrorHandler("Deliverer profile not found.", 404));
        }


        const activeRoute = await RouteModel.findOne({
          assignedDelivererId: deliverer._id,
          status: { $in: ['planned', 'assigned', 'active', 'paused'] }
        }).lean();

        if (activeRoute && activeRoute.stops && activeRoute.stops.length > 0) {

          const allPackageIds: mongoose.Types.ObjectId[] = [];
          const stopOrderMap = new Map<string, { stopIndex: number; orderInStop: number }>();

          for (let stopIndex = 0; stopIndex < activeRoute.stops.length; stopIndex++) {
            const stop = activeRoute.stops[stopIndex];
            if (stop.packageIds && stop.packageIds.length > 0) {

              for (let orderInStop = 0; orderInStop < stop.packageIds.length; orderInStop++) {
                const packageId = stop.packageIds[orderInStop];
                allPackageIds.push(packageId);
                stopOrderMap.set(packageId.toString(), {
                  stopIndex: stopIndex,
                  orderInStop: orderInStop
                });
              }
            }
          }

          if (allPackageIds.length > 0) {
            routePackageIds = allPackageIds;
            packageStopOrderMap = stopOrderMap;

            filter._id = { $in: allPackageIds };
          } else {

            routePackageIds = [];
            filter._id = { $in: [] };
          }
        } else {

          routePackageIds = [];
          filter._id = { $in: [] };
        }

        assignedDelivererId = deliverer._id;
      }

      if (userRole === 'cashier') {

      }


      if (req.query.assignedDelivererId && userRole !== 'deliverer') {
        if (!isValidId(req.query.assignedDelivererId as string))
          return next(new ErrorHandler("Invalid assignedDelivererId.", 400));
        assignedDelivererId = toObjectId(req.query.assignedDelivererId as string);
        filter.assignedDelivererId = assignedDelivererId;
      }


      if (req.query.clientId) {
        if (!isValidId(req.query.clientId as string))
          return next(new ErrorHandler("Invalid clientId.", 400));
        filter.clientId = toObjectId(req.query.clientId as string);
      }

      if (req.query.originBranchId) {
        if (!isValidId(req.query.originBranchId as string))
          return next(new ErrorHandler("Invalid originBranchId.", 400));
        filter.originBranchId = toObjectId(req.query.originBranchId as string);
      }

      if (req.query.currentBranchId) {
        if (!isValidId(req.query.currentBranchId as string))
          return next(new ErrorHandler("Invalid currentBranchId.", 400));
        filter.currentBranchId = toObjectId(req.query.currentBranchId as string);
      }


      const VALID_STATUSES: PackageStatus[] = [
        "pending", "accepted", "at_origin_branch", "in_transit_to_branch",
        "at_destination_branch", "out_for_delivery", "delivered",
        "failed_delivery", "failed_delivery_attempt", "rescheduled", "returned", "cancelled",
        "lost", "damaged", "on_hold",
      ];
      if (req.query.status) {
        const s = req.query.status as string;
        if (!VALID_STATUSES.includes(s as PackageStatus))
          return next(new ErrorHandler(`Invalid status: ${s}.`, 400));
        filter.status = s;
      }


      const VALID_TYPES: PackageType[] = [
        "document", "parcel", "fragile", "heavy",
        "perishable", "electronic", "clothing",
      ];
      if (req.query.type) {
        const t = req.query.type as string;
        if (!VALID_TYPES.includes(t as PackageType))
          return next(new ErrorHandler(`Invalid package type: ${t}.`, 400));
        filter.type = t;
      }


      const VALID_PAYMENT_STATUSES: PaymentStatus[] = [
        "pending", "paid", "partially_paid", "refunded", "failed",
      ];
      if (req.query.paymentStatus && req.query.paymentStatus !== "") {
        const ps = req.query.paymentStatus as string;
        if (!VALID_PAYMENT_STATUSES.includes(ps as PaymentStatus))
          return next(new ErrorHandler(`Invalid paymentStatus: ${ps}.`, 400));
        filter.paymentStatus = ps;
      }


      const VALID_PRIORITIES = ["standard", "express", "same_day"];
      if (req.query.deliveryPriority && req.query.deliveryPriority !== "") {
        const dp = req.query.deliveryPriority as string;
        if (!VALID_PRIORITIES.includes(dp))
          return next(new ErrorHandler(`Invalid deliveryPriority: ${dp}.`, 400));
        filter.deliveryPriority = dp;
      }


      const VALID_DELIVERY_TYPES: DeliveryType[] = ["home", "branch_pickup"];
      if (req.query.deliveryType) {
        const dt = req.query.deliveryType as string;
        if (!VALID_DELIVERY_TYPES.includes(dt as DeliveryType))
          return next(new ErrorHandler(`Invalid deliveryType: ${dt}.`, 400));
        filter.deliveryType = dt;
      }


      if (req.query.isFragile !== undefined && req.query.isFragile !== "") {
        filter.isFragile = req.query.isFragile === "true";
      }

      if (req.query.isReturn !== undefined) {
        filter["returnInfo.isReturn"] = req.query.isReturn === "true";
      }

      if (req.query.hasIssues !== undefined) {
        filter.issues =
          req.query.hasIssues === "true"
            ? { $elemMatch: { resolved: false } }
            : { $not: { $elemMatch: { resolved: false } } };
      }


      const applyRange = (
        field: string,
        minKey: string,
        maxKey: string,
      ) => {
        const min = req.query[minKey]
          ? parseFloat(req.query[minKey] as string)
          : null;
        const max = req.query[maxKey]
          ? parseFloat(req.query[maxKey] as string)
          : null;
        if (min !== null || max !== null) {
          filter[field] = {
            ...(min !== null && !isNaN(min) && { $gte: min }),
            ...(max !== null && !isNaN(max) && { $lte: max }),
          };
        }
      };

      applyRange("weight", "minWeight", "maxWeight");
      applyRange("volume", "minVolume", "maxVolume");
      applyRange("dimensions.length", "minLength", "maxLength");
      applyRange("dimensions.width", "minWidth", "maxWidth");
      applyRange("dimensions.height", "minHeight", "maxHeight");


      if (req.query.city) {
        filter["destination.city"] = new RegExp(req.query.city as string, "i");
      }
      if (req.query.state) {
        filter["destination.state"] = new RegExp(req.query.state as string, "i");
      }


      let delivererStats: any = null;
      if (assignedDelivererId) {
        const deliverer = await DelivererModel.findById(assignedDelivererId)
          .lean({ virtuals: true });

        if (deliverer) {

          let statsMatchFilter: any = {};

          if (userRole === 'deliverer' && routePackageIds !== null) {

            if (routePackageIds.length > 0) {
              statsMatchFilter._id = { $in: routePackageIds };
            } else {
              statsMatchFilter._id = { $in: [] };
            }
          } else {

            statsMatchFilter.assignedDelivererId = assignedDelivererId;
          }


          const packageStats = await PackageModel.aggregate([
            {
              $match: statsMatchFilter,
            },
            {
              $group: {
                _id: null,
                totalPackages: { $sum: 1 },
                deliveredPackages: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "delivered"] }, 1, 0],
                  },
                },
                failedPackages: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          "$status",
                          ["failed_delivery", "failed_delivery_attempt", "cancelled", "returned"],
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                inProgressPackages: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          "$status",
                          ["out_for_delivery", "at_destination_branch"],
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                pendingPackages: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          "$status",
                          ["pending", "accepted", "at_origin_branch", "in_transit_to_branch"],
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                totalCollected: {
                  $sum: {
                    $cond: [
                      { $eq: ["$paymentStatus", "paid"] },
                      "$totalPrice",
                      0,
                    ],
                  },
                },
                totalCOD: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$status", "delivered"] },
                          { $eq: ["$paymentMethod", "cod"] },
                        ],
                      },
                      "$totalPrice",
                      0,
                    ],
                  },
                },
              },
            },
          ]);

          const stats = packageStats[0] || {
            totalPackages: 0,
            deliveredPackages: 0,
            failedPackages: 0,
            inProgressPackages: 0,
            pendingPackages: 0,
            totalCollected: 0,
            totalCOD: 0,
          };

          delivererStats = {
            id: deliverer._id,
            userId: deliverer.userId,
            branchId: deliverer.branchId,
            companyId: deliverer.companyId,
            availabilityStatus: deliverer.availabilityStatus,
            verificationStatus: deliverer.verificationStatus,
            isActive: deliverer.isActive,
            isOnline: deliverer.isOnline,
            isSuspended: deliverer.isSuspended,
            isVerified: deliverer.isVerified,
            isAvailable: deliverer.isAvailable,
            isOnDuty: deliverer.isOnDuty,
            rating: deliverer.rating,
            successRate: deliverer.successRate,
            totalDeliveries: deliverer.totalDeliveries,
            successfulDeliveries: deliverer.successfulDeliveries,
            failedDeliveries: deliverer.failedDeliveries,
            todayDeliveriesCount: deliverer.todayDeliveriesCount,
            todayEarnings: deliverer.todayEarnings,
            todayCollectedAmount: deliverer.todayCollectedAmount,
            commission: deliverer.commission,
            totalEarnings: deliverer.totalEarnings,
            pendingBranchReturn: deliverer.pendingBranchReturn,
            performance: {
              averageDeliveryTime: deliverer.performance?.averageDeliveryTime ?? 0,
              onTimeDeliveryRate: deliverer.performance?.onTimeDeliveryRate ?? 0,
              customerSatisfaction: deliverer.performance?.customerSatisfaction ?? 0,
              totalDistanceCovered: deliverer.performance?.totalDistanceCovered ?? 0,
            },
            packageStats: {
              totalAssigned: stats.totalPackages,
              delivered: stats.deliveredPackages,
              failed: stats.failedPackages,
              inProgress: stats.inProgressPackages,
              pending: stats.pendingPackages,
              totalCollected: stats.totalCollected,
              totalCOD: stats.totalCOD,
            },
            documentStatus: deliverer.documentStatus,
            hasValidLicense: deliverer.hasValidLicense,
            canAcceptDeliveries: deliverer.canAcceptDeliveries,
            currentVehicleId: deliverer.currentVehicleId ?? null,
            currentRouteId: deliverer.currentRouteId ?? null,
            suspensionReason: deliverer.suspensionReason ?? null,
            lastActiveAt: deliverer.lastActiveAt,
          };
        }
      }


      const [total, packages] = await Promise.all([
        PackageModel.countDocuments(filter),
        PackageModel.find(filter)
          .skip(skip)
          .limit(limit)
          .lean({ virtuals: true }),
      ]);


      let filteredPackages = packages as any[];
      if (req.query.isOverdue !== undefined) {
        const wantOverdue = req.query.isOverdue === "true";
        filteredPackages = filteredPackages.filter((pkg) => pkg.isOverdue === wantOverdue);
      }


      if (userRole === 'deliverer' && packageStopOrderMap) {
        filteredPackages.sort((a, b) => {
          const orderA = packageStopOrderMap.get(a._id.toString());
          const orderB = packageStopOrderMap.get(b._id.toString());


          if (orderA && orderB) {
            if (orderA.stopIndex !== orderB.stopIndex) {
              return orderA.stopIndex - orderB.stopIndex;
            }
            return orderA.orderInStop - orderB.orderInStop;
          }


          if (orderA) return -1;
          if (orderB) return 1;
          return 0;
        });
      } else {

        const sortBy = (req.query.sortBy as string) || "createdAt";
        const order = req.query.order === "desc" ? -1 : 1;

        switch (sortBy) {
          case "estimatedTimeRemaining":
            filteredPackages.sort((a, b) => {
              const aVal = a.estimatedTimeRemaining ?? Infinity;
              const bVal = b.estimatedTimeRemaining ?? Infinity;
              return (aVal - bVal) * order;
            });
            break;
          case "weight":
            filteredPackages.sort((a, b) => (a.weight - b.weight) * order);
            break;
          case "totalPrice":
            filteredPackages.sort((a, b) => (a.totalPrice - b.totalPrice) * order);
            break;
          case "createdAt":
            filteredPackages.sort(
              (a, b) =>
                (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * order,
            );
            break;
          case "attemptCount":
            filteredPackages.sort((a, b) => (a.attemptCount - b.attemptCount) * order);
            break;
          default:
            if (order === -1) filteredPackages.reverse();
        }
      }


      const formattedPackages = filteredPackages.map((pkg) => ({
        id: pkg._id,
        trackingNumber: pkg.trackingNumber,
        status: pkg.status,
        type: pkg.type,
        isFragile: pkg.isFragile,
        senderId: pkg.senderId,
        senderType: pkg.senderType,
        clientId: pkg.clientId ?? null,
        weight: pkg.weight,
        volume: pkg.volume ?? null,
        dimensions: pkg.dimensions ?? null,
        destination: {
          recipientName: pkg.destination.recipientName,
          recipientPhone: pkg.destination.recipientPhone,
          alternativePhone: pkg.destination.alternativePhone ?? null,
          address: pkg.destination.address,
          city: pkg.destination.city,
          state: pkg.destination.state,
          postalCode: pkg.destination.postalCode ?? null,
          notes: pkg.destination.notes ?? null,
          coordinates: pkg.deliveryType === "home" && pkg.destination.location?.coordinates
            ? {
              type: pkg.destination.location.type || "Point",
              coordinates: pkg.destination.location.coordinates,
            }
            : null,
        },
        description: pkg.description ?? null,
        deliveryType: pkg.deliveryType,
        deliveryPriority: pkg.deliveryPriority,
        estimatedDeliveryTime: pkg.estimatedDeliveryTime ?? null,
        estimatedTimeRemaining: pkg.estimatedTimeRemaining ?? null,
        isOverdue: pkg.isOverdue,
        deliveryProgress: pkg.deliveryProgress,
        canBeDelivered: pkg.canBeDelivered,
        needsAttention: pkg.needsAttention,
        isInTransit: pkg.isInTransit,
        isAtBranch: pkg.isAtBranch,
        totalPrice: pkg.totalPrice,
        paymentStatus: pkg.paymentStatus,
        paymentMethod: pkg.paymentMethod ?? null,
        paidAt: pkg.paidAt ?? null,
        assignedDelivererId: pkg.assignedDelivererId ?? null,
        assignedVehicleId: pkg.assignedVehicleId ?? null,
        attemptCount: pkg.attemptCount,
        maxAttempts: pkg.maxAttempts,
        lastAttemptDate: pkg.lastAttemptDate ?? null,
        nextAttemptDate: pkg.nextAttemptDate ?? null,
        returnInfo: pkg.returnInfo,
        unresolvedIssuesCount: (pkg.issues as IIssue[]).filter(
          (i) => !i.resolved,
        ).length,
        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
        deliveredAt: pkg.deliveredAt ?? null,
      }));


      const responseData: any = {
        packages: formattedPackages,
        pagination: {
          total: filteredPackages.length,
          page,
          limit,
          pages: Math.ceil(filteredPackages.length / limit),
          hasMore: filteredPackages.length > skip + limit,
        },
        filters: {
          status: req.query.status ?? null,
          type: req.query.type ?? null,
          paymentStatus: req.query.paymentStatus ?? null,
          deliveryPriority: req.query.deliveryPriority ?? null,
          deliveryType: req.query.deliveryType ?? null,
          isFragile: req.query.isFragile ?? null,
          isOverdue: req.query.isOverdue ?? null,
          isReturn: req.query.isReturn ?? null,
          hasIssues: req.query.hasIssues ?? null,
          minWeight: req.query.minWeight ?? null,
          maxWeight: req.query.maxWeight ?? null,
          minVolume: req.query.minVolume ?? null,
          maxVolume: req.query.maxVolume ?? null,
          minLength: req.query.minLength ?? null,
          maxLength: req.query.maxLength ?? null,
          minWidth: req.query.minWidth ?? null,
          maxWidth: req.query.maxWidth ?? null,
          minHeight: req.query.minHeight ?? null,
          maxHeight: req.query.maxHeight ?? null,
          city: req.query.city ?? null,
          state: req.query.state ?? null,
          clientId: req.query.clientId ?? null,
          companyId: req.query.companyId ?? null,
          originBranchId: req.query.originBranchId ?? null,
          currentBranchId: req.query.currentBranchId ?? null,
          assignedDelivererId: req.query.assignedDelivererId ?? null,
          sortBy: req.query.sortBy ?? "route_order",
          order: req.query.order ?? "asc",
        },
      };


      if (delivererStats) {
        responseData.delivererStats = delivererStats;
      }

      res.status(200).json({
        success: true,
        data: responseData,
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400,
          ),
        );
      }
      return next(
        new ErrorHandler(error.message || "Error fetching packages.", 500),
      );
    }
  },
);










export const completeDeliveryByQrCode = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const delivererUserId = req.user?._id;

      if (!delivererUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (req.user?.role !== "deliverer") {
        return next(new ErrorHandler("Only deliverers can complete deliveries.", 403));
      }


      const { payload, coordinates, notes } = req.body;

      if (!payload || typeof payload !== "string") {
        return next(new ErrorHandler("Valid payload is required.", 400));
      }

      if (!coordinates || coordinates.length !== 2) {
        return next(new ErrorHandler("Valid coordinates [lng, lat] are required.", 400));
      }


      let qrPayload;
      try {
        const decodedString = Buffer.from(payload, 'base64').toString();
        qrPayload = JSON.parse(decodedString);
      } catch (error) {
        return next(new ErrorHandler("Invalid payload format. Unable to decode QR data.", 400));
      }


      const { sessionId, code, packageId, trackingNumber, timestamp } = qrPayload;

      if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
        return next(new ErrorHandler("Valid sessionId is required in payload.", 400));
      }

      if (!code || typeof code !== "string") {
        return next(new ErrorHandler("QR code is required in payload.", 400));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId)) {
        return next(new ErrorHandler("Valid packageId is required in payload.", 400));
      }

      const deliverer = await DelivererModel.findOne({ userId: delivererUserId }).lean();
      if (!deliverer) {
        return next(new ErrorHandler("Deliverer profile not found.", 404));
      }

      if (!deliverer.isActive || deliverer.isSuspended) {
        return next(new ErrorHandler("Deliverer account is not active.", 403));
      }


      const route = await RouteModel.findOne({
        assignedDelivererId: deliverer._id,
        status: "active",
        "stops.packageIds": new mongoose.Types.ObjectId(packageId),
      });

      if (!route) {
        return next(new ErrorHandler("No active route found for this package.", 404));
      }


      const stopIndex = route.stops.findIndex((stop: any) =>
        stop.packageIds.some((id: mongoose.Types.ObjectId) => id.toString() === packageId)
      );

      if (stopIndex === -1) {
        return next(new ErrorHandler("Package not found in current route stops.", 404));
      }

      if (stopIndex !== route.currentStopIndex) {
        return next(new ErrorHandler(
          `Expected stop ${route.currentStopIndex}, but package is at stop ${stopIndex}. Please complete current stop first.`,
          400
        ));
      }

      const qrSession = await DeliveryQrSession.findById(sessionId);
      if (!qrSession) {
        return next(new ErrorHandler("QR session not found.", 404));
      }


      if (qrSession.packageId.toString() !== packageId) {
        return next(new ErrorHandler("QR session does not match the package.", 400));
      }

      const socketService = (global as any).socketService as SocketService | undefined;
      if (!socketService) {
        return next(new ErrorHandler("Socket service not available. Please try again later.", 500));
      }

      const delivererSocketId = socketService.getSocketId(delivererUserId.toString(), "deliverer");

      if (!delivererSocketId) {
        return next(new ErrorHandler("Deliverer is not connected to socket. Please check your connection.", 400));
      }

      const io = (socketService as any).io;
      if (!io) {
        return next(new ErrorHandler("Socket IO not available.", 500));
      }


      io.to(delivererSocketId).emit("complete_delivery", {
        sessionId,
        qrCode: code,
        routeId: route._id.toString(),
        stopIndex,
        coordinates,
        notes: notes || "",
      });

      return res.status(200).json({
        success: true,
        message: "QR scan submitted for processing. Delivery will be completed shortly.",
        data: {
          sessionId,
          packageId,
          trackingNumber,
          routeId: route._id,
          stopIndex,
          status: "processing",
        },
      });
    } catch (error: any) {
      console.error("[HTTP Bridge] Error:", error);

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

      return next(new ErrorHandler(error.message || "Failed to process QR scan.", 500));
    }
  }
);






export const startRouteByQrCode = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterUserId = req.user?._id;

      if (!transporterUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (req.user?.role !== "transporter") {
        return next(new ErrorHandler("Only transporters can start routes via QR.", 403));
      }

      const { payload, coordinates } = req.body;

      if (!payload || typeof payload !== "string") {
        return next(new ErrorHandler("Valid payload is required.", 400));
      }

      if (!coordinates || coordinates.length !== 2) {
        return next(new ErrorHandler("Valid coordinates [lng, lat] are required.", 400));
      }

      let qrPayload;
      try {
        const decodedString = Buffer.from(payload, 'base64').toString();
        qrPayload = JSON.parse(decodedString);
      } catch (error) {
        return next(new ErrorHandler("Invalid payload format. Unable to decode QR data.", 400));
      }

      const { sessionId, code, routeId, stopIndex, type } = qrPayload;

      if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
        return next(new ErrorHandler("Valid sessionId is required in payload.", 400));
      }

      if (!code || typeof code !== "string") {
        return next(new ErrorHandler("QR code is required in payload.", 400));
      }

      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId)) {
        return next(new ErrorHandler("Valid routeId is required in payload.", 400));
      }

      if (type !== "start_route") {
        return next(new ErrorHandler("This QR is not a start route QR.", 400));
      }

      if (stopIndex !== -1) {
        return next(new ErrorHandler("Invalid QR type. Expected start route QR.", 400));
      }

      const transporter = await TransporterModel.findOne({ userId: transporterUserId }).lean();
      if (!transporter) {
        return next(new ErrorHandler("Transporter profile not found.", 404));
      }

      const qrSession = await StopQrSessionModel.findById(sessionId);
      if (!qrSession) {
        return next(new ErrorHandler("QR session not found.", 404));
      }

      if (qrSession.routeId.toString() !== routeId) {
        return next(new ErrorHandler("QR session does not match the route.", 400));
      }

      if (qrSession.stopIndex !== -1) {
        return next(new ErrorHandler("This QR is not a start route QR.", 400));
      }

      const socketService = (global as any).socketService as SocketService | undefined;
      if (!socketService) {
        return next(new ErrorHandler("Socket service not available. Please try again later.", 500));
      }

      const transporterSocketId = socketService.getSocketId(transporterUserId.toString(), "transporter");

      if (!transporterSocketId) {
        return next(new ErrorHandler("Transporter is not connected to socket. Please check your connection.", 400));
      }

      const io = (socketService as any).io;
      if (!io) {
        return next(new ErrorHandler("Socket IO not available.", 500));
      }

      io.to(transporterSocketId).emit("start_route", {
        routeId,
        sessionId,
        qrCode: code,
        coordinates,
      });

      return res.status(200).json({
        success: true,
        message: "QR scan submitted. Route will start shortly.",
        data: {
          sessionId,
          routeId,
          status: "processing",
        },
      });
    } catch (error: any) {
      console.error("[HTTP Bridge] Error in startRouteByQrCode:", error);
      return next(new ErrorHandler(error.message || "Failed to process QR scan.", 500));
    }
  }
);





export const arriveAtStopByQrCode = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterUserId = req.user?._id;

      if (!transporterUserId) {
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (req.user?.role !== "transporter") {
        return next(new ErrorHandler("Only transporters can arrive at stops via QR.", 403));
      }

      const { payload, coordinates, completedManifestIds, discrepancyManifestIds, notes } = req.body;

      if (!payload || typeof payload !== "string") {
        return next(new ErrorHandler("Valid payload is required.", 400));
      }

      if (!coordinates || coordinates.length !== 2) {
        return next(new ErrorHandler("Valid coordinates [lng, lat] are required.", 400));
      }

      let qrPayload;
      try {
        const decodedString = Buffer.from(payload, 'base64').toString();
        qrPayload = JSON.parse(decodedString);
      } catch (error) {
        return next(new ErrorHandler("Invalid payload format. Unable to decode QR data.", 400));
      }

      const { sessionId, code, routeId, stopIndex, type } = qrPayload;

      if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
        return next(new ErrorHandler("Valid sessionId is required in payload.", 400));
      }

      if (!code || typeof code !== "string") {
        return next(new ErrorHandler("QR code is required in payload.", 400));
      }

      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId)) {
        return next(new ErrorHandler("Valid routeId is required in payload.", 400));
      }

      if (stopIndex === undefined || stopIndex < 0) {
        return next(new ErrorHandler("Valid stopIndex is required in payload.", 400));
      }

      if (type !== "stop_verification") {
        return next(new ErrorHandler("This QR is not a stop verification QR.", 400));
      }

      const transporter = await TransporterModel.findOne({ userId: transporterUserId }).lean();
      if (!transporter) {
        return next(new ErrorHandler("Transporter profile not found.", 404));
      }

      const qrSession = await StopQrSessionModel.findById(sessionId);
      if (!qrSession) {
        return next(new ErrorHandler("QR session not found.", 404));
      }

      if (qrSession.routeId.toString() !== routeId) {
        return next(new ErrorHandler("QR session does not match the route.", 400));
      }

      if (qrSession.stopIndex !== stopIndex) {
        return next(new ErrorHandler("QR session stopIndex mismatch.", 400));
      }

      const socketService = (global as any).socketService as SocketService | undefined;
      if (!socketService) {
        return next(new ErrorHandler("Socket service not available. Please try again later.", 500));
      }

      const transporterSocketId = socketService.getSocketId(transporterUserId.toString(), "transporter");

      if (!transporterSocketId) {
        return next(new ErrorHandler("Transporter is not connected to socket. Please check your connection.", 400));
      }

      const io = (socketService as any).io;
      if (!io) {
        return next(new ErrorHandler("Socket IO not available.", 500));
      }

      io.to(transporterSocketId).emit("scan_stop_qr", {
        sessionId,
        qrCode: code,
        routeId,
        stopIndex,
        coordinates,
        completedManifestIds,
        discrepancyManifestIds,
        notes,
      });

      return res.status(200).json({
        success: true,
        message: "QR scan submitted. Stop verification processing.",
        data: {
          sessionId,
          routeId,
          stopIndex,
          status: "processing",
        },
      });
    } catch (error: any) {
      console.error("[HTTP Bridge] Error in arriveAtStopByQrCode:", error);
      return next(new ErrorHandler(error.message || "Failed to process QR scan.", 500));
    }
  }
);


export const searchDeliveries = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const delivererUserId = req.user?._id;
      if (!delivererUserId) {
        return next(new ErrorHandler("Unauthorized — user not found.", 401));
      }

      const deliverer = await DelivererModel.findOne({ userId: delivererUserId }).lean();
      if (!deliverer) {
        return next(new ErrorHandler("Deliverer profile not found.", 404));
      }

      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;

      const rawSearch = (req.query.q as string)?.trim() ?? "";


      type PeriodFilter = "today" | "yesterday" | "last7days" | "last30days" | "last6months" | "custom" | "all";
      const period = req.query.period ? (req.query.period as PeriodFilter) : "all";

      let dateFilter: Record<string, any> = {};

      if (period !== "all") {
        const now = new Date();
        let startDate: Date;
        let endDate: Date = new Date();

        switch (period) {
          case "today":
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
            dateFilter = { $gte: startDate, $lt: endDate };
            break;
          case "yesterday":
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
            dateFilter = { $gte: startDate, $lt: endDate };
            break;
          case "last7days":
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            startDate.setHours(0, 0, 0, 0);
            dateFilter = { $gte: startDate };
            break;
          case "last30days":
            startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            startDate.setHours(0, 0, 0, 0);
            dateFilter = { $gte: startDate };
            break;
          case "last6months":
            startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
            dateFilter = { $gte: startDate };
            break;
          case "custom":
            if (req.query.startDate && req.query.endDate) {
              dateFilter = {
                $gte: new Date(req.query.startDate as string),
                $lte: new Date(req.query.endDate as string),
              };
            }
            break;
        }
      }


      const routesPipeline: any[] = [
        {
          $match: {
            assignedDelivererId: deliverer._id,
            status: { $in: ['completed', 'active', 'paused', 'cancelled'] },
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $project: {
            _id: 1,
            routeNumber: 1,
            status: 1,
            createdAt: 1,
            stops: 1,
          },
        },
      ];

      const routes = await RouteModel.aggregate(routesPipeline);

      if (routes.length === 0) {
        res.status(200).json({
          success: true,
          data: {
            packages: [],
            total: 0,
            page,
            limit,
            totalPages: 0,
            hasMore: false,
            query: rawSearch || null,
            period: period === "all" ? "all_time" : period,
          },
        });
        return;
      }


      const allPackageIds: mongoose.Types.ObjectId[] = [];
      routes.forEach(route => {
        route.stops?.forEach((stop: IRouteStop) => {
          if (stop.packageIds && stop.packageIds.length > 0) {
            allPackageIds.push(...stop.packageIds);
          }
        });
      });

      if (allPackageIds.length === 0) {
        res.status(200).json({
          success: true,
          data: {
            packages: [],
            total: 0,
            page,
            limit,
            totalPages: 0,
            hasMore: false,
            query: rawSearch || null,
            period: period === "all" ? "all_time" : period,
          },
        });
        return;
      }


      const matchStage: Record<string, any> = {
        _id: { $in: allPackageIds },
      };


      if (req.query.companyId) {
        if (!mongoose.Types.ObjectId.isValid(req.query.companyId as string)) {
          return next(new ErrorHandler("Invalid companyId.", 400));
        }
        matchStage.companyId = new mongoose.Types.ObjectId(req.query.companyId as string);
      }


      if (req.query.clientId) {
        if (!mongoose.Types.ObjectId.isValid(req.query.clientId as string)) {
          return next(new ErrorHandler("Invalid clientId.", 400));
        }
        matchStage.clientId = new mongoose.Types.ObjectId(req.query.clientId as string);
      }


      if (Object.keys(dateFilter).length > 0) {
        matchStage.createdAt = dateFilter;
      }


      const FAILED_STATUS_GROUP = ["failed_delivery", "cancelled", "returned"];
      const DELIVERED_STATUS_GROUP = ["delivered"];
      const IN_PROGRESS_STATUS_GROUP = ["out_for_delivery", "at_destination_branch", "in_transit_to_branch"];
      const PENDING_STATUS_GROUP = ["pending", "accepted", "at_origin_branch"];


      const VALID_STATUSES: PackageStatus[] = [
        "pending", "accepted", "at_origin_branch", "in_transit_to_branch",
        "at_destination_branch", "out_for_delivery", "delivered", 'failed_delivery_attempt',
        "failed_delivery", "rescheduled", "returned", "cancelled",
        "lost", "damaged", "on_hold",
      ];


      const expandStatusGroup = (statusValue: string): string[] => {
        switch (statusValue.toLowerCase()) {
          case "failed":
          case "failed_group":
            return FAILED_STATUS_GROUP;
          case "delivered_group":
            return DELIVERED_STATUS_GROUP;
          case "in_progress":
          case "in_progress_group":
            return IN_PROGRESS_STATUS_GROUP;
          case "pending_group":
            return PENDING_STATUS_GROUP;
          default:
            return [statusValue];
        }
      };

      if (req.query.statuses) {
        const rawStatuses = (req.query.statuses as string).split(",").map(s => s.trim());

        const expandedStatuses: string[] = [];
        for (const status of rawStatuses) {
          const expanded = expandStatusGroup(status);
          expandedStatuses.push(...expanded);
        }

        const uniqueStatuses = [...new Set(expandedStatuses)];

        const invalidStatuses = uniqueStatuses.filter(s => !VALID_STATUSES.includes(s as PackageStatus));
        if (invalidStatuses.length > 0) {
          return next(new ErrorHandler(`Invalid status(es): ${invalidStatuses.join(", ")}`, 400));
        }
        matchStage.status = { $in: uniqueStatuses };
      } else if (req.query.status) {
        const s = req.query.status as string;

        const expanded = expandStatusGroup(s);
        if (expanded.length > 1 || expanded[0] !== s) {

          const invalidStatuses = expanded.filter(stat => !VALID_STATUSES.includes(stat as PackageStatus));
          if (invalidStatuses.length > 0) {
            return next(new ErrorHandler(`Invalid status(es) in group: ${invalidStatuses.join(", ")}`, 400));
          }
          matchStage.status = { $in: expanded };
        } else {

          if (!VALID_STATUSES.includes(s as PackageStatus)) {
            return next(new ErrorHandler(`Invalid status: ${s}`, 400));
          }
          matchStage.status = s;
        }
      }


      const VALID_TYPES: PackageType[] = [
        "document", "parcel", "fragile", "heavy",
        "perishable", "electronic", "clothing",
      ];

      if (req.query.types) {
        const typesArray = (req.query.types as string).split(",").map(t => t.trim());
        const invalidTypes = typesArray.filter(t => !VALID_TYPES.includes(t as PackageType));
        if (invalidTypes.length > 0) {
          return next(new ErrorHandler(`Invalid type(s): ${invalidTypes.join(", ")}`, 400));
        }
        matchStage.type = { $in: typesArray };
      } else if (req.query.type) {
        const t = req.query.type as string;
        if (!VALID_TYPES.includes(t as PackageType)) {
          return next(new ErrorHandler(`Invalid package type: ${t}`, 400));
        }
        matchStage.type = t;
      }


      const VALID_PAYMENT_STATUSES: PaymentStatus[] = [
        "pending", "paid", "partially_paid", "refunded", "failed",
      ];

      if (req.query.paymentStatuses) {
        const psArray = (req.query.paymentStatuses as string).split(",").map(ps => ps.trim());
        const invalidPS = psArray.filter(ps => !VALID_PAYMENT_STATUSES.includes(ps as PaymentStatus));
        if (invalidPS.length > 0) {
          return next(new ErrorHandler(`Invalid paymentStatus(es): ${invalidPS.join(", ")}`, 400));
        }
        matchStage.paymentStatus = { $in: psArray };
      } else if (req.query.paymentStatus) {
        const ps = req.query.paymentStatus as string;
        if (!VALID_PAYMENT_STATUSES.includes(ps as PaymentStatus)) {
          return next(new ErrorHandler(`Invalid paymentStatus: ${ps}`, 400));
        }
        matchStage.paymentStatus = ps;
      }


      const VALID_PRIORITIES = ["standard", "express", "same_day"];

      if (req.query.deliveryPriorities) {
        const dpArray = (req.query.deliveryPriorities as string).split(",").map(dp => dp.trim());
        const invalidDP = dpArray.filter(dp => !VALID_PRIORITIES.includes(dp));
        if (invalidDP.length > 0) {
          return next(new ErrorHandler(`Invalid deliveryPriority(es): ${invalidDP.join(", ")}`, 400));
        }
        matchStage.deliveryPriority = { $in: dpArray };
      } else if (req.query.deliveryPriority) {
        const dp = req.query.deliveryPriority as string;
        if (!VALID_PRIORITIES.includes(dp)) {
          return next(new ErrorHandler(`Invalid deliveryPriority: ${dp}`, 400));
        }
        matchStage.deliveryPriority = dp;
      }


      const VALID_DELIVERY_TYPES: DeliveryType[] = ["home", "branch_pickup"];

      if (req.query.deliveryTypes) {
        const dtArray = (req.query.deliveryTypes as string).split(",").map(dt => dt.trim());
        const invalidDT = dtArray.filter(dt => !VALID_DELIVERY_TYPES.includes(dt as DeliveryType));
        if (invalidDT.length > 0) {
          return next(new ErrorHandler(`Invalid deliveryType(s): ${invalidDT.join(", ")}`, 400));
        }
        matchStage.deliveryType = { $in: dtArray };
      } else if (req.query.deliveryType) {
        const dt = req.query.deliveryType as string;
        if (!VALID_DELIVERY_TYPES.includes(dt as DeliveryType)) {
          return next(new ErrorHandler(`Invalid deliveryType: ${dt}`, 400));
        }
        matchStage.deliveryType = dt;
      }


      if (req.query.isFragile !== undefined) {
        matchStage.isFragile = req.query.isFragile === "true";
      }


      if (req.query.isReturn !== undefined) {
        matchStage["returnInfo.isReturn"] = req.query.isReturn === "true";
      }


      if (req.query.hasIssues !== undefined) {
        if (req.query.hasIssues === "true") {
          matchStage["issues"] = { $elemMatch: { resolved: false } };
        } else {
          matchStage["issues"] = {
            $not: { $elemMatch: { resolved: false } },
          };
        }
      }


      if (req.query.needsAttention === "true") {
        matchStage.status = {
          $in: ["failed_delivery", "damaged", "lost", "on_hold"],
        };
      }


      if (req.query.minWeight || req.query.maxWeight) {
        matchStage.weight = {
          ...(req.query.minWeight && { $gte: parseFloat(req.query.minWeight as string) }),
          ...(req.query.maxWeight && { $lte: parseFloat(req.query.maxWeight as string) }),
        };
      }


      if (req.query.minVolume || req.query.maxVolume) {
        matchStage.volume = {
          ...(req.query.minVolume && { $gte: parseFloat(req.query.minVolume as string) }),
          ...(req.query.maxVolume && { $lte: parseFloat(req.query.maxVolume as string) }),
        };
      }


      if (req.query.minLength || req.query.maxLength) {
        matchStage["dimensions.length"] = {
          ...(req.query.minLength && { $gte: parseFloat(req.query.minLength as string) }),
          ...(req.query.maxLength && { $lte: parseFloat(req.query.maxLength as string) }),
        };
      }

      if (req.query.minWidth || req.query.maxWidth) {
        matchStage["dimensions.width"] = {
          ...(req.query.minWidth && { $gte: parseFloat(req.query.minWidth as string) }),
          ...(req.query.maxWidth && { $lte: parseFloat(req.query.maxWidth as string) }),
        };
      }

      if (req.query.minHeight || req.query.maxHeight) {
        matchStage["dimensions.height"] = {
          ...(req.query.minHeight && { $gte: parseFloat(req.query.minHeight as string) }),
          ...(req.query.maxHeight && { $lte: parseFloat(req.query.maxHeight as string) }),
        };
      }


      if (req.query.city) {
        matchStage["destination.city"] = new RegExp(req.query.city as string, "i");
      }

      if (req.query.state) {
        matchStage["destination.state"] = new RegExp(req.query.state as string, "i");
      }


      const pipeline: any[] = [
        { $match: matchStage },


        {
          $addFields: {
            _estimatedTimeRemaining: {
              $cond: {
                if: {
                  $and: [
                    { $ifNull: ["$estimatedDeliveryTime", false] },
                    { $ne: ["$status", "delivered"] },
                  ],
                },
                then: {
                  $max: [
                    0,
                    {
                      $round: [
                        {
                          $divide: [
                            { $subtract: ["$estimatedDeliveryTime", new Date()] },
                            3600000,
                          ],
                        },
                        0,
                      ],
                    },
                  ],
                },
                else: null,
              },
            },
            _isOverdue: {
              $cond: {
                if: {
                  $and: [
                    { $ifNull: ["$estimatedDeliveryTime", false] },
                    { $ne: ["$status", "delivered"] },
                    { $lt: ["$estimatedDeliveryTime", new Date()] },
                  ],
                },
                then: true,
                else: false,
              },
            },
          },
        },


        ...(req.query.isOverdue !== undefined
          ? [{ $match: { _isOverdue: req.query.isOverdue === "true" } }]
          : []),


        ...(rawSearch
          ? [
            {
              $match: {
                $or: [
                  { trackingNumber: { $regex: rawSearch, $options: "i" } },
                  { "destination.recipientName": { $regex: rawSearch, $options: "i" } },
                  { "destination.recipientPhone": { $regex: rawSearch, $options: "i" } },
                  { "destination.alternativePhone": { $regex: rawSearch, $options: "i" } },
                ],
              },
            },
            {
              $addFields: {
                _searchScore: {
                  $add: [
                    { $cond: [{ $regexMatch: { input: "$trackingNumber", regex: `^${rawSearch}$`, options: "i" } }, 10, 0] },
                    { $cond: [{ $regexMatch: { input: "$trackingNumber", regex: `^${rawSearch}`, options: "i" } }, 5, 0] },
                    { $cond: [{ $regexMatch: { input: { $toLower: "$destination.recipientName" }, regex: `^${rawSearch.toLowerCase()}` } }, 3, 0] },
                  ],
                },
              },
            },
          ]
          : [{ $addFields: { _searchScore: 0 } }]),


        {
          $sort: {
            _searchScore: -1,
            _estimatedTimeRemaining: 1,
            createdAt: -1,
          },
        },


        {
          $facet: {
            metadata: [{ $count: "total" }],
            data: [
              { $skip: skip },
              { $limit: limit },
              {
                $project: {
                  _estimatedTimeRemaining: 0,
                  _isOverdue: 0,
                  _searchScore: 0,
                },
              },
            ],
          },
        },
      ];

      const [result] = await PackageModel.aggregate(pipeline);

      const total: number = result.metadata[0]?.total ?? 0;
      const packages: any[] = result.data ?? [];


      const formattedPackages = packages.map((pkg) => ({
        id: pkg._id,
        trackingNumber: pkg.trackingNumber,
        status: pkg.status,
        type: pkg.type,
        isFragile: pkg.isFragile,

        senderId: pkg.senderId,
        senderType: pkg.senderType,
        clientId: pkg.clientId ?? null,

        weight: pkg.weight,
        volume: pkg.volume ?? null,
        dimensions: pkg.dimensions ?? null,

        destination: {
          recipientName: pkg.destination.recipientName,
          recipientPhone: pkg.destination.recipientPhone,
          alternativePhone: pkg.destination.alternativePhone ?? null,
          address: pkg.destination.address,
          city: pkg.destination.city,
          state: pkg.destination.state,
          postalCode: pkg.destination.postalCode ?? null,
          notes: pkg.destination.notes ?? null,
          coordinates: pkg.deliveryType === "home" && pkg.destination.location?.coordinates
            ? {
              type: pkg.destination.location.type || "Point",
              coordinates: pkg.destination.location.coordinates,
            }
            : null,
        },

        description: pkg.description ?? null,
        deliveryType: pkg.deliveryType,
        deliveryPriority: pkg.deliveryPriority,
        estimatedDeliveryTime: pkg.estimatedDeliveryTime ?? null,

        totalPrice: pkg.totalPrice,
        paymentStatus: pkg.paymentStatus,
        paymentMethod: pkg.paymentMethod ?? null,

        assignedDelivererId: pkg.assignedDelivererId ?? null,
        assignedTransporterId: pkg.assignedTransporterId ?? null,
        assignedVehicleId: pkg.assignedVehicleId ?? null,

        attemptCount: pkg.attemptCount,
        maxAttempts: pkg.maxAttempts,
        nextAttemptDate: pkg.nextAttemptDate ?? null,

        returnInfo: pkg.returnInfo,

        unresolvedIssuesCount: (pkg.issues as any[]).filter((i: any) => !i.resolved).length,

        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
        deliveredAt: pkg.deliveredAt ?? null,
      }));

      res.status(200).json({
        success: true,
        data: {
          packages: formattedPackages,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
          hasMore: total > skip + limit,
          query: rawSearch || null,
          period: period === "all" ? "all_time" : period,
        },
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400,
          ),
        );
      }
      return next(new ErrorHandler(error.message || "Error searching deliverer deliveries.", 500));
    }
  },
);







export const getOrCreateTodayTransportation = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {



    const isValidId = (val: string) => mongoose.Types.ObjectId.isValid(val);
    const toObjectId = (val: string) => new mongoose.Types.ObjectId(val);

    if (!req.query.transporterId || !isValidId(req.query.transporterId as string)) {
      return next(new ErrorHandler("Valid transporterId is required.", 400));
    }
    const transporterId = toObjectId(req.query.transporterId as string);

    const VALID_TRANSPORTATION_STATUSES: TransportationStatus[] = [
      "pending", "in_transit", "arrived", "completed", "cancelled",
    ];
    const VALID_ROUTE_STATUSES: RouteStatus[] = [
      "planned", "assigned", "active", "paused", "completed", "cancelled",
    ];

    if (req.query.status) {
      const s = req.query.status as string;
      if (!VALID_TRANSPORTATION_STATUSES.includes(s as TransportationStatus))
        return next(new ErrorHandler(`Invalid status: ${s}.`, 400));
    }

    if (req.query.routeStatus) {
      const s = req.query.routeStatus as string;
      if (!VALID_ROUTE_STATUSES.includes(s as RouteStatus))
        return next(new ErrorHandler(`Invalid routeStatus: ${s}.`, 400));
    }

    const parseNum = (key: string): number | null => {
      if (req.query[key] === undefined) return null;
      const n = parseFloat(req.query[key] as string);
      return isNaN(n) ? null : n;
    };

    const minWeight = parseNum("minWeight");
    const maxWeight = parseNum("maxWeight");
    const minVolume = parseNum("minVolume");
    const maxVolume = parseNum("maxVolume");
    const minPackageCount = parseNum("minPackageCount");
    const maxPackageCount = parseNum("maxPackageCount");
    const minManifestCount = parseNum("minManifestCount");
    const maxManifestCount = parseNum("maxManifestCount");


    const numericKeys = [
      "minWeight", "maxWeight", "minVolume", "maxVolume",
      "minPackageCount", "maxPackageCount",
      "minManifestCount", "maxManifestCount",
    ];
    for (const key of numericKeys) {
      if (req.query[key] !== undefined && parseNum(key) === null) {
        return next(new ErrorHandler(`Invalid ${key}: must be a number.`, 400));
      }
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);



    const session = await mongoose.startSession();
    let transactionCommitted = false;

    let resultDoc: ITransportation | null = null;
    let noRouteToday = false;

    try {
      session.startTransaction();


      const todaysRoute = await RouteModel.findOne({
        assignedTransporterId: transporterId,
        $or: [
          { scheduledStart: { $gte: startOfToday, $lte: endOfToday } },
          { actualStart: { $gte: startOfToday, $lte: endOfToday } },
        ],

      })
        .sort({ scheduledStart: -1 })
        .session(session);

      if (!todaysRoute) {
        noRouteToday = true;
      } else {


        let transportation = await TransportationModel.findOne({
          sourceRouteId: todaysRoute._id,
        }).session(session);

        if (!transportation) {

          const manifestIds = todaysRoute.stops.reduce<mongoose.Types.ObjectId[]>(
            (acc, stop) => acc.concat(stop.manifestIds || []),
            [],
          );


          let totalWeight = 0;
          let totalPackages = 0;
          if (manifestIds.length > 0) {
            const manifests = await ManifestModel.find({ _id: { $in: manifestIds } })
              .select("totalDeclaredWeight packageCount")
              .session(session);

            for (const m of manifests) {
              totalWeight += m.totalDeclaredWeight || 0;
              totalPackages += m.packageCount || 0;
            }
          }


          const firstStop = todaysRoute.stops[0];
          const lastStop = todaysRoute.stops[todaysRoute.stops.length - 1];

          if (!firstStop || !lastStop) {
            throw new ErrorHandler("Today's route has no stops; cannot build transportation.", 422);
          }

          const sourcePoint = {
            branchId: todaysRoute.originBranchId,
            location: firstStop.location,
          };
          const destinationPoint = {
            branchId: todaysRoute.destinationBranchId ?? lastStop.branchId,
            location: lastStop.location,
          };

          const created = await TransportationModel.create(
            [{
              companyId: todaysRoute.companyId,
              sourceRouteId: todaysRoute._id,
              source: sourcePoint,
              destination: destinationPoint,
              manifestIds,
              manifestCount: manifestIds.length,
              packageCount: totalPackages,
              totalWeight,
              totalVolume: 0,
              assignedTransporterId: todaysRoute.assignedTransporterId,
              assignedVehicleId: todaysRoute.assignedVehicleId,
              status: "pending",
              estimatedDeliveryTime: todaysRoute.scheduledEnd,
              actualDeliveryTime: todaysRoute.actualEnd,
              departedAt: todaysRoute.actualStart,
            }],
            { session },
          );
          transportation = created[0];
        }

        resultDoc = transportation;
      }

      await session.commitTransaction();
      transactionCommitted = true;

    } catch (error: any) {
      if (error instanceof ErrorHandler) {
        return next(error);
      }
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors).map((e: any) => e.message).join(", "),
            400,
          ),
        );
      }
      return next(new ErrorHandler(error.message || "Error fetching transportation.", 500));
    } finally {
      if (!transactionCommitted && session.inTransaction()) {
        await session.abortTransaction();
      }
      session.endSession();
    }



    if (noRouteToday || !resultDoc) {
      res.status(200).json({
        success: true,
        data: null,
        message: "No transportation scheduled for today.",
      });
      return;
    }


    const t = resultDoc;

    if (req.query.status && t.status !== (req.query.status as string)) {
      res.status(200).json({ success: true, data: null, message: "Transportation does not match status filter." });
      return;
    }
    if (minWeight !== null && t.totalWeight < minWeight) {
      res.status(200).json({ success: true, data: null, message: "Transportation does not match minWeight filter." });
      return;
    }
    if (maxWeight !== null && t.totalWeight > maxWeight) {
      res.status(200).json({ success: true, data: null, message: "Transportation does not match maxWeight filter." });
      return;
    }
    if (minVolume !== null && t.totalVolume < minVolume) {
      res.status(200).json({ success: true, data: null, message: "Transportation does not match minVolume filter." });
      return;
    }
    if (maxVolume !== null && t.totalVolume > maxVolume) {
      res.status(200).json({ success: true, data: null, message: "Transportation does not match maxVolume filter." });
      return;
    }
    if (minPackageCount !== null && t.packageCount < minPackageCount) {
      res.status(200).json({ success: true, data: null, message: "Transportation does not match minPackageCount filter." });
      return;
    }
    if (maxPackageCount !== null && t.packageCount > maxPackageCount) {
      res.status(200).json({ success: true, data: null, message: "Transportation does not match maxPackageCount filter." });
      return;
    }
    if (minManifestCount !== null && t.manifestCount < minManifestCount) {
      res.status(200).json({ success: true, data: null, message: "Transportation does not match minManifestCount filter." });
      return;
    }
    if (maxManifestCount !== null && t.manifestCount > maxManifestCount) {
      res.status(200).json({ success: true, data: null, message: "Transportation does not match maxManifestCount filter." });
      return;
    }
    if (req.query.routeStatus) {

      const route = await RouteModel.findById(t.sourceRouteId).select("status").lean();
      if (!route || route.status !== (req.query.routeStatus as string)) {
        res.status(200).json({ success: true, data: null, message: "Transportation does not match routeStatus filter." });
        return;
      }
    }


    const data = (t as any).toObject ? (t as any).toObject({ virtuals: true }) : t;

    res.status(200).json({
      success: true,
      data,
    });
  },
);





//get only status arrived and cancelled 
export const getTransportationsHistory = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {

    const isValidId = (val: string) => mongoose.Types.ObjectId.isValid(val);
    const toObjectId = (val: string) => new mongoose.Types.ObjectId(val);

    let transporterId: mongoose.Types.ObjectId;

    if (req.user?.role === 'transporter') {
      const transporter = await TransporterModel.findOne({ userId: req.user._id });
      if (!transporter) {
        return next(new ErrorHandler("Transporter not found for this user.", 404));
      }
      transporterId = transporter._id;
    } else if (req.query.transporterId && isValidId(req.query.transporterId as string)) {
      transporterId = toObjectId(req.query.transporterId as string);
    } else {
      return next(new ErrorHandler("Valid transporterId is required.", 400));
    }

    const transporter = await TransporterModel.findById(transporterId);
    if (!transporter) {
      return next(new ErrorHandler("Transporter not found.", 404));
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const validSortFields = [
      'createdAt', 'updatedAt', 'departedAt', 'actualDeliveryTime',
      'estimatedDeliveryTime', 'totalWeight', 'packageCount', 'manifestCount',
      'status', 'transportationCode'
    ];
    const sortBy = (req.query.sortBy as string) && validSortFields.includes(req.query.sortBy as string)
      ? req.query.sortBy as string
      : 'createdAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const sort: Record<string, 1 | -1> = { [sortBy]: sortOrder };

    const VALID_TRANSPORTATION_STATUSES: TransportationStatus[] = [
      "pending", "in_transit", "arrived", "completed", "cancelled",
    ];
    const VALID_ROUTE_STATUSES: RouteStatus[] = [
      "planned", "assigned", "active", "paused", "completed", "cancelled",
    ];

    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom as string) : null;
    const dateTo = req.query.dateTo ? new Date(req.query.dateTo as string) : null;

    if (dateFrom && isNaN(dateFrom.getTime())) {
      return next(new ErrorHandler("Invalid dateFrom format.", 400));
    }
    if (dateTo && isNaN(dateTo.getTime())) {
      return next(new ErrorHandler("Invalid dateTo format.", 400));
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      return next(new ErrorHandler("dateFrom cannot be after dateTo.", 400));
    }

    const parseNum = (key: string): number | null => {
      if (req.query[key] === undefined) return null;
      const n = parseFloat(req.query[key] as string);
      return isNaN(n) ? null : n;
    };

    const numericKeys = [
      "minWeight", "maxWeight", "minVolume", "maxVolume",
      "minPackageCount", "maxPackageCount", "minManifestCount", "maxManifestCount",
    ];
    for (const key of numericKeys) {
      if (req.query[key] !== undefined && parseNum(key) === null) {
        return next(new ErrorHandler(`Invalid ${key}: must be a number.`, 400));
      }
    }

    const minWeight = parseNum("minWeight");
    const maxWeight = parseNum("maxWeight");
    const minVolume = parseNum("minVolume");
    const maxVolume = parseNum("maxVolume");
    const minPackageCount = parseNum("minPackageCount");
    const maxPackageCount = parseNum("maxPackageCount");
    const minManifestCount = parseNum("minManifestCount");
    const maxManifestCount = parseNum("maxManifestCount");

    const sourceBranchId = req.query.sourceBranchId as string;
    const destinationBranchId = req.query.destinationBranchId as string;

    if (sourceBranchId && !isValidId(sourceBranchId)) {
      return next(new ErrorHandler("Invalid sourceBranchId format.", 400));
    }
    if (destinationBranchId && !isValidId(destinationBranchId)) {
      return next(new ErrorHandler("Invalid destinationBranchId format.", 400));
    }

    // Base query
    const query: any = { assignedTransporterId: transporterId };

    // ADDED: Statuses filter (arrived or cancelled)
    if (req.query.statuses) {
      const statuses = (req.query.statuses as string).split(",").map(s => s.trim());
      const invalid = statuses.filter(s => !VALID_TRANSPORTATION_STATUSES.includes(s as TransportationStatus));
      if (invalid.length > 0) {
        return next(new ErrorHandler(`Invalid statuses: ${invalid.join(", ")}.`, 400));
      }
      query.status = { $in: statuses };
    } else if (req.query.status) {
      // Keep single status filter as fallback
      const status = req.query.status as string;
      if (!VALID_TRANSPORTATION_STATUSES.includes(status as TransportationStatus)) {
        return next(new ErrorHandler(`Invalid status: ${status}.`, 400));
      }
      query.status = status;
    }

    // ADDED: Search filter
    if (req.query.search) {
      const searchRe = new RegExp(req.query.search as string, "i");
      query.$or = [
        ...(query.$or || []),
        { manifestCode: searchRe },
        { internalReference: searchRe },
        { notes: searchRe },
        { "packages.trackingNumber": searchRe },
      ];
    }

    if (dateFrom || dateTo) {
      query.$or = query.$or || [];
      query.$or.push(
        { createdAt: {} as any },
        { actualDeliveryTime: {} as any }
      );
      if (dateFrom) {
        query.$or[query.$or.length - 2].createdAt.$gte = dateFrom;
        query.$or[query.$or.length - 1].actualDeliveryTime.$gte = dateFrom;
      }
      if (dateTo) {
        query.$or[query.$or.length - 2].createdAt.$lte = dateTo;
        query.$or[query.$or.length - 1].actualDeliveryTime.$lte = dateTo;
      }
    }

    if (minWeight !== null) query.totalWeight = { $gte: minWeight };
    if (maxWeight !== null) {
      query.totalWeight = { ...(query.totalWeight || {}), $lte: maxWeight };
    }
    if (minVolume !== null) query.totalVolume = { $gte: minVolume };
    if (maxVolume !== null) {
      query.totalVolume = { ...(query.totalVolume || {}), $lte: maxVolume };
    }
    if (minPackageCount !== null) query.packageCount = { $gte: minPackageCount };
    if (maxPackageCount !== null) {
      query.packageCount = { ...(query.packageCount || {}), $lte: maxPackageCount };
    }
    if (minManifestCount !== null) query.manifestCount = { $gte: minManifestCount };
    if (maxManifestCount !== null) {
      query.manifestCount = { ...(query.manifestCount || {}), $lte: maxManifestCount };
    }

    let routeStatusFilter: string | null = null;
    if (req.query.routeStatus) {
      const rs = req.query.routeStatus as string;
      if (!VALID_ROUTE_STATUSES.includes(rs as RouteStatus)) {
        return next(new ErrorHandler(`Invalid routeStatus: ${rs}.`, 400));
      }
      routeStatusFilter = rs;
    }

    const needsAdvancedFiltering = routeStatusFilter || sourceBranchId || destinationBranchId;

    let transportations: any[] = [];
    let total = 0;

    if (needsAdvancedFiltering) {
      const allTransportations = await TransportationModel.find(query);
      const routeIds = allTransportations.map(t => t.sourceRouteId).filter(id => id);

      const routes = await RouteModel.find(
        { _id: { $in: routeIds } },
        { status: 1, originBranchId: 1, destinationBranchId: 1, stops: 1, name: 1, code: 1 }
      );

      const routeMap = new Map();
      routes.forEach(route => {
        routeMap.set(route._id.toString(), route);
      });

      const filtered = allTransportations.filter(t => {
        const route = routeMap.get(t.sourceRouteId?.toString());
        if (!route) return false;

        if (routeStatusFilter && route.status !== routeStatusFilter) return false;
        if (sourceBranchId && route.originBranchId?.toString() !== sourceBranchId) return false;
        if (destinationBranchId) {
          const destId = route.destinationBranchId?.toString() || route.stops[route.stops.length - 1]?.branchId?.toString();
          if (destId !== destinationBranchId) return false;
        }
        return true;
      });

      total = filtered.length;
      transportations = filtered.slice(skip, skip + limit);

      transportations.forEach((t: any) => {
        t._route = routeMap.get(t.sourceRouteId?.toString());
      });
    } else {
      const [countResult, transportationsResult] = await Promise.all([
        TransportationModel.countDocuments(query),
        TransportationModel.find(query)
          .sort(sort)
          .skip(skip)
          .limit(limit),
      ]);
      total = countResult;
      transportations = transportationsResult;
    }

    // Resolve branch names for source/destination
    const branchIdsToResolve = new Set<string>();
    transportations.forEach((t: any) => {
      if (t.source?.branchId) branchIdsToResolve.add(t.source.branchId.toString());
      if (t.destination?.branchId) branchIdsToResolve.add(t.destination.branchId.toString());
    });

    const branchNameMap = new Map<string, string>();
    if (branchIdsToResolve.size > 0) {
      const branches = await BranchModel.find(
        { _id: { $in: Array.from(branchIdsToResolve).map(toObjectId) } },
        { name: 1 }
      );
      branches.forEach((b: any) => branchNameMap.set(b._id.toString(), b.name));
    }

    const allTransporterTransportations = await TransportationModel.find({
      assignedTransporterId: transporterId,
    });

    const completedTransportations = allTransporterTransportations.filter(t => t.status === 'completed');
    const cancelledTransportations = allTransporterTransportations.filter(t => t.status === 'cancelled');
    const inTransitTransportations = allTransporterTransportations.filter(t => t.status === 'in_transit');
    const arrivedTransportations = allTransporterTransportations.filter(t => t.status === 'arrived');
    const pendingTransportations = allTransporterTransportations.filter(t => t.status === 'pending');

    const completedWithTimes = completedTransportations.filter(t => t.departedAt && t.actualDeliveryTime);
    const totalDeliveryMinutes = completedWithTimes.reduce((sum, t) => {
      const minutes = Math.round((t.actualDeliveryTime!.getTime() - t.departedAt!.getTime()) / 60000);
      return sum + minutes;
    }, 0);
    const averageDeliveryTimeMinutes = completedWithTimes.length > 0
      ? Math.round(totalDeliveryMinutes / completedWithTimes.length)
      : null;

    const totalWeightTransported = completedTransportations.reduce((sum, t) => sum + (t.totalWeight || 0), 0);
    const totalManifestsTransported = completedTransportations.reduce((sum, t) => sum + (t.manifestCount || 0), 0);
    const totalPackagesTransported = completedTransportations.reduce((sum, t) => sum + (t.packageCount || 0), 0);

    const statusBreakdown: Record<TransportationStatus, number> = {
      pending: pendingTransportations.length,
      in_transit: inTransitTransportations.length,
      arrived: arrivedTransportations.length,
      completed: completedTransportations.length,
      cancelled: cancelledTransportations.length,
    };

    const formattedTransportations = transportations.map((t: any) => ({
      id: t._id,
      transportationCode: t.transportationCode,
      companyId: t.companyId,
      sourceRouteId: t.sourceRouteId,
      source: t.source ? {
        branchId: t.source.branchId,
        name: t.source.name || (t.source.branchId ? branchNameMap.get(t.source.branchId.toString()) : undefined) || null,
        location: t.source.location,
      } : null,
      destination: t.destination ? {
        branchId: t.destination.branchId,
        name: t.destination.name || (t.destination.branchId ? branchNameMap.get(t.destination.branchId.toString()) : undefined) || null,
        location: t.destination.location,
      } : null,
      manifestIds: t.manifestIds,
      manifestCount: t.manifestCount,
      packageCount: t.packageCount,
      totalWeight: t.totalWeight,
      totalVolume: t.totalVolume,
      assignedTransporterId: t.assignedTransporterId,
      assignedVehicleId: t.assignedVehicleId,
      status: t.status,
      estimatedDeliveryTime: t.estimatedDeliveryTime ?? null,
      actualDeliveryTime: t.actualDeliveryTime ?? null,
      departedAt: t.departedAt ?? null,
      notes: t.notes ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      isInTransit: t.isInTransit,
      isCompleted: t.isCompleted,
      isOverdue: t.isOverdue,
      durationMinutes: t.durationMinutes ?? null,
      route: t._route ? {
        id: t._route._id,
        name: t._route.name,
        code: t._route.code,
        status: t._route.status,
        originBranchId: t._route.originBranchId,
        destinationBranchId: t._route.destinationBranchId,
      } : null,
    }));

    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      data: {
        transportations: formattedTransportations,
        pagination: {
          page,
          limit,
          total,
          pages: totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
        summary: {
          totalTransportations: allTransporterTransportations.length,
          pendingCount: pendingTransportations.length,
          inTransitCount: inTransitTransportations.length,
          arrivedCount: arrivedTransportations.length,
          completedCount: completedTransportations.length,
          cancelledCount: cancelledTransportations.length,
          totalWeightTransported,
          totalManifestsTransported,
          totalPackagesTransported,
          averageDeliveryTimeMinutes,
          totalDistance: allTransporterTransportations.reduce((sum, t) => sum + ((t as any).totalDistance || 0), 0),
          statusBreakdown,
        },
        filters: {
          transporterId,
          status: req.query.status ?? null,
          statuses: req.query.statuses ?? null,
          search: req.query.search ?? null,
          routeStatus: req.query.routeStatus ?? null,
          dateFrom: dateFrom ?? null,
          dateTo: dateTo ?? null,
          minWeight: minWeight ?? null,
          maxWeight: maxWeight ?? null,
          minVolume: minVolume ?? null,
          maxVolume: maxVolume ?? null,
          minPackageCount: minPackageCount ?? null,
          maxPackageCount: maxPackageCount ?? null,
          minManifestCount: minManifestCount ?? null,
          maxManifestCount: maxManifestCount ?? null,
          sourceBranchId: sourceBranchId ?? null,
          destinationBranchId: destinationBranchId ?? null,
          sortBy,
          sortOrder: req.query.sortOrder ?? "desc",
        },
      },
    });
  },
);








export const getManifestsHistory = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {

      const isValidId = (val: string) => mongoose.Types.ObjectId.isValid(val);
      const toObjectId = (val: string) => new mongoose.Types.ObjectId(val);

      if (!req.query.transporterId || !isValidId(req.query.transporterId as string)) {
        return next(new ErrorHandler("Valid transporterId is required.", 400));
      }
      const transporterId = toObjectId(req.query.transporterId as string);

      // Verify transporter exists
      const transporter = await TransporterModel.findById(transporterId).lean();
      if (!transporter) {
        return next(new ErrorHandler("Transporter not found.", 404));
      }


      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;


      const sortBy = (req.query.sortBy as string) || "createdAt";
      const order = req.query.order === "asc" ? 1 : -1;
      const sortMap: Record<string, any> = {
        createdAt: { createdAt: order },
        updatedAt: { updatedAt: order },
        totalDeclaredWeight: { totalDeclaredWeight: order },
        packageCount: { packageCount: order },
        manifestCode: { manifestCode: order },
        departedAt: { departedAt: order },
        arrivedAt: { arrivedAt: order },
        status: { status: order },
        priority: { priority: order },
      };
      const sort = sortMap[sortBy] || { createdAt: -1 };


      const filter: Record<string, any> = {
        "transportLeg.transporterId": transporterId,
      };


      const VALID_STATUSES: ManifestStatus[] = [
        "open", "sealed", "loaded", "in_transit",
        "arrived", "unloading", "closed", "discrepancy", "cancelled",
      ];

      if (req.query.status) {
        const s = req.query.status as string;
        if (!VALID_STATUSES.includes(s as ManifestStatus)) {
          return next(new ErrorHandler(`Invalid status: ${s}.`, 400));
        }
        filter.status = s;
      }

      if (req.query.statuses) {
        const statuses = (req.query.statuses as string).split(",").map(s => s.trim());
        const invalid = statuses.filter(s => !VALID_STATUSES.includes(s as ManifestStatus));
        if (invalid.length > 0) {
          return next(new ErrorHandler(`Invalid statuses: ${invalid.join(", ")}.`, 400));
        }
        filter.status = { $in: statuses };
      }


      const VALID_PRIORITIES: ManifestPriority[] = ["standard", "express", "urgent"];
      if (req.query.priority) {
        const p = req.query.priority as string;
        if (!VALID_PRIORITIES.includes(p as ManifestPriority)) {
          return next(new ErrorHandler(`Invalid priority: ${p}.`, 400));
        }
        filter.priority = p;
      }


      if (req.query.manifestCode) {
        filter.manifestCode = new RegExp(req.query.manifestCode as string, "i");
      }

      if (req.query.search) {
        const searchRe = new RegExp(req.query.search as string, "i");
        filter.$or = [
          { manifestCode: searchRe },
          { internalReference: searchRe },
          { notes: searchRe },
          { "packages.trackingNumber": searchRe },
        ];
      }


      if (req.query.containsPackageId) {
        if (!isValidId(req.query.containsPackageId as string)) {
          return next(new ErrorHandler("Invalid containsPackageId.", 400));
        }
        filter["packages.packageId"] = toObjectId(req.query.containsPackageId as string);
      }


      if (req.query.hasDiscrepancy !== undefined) {
        if (req.query.hasDiscrepancy === "true") {
          filter.$or = [
            ...(filter.$or || []),
            { status: "discrepancy" },
            { discrepancy: { $ne: null } },
          ];
        } else {
          filter.status = { $nin: ["discrepancy"] };
          filter.discrepancy = null;
        }
      }


      if (req.query.minWeight || req.query.maxWeight) {
        const min = req.query.minWeight ? parseFloat(req.query.minWeight as string) : null;
        const max = req.query.maxWeight ? parseFloat(req.query.maxWeight as string) : null;
        if ((min !== null && isNaN(min)) || (max !== null && isNaN(max))) {
          return next(new ErrorHandler("Invalid weight filter values.", 400));
        }
        filter.totalDeclaredWeight = {
          ...(min !== null && { $gte: min }),
          ...(max !== null && { $lte: max }),
        };
      }

      if (req.query.minPackageCount || req.query.maxPackageCount) {
        const min = req.query.minPackageCount ? parseInt(req.query.minPackageCount as string) : null;
        const max = req.query.maxPackageCount ? parseInt(req.query.maxPackageCount as string) : null;
        if ((min !== null && isNaN(min)) || (max !== null && isNaN(max))) {
          return next(new ErrorHandler("Invalid package count filter values.", 400));
        }
        filter.packageCount = {
          ...(min !== null && { $gte: min }),
          ...(max !== null && { $lte: max }),
        };
      }


      if (req.query.createdFrom || req.query.createdTo) {
        filter.createdAt = {
          ...(req.query.createdFrom && { $gte: new Date(req.query.createdFrom as string) }),
          ...(req.query.createdTo && { $lte: new Date(req.query.createdTo as string) }),
        };
      }

      if (req.query.departedFrom || req.query.departedTo) {
        filter.departedAt = {
          ...(req.query.departedFrom && { $gte: new Date(req.query.departedFrom as string) }),
          ...(req.query.departedTo && { $lte: new Date(req.query.departedTo as string) }),
        };
      }

      if (req.query.arrivedFrom || req.query.arrivedTo) {
        filter.arrivedAt = {
          ...(req.query.arrivedFrom && { $gte: new Date(req.query.arrivedFrom as string) }),
          ...(req.query.arrivedTo && { $lte: new Date(req.query.arrivedTo as string) }),
        };
      }


      if (req.query.originBranchId) {
        if (!isValidId(req.query.originBranchId as string)) {
          return next(new ErrorHandler("Invalid originBranchId.", 400));
        }
        filter.originBranchId = toObjectId(req.query.originBranchId as string);
      }

      if (req.query.destinationBranchId) {
        if (!isValidId(req.query.destinationBranchId as string)) {
          return next(new ErrorHandler("Invalid destinationBranchId.", 400));
        }
        filter.destinationBranchId = toObjectId(req.query.destinationBranchId as string);
      }

      if (req.query.branchId) {
        if (!isValidId(req.query.branchId as string)) {
          return next(new ErrorHandler("Invalid branchId.", 400));
        }
        const branchOid = toObjectId(req.query.branchId as string);
        filter.$or = [
          ...(filter.$or || []),
          { originBranchId: branchOid },
          { destinationBranchId: branchOid },
        ];
      }


      const [total, manifests] = await Promise.all([
        ManifestModel.countDocuments(filter),
        ManifestModel.find(filter)
          .populate("originBranchId", "name code address.city")
          .populate("destinationBranchId", "name code address.city")
          .populate("createdBy", "name email")
          .populate("transportLeg.transporterId", "name email phone")
          .populate("transportLeg.vehicleId", "registrationNumber type")
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean({ virtuals: true }),
      ]);


      const allTransporterManifests = await ManifestModel.find({
        "transportLeg.transporterId": transporterId,
      }).lean();

      const completedManifests = allTransporterManifests.filter(
        m => m.status === "closed" || m.status === "arrived"
      );
      const cancelledManifests = allTransporterManifests.filter(
        m => m.status === "cancelled"
      );
      const discrepancyManifests = allTransporterManifests.filter(
        m => m.status === "discrepancy" || m.discrepancy
      );


      const manifestsWithDuration = allTransporterManifests.filter(
        m => m.departedAt && m.arrivedAt
      );
      const totalDurationMinutes = manifestsWithDuration.reduce((sum, m) => {
        const minutes = Math.round((m.arrivedAt!.getTime() - m.departedAt!.getTime()) / 60000);
        return sum + minutes;
      }, 0);
      const averageDurationMinutes = manifestsWithDuration.length > 0
        ? Math.round(totalDurationMinutes / manifestsWithDuration.length)
        : null;


      const statusBreakdown: Record<ManifestStatus, number> = {} as any;
      VALID_STATUSES.forEach(status => {
        statusBreakdown[status] = 0;
      });
      allTransporterManifests.forEach(m => {
        statusBreakdown[m.status]++;
      });


      const priorityBreakdown: Record<ManifestPriority, number> = {
        standard: 0,
        express: 0,
        urgent: 0,
      };
      allTransporterManifests.forEach(m => {
        priorityBreakdown[m.priority]++;
      });

      const totalWeight = allTransporterManifests.reduce((sum, m) => sum + (m.totalDeclaredWeight || 0), 0);
      const totalPackages = allTransporterManifests.reduce((sum, m) => sum + (m.packageCount || 0), 0);

      const summary = {
        totalManifests: allTransporterManifests.length,
        completedCount: completedManifests.length,
        cancelledCount: cancelledManifests.length,
        discrepancyCount: discrepancyManifests.length,
        totalPackagesTransported: totalPackages,
        totalWeightTransported: totalWeight,
        averageWeightPerManifest: allTransporterManifests.length > 0
          ? parseFloat((totalWeight / allTransporterManifests.length).toFixed(2))
          : 0,
        averageDurationMinutes,
        manifestsByStatus: statusBreakdown,
        manifestsByPriority: priorityBreakdown,
      };


      const formattedManifests = manifests.map((m: any) => ({
        id: m._id,
        manifestCode: m.manifestCode,
        companyId: m.companyId,
        originBranch: m.originBranchId
          ? {
            id: m.originBranchId._id,
            name: m.originBranchId.name,
            code: m.originBranchId.code,
            city: m.originBranchId.address?.city,
          }
          : null,
        destinationBranch: m.destinationBranchId
          ? {
            id: m.destinationBranchId._id,
            name: m.destinationBranchId.name,
            code: m.destinationBranchId.code,
            city: m.destinationBranchId.address?.city,
            coordinates: m.destinationBranchId.location?.coordinates,
          }
          : null,
        status: m.status,
        priority: m.priority,
        createdBy: m.createdBy
          ? { id: m.createdBy._id, name: m.createdBy.name, email: m.createdBy.email }
          : null,
        sealInfo: m.sealInfo
          ? {
            sealedBy: m.sealInfo.sealedBy,
            sealedAt: m.sealInfo.sealedAt,
            sealNumber: m.sealInfo.sealNumber,
            totalWeight: m.sealInfo.totalWeight,
            packageCount: m.sealInfo.packageCount,
            notes: m.sealInfo.notes ?? null,
          }
          : null,
        transportLeg: m.transportLeg
          ? {
            vehicle: m.transportLeg.vehicleId
              ? {
                id: m.transportLeg.vehicleId._id,
                registrationNumber: m.transportLeg.vehicleId.registrationNumber,
                type: m.transportLeg.vehicleId.type,
              }
              : null,
            transporter: m.transportLeg.transporterId
              ? {
                id: m.transportLeg.transporterId._id,
                name: m.transportLeg.transporterId.name,
                email: m.transportLeg.transporterId.email,
                phone: m.transportLeg.transporterId.phone,
              }
              : null,
            assignedAt: m.transportLeg.assignedAt,
            departedAt: m.transportLeg.departedAt ?? null,
            arrivedAt: m.transportLeg.arrivedAt ?? null,
            estimatedArrival: m.transportLeg.estimatedArrival ?? null,
          }
          : null,
        totalDeclaredWeight: m.totalDeclaredWeight,
        packageCount: m.packageCount,
        packages: (m.packages || []).slice(0, 10).map((p: any) => ({
          packageId: p.packageId,
          trackingNumber: p.trackingNumber,
          weight: p.weight,
          sequence: p.sequence,
          entryStatus: p.entryStatus,
          scannedInAt: p.scannedInAt,
          scannedOutAt: p.scannedOutAt ?? null,
          remanifestId: p.remanifestId ?? null,
          notes: p.notes ?? null,
        })),
        hasDiscrepancy: m.hasDiscrepancy,
        discrepancy: m.discrepancy
          ? {
            reportedBy: m.discrepancy.reportedBy,
            reportedAt: m.discrepancy.reportedAt,
            expectedCount: m.discrepancy.expectedCount,
            actualCount: m.discrepancy.actualCount,
            missingPackageIds: m.discrepancy.missingPackageIds,
            extraPackageIds: m.discrepancy.extraPackageIds,
            notes: m.discrepancy.notes,
            resolvedBy: m.discrepancy.resolvedBy ?? null,
            resolvedAt: m.discrepancy.resolvedAt ?? null,
            resolution: m.discrepancy.resolution ?? null,
          }
          : null,
        isSealed: m.isSealed,
        isInTransit: m.isInTransit,
        isClosed: m.isClosed,
        unloadedCount: m.unloadedCount,
        remainingCount: m.remainingCount,
        durationMinutes: m.durationMinutes ?? null,
        internalReference: m.internalReference ?? null,
        notes: m.notes ?? null,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        sealedAt: m.sealedAt ?? null,
        closedAt: m.closedAt ?? null,
        departedAt: m.departedAt ?? null,
        arrivedAt: m.arrivedAt ?? null,
        estimatedArrival: m.estimatedArrival ?? null,
      }));

      res.status(200).json({
        success: true,
        data: {
          manifests: formattedManifests,
          pagination: {
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
            hasMore: page * limit < total,
          },
          summary,
          filters: {
            transporterId,
            status: req.query.status ?? null,
            statuses: req.query.statuses ?? null,
            priority: req.query.priority ?? null,
            hasDiscrepancy: req.query.hasDiscrepancy ?? null,
            minWeight: req.query.minWeight ?? null,
            maxWeight: req.query.maxWeight ?? null,
            minPackageCount: req.query.minPackageCount ?? null,
            maxPackageCount: req.query.maxPackageCount ?? null,
            manifestCode: req.query.manifestCode ?? null,
            search: req.query.search ?? null,
            containsPackageId: req.query.containsPackageId ?? null,
            originBranchId: req.query.originBranchId ?? null,
            destinationBranchId: req.query.destinationBranchId ?? null,
            branchId: req.query.branchId ?? null,
            createdFrom: req.query.createdFrom ?? null,
            createdTo: req.query.createdTo ?? null,
            departedFrom: req.query.departedFrom ?? null,
            departedTo: req.query.departedTo ?? null,
            arrivedFrom: req.query.arrivedFrom ?? null,
            arrivedTo: req.query.arrivedTo ?? null,
            sortBy,
            order: req.query.order ?? "desc",
          },
        },
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400,
          ),
        );
      }
      return next(
        new ErrorHandler(error.message || "Error fetching manifest history.", 500),
      );
    }
  },
);







export const generateStopVerificationQR = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        routeId,
        stopIndex = 0,
        branchId,
        routeNumber = 1,
        routeType = 'hub_to_hub',
        manifestCount = 3,
        packageCount = 5,
        isLastStop = false,
      } = req.body;

      // Validate required fields
      // if (!routeId || !mongoose.Types.ObjectId.isValid(routeId)) {
      //   return next(new ErrorHandler('Valid routeId is required', 400));
      // }

      // if (stopIndex === undefined || stopIndex < 0) {
      //   return next(new ErrorHandler('Valid stopIndex is required', 400));
      // }

      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
        return next(new ErrorHandler('Valid branchId is required', 400));
      }

      // Get socket service
      const socketService = (global as any).socketService as SocketService | undefined;
      if (!socketService) {
        return next(new ErrorHandler('Socket service not available', 500));
      }

      // Generate QR data
      const qrCode = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const sessionId = new mongoose.Types.ObjectId();
      const dummyTransporterId = new mongoose.Types.ObjectId();
      const dummyStopId = new mongoose.Types.ObjectId();

      const qrPayload = {
        sessionId: sessionId.toString(),
        code: qrCode,
        routeId,
        stopIndex,
        type: 'stop_verification',
        timestamp: Date.now(),
      };

      const qrDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload));

      // Emit to branch room - this triggers the supervisor:show_stop_qr event
      socketService.emitToBranch(branchId, 'supervisor:show_stop_qr', {
        sessionId: sessionId,
        qrCode: qrCode,
        qrImage: qrDataUrl,
        payload: qrPayload,
        routeId,
        routeNumber: routeNumber || `RT-${Date.now().toString().slice(-6)}`,
        routeType,
        stopIndex,
        stopId: dummyStopId,
        branchId,
        transporterId: dummyTransporterId,
        manifestCount,
        packageCount,
        isLastStop,
        expiresAt,
        message: isLastStop
          ? 'Transporter has arrived with the final delivery. Please scan to confirm receipt.'
          : `Transporter has arrived at stop ${stopIndex + 1}. Please scan to confirm receipt.`,
        timestamp: new Date(),
        // Dummy flag for testing
        _dummy: true,
        _note: 'This is a dummy QR for testing. No verification will occur.'
      });

      console.log(`[DUMMY] Stop QR emitted to branch ${branchId} for route ${routeId}, stop ${stopIndex}`);

      return res.status(200).json({
        success: true,
        message: 'Stop verification QR sent to supervisor successfully',
        data: {
          sessionId: sessionId,
          qrCode: qrCode,
          qrImage: qrDataUrl,
          routeId,
          stopIndex,
          branchId,
          expiresAt,
          _dummy: true
        }
      });

    } catch (error: any) {
      console.error('[DUMMY] generateStopVerificationQR error:', error);
      return next(new ErrorHandler(error.message || 'Failed to generate QR', 500));
    }
  }
);

/**
 * DUMMY: Generate and send start route QR to supervisor
 * Emits 'supervisor:show_start_route_qr' event to the branch room
 */
export const generateStartRouteQR = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        routeId,
        originBranchId,
        routeNumber,
        routeType = 'hub_to_hub',
        totalStops = 5,
        manifestCount = 10,
        packageCount = 15,
      } = req.body;

      // Validate required fields
      if (!routeId || !mongoose.Types.ObjectId.isValid(routeId)) {
        return next(new ErrorHandler('Valid routeId is required', 400));
      }

      if (!originBranchId || !mongoose.Types.ObjectId.isValid(originBranchId)) {
        return next(new ErrorHandler('Valid originBranchId is required', 400));
      }

      // Get socket service
      const socketService = (global as any).socketService as SocketService | undefined;
      if (!socketService) {
        return next(new ErrorHandler('Socket service not available', 500));
      }

      // Generate QR data
      const qrCode = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const sessionId = new mongoose.Types.ObjectId();
      const dummyTransporterId = new mongoose.Types.ObjectId();

      const qrPayload = {
        sessionId: sessionId.toString(),
        code: qrCode,
        routeId,
        stopIndex: -1, // -1 indicates start route
        type: 'start_route',
        timestamp: Date.now(),
      };

      const qrDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload));

      // Emit to branch room - this triggers the supervisor:show_start_route_qr event
      socketService.emitToBranch(originBranchId, 'supervisor:show_start_route_qr', {
        sessionId: sessionId,
        qrCode: qrCode,
        qrImage: qrDataUrl,
        payload: qrPayload,
        routeId,
        routeNumber: routeNumber || `RT-${Date.now().toString().slice(-6)}`,
        routeType,
        transporterId: dummyTransporterId,
        originBranchId,
        totalStops,
        manifestCount,
        packageCount,
        expiresAt,
        message: `Transporter is departing on route ${routeNumber || 'RT-' + Date.now().toString().slice(-6)}. Please scan to confirm departure.`,
        timestamp: new Date(),
        // Dummy flag for testing
        _dummy: true,
        _note: 'This is a dummy QR for testing. No verification will occur.'
      });

      console.log(`[DUMMY] Start route QR emitted to branch ${originBranchId} for route ${routeId}`);

      return res.status(200).json({
        success: true,
        message: 'Start route QR sent to supervisor successfully',
        data: {
          sessionId: sessionId,
          qrCode: qrCode,
          qrImage: qrDataUrl,
          routeId,
          originBranchId,
          expiresAt,
          _dummy: true
        }
      });

    } catch (error: any) {
      console.error('[DUMMY] generateStartRouteQR error:', error);
      return next(new ErrorHandler(error.message || 'Failed to generate QR', 500));
    }
  }
);








export const getManifestsPaginatedFromRoute = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit as string) || 20),
      );
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const skip = (page - 1) * limit;

      const filter: Record<string, any> = {};

      const toObjectId = (val: string) => new mongoose.Types.ObjectId(val);
      const isValidId = (val: string) => mongoose.Types.ObjectId.isValid(val);

      const user = (req as any).user;
      const userRole = user?.role;
      const userId = user?._id;

      let assignedTransporterId: mongoose.Types.ObjectId | null = null;
      let routeManifestIds: mongoose.Types.ObjectId[] | null = null;
      let manifestStopOrderMap: Map<string, { stopIndex: number; orderInStop: number }> | null = null;

      // ── Company filter ──────────────────────────────────────────────────
      if (req.query.companyId) {
        if (!isValidId(req.query.companyId as string))
          return next(new ErrorHandler("Invalid companyId.", 400));
        filter.companyId = toObjectId(req.query.companyId as string);
      }

      // ── Transporter role: get manifests from their active route ──────
      if (userRole === 'transporter') {
        const transporter = await TransporterModel.findOne({ userId: userId });
        if (!transporter) {
          return next(new ErrorHandler("Transporter profile not found.", 404));
        }

        // ── ONLY GET ROUTES THAT ARE NOT COMPLETED OR CANCELLED ──────────
        const activeRoute = await RouteModel.findOne({
          assignedTransporterId: transporter._id,
          status: { $in: ['planned', 'assigned', 'active', 'paused'] }
        }).lean();

        if (activeRoute && activeRoute.stops && activeRoute.stops.length > 0) {
          const allManifestIds: mongoose.Types.ObjectId[] = [];
          const stopOrderMap = new Map<string, { stopIndex: number; orderInStop: number }>();

          for (let stopIndex = 0; stopIndex < activeRoute.stops.length; stopIndex++) {
            const stop = activeRoute.stops[stopIndex];
            if (stop.manifestIds && stop.manifestIds.length > 0) {
              for (let orderInStop = 0; orderInStop < stop.manifestIds.length; orderInStop++) {
                const manifestId = stop.manifestIds[orderInStop];
                allManifestIds.push(manifestId);
                stopOrderMap.set(manifestId.toString(), {
                  stopIndex: stopIndex,
                  orderInStop: orderInStop
                });
              }
            }
          }

          if (allManifestIds.length > 0) {
            routeManifestIds = allManifestIds;
            manifestStopOrderMap = stopOrderMap;
            filter._id = { $in: allManifestIds };
          } else {
            routeManifestIds = [];
            filter._id = { $in: [] };
          }
        } else {
          routeManifestIds = [];
          filter._id = { $in: [] };
        }

        assignedTransporterId = transporter._id;
      }

      // ── Other role: allow manual transporter filter ──────────────────
      if (req.query.transporterId && userRole !== 'transporter') {
        if (!isValidId(req.query.transporterId as string))
          return next(new ErrorHandler("Invalid transporterId.", 400));
        const transporterId = toObjectId(req.query.transporterId as string);
        assignedTransporterId = transporterId;
        filter["transportLeg.transporterId"] = transporterId;
      }

      // ── Branch filters ──────────────────────────────────────────────────
      if (req.query.originBranchId) {
        if (!isValidId(req.query.originBranchId as string))
          return next(new ErrorHandler("Invalid originBranchId.", 400));
        filter.originBranchId = toObjectId(req.query.originBranchId as string);
      }

      if (req.query.destinationBranchId) {
        if (!isValidId(req.query.destinationBranchId as string))
          return next(new ErrorHandler("Invalid destinationBranchId.", 400));
        filter.destinationBranchId = toObjectId(req.query.destinationBranchId as string);
      }

      if (req.query.branchId) {
        if (!isValidId(req.query.branchId as string))
          return next(new ErrorHandler("Invalid branchId.", 400));
        const branchOid = toObjectId(req.query.branchId as string);
        filter.$or = [
          { originBranchId: branchOid },
          { destinationBranchId: branchOid },
        ];
      }

      // ── Created by filter ──────────────────────────────────────────────
      if (req.query.createdBy) {
        if (!isValidId(req.query.createdBy as string))
          return next(new ErrorHandler("Invalid createdBy.", 400));
        filter.createdBy = toObjectId(req.query.createdBy as string);
      }

      // ── Vehicle filter ──────────────────────────────────────────────────
      if (req.query.vehicleId) {
        if (!isValidId(req.query.vehicleId as string))
          return next(new ErrorHandler("Invalid vehicleId.", 400));
        filter["transportLeg.vehicleId"] = toObjectId(req.query.vehicleId as string);
      }

      // ── Status filters ──────────────────────────────────────────────────
      const VALID_STATUSES: ManifestStatus[] = [
        "open", "sealed", "loaded", "in_transit",
        "arrived", "unloading", "closed", "discrepancy", "cancelled",
      ];

      if (req.query.status) {
        const s = req.query.status as string;
        if (!VALID_STATUSES.includes(s as ManifestStatus))
          return next(new ErrorHandler(`Invalid status: ${s}.`, 400));
        filter.status = s;
      }

      if (req.query.statuses) {
        const statuses = (req.query.statuses as string).split(",").map(s => s.trim());
        const invalid = statuses.filter(s => !VALID_STATUSES.includes(s as ManifestStatus));
        if (invalid.length > 0)
          return next(new ErrorHandler(`Invalid statuses: ${invalid.join(", ")}.`, 400));
        filter.status = { $in: statuses };
      }

      // ── Priority filter ─────────────────────────────────────────────────
      const VALID_PRIORITIES: ManifestPriority[] = ["standard", "express", "urgent"];
      if (req.query.priority) {
        const p = req.query.priority as string;
        if (!VALID_PRIORITIES.includes(p as ManifestPriority))
          return next(new ErrorHandler(`Invalid priority: ${p}.`, 400));
        filter.priority = p;
      }

      // ── Search filters ──────────────────────────────────────────────────
      if (req.query.manifestCode) {
        filter.manifestCode = new RegExp(req.query.manifestCode as string, "i");
      }

      if (req.query.search) {
        const searchRe = new RegExp(req.query.search as string, "i");
        filter.$or = [
          ...(filter.$or || []),
          { manifestCode: searchRe },
          { internalReference: searchRe },
          { notes: searchRe },
          { "packages.trackingNumber": searchRe },
        ];
      }

      // ── Package containment filter ─────────────────────────────────────
      if (req.query.containsPackageId) {
        if (!isValidId(req.query.containsPackageId as string))
          return next(new ErrorHandler("Invalid containsPackageId.", 400));
        filter["packages.packageId"] = toObjectId(req.query.containsPackageId as string);
      }

      // ── Discrepancy filters ─────────────────────────────────────────────
      if (req.query.hasDiscrepancy !== undefined) {
        if (req.query.hasDiscrepancy === "true") {
          filter.$or = [
            ...(filter.$or || []),
            { status: "discrepancy" },
            { discrepancy: { $ne: null } },
          ];
        } else {
          filter.status = { $nin: ["discrepancy"] };
          filter.discrepancy = null;
        }
      }

      // ── Sealed filter ───────────────────────────────────────────────────
      if (req.query.isSealed !== undefined) {
        if (req.query.isSealed === "true") {
          filter.status = { $in: ["sealed", "loaded", "in_transit", "arrived", "unloading", "closed"] };
        } else {
          filter.status = { $in: ["open", "cancelled"] };
        }
      }

      // ── In transit filter ──────────────────────────────────────────────
      if (req.query.isInTransit !== undefined) {
        filter.status = req.query.isInTransit === "true" ? "in_transit" : { $ne: "in_transit" };
      }

      // ── Weight range filters ────────────────────────────────────────────
      if (req.query.minWeight || req.query.maxWeight) {
        const min = req.query.minWeight ? parseFloat(req.query.minWeight as string) : null;
        const max = req.query.maxWeight ? parseFloat(req.query.maxWeight as string) : null;
        filter.totalDeclaredWeight = {
          ...(min !== null && !isNaN(min) && { $gte: min }),
          ...(max !== null && !isNaN(max) && { $lte: max }),
        };
      }

      // ── Package count range filters ────────────────────────────────────
      if (req.query.minPackageCount || req.query.maxPackageCount) {
        const min = req.query.minPackageCount ? parseInt(req.query.minPackageCount as string) : null;
        const max = req.query.maxPackageCount ? parseInt(req.query.maxPackageCount as string) : null;
        filter.packageCount = {
          ...(min !== null && !isNaN(min) && { $gte: min }),
          ...(max !== null && !isNaN(max) && { $lte: max }),
        };
      }

      // ── Date range filters ──────────────────────────────────────────────
      if (req.query.createdFrom || req.query.createdTo) {
        filter.createdAt = {
          ...(req.query.createdFrom && { $gte: new Date(req.query.createdFrom as string) }),
          ...(req.query.createdTo && { $lte: new Date(req.query.createdTo as string) }),
        };
      }

      if (req.query.departedFrom || req.query.departedTo) {
        filter.departedAt = {
          ...(req.query.departedFrom && { $gte: new Date(req.query.departedFrom as string) }),
          ...(req.query.departedTo && { $lte: new Date(req.query.departedTo as string) }),
        };
      }

      if (req.query.arrivedFrom || req.query.arrivedTo) {
        filter.arrivedAt = {
          ...(req.query.arrivedFrom && { $gte: new Date(req.query.arrivedFrom as string) }),
          ...(req.query.arrivedTo && { $lte: new Date(req.query.arrivedTo as string) }),
        };
      }

      // ── Transporter stats ────────────────────────────────────────────────
      let transporterStats: any = null;
      if (assignedTransporterId) {
        const transporter = await TransporterModel.findById(assignedTransporterId)
          .lean({ virtuals: true });

        if (transporter) {
          let statsMatchFilter: any = {};

          if (userRole === 'transporter' && routeManifestIds !== null) {
            if (routeManifestIds.length > 0) {
              statsMatchFilter._id = { $in: routeManifestIds };
            } else {
              statsMatchFilter._id = { $in: [] };
            }
          } else {
            statsMatchFilter["transportLeg.transporterId"] = assignedTransporterId;
          }

          const manifestStats = await ManifestModel.aggregate([
            {
              $match: statsMatchFilter,
            },
            {
              $group: {
                _id: null,
                totalManifests: { $sum: 1 },
                inTransitManifests: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "in_transit"] }, 1, 0],
                  },
                },
                arrivedManifests: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "arrived"] }, 1, 0],
                  },
                },
                closedManifests: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "closed"] }, 1, 0],
                  },
                },
                discrepancyManifests: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "discrepancy"] }, 1, 0],
                  },
                },
                loadedManifests: {
                  $sum: {
                    $cond: [{ $in: ["$status", ["sealed", "loaded"]] }, 1, 0],
                  },
                },
                totalPackagesTransported: {
                  $sum: "$packageCount",
                },
                totalWeightTransported: {
                  $sum: "$totalDeclaredWeight",
                },
                todayManifests: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ["$departedAt", new Date(new Date().setHours(0, 0, 0, 0))] },
                          { $lt: ["$departedAt", new Date(new Date().setHours(23, 59, 59, 999))] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ]);

          const stats = manifestStats[0] || {
            totalManifests: 0,
            inTransitManifests: 0,
            arrivedManifests: 0,
            closedManifests: 0,
            discrepancyManifests: 0,
            loadedManifests: 0,
            totalPackagesTransported: 0,
            totalWeightTransported: 0,
            todayManifests: 0,
          };

          transporterStats = {
            id: transporter._id,
            userId: transporter.userId,
            companyId: transporter.companyId,
            transporterType: transporter.transporterType ?? null,
            isHubTransporter: transporter.isHubTransporter,
            isHubToHub: transporter.isHubToHub,
            isHubToBranch: transporter.isHubToBranch,
            assignedLine: transporter.assignedLine ?? null,
            assignedBranches: transporter.assignedBranches ?? null,
            availabilityStatus: transporter.availabilityStatus,
            verificationStatus: transporter.verificationStatus,
            isActive: transporter.isActive,
            isOnline: transporter.isOnline,
            isSuspended: transporter.isSuspended,
            isVerified: transporter.isVerified,
            isAvailable: transporter.isAvailable,
            isOnDuty: transporter.isOnDuty,
            rating: transporter.rating,
            completionRate: transporter.completionRate,
            todayCompletionRate: transporter.todayCompletionRate,
            efficiencyScore: transporter.efficiencyScore,
            totalTrips: transporter.totalTrips,
            completedTrips: transporter.completedTrips,
            cancelledTrips: transporter.cancelledTrips,
            totalManifestsTransported: transporter.totalManifestsTransported,
            currentActiveManifests: transporter.currentActiveManifests,
            todayTransportedCount: transporter.todayTransportedCount,
            todayAssignedManifests: transporter.todayAssignedManifests,
            todayCompletedTrips: transporter.todayCompletedTrips,
            todayTotalWeight: transporter.todayTotalWeight,
            totalDistance: transporter.totalDistance,
            totalDeliveryTime: transporter.totalDeliveryTime,
            averageDeliveryTime: transporter.averageDeliveryTime,
            manifestStats: {
              totalAssigned: stats.totalManifests,
              loaded: stats.loadedManifests,
              inTransit: stats.inTransitManifests,
              arrived: stats.arrivedManifests,
              closed: stats.closedManifests,
              discrepancy: stats.discrepancyManifests,
              totalPackagesTransported: stats.totalPackagesTransported,
              totalWeightTransported: stats.totalWeightTransported,
              todayManifests: stats.todayManifests,
            },
            documentStatus: transporter.documentStatus,
            hasValidLicense: transporter.hasValidLicense,
            canAcceptJobs: transporter.canAcceptJobs,
            currentBranchId: transporter.currentBranchId ?? null,
            currentVehicleId: transporter.currentVehicleId ?? null,
            currentRouteId: transporter.currentRouteId ?? null,
            suspensionReason: transporter.suspensionReason ?? null,
            suspensionEndDate: transporter.suspensionEndDate ?? null,
            lastActiveAt: transporter.lastActiveAt,
            createdAt: transporter.createdAt,
            updatedAt: transporter.updatedAt,
          };
        }
      }

      // ── Execute query ───────────────────────────────────────────────────
      const [total, manifests] = await Promise.all([
        ManifestModel.countDocuments(filter),
        ManifestModel.find(filter)
          .populate("originBranchId", "name code address.city")
          .populate("destinationBranchId", "name code address.city")
          .populate("createdBy", "name email")
          .populate("transportLeg.transporterId", "name email phone")
          .populate("transportLeg.vehicleId", "registrationNumber type")
          .skip(skip)
          .limit(limit)
          .lean({ virtuals: true }),
      ]);

      // ── Sort manifests by route order (for transporter) ────────────────
      let filteredManifests = manifests as any[];

      if (userRole === 'transporter' && manifestStopOrderMap) {
        filteredManifests.sort((a, b) => {
          const orderA = manifestStopOrderMap.get(a._id.toString());
          const orderB = manifestStopOrderMap.get(b._id.toString());

          if (orderA && orderB) {
            if (orderA.stopIndex !== orderB.stopIndex) {
              return orderA.stopIndex - orderB.stopIndex;
            }
            return orderA.orderInStop - orderB.orderInStop;
          }

          if (orderA) return -1;
          if (orderB) return 1;
          return 0;
        });
      } else {
        // ── Apply sorting for non-transporter roles ──────────────────────
        const sortBy = (req.query.sortBy as string) || "createdAt";
        const order = req.query.order === "desc" ? -1 : 1;

        switch (sortBy) {
          case "manifestCode":
            filteredManifests.sort((a, b) => a.manifestCode.localeCompare(b.manifestCode) * order);
            break;
          case "totalDeclaredWeight":
            filteredManifests.sort((a, b) => (a.totalDeclaredWeight - b.totalDeclaredWeight) * order);
            break;
          case "packageCount":
            filteredManifests.sort((a, b) => (a.packageCount - b.packageCount) * order);
            break;
          case "departedAt":
            filteredManifests.sort(
              (a, b) =>
                (new Date(a.departedAt || 0).getTime() - new Date(b.departedAt || 0).getTime()) * order,
            );
            break;
          case "arrivedAt":
            filteredManifests.sort(
              (a, b) =>
                (new Date(a.arrivedAt || 0).getTime() - new Date(b.arrivedAt || 0).getTime()) * order,
            );
            break;
          case "status":
            filteredManifests.sort((a, b) => a.status.localeCompare(b.status) * order);
            break;
          case "priority":
            const priorityRank: Record<'urgent' | 'express' | 'standard', number> = {
              urgent: 0,
              express: 1,
              standard: 2,
            };
            filteredManifests.sort(
              (a, b) =>
                (priorityRank[a.priority as keyof typeof priorityRank] -
                  priorityRank[b.priority as keyof typeof priorityRank]) *
                order,
            );
            break;
          case "createdAt":
          default:
            filteredManifests.sort(
              (a, b) =>
                (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * order,
            );
            break;
        }
      }

      // ── Format manifests (same as original) ─────────────────────────────
      const formattedManifests = filteredManifests.map((m: any) => ({
        id: m._id,
        manifestCode: m.manifestCode,
        companyId: m.companyId,
        originBranch: m.originBranchId
          ? {
            id: m.originBranchId._id,
            name: m.originBranchId.name,
            code: m.originBranchId.code,
            city: m.originBranchId.address?.city,
          }
          : null,
        destinationBranch: m.destinationBranchId
          ? {
            id: m.destinationBranchId._id,
            name: m.destinationBranchId.name,
            code: m.destinationBranchId.code,
            city: m.destinationBranchId.address?.city,
            coordinates: m.destinationBranchId.location?.coordinates,
          }
          : null,
        status: m.status,
        priority: m.priority,
        createdBy: m.createdBy
          ? { id: m.createdBy._id, name: m.createdBy.name, email: m.createdBy.email }
          : null,
        sealInfo: m.sealInfo
          ? {
            sealedBy: m.sealInfo.sealedBy,
            sealedAt: m.sealInfo.sealedAt,
            sealNumber: m.sealInfo.sealNumber,
            totalWeight: m.sealInfo.totalWeight,
            packageCount: m.sealInfo.packageCount,
            notes: m.sealInfo.notes ?? null,
          }
          : null,
        transportLeg: m.transportLeg
          ? {
            vehicle: m.transportLeg.vehicleId
              ? {
                id: m.transportLeg.vehicleId._id,
                registrationNumber: m.transportLeg.vehicleId.registrationNumber,
                type: m.transportLeg.vehicleId.type,
              }
              : null,
            transporter: m.transportLeg.transporterId
              ? {
                id: m.transportLeg.transporterId._id,
                name: m.transportLeg.transporterId.name,
                email: m.transportLeg.transporterId.email,
                phone: m.transportLeg.transporterId.phone,
              }
              : null,
            assignedAt: m.transportLeg.assignedAt,
            departedAt: m.transportLeg.departedAt ?? null,
            arrivedAt: m.transportLeg.arrivedAt ?? null,
            estimatedArrival: m.transportLeg.estimatedArrival ?? null,
          }
          : null,
        totalDeclaredWeight: m.totalDeclaredWeight,
        packageCount: m.packageCount,
        packages: (m.packages || []).map((p: any) => ({
          packageId: p.packageId,
          trackingNumber: p.trackingNumber,
          weight: p.weight,
          sequence: p.sequence,
          entryStatus: p.entryStatus,
          scannedInAt: p.scannedInAt,
          scannedOutAt: p.scannedOutAt ?? null,
          remanifestId: p.remanifestId ?? null,
          notes: p.notes ?? null,
        })),
        hasDiscrepancy: m.hasDiscrepancy,
        discrepancy: m.discrepancy
          ? {
            reportedBy: m.discrepancy.reportedBy,
            reportedAt: m.discrepancy.reportedAt,
            expectedCount: m.discrepancy.expectedCount,
            actualCount: m.discrepancy.actualCount,
            missingPackageIds: m.discrepancy.missingPackageIds,
            extraPackageIds: m.discrepancy.extraPackageIds,
            notes: m.discrepancy.notes,
            resolvedBy: m.discrepancy.resolvedBy ?? null,
            resolvedAt: m.discrepancy.resolvedAt ?? null,
            resolution: m.discrepancy.resolution ?? null,
          }
          : null,
        isSealed: m.isSealed,
        isInTransit: m.isInTransit,
        isClosed: m.isClosed,
        unloadedCount: m.unloadedCount,
        remainingCount: m.remainingCount,
        durationMinutes: m.durationMinutes ?? null,
        internalReference: m.internalReference ?? null,
        notes: m.notes ?? null,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        sealedAt: m.sealedAt ?? null,
        closedAt: m.closedAt ?? null,
        departedAt: m.departedAt ?? null,
        arrivedAt: m.arrivedAt ?? null,
        estimatedArrival: m.estimatedArrival ?? null,
      }));

      // ── Build response ───────────────────────────────────────────────────
      const responseData: any = {
        manifests: formattedManifests,
        pagination: {
          total: filteredManifests.length,
          page,
          limit,
          pages: Math.ceil(filteredManifests.length / limit),
          hasMore: filteredManifests.length > skip + limit,
        },
        filters: {
          status: req.query.status ?? null,
          statuses: req.query.statuses ?? null,
          priority: req.query.priority ?? null,
          isSealed: req.query.isSealed ?? null,
          isInTransit: req.query.isInTransit ?? null,
          hasDiscrepancy: req.query.hasDiscrepancy ?? null,
          minWeight: req.query.minWeight ?? null,
          maxWeight: req.query.maxWeight ?? null,
          minPackageCount: req.query.minPackageCount ?? null,
          maxPackageCount: req.query.maxPackageCount ?? null,
          manifestCode: req.query.manifestCode ?? null,
          search: req.query.search ?? null,
          containsPackageId: req.query.containsPackageId ?? null,
          companyId: req.query.companyId ?? null,
          originBranchId: req.query.originBranchId ?? null,
          destinationBranchId: req.query.destinationBranchId ?? null,
          branchId: req.query.branchId ?? null,
          createdBy: req.query.createdBy ?? null,
          transporterId: req.query.transporterId ?? null,
          vehicleId: req.query.vehicleId ?? null,
          createdFrom: req.query.createdFrom ?? null,
          createdTo: req.query.createdTo ?? null,
          departedFrom: req.query.departedFrom ?? null,
          departedTo: req.query.departedTo ?? null,
          arrivedFrom: req.query.arrivedFrom ?? null,
          arrivedTo: req.query.arrivedTo ?? null,
          sortBy: req.query.sortBy ?? "route_order",
          order: req.query.order ?? "asc",
        },
      };

      if (transporterStats) {
        responseData.transporterStats = transporterStats;
      }

      res.status(200).json({
        success: true,
        data: responseData,
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400,
          ),
        );
      }
      return next(
        new ErrorHandler(error.message || "Error fetching manifests.", 500),
      );
    }
  },
);