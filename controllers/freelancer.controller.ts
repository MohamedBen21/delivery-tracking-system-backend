import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import PackageModel, { PackageStatus } from "../models/package.model";
import PackageHistoryModel from "../models/package-history.model";
import FreelancerModel from "../models/freelancer.model";
import BranchModel from "../models/branch.model";



// Freelancer may only cancel before the package leaves their origin branch.
// Once it is in_transit or beyond,the package must be returned the old same way.
const FREELANCER_CANCELLABLE_STATUSES: PackageStatus[] = [
  "pending",
  "accepted",
  "at_origin_branch",
];

// Statuses that count as active (package is moving / in the system)
const ACTIVE_STATUSES: PackageStatus[] = [
  "pending",
  "accepted",
  "at_origin_branch",
  "in_transit_to_branch",
  "at_destination_branch",
  "out_for_delivery",
  "failed_delivery",
  "rescheduled",
  "on_hold",
];

// Shared lookup stages  added to packages with branch names.
// trackingHistory is excluded from list views (returned only in trackPackage).
const LIST_LOOKUP_STAGES: mongoose.PipelineStage[] = [
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
      pipeline: [{ $project: { name: 1, code: 1 } }],
    },
  },
  { $unwind: { path: "$currentBranch", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "branches",
      localField: "destinationBranchId",
      foreignField: "_id",
      as: "destinationBranch",
      pipeline: [{ $project: { name: 1, code: 1 } }],
    },
  },
  { $unwind: { path: "$destinationBranch", preserveNullAndEmptyArrays: true } },
  { $project: { trackingHistory: 0 } },
];



function paginationMeta(total: number, page: number, limit: number) {
  const totalPages = Math.ceil(total / limit);
  return {
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}


async function resolveFreelancer(
  userId: any,
  next: NextFunction,
): Promise<mongoose.Document & { _id: mongoose.Types.ObjectId; userId: mongoose.Types.ObjectId; companyId: mongoose.Types.ObjectId } | null> {
  if (!userId) {
    next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    return null;
  }
  const freelancer = await FreelancerModel.findOne({ userId }).lean();
  if (!freelancer) {
    next(new ErrorHandler("Freelancer profile not found.", 404));
    return null;
  }
  if (freelancer.status !== "active" || freelancer.isActive === false) {
    next(
      new ErrorHandler(
        `Your freelancer account is ${freelancer.status}. Contact support.`,
        403,
      ),
    );
    return null;
  }
  return freelancer as any;
}



//  GET MY PACKAGES
//  Returns ALL packages sent by this freelancer, grouped by status in the
//  summary and paginated in the data array.
export const getMyPackages = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const freelancerUserId = req.user?._id;

    const freelancer = await resolveFreelancer(freelancerUserId, next);
    if (!freelancer) return;


    const ALL_STATUSES: PackageStatus[] = [
      "pending", "accepted", "at_origin_branch", "in_transit_to_branch",
      "at_destination_branch", "out_for_delivery", "delivered",
      "failed_delivery", "rescheduled", "returned", "cancelled",
      "lost", "damaged", "on_hold",
    ];
    const VALID_PAYMENT_STATUSES = ["pending", "paid", "partially_paid", "refunded", "failed"];
    const VALID_SORT_BY = ["createdAt", "totalPrice", "status"];

    const {
      status,
      deliveryType,
      paymentStatus,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      page,
      limit,
    } = req.query as Record<string, string | undefined>;

    let statusFilter: PackageStatus[] | undefined;
    if (status) {
      const raw = status.split(",").map((s) => s.trim());
      const invalid = raw.filter((s) => !ALL_STATUSES.includes(s as PackageStatus));
      if (invalid.length) {
        return next(
          new ErrorHandler(`Invalid status value(s): ${invalid.join(", ")}`, 400),
        );
      }
      statusFilter = raw as PackageStatus[];
    }

    if (deliveryType && !["home", "branch_pickup"].includes(deliveryType)) {
      return next(new ErrorHandler("deliveryType must be 'home' or 'branch_pickup'", 400));
    }

    if (paymentStatus && !VALID_PAYMENT_STATUSES.includes(paymentStatus)) {
      return next(
        new ErrorHandler(
          `paymentStatus must be one of: ${VALID_PAYMENT_STATUSES.join(", ")}`,
          400,
        ),
      );
    }

    if (!VALID_SORT_BY.includes(sortBy)) {
      return next(
        new ErrorHandler(`sortBy must be one of: ${VALID_SORT_BY.join(", ")}`, 400),
      );
    }

    if (!["asc", "desc"].includes(sortOrder)) {
      return next(new ErrorHandler("sortOrder must be 'asc' or 'desc'", 400));
    }

    const pageNum  = parseInt(page  ?? "1",  10);
    const limitNum = parseInt(limit ?? "20", 10);
    if (isNaN(pageNum)  || pageNum  < 1)               return next(new ErrorHandler("page must be a positive integer", 400));
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) return next(new ErrorHandler("limit must be between 1 and 100", 400));
    const skip = (pageNum - 1) * limitNum;


    const matchStage: Record<string, any> = {
      senderId:   new mongoose.Types.ObjectId((freelancerUserId as mongoose.Types.ObjectId).toString()),
      senderType: "freelancer",
    };

    if (statusFilter) {
      matchStage.status = statusFilter.length === 1 ? statusFilter[0] : { $in: statusFilter };
    }
    if (deliveryType)  matchStage.deliveryType  = deliveryType;
    if (paymentStatus) matchStage.paymentStatus = paymentStatus;
    if (search) {
      const regex = { $regex: search.trim(), $options: "i" };
      matchStage.$or = [
        { trackingNumber: regex },
        { "destination.recipientName":  regex },
        { "destination.recipientPhone": regex },
      ];
    }

    const sortStage: Record<string, 1 | -1> = {
      [sortBy]: sortOrder === "asc" ? 1 : -1,
    };


    const [result] = await PackageModel.aggregate([
      { $match: matchStage },
      ...LIST_LOOKUP_STAGES,
      { $sort: sortStage },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limitNum }],
          totalCount:   [{ $count: "count" }],
          statusSummary: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          paymentSummary: [
            {
              $group: {
                _id: null,
                totalRevenue:   { $sum: "$totalPrice" },
                totalPackages:  { $sum: 1 },
                paidPackages:   { $sum: { $cond: [{ $eq: ["$paymentStatus", "paid"] }, 1, 0] } },
                pendingPayment: { $sum: { $cond: [{ $eq: ["$paymentStatus", "pending"] }, 1, 0] } },
              },
            },
          ],
        },
      },
    ]);

    const total = result.totalCount[0]?.count ?? 0;

    const statusSummary = Object.fromEntries(
      (result.statusSummary as { _id: string; count: number }[]).map(
        ({ _id, count }) => [_id, count],
      ),
    );

    const payment = result.paymentSummary[0] ?? {
      totalRevenue: 0, totalPackages: 0, paidPackages: 0, pendingPayment: 0,
    };

    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: paginationMeta(total, pageNum, limitNum),
      summary: {
        byStatus: statusSummary,
        payment: {
          totalRevenue:   payment.totalRevenue,
          paidPackages:   payment.paidPackages,
          pendingPayment: payment.pendingPayment,
        },
      },
    });
  },
);




