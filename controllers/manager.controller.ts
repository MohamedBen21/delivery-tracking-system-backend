import { Request, Response, NextFunction } from "express";
import CompanyModel, { ICompany } from "../models/company.model";
import ManagerModel from "../models/manager.model";
import userModel from "../models/user.model";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";


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
    } = req.body;

    if (!name || !businessType) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Company name and business type are required",
      });
    }

    const existingManager = await ManagerModel.findOne({ userId }).session(session);
    if (existingManager) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "User already manages a company",
      });
    }

    const existingCompany = await CompanyModel.findOne({ name }).session(session);
    if (existingCompany) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Company name already exists",
      });
    }

    const [user, companyWithSameRegistration] = await Promise.all([
      userModel.findById(userId).session(session),
      registrationNumber
        ? CompanyModel.findOne({ registrationNumber }).session(session)
        : Promise.resolve(null),
    ]);

    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (companyWithSameRegistration) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Registration number already exists",
      });
    }


    user.role = "manager";
    await user.save({ session });

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

    const manager = await ManagerModel.create(
      [
        {
          userId,
          companyId: company[0]._id,
          accessLevel: "full",
          branchAccess: {
            allBranches: true,
            specificBranches: [],
          },
          isActive: true,
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
        manager: manager[0],
      },
    });
  } catch (error: any) {
    await session.abortTransaction();
    session.endSession();

    console.error("Create company error:", error);

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
      message: "Error creating company",
      error: error.message,
    });
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

