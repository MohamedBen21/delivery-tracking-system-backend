import { Request, Response, NextFunction } from "express";
import CompanyModel, { ICompany } from "../models/company.model";
import ManagerModel from "../models/manager.model";
import userModel from "../models/user.model";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import BranchModel, { WeekDay } from "../models/branch.model";
import SupervisorModel, { SupervisorPermission } from "../models/supervisor.model";

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

export const createCompany = catchAsyncError( async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.user?._id;

    if (!userId) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler("Unauthorized - User not authenticated", 401));
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
      return next(new ErrorHandler("Name and business type are required", 400));
    }

    const companyType = ["solo", "company"];

    if (!businessType || typeof name !== "string" || companyType.includes(businessType)) {

      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler("Name and business type does not meet the requirements", 400));
    }

    if(registrationNumber && typeof registrationNumber !== "string"){

      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler("Registration number must be a string", 400));
    }

    if (businessType === "company" && !registrationNumber) {
      await session.abortTransaction();
      session.endSession();
      return next(
        new ErrorHandler(
          "Registration number is required for company business type",
          400
        )
      );
    }


    if(email && typeof email !== "string"){

      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler("email must be a string", 400));

    }

    if(phone && typeof phone !== "string"){

      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler("phone number must be a string", 400));
    }


    if (headquarters) {
        const hq = headquarters;

        if (
          typeof hq.address !== "string" ||
          typeof hq.city !== "string" 
        ) {
          return next(
            new ErrorHandler("Invalid headquarters address data", 400)
          );
        }

        if (
          !hq.location ||
          hq.location.type !== "Point" ||
          !Array.isArray(hq.location.coordinates) ||
          hq.location.coordinates.length !== 2
        ) {
          return next(
            new ErrorHandler("Invalid headquarters location format", 400)
          );
        }
    }

    const existingCompany = await CompanyModel.findOne({ name }).session(session);

    if (existingCompany) {

      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler("Company with this name already exists.", 400));

    }

    let companyWithSameRegistration = null;

    if (businessType === "company" && registrationNumber) {

      companyWithSameRegistration = await CompanyModel.findOne({ registrationNumber }).session(session);

      if (companyWithSameRegistration) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            "Company with this registration number already exists.",
            400
          )
        );
      }
    }


    const [user,manager] = await Promise.all([
      userModel.findById(userId).session(session),
      ManagerModel.findOne({userId}).session(session),
    ]);

    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler("User Not found",400));
    }

    if (companyWithSameRegistration) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler("Company with this registration number already exists.", 400));
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
      { session }
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
        manager
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
          400
        )
      );
    }

    return next(new ErrorHandler(error.message || "Error creating company", 500));
  }
});


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
export const updateCompany = catchAsyncError(async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.user?._id;
    const { companyId } = req.params;

    if (!userId) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler("Unauthorized, you are not authenticated", 401));
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
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

    if (body.registrationNumber && typeof body.registrationNumber !== "string") {

      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler("Registration number must be a string", 400));

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

      if (
        typeof hq.address !== "string" ||
        typeof hq.city !== "string"
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid headquarters address data", 400));
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
          new ErrorHandler("Invalid headquarters location format", 400)
        );
      }
    }

    const [company,user, manager] = await Promise.all([
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
        new ErrorHandler("You are not authorized to update this company", 403)
      );
    }

    if (!manager.hasPermission("can_manage_settings")) {
      await session.abortTransaction();
      session.endSession();
      return next(
        new ErrorHandler(
          "You don't have permission to update company settings",
          403
        )
      );
    }


    const finalBusinessType = body.businessType ?? company.businessType;
    const finalRegistration = body.registrationNumber ?? company.registrationNumber;

    if (finalBusinessType === "company" && !finalRegistration) {
      await session.abortTransaction();
      session.endSession();
      return next(
        new ErrorHandler(
          "Registration number is required for company business type",
          400
        )
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
            400
          )
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
      manager
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

    return next(
      new ErrorHandler(error.message || "Error updating company", 500)
    );
  }
});


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
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
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
      const isAuthorizedManager = manager && manager.hasPermission("can_manage_settings");

      if (!isAdmin && !isAuthorizedManager) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler("Not authorized to change company status", 403)
        );
      }

      if (!["active", "suspended"].includes(company.status)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(`Invalid company status: ${company.status}`, 400)
        );
      }

      const newStatus: CompanyStatus = company.status === "active" ? "suspended" : "active";

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
        new ErrorHandler(error.message || "Error toggling company status", 500)
      );
    }
  }
);