//  GET MY ACTIVE PACKAGES
//
//  Active = package is still moving through the system (not terminal).
//  Returns the same structure as getMyPackages but pre-filtered + sorted by
//  most recently updated so the freelancer always sees urgent packages first.

export const getMyActivePackages = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const freelancerUserId = req.user?._id;

    const freelancer = await resolveFreelancer(freelancerUserId, next);
    if (!freelancer) return;

    const { deliveryType, search, page, limit } = req.query as Record<string, string | undefined>;

    if (deliveryType && !["home", "branch_pickup"].includes(deliveryType)) {
      return next(new ErrorHandler("deliveryType must be 'home' or 'branch_pickup'", 400));
    }

    const pageNum  = parseInt(page  ?? "1",  10);
    const limitNum = parseInt(limit ?? "20", 10);
    if (isNaN(pageNum)  || pageNum  < 1)               return next(new ErrorHandler("page must be a positive integer", 400));
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) return next(new ErrorHandler("limit must be between 1 and 100", 400));
    const skip = (pageNum - 1) * limitNum;

    const matchStage: Record<string, any> = {
      senderId:   new mongoose.Types.ObjectId((freelancerUserId as mongoose.Types.ObjectId).toString()),
      senderType: "freelancer",
      status:     { $in: ACTIVE_STATUSES },
    };

    if (deliveryType) matchStage.deliveryType = deliveryType;
    if (search) {
      const regex = { $regex: search.trim(), $options: "i" };
      matchStage.$or = [
        { trackingNumber: regex },
        { "destination.recipientName":  regex },
        { "destination.recipientPhone": regex },
      ];
    }

    const [result] = await PackageModel.aggregate([
      { $match: matchStage },
      ...LIST_LOOKUP_STAGES,
      { $sort: { updatedAt: -1 } },
      {
        $facet: {
          data:          [{ $skip: skip }, { $limit: limitNum }],
          totalCount:    [{ $count: "count" }],
          statusBreakdown: [{ $group: { _id: "$status", count: { $sum: 1 } } }],

          needsAttention: [
            {
              $match: {
                $or: [
                  { status: { $in: ["failed_delivery", "on_hold", "damaged"] } },
                  {
                    estimatedDeliveryTime: { $lt: new Date() },
                    status: { $nin: ["delivered", "cancelled", "returned"] },
                  },
                ],
              },
            },
            { $count: "count" },
          ],
        },
      },
    ]);

    const total = result.totalCount[0]?.count ?? 0;

    const statusBreakdown = Object.fromEntries(
      (result.statusBreakdown as { _id: string; count: number }[]).map(
        ({ _id, count }) => [_id, count],
      ),
    );

    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: paginationMeta(total, pageNum, limitNum),
      summary: {
        total,
        byStatus:      statusBreakdown,
        needsAttention: result.needsAttention[0]?.count ?? 0,
      },
    });
  },
);




