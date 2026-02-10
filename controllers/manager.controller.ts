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

//update company
export const updateCompany = catchAsyncError(async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?._id;
    const { companyId } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized - User not authenticated",
      });
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid((companyId.toString()))) {
      return res.status(400).json({
        success: false,
        message: "Invalid company ID",
      });
    }

    const {
      name,
      businessType,
      registrationNumber,
      email,
      phone,
      logo,
      headquarters,
      status,
    } = req.body;

    // Check if nothing to update
    if (
      !name &&
      !businessType &&
      !registrationNumber &&
      !email &&
      !phone &&
      !logo &&
      !headquarters &&
      !status
    ) {
      return res.status(400).json({
        success: false,
        message: "No update data provided",
      });
    }

    const [company, manager, nameExists, registrationExists] = await Promise.all([
      CompanyModel.findById(companyId),
      ManagerModel.findOne({ userId, companyId }),
      name
        ? CompanyModel.findOne({ name, _id: { $ne: companyId } })
        : Promise.resolve(null),
      registrationNumber
        ? CompanyModel.findOne({
            registrationNumber,
            _id: { $ne: companyId },
          })
        : Promise.resolve(null),
    ]);

    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Company not found",
      });
    }

    if (!manager) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to update this company",
      });
    }


    if (!manager.hasPermission("can_manage_settings")) {
      return res.status(403).json({
        success: false,
        message: "You don't have permission to update company settings",
      });
    }

    if (nameExists) {
      return res.status(400).json({
        success: false,
        message: "Company name already exists",
      });
    }

    if (registrationExists) {
      return res.status(400).json({
        success: false,
        message: "Registration number already exists",
      });
    }

    const updateData: any = {};
    if (name) updateData.name = name;
    if (businessType) updateData.businessType = businessType;
    if (registrationNumber) updateData.registrationNumber = registrationNumber;
    if (email) updateData.email = email;
    if (phone) updateData.phone = phone;
    if (logo) updateData.logo = logo;
    if (headquarters) updateData.headquarters = headquarters;
    if (status) updateData.status = status;

    const updatedCompany = await CompanyModel.findByIdAndUpdate(
      companyId,
      { $set: updateData },
      {
        new: true,
        runValidators: true,
      }
    ).populate("userId", "firstName lastName email phone username");

    return res.status(200).json({
      success: true,
      message: "Company updated successfully",
      data: updatedCompany,
    });
  } catch (error: any) {
    console.error("Update company error:", error);

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map(
        (err: any) => err.message
      );
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors: messages,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Error updating company",
      error: error.message,
    });
  }
});

//toggle between suspend and activate company
export const toggleBlockCompany = catchAsyncError(async (
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
      return res.status(401).json({
        success: false,
        message: "Unauthorized - User not authenticated",
      });
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Invalid company ID",
      });
    }


    const [company, manager, user] = await Promise.all([
      CompanyModel.findById(companyId).session(session),
      ManagerModel.findOne({ userId, companyId }).session(session),
      userModel.findById(userId).session(session),
    ]);

    if (!company) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "Company not found",
      });
    }

    const isAdmin = user?.role === "admin";
    const isAuthorizedManager =
      manager && manager.hasPermission("can_manage_settings");

    if (!isAdmin && !isAuthorizedManager) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({
        success: false,
        message: "You are not authorized to block/unblock this company",
      });
    }

    let newStatus: "active" | "suspended";
    let action: string;

    if (company.status === "active") {
      newStatus = "suspended";
      action = "suspended";
    } else if (company.status === "suspended") {
      newStatus = "active";
      action = "activated";
    } else {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Cannot toggle company with status: ${company.status}`,
      });
    }

    company.status = newStatus;
    await company.save({ session });

    if (newStatus === "suspended") {
      await ManagerModel.updateMany(
        { companyId },
        { $set: { isActive: false } }
      ).session(session);
    } else {

      await ManagerModel.updateMany(
        { companyId },
        { $set: { isActive: true } }
      ).session(session);
    }

    await session.commitTransaction();
    session.endSession();

    const updatedCompany = await CompanyModel.findById(companyId)
      .populate("userId", "firstName lastName email phone username")
      .lean();

    return res.status(200).json({
      success: true,
      message: `Company ${action} successfully`,
      data: {
        company: updatedCompany,
        previousStatus: company.status === "active" ? "suspended" : "active",
        newStatus,
      },
    });
  } catch (error: any) {
    await session.abortTransaction();
    session.endSession();

    console.error("Toggle block company error:", error);

    return res.status(500).json({
      success: false,
      message: "Error toggling company status",
      error: error.message,
    });
  }
});


//get company 
export const getCompany = catchAsyncError(async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?._id;
    const { companyId } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized - User not authenticated",
      });
    }

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId.toString())) {
      return res.status(400).json({
        success: false,
        message: "Invalid company ID",
      });
    }

    const [company, manager, user] = await Promise.all([
      CompanyModel.findById(companyId)
        .populate("userId", "firstName lastName email phone username imageUrl")
        .lean(),
      ManagerModel.findOne({ userId, companyId }).lean(),
      userModel.findById(userId).select("role").lean(),
    ]);

    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Company not found",
      });
    }


    const isAdmin = user?.role === "admin";
    const isManager = !!manager;

    if (!isAdmin && !isManager) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to view this company",
      });
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
    console.error("Get company error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching company",
      error: error.message,
    });
  }
});



// GET MY COMPANY (Get company where this user is a manager)
export const getMyCompany = catchAsyncError(async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized - User not authenticated",
      });
    }

    const manager = await ManagerModel.findOne({ userId })
      .populate({
        path: "companyId",
        populate: {
          path: "userId",
          select: "firstName lastName email phone username imageUrl",
        },
      })
      .lean();

    if (!manager) {
      return res.status(404).json({
        success: false,
        message: "You are not a manager of any company",
      });
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
      },
    });
  } catch (error: any) {
    console.error("Get my company error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching your company",
      error: error.message,
    });
  }
});