//get company 
export const getCompany = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;
    const { companyId } = req.params;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, user not authenticated.", 401));
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
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
        new ErrorHandler("Not authorized to view this company", 403)
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

    } catch (error:any) {
      return next(new ErrorHandler(error.message || "Error getting company.", 500)
      );
    }
  }
);




export const getMyCompany = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    const manager = await ManagerModel.findOne({ userId })
      .populate({
        path: "userId",  
        select: "firstName lastName email phone username"
      }).populate("companyId").lean();

    if (!manager) {
      return next(
        new ErrorHandler("You are not a manager of any company", 404)
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
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
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
          new ErrorHandler("name, code, address, location, phone and email are required", 400)
        );
      }

      if (typeof name !== "string" || typeof code !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("name and code must be strings", 400));
      }

      if (
        !address.street || typeof address.street !== "string" ||
        !address.city   || typeof address.city   !== "string" ||
        !address.state  || typeof address.state  !== "string"
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("address must include street, city and state", 400));
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
        return next(new ErrorHandler("Invalid location format. Expected GeoJSON Point with [lng, lat]", 400));
      }

      if (capacityLimit !== undefined && (typeof capacityLimit !== "number" || capacityLimit < 1)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("capacityLimit must be a positive number", 400));
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
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      if (!manager.hasPermission("can_manage_branches")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage branches", 403));
      }

      if (company.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot create branch for an inactive or suspended company", 400));
      }


      const existingBranch = await BranchModel.findOne({ code: code.toUpperCase() }).session(session);

      if (existingBranch) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("A branch with this code already exists", 400));
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
        { session }
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
            400
          )
        );
      }

      return next(new ErrorHandler(error.message || "Error creating branch", 500));
    }
  }
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
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
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
          (city   !== undefined && typeof city   !== "string") ||
          (state  !== undefined && typeof state  !== "string")
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
          return next(new ErrorHandler("Invalid location format. Expected GeoJSON Point with [lng, lat]", 400));
        }
      }

      if (
        body.capacityLimit !== undefined &&
        (typeof body.capacityLimit !== "number" || body.capacityLimit < 1)
      ) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("capacityLimit must be a positive number", 400));
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
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      if (!manager.hasPermission("can_manage_branches")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage branches", 403));
      }


      if (!manager.canAccessBranch(new mongoose.Types.ObjectId(branchId.toString()))) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have access to this branch", 403));
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
            400
          )
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
            400
          )
        );
      }

      return next(new ErrorHandler(error.message || "Error updating branch", 500));
    }
  }
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
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
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
        manager.canAccessBranch(new mongoose.Types.ObjectId(branchId.toString()));

      if (!isAdmin && !isAuthorizedManager) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Not authorized to change this branch status", 403));
      }


      if (!["active", "inactive"].includes(branch.status)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Cannot toggle a branch with status "${branch.status}". Only active/inactive branches can be toggled`,
            400
          )
        );
      }

      const newStatus: BranchStatus = branch.status === "active" ? "inactive" : "active";

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
      return next(new ErrorHandler(error.message || "Error toggling branch status", 500));
    }
  }
);


//  GET BRANCH BY ID

export const getBranch = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const { companyId, branchId } = req.params;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
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
  }
);



//  GET ALL BRANCHES OF MANAGER'S COMPANY

export const getMyBranches = catchAsyncError(
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
  }
);



//supervisor functions and interfaces

interface IWorkScheduleDayBody {
  start: string;
  end: string;
  dayOff: boolean;
}

interface ICreateSupervisor {
  userId: string;
  branchId: string;
  permissions?: SupervisorPermission[];
  workSchedule?: Partial<Record<WeekDay, IWorkScheduleDayBody>>;
}

interface IUpdateSupervisor {
  permissions?: SupervisorPermission[];
  workSchedule?: Partial<Record<WeekDay, IWorkScheduleDayBody>>;
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
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      const { userId, branchId, permissions, workSchedule } = req.body as ICreateSupervisor;

      if (!userId || !branchId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("userId and branchId are required", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(userId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid user ID", 400));
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
          return next(new ErrorHandler("permissions must be an array", 400));
        }
        if (new Set(permissions).size !== permissions.length) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Duplicate permissions are not allowed", 400));
        }
      }

      const [manager, targetUser, branch, existingSupervisor] = await Promise.all([
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
        userModel.findById(userId).session(session),
        BranchModel.findOne({ _id: branchId, companyId }).session(session),
        SupervisorModel.findOne({ userId }).session(session),
      ]);

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      if (!manager.hasPermission("can_manage_supervisors")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage supervisors", 403));
      }

      if (!manager.canAccessBranch(new mongoose.Types.ObjectId(branchId))) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have access to this branch", 403));
      }

      if (!targetUser) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("User not found", 404));
      }

      if (!branch) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Branch not found or does not belong to this company", 404));
      }

      if (branch.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Cannot assign a supervisor to an inactive branch", 400));
      }

      if (existingSupervisor) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("This user is already a supervisor", 400));
      }

      targetUser.role = "supervisor";
      await targetUser.save({ session });

      const supervisor = await SupervisorModel.create(
        [
          {
            userId,
            companyId,
            branchId,
            ...(permissions && { permissions }),
            ...(workSchedule && { workSchedule }),
            isActive: true,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

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

      return next(new ErrorHandler(error.message || "Error creating supervisor", 500));
    }
  }
);


//  UPDATE SUPERVISOR
export const updateSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const managerId = req.user?._id;
      const { companyId, supervisorId } = req.params;

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

      if (!supervisorId || !mongoose.Types.ObjectId.isValid(supervisorId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid supervisor ID", 400));
      }

      const body = req.body as IUpdateSupervisor;

      if (Object.keys(body).length === 0) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("No update data provided", 400));
      }

      if (body.permissions !== undefined) {
        if (!Array.isArray(body.permissions)) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("permissions must be an array", 400));
        }
        if (new Set(body.permissions).size !== body.permissions.length) {
          await session.abortTransaction();
          session.endSession();
          return next(new ErrorHandler("Duplicate permissions are not allowed", 400));
        }
      }

      const [supervisor, manager] = await Promise.all([
        SupervisorModel.findOne({ _id: supervisorId, companyId }).session(session),
        ManagerModel.findOne({ userId: managerId, companyId }).session(session),
      ]);

      if (!supervisor) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Supervisor not found", 404));
      }

      if (!manager || !manager.isActive) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You are not an active manager of this company", 403));
      }

      if (!manager.hasPermission("can_manage_supervisors")) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have permission to manage supervisors", 403));
      }

      if (!manager.canAccessBranch(supervisor.branchId)) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("You don't have access to this supervisor's branch", 403));
      }

      if (body.workSchedule) {
        const days = Object.keys(body.workSchedule) as WeekDay[];
        days.forEach((day) => {
          supervisor.workSchedule[day] = {
            ...supervisor.workSchedule[day],
            ...body.workSchedule![day],
          };
        });
      }

      if (body.permissions) {
        supervisor.permissions = body.permissions;
      }

      await supervisor.save({ session });

      await session.commitTransaction();
      session.endSession();

      const populatedSupervisor = await SupervisorModel.findById(supervisorId)
        .populate("userId", "firstName lastName email phone username imageUrl")
        .populate("branchId", "name code address status")
        .populate("companyId", "name businessType status")
        .lean();

      return res.status(200).json({
        success: true,
        message: "Supervisor updated successfully",
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
            400
          )
        );
      }

      return next(new ErrorHandler(error.message || "Error updating supervisor", 500));
    }
  }
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
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid company ID", 400));
      }

      if (!supervisorId || !mongoose.Types.ObjectId.isValid(supervisorId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid supervisor ID", 400));
      }

      const [supervisor, manager, requestingUser] = await Promise.all([
        SupervisorModel.findOne({ _id: supervisorId, companyId }).session(session),
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
        return next(new ErrorHandler("Not authorized to change this supervisor's status", 403));
      }

      const newIsActive = !supervisor.isActive;

      await Promise.all([
        supervisor.set({ isActive: newIsActive }).save({ session }),
        userModel.findByIdAndUpdate(
          supervisor.userId,
          { status: newIsActive ? "active" : "suspended" },
          { session }
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
      return next(new ErrorHandler(error.message || "Error toggling supervisor status", 500));
    }
  }
);


//  GET BRANCH SUPERVISOR
export const getBranchSupervisor = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const managerId = req.user?._id;
    const { companyId, branchId } = req.params;

    if (!managerId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
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
      return next(new ErrorHandler("Not authorized to view this branch's supervisor", 403));
    }

    if (!supervisor) {
      return next(new ErrorHandler("No supervisor found for this branch", 404));
    }

    return res.status(200).json({
      success: true,
      data: supervisor,
    });
  }
);


//  GET ALL ACTIVE SUPERVISORS OF MY COMPANY
export const getMySupervisors = catchAsyncError(
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
                  { lastName:  { $regex: search, $options: "i" } },
                  { email:     { $regex: search, $options: "i" } },
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
  }
);