//  GET MY DELIVERED PACKAGES
//  Terminal successful deliveries only (status = delivered).
export const getMyDeliveredPackages = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const freelancerUserId = req.user?._id;

    const freelancer = await resolveFreelancer(freelancerUserId, next);
    if (!freelancer) return;

    const {
      fromDate,
      toDate,
      deliveryType,
      paymentStatus,
      search,
      sortOrder = "desc",
      page,
      limit,
    } = req.query as Record<string, string | undefined>;

    const VALID_PAYMENT_STATUSES = ["pending", "paid", "partially_paid", "refunded", "failed"];

    if (deliveryType && !["home", "branch_pickup"].includes(deliveryType)) {
      return next(new ErrorHandler("deliveryType must be 'home' or 'branch_pickup'", 400));
    }

    if (paymentStatus && !VALID_PAYMENT_STATUSES.includes(paymentStatus)) {
      return next(new ErrorHandler(`paymentStatus must be one of: ${VALID_PAYMENT_STATUSES.join(", ")}`, 400));
    }

    if (!["asc", "desc"].includes(sortOrder)) {
      return next(new ErrorHandler("sortOrder must be 'asc' or 'desc'", 400));
    }

    let fromDateParsed: Date | undefined;
    let toDateParsed:   Date | undefined;

    if (fromDate) {
      fromDateParsed = new Date(fromDate);
      if (isNaN(fromDateParsed.getTime())) return next(new ErrorHandler("fromDate is not a valid date", 400));
    }
    if (toDate) {
      toDateParsed = new Date(toDate);
      if (isNaN(toDateParsed.getTime())) return next(new ErrorHandler("toDate is not a valid date", 400));
    }
    if (fromDateParsed && toDateParsed && fromDateParsed > toDateParsed) {
      return next(new ErrorHandler("fromDate must be before toDate", 400));
    }

    const pageNum  = parseInt(page  ?? "1",  10);
    const limitNum = parseInt(limit ?? "20", 10);
    if (isNaN(pageNum)  || pageNum  < 1)               return next(new ErrorHandler("page must be a positive integer", 400));
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) return next(new ErrorHandler("limit must be between 1 and 100", 400));
    const skip = (pageNum - 1) * limitNum;

    const matchStage: Record<string, any> = {
      senderId:   new mongoose.Types.ObjectId((freelancerUserId as mongoose.Types.ObjectId).toString()),
      senderType: "freelancer",
      status:     "delivered",
    };

    if (fromDateParsed || toDateParsed) {
      matchStage.deliveredAt = {
        ...(fromDateParsed && { $gte: fromDateParsed }),
        ...(toDateParsed   && { $lte: toDateParsed   }),
      };
    }

    if (deliveryType)  matchStage.deliveryType  = deliveryType;
    if (paymentStatus) matchStage.paymentStatus = paymentStatus;
    if (search) {
      const regex = { $regex: search.trim(), $options: "i" };
      matchStage.$or = [
        { trackingNumber: regex },
        { "destination.recipientName":  regex },
        { "destination.recipientPhone": regex },
      ];
    }

    const [result] = await PackageModel.aggregate([
      { $match: matchStage },
      ...LIST_LOOKUP_STAGES,
      { $sort: { deliveredAt: sortOrder === "asc" ? 1 : -1 } },
      {
        $facet: {
          data:         [{ $skip: skip }, { $limit: limitNum }],
          totalCount:   [{ $count: "count" }],
          revenueStats: [
            {
              $group: {
                _id:           null,
                totalRevenue:  { $sum: "$totalPrice" },
                avgOrderValue: { $avg: "$totalPrice" },
                paidCount:     { $sum: { $cond: [{ $eq: ["$paymentStatus", "paid"] }, 1, 0] } },
              },
            },
          ],

          monthlyBreakdown: [
            {
              $group: {
                _id: {
                  year:  { $year:  "$deliveredAt" },
                  month: { $month: "$deliveredAt" },
                },
                count:   { $sum: 1 },
                revenue: { $sum: "$totalPrice" },
              },
            },
            { $sort: { "_id.year": -1, "_id.month": -1 } },
            { $limit: 12 },
          ],
        },
      },
    ]);

    const total   = result.totalCount[0]?.count ?? 0;
    const revenue = result.revenueStats[0] ?? { totalRevenue: 0, avgOrderValue: 0, paidCount: 0 };

    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: paginationMeta(total, pageNum, limitNum),
      summary: {
        total,
        totalRevenue:   revenue.totalRevenue,
        avgOrderValue:  revenue.avgOrderValue,
        paidCount:      revenue.paidCount,
        monthlyBreakdown: result.monthlyBreakdown,
      },
    });
  },
);





