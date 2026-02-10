import { Request, Response, NextFunction } from "express";
import CompanyModel, { ICompany } from "../models/company.model";
import ManagerModel from "../models/manager.model";
import userModel from "../models/user.model";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";

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