//  CANCEL PACKAGE
//  Freelancer may only cancel while the package is still at the origin branch
//  or hasn't been accepted yet. Once it's in transit the shipment is already
//  moving and must be returned the same old way.
export const cancelPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const freelancerUserId = req.user?._id;
      const { packageId } = req.params;

      if (!freelancerUserId) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Invalid package ID", 400));
      }

      const { reason } = req.body as { reason?: string };

      if (reason !== undefined && typeof reason !== "string") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("reason must be a string", 400));
      }

      // ── Auth + package (parallel) ────────────────────────────────────────
      const [freelancer, packageDoc] = await Promise.all([
        FreelancerModel.findOne({ userId: freelancerUserId }).session(session),
        PackageModel.findOne({
          _id: packageId,
          senderId:   freelancerUserId,
          senderType: "freelancer",
        }).session(session),
      ]);

      if (!freelancer || freelancer.status !== "active") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Freelancer account is not active", 403));
      }

      if (!packageDoc) {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Package not found or does not belong to you", 404));
      }

      if (packageDoc.status === "cancelled") {
        await session.abortTransaction();
        session.endSession();
        return next(new ErrorHandler("Package is already cancelled", 400));
      }

      if (!FREELANCER_CANCELLABLE_STATUSES.includes(packageDoc.status)) {
        await session.abortTransaction();
        session.endSession();
        return next(
          new ErrorHandler(
            `Cannot cancel a package with status '${packageDoc.status}'. ` +
              `Cancellation is only allowed while the package is: ${FREELANCER_CANCELLABLE_STATUSES.join(", ")}. ` +
              `Contact your branch supervisor to cancel a shipment that is already in transit.`,
            400,
          ),
        );
      }

      const now = new Date();
      const noteText = reason?.trim()
        ? `Cancelled by freelancer. Reason: ${reason.trim()}`
        : "Cancelled by freelancer";

      await Promise.all([
        // Update package
        PackageModel.findByIdAndUpdate(
          packageId,
          {
            $set: { status: "cancelled" },
            $push: {
              trackingHistory: {
                status:    "cancelled",
                branchId:  packageDoc.currentBranchId,
                userId:    freelancerUserId,
                notes:     noteText,
                timestamp: now,
              },
            },
          },
          { session },
        ),


        PackageHistoryModel.create(
          [
            {
              packageId:   new mongoose.Types.ObjectId(packageId.toString()),
              status:      "cancelled" as PackageStatus,
              handledBy:   new mongoose.Types.ObjectId(freelancerUserId.toString()),
              handlerRole: "client", 
              branchId:    packageDoc.currentBranchId,
              notes:       noteText,
              timestamp:   now,
            },
          ],
          { session },
        ),

        // Decrement branch currentLoad
        BranchModel.findByIdAndUpdate(
          packageDoc.currentBranchId,
          { $inc: { currentLoad: -1 } },
          { session },
        ),

        // Update freelancer statistics
        FreelancerModel.findByIdAndUpdate(
          freelancer._id,
          {
            $inc: {
              "statistics.packagesCancelled": 1,
              // Subtract from inTransit only if it was already counted there
              ...(["at_origin_branch", "accepted"].includes(packageDoc.status) && {
                "statistics.packagesInTransit": -1,
              }),
            },
            $set: { lastActiveAt: now },
          },
          { session },
        ),
      ]);

      await session.commitTransaction();
      session.endSession();

      return res.status(200).json({
        success: true,
        message: "Package cancelled successfully",
        data: {
          packageId,
          trackingNumber: packageDoc.trackingNumber,
          status:         "cancelled",
          cancelledAt:    now,
          previousStatus: packageDoc.status,
        },
      });
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      return next(new ErrorHandler(error.message || "Error cancelling package", 500));
    }
  },
);

