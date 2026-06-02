import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import PackageModel, { PackageStatus } from "../models/package.model";
import PackageHistoryModel from "../models/package-history.model";
import FreelancerModel, { IFreelancer } from "../models/freelancer.model";
import BranchModel from "../models/branch.model";
import userModel from "../models/user.model";
import { buildUserFieldUpdates } from "./manager.controller";
import PaymentModel from "../models/payment.model";
import clientModel from "../models/client.model";
import { sendPackageCreatedNotification } from "../services/notification.service";



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
) {
  if (!userId) {
    next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    return null;
  }
  
  const freelancer = await FreelancerModel.findOne({ userId });
  
  if (!freelancer) {
    throw new ErrorHandler("Freelancer profile not found.", 404);
    return null;
  }
  
  if (freelancer.status !== "active" || !freelancer.isActive) {

    throw  new ErrorHandler(
        `Your freelancer account is ${freelancer.status}. Contact support.`,
        403,
    );
    return null;
  }
  
  return freelancer;
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

    let transactionCommitted = false;

    try {
      const freelancerUserId = req.user?._id;
      const { packageId } = req.params;

      if (!freelancerUserId) {

        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {

        return next(new ErrorHandler("Invalid package ID", 400));
      }

      const { reason } = req.body as { reason?: string };

      if (reason !== undefined && typeof reason !== "string") {

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

        throw new ErrorHandler("Freelancer account is not active", 403);
      }

      if (!packageDoc) {

        throw new ErrorHandler("Package not found or does not belong to you", 404);
      }

      if (packageDoc.status === "cancelled") {

        throw new ErrorHandler("Package is already cancelled", 400);
      }

      if (!FREELANCER_CANCELLABLE_STATUSES.includes(packageDoc.status)) {

        throw new ErrorHandler(
          `Cannot cancel a package with status '${packageDoc.status}'. ` +
            `Cancellation is only allowed while the package is: ${FREELANCER_CANCELLABLE_STATUSES.join(", ")}. ` +
            `Contact your branch supervisor to cancel a shipment that is already in transit.`,
            400,
          )
      }

      const now = new Date();
      const noteText = reason?.trim()
        ? `Cancelled by freelancer. Reason: ${reason.trim()}`
        : "Cancelled by freelancer";

        await Promise.all([

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


        PaymentModel.findOneAndUpdate(
          { packageId: packageDoc._id },
          { $set: { status: 'cancelled' } },
          { session }
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
      transactionCommitted = true;

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

      if (error.name === "ValidationError") {
        return next(new ErrorHandler(
          Object.values(error.errors).map((e: any) => e.message).join(", "), 400
        ));
      }

      return next(error);
    }
    finally {

      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => {});
      }
      
      await session.endSession();
    }
  },
);





//  TRACK PACKAGE
//  Returns the full tracking timeline from the embedded trackingHistory array
const READABLE_STATUS: Record<PackageStatus, string> = {
  pending:               "Created",
  accepted:              "Accepted",
  at_origin_branch:      "At Origin Branch",
  in_transit_to_branch:  "In Transit",
  at_destination_branch: "Arrived at Destination Branch",
  out_for_delivery:      "Out for Delivery",
  delivered:             "Delivered",
  failed_delivery:       "Delivery Failed",
  failed_delivery_attempt:       "Delivery Failed attempt",

  cashier_claimed: 'Claimed at Counter',
  manifested:      'Assigned to Manifest',

  rescheduled:           "Rescheduled",
  returned:              "Returned",
  cancelled:             "Cancelled",
  lost:                  "Lost",
  damaged:               "Damaged",
  on_hold:               "On Hold",
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

const EXCEPTION_STATUSES = new Set<PackageStatus>([
  "failed_delivery", "rescheduled", "returned",
  "cancelled", "lost", "damaged", "on_hold",
]);

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

export const trackPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const freelancerUserId = req.user?._id;
    const { packageId } = req.params;

    if (!freelancerUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!packageId || !mongoose.Types.ObjectId.isValid(packageId.toString())) {
      return next(new ErrorHandler("Invalid package ID", 400));
    }


    const [freelancer, packageDoc] = await Promise.all([
      FreelancerModel.findOne({ userId: freelancerUserId }).lean(),
      PackageModel.findOne({
        _id:        packageId,
        senderId:   freelancerUserId,
        senderType: "freelancer",
      })
        .select(
          "trackingNumber status deliveryType deliveryPriority " +
          "destination originBranchId currentBranchId destinationBranchId " +
          "totalPrice paymentStatus estimatedDeliveryTime deliveredAt " +
          "attemptCount maxAttempts returnInfo trackingHistory createdAt weight type isFragile",
        )
        .populate("originBranchId",      "name code address")
        .populate("currentBranchId",     "name code address")
        .populate("destinationBranchId", "name code address")
        .lean(),
    ]);

    if (!freelancer || freelancer.status !== "active") {
      return next(new ErrorHandler("Freelancer account is not active", 403));
    }

    if (!packageDoc) {
      return next(
        new ErrorHandler("Package not found or does not belong to you", 404),
      );
    }


    const history: any[] = ((packageDoc as any).trackingHistory ?? [])
      .slice()
      .sort(
        (a: any, b: any) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

    const currentStatus = packageDoc.status as PackageStatus;

    const timeline = history.map((event: any, idx: number) => {
      const status = event.status as PackageStatus;
      return {
        status,
        readableStatus: READABLE_STATUS[status] ?? status,
        isException:    EXCEPTION_STATUSES.has(status),
        stepState:      idx === history.length - 1 ? "active" : "completed",
        timestamp:      event.timestamp,
        notes:          event.notes   ?? null,
        location:       event.location ?? null,
      };
    });


    const expectedSteps = HAPPY_PATH.map((status) => {
      const reached   = history.find((e: any) => e.status === status);
      const isCurrent = status === currentStatus;
      return {
        status,
        readableStatus: READABLE_STATUS[status],
        stepState:  reached ? (isCurrent ? "active" : "completed") : "pending",
        timestamp:  reached?.timestamp ?? null,
      };
    });


    const latestEvent = history[history.length - 1];
    let lastUpdatedAgo: string | null = null;
    if (latestEvent) {
      const seconds = Math.floor(
        (Date.now() - new Date(latestEvent.timestamp).getTime()) / 1000,
      );
      if      (seconds < 60)    lastUpdatedAgo = "just now";
      else if (seconds < 3600)  lastUpdatedAgo = `${Math.floor(seconds / 60)}m ago`;
      else if (seconds < 86400) lastUpdatedAgo = `${Math.floor(seconds / 3600)}h ago`;
      else                      lastUpdatedAgo = `${Math.floor(seconds / 86400)}d ago`;
    }

    return res.status(200).json({
      success: true,

      currentState: {
        status:         currentStatus,
        readableStatus: READABLE_STATUS[currentStatus] ?? currentStatus,
        isException:    EXCEPTION_STATUSES.has(currentStatus),
        progress:       deliveryProgress(currentStatus),
        lastUpdatedAgo,
      },

      package: {
        trackingNumber:        packageDoc.trackingNumber,
        type:                  (packageDoc as any).type,
        isFragile:             (packageDoc as any).isFragile,
        weight:                (packageDoc as any).weight,
        deliveryType:          packageDoc.deliveryType,
        deliveryPriority:      (packageDoc as any).deliveryPriority,
        totalPrice:            (packageDoc as any).totalPrice,
        paymentStatus:         (packageDoc as any).paymentStatus,
        estimatedDeliveryTime: (packageDoc as any).estimatedDeliveryTime ?? null,
        deliveredAt:           (packageDoc as any).deliveredAt           ?? null,
        attemptCount:          (packageDoc as any).attemptCount,
        maxAttempts:           (packageDoc as any).maxAttempts,
        isReturn:              (packageDoc as any).returnInfo?.isReturn   ?? false,
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



export const getMeFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
 
    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }
 
    const [user, freelancer] = await Promise.all([
      userModel.findById(userId)
        .select("firstName lastName email phone imageUrl role status createdAt")
        .lean(),
      FreelancerModel.findOne({ userId })
        .populate("companyId",            "name logo status")
        .populate("defaultOriginBranchId", "name code address wilaya")
        .lean(),
    ]);
 
    if (!user) {
      return next(new ErrorHandler("User not found.", 404));
    }
    if (!freelancer) {
      return next(new ErrorHandler("Freelancer profile not found.", 404));
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

        businessName:          freelancer.businessName          ?? null,
        businessType:          freelancer.businessType          ?? null,
        preferredDeliveryType: freelancer.preferredDeliveryType ?? null,
        freelancerStatus:      freelancer.status,
        statistics:            freelancer.statistics,
        company:               freelancer.companyId,       
        defaultOriginBranch:   freelancer.defaultOriginBranchId,
        lastActiveAt:          freelancer.lastActiveAt,
      },
    });
  },
);





//  UPDATE ME — FREELANCER
//  PATCH /freelancer/me

//  Updatable on User:             firstName, lastName, imageUrl
//  Updatable on FreelancerModel:  businessName, businessType, preferredDeliveryType

//  Blocked: status, statistics, companyId, defaultOriginBranchId, lastActiveAt
//  — all system or supervisor managed.

 
export const updateMeFreelancer = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
 
    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }
 
    const blocked = ["status", "statistics", "companyId", "defaultOriginBranchId", "lastActiveAt"];
    const blockedFound = blocked.filter((f) => f in req.body);
    if (blockedFound.length) {
      return next(
        new ErrorHandler(
          `Field(s) cannot be self-updated: ${blockedFound.join(", ")}`,
          400,
        ),
      );
    }
 
    const [user, freelancer] = await Promise.all([
      userModel.findById(userId).lean(),
      FreelancerModel.findOne({ userId }).lean(),
    ]);
 
    if (!user)       return next(new ErrorHandler("User not found.", 404));
    if (!freelancer) return next(new ErrorHandler("Freelancer profile not found.", 404));
 
    if (freelancer.status === "suspended") {
      return next(new ErrorHandler("Your account is suspended. Contact support.", 403));
    }
 

    const userUpdates = buildUserFieldUpdates(req.body, next);

    if (!userUpdates) return;
 

    const freelancerUpdates: Record<string, any> = {};
    const { businessName, businessType, preferredDeliveryType } = req.body as {
      businessName?:          string;
      businessType?:          string;
      preferredDeliveryType?: string;
    };
 
    if (businessName !== undefined) {
      if (typeof businessName !== "string") {
        return next(new ErrorHandler("businessName must be a string", 400));
      }
      const trimmed = businessName.trim();
      if (trimmed.length > 100) {
        return next(new ErrorHandler("businessName cannot exceed 100 characters", 400));
      }
      freelancerUpdates.businessName = trimmed || null;
    }
 
    if (businessType !== undefined) {
      const valid = ["individual", "small_business", "ecommerce", "other"];
      if (!valid.includes(businessType)) {
        return next(
          new ErrorHandler(`businessType must be one of: ${valid.join(", ")}`, 400),
        );
      }
      freelancerUpdates.businessType = businessType;
    }
 
    if (preferredDeliveryType !== undefined) {
      if (!["home", "branch_pickup"].includes(preferredDeliveryType)) {
        return next(
          new ErrorHandler("preferredDeliveryType must be 'home' or 'branch_pickup'", 400),
        );
      }
      freelancerUpdates.preferredDeliveryType = preferredDeliveryType;
    }
 
    const allUpdates = { ...userUpdates, ...freelancerUpdates };
 
    if (Object.keys(allUpdates).length === 0) {
      return next(new ErrorHandler("No valid fields to update.", 400));
    }
 

    await Promise.all([
      Object.keys(userUpdates).length > 0 &&
        userModel.findByIdAndUpdate(userId, { $set: userUpdates }, { runValidators: true }),
      Object.keys(freelancerUpdates).length > 0 &&
        FreelancerModel.findByIdAndUpdate(
          freelancer._id,
          { $set: { ...freelancerUpdates, lastActiveAt: new Date() } },
          { runValidators: true },
        ),
    ]);
 
    const [updatedUser, updatedFreelancer] = await Promise.all([
      userModel.findById(userId)
        .select("firstName lastName email phone imageUrl role status")
        .lean(),
      FreelancerModel.findById(freelancer._id)
        .select("businessName businessType preferredDeliveryType status statistics lastActiveAt")
        .lean(),
    ]);
 
    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: {
        ...updatedUser,
        businessName:          updatedFreelancer?.businessName          ?? null,
        businessType:          updatedFreelancer?.businessType          ?? null,
        preferredDeliveryType: updatedFreelancer?.preferredDeliveryType ?? null,
        freelancerStatus:      updatedFreelancer?.status,
        statistics:            updatedFreelancer?.statistics,
        lastActiveAt:          updatedFreelancer?.lastActiveAt,
      },
    });
  },
);




interface ICreatePackageBody {

  recipientName: string;
  recipientPhone: string;
  alternativePhone?: string;
  recipientAddress: string;
  recipientCity: string;
  recipientState: string;
  recipientPostalCode?: string;
  deliveryNotes?: string;

  deliveryLat?: number;
  deliveryLon?: number;
 

  weight: number;
  dimensions?: { length: number; width: number; height: number };
  isFragile?: boolean;
  type: "document" | "parcel" | "fragile" | "heavy" | "perishable" | "electronic" | "clothing";
  description?: string;
  declaredValue?: number;
 

  deliveryType: "home" | "branch_pickup";
  deliveryPriority?: "standard" | "express" | "same_day";
  destinationBranchId?: string;   
 

  totalPrice: number;
  paymentMethod?: string;
 

  estimatedDeliveryTime?: string;
}



function normalizePhone(phone: string): string {
  let normalized = phone.trim().replace(/[^\d+]/g, '').replace(/\s+/g, '');
  
  if (normalized.startsWith('0')) {
    normalized = '+213' + normalized.substring(1);
  }
  
  if (!normalized.startsWith('+213')) {
    throw new Error('Phone number must start with +213 or 0');
  }
  
  return normalized;
}


function generateTrackingNumber(): string {
  const prefix = 'PKG';
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}${timestamp}${random}`;
}


async function resolveClientByPhone(
  recipientPhone: string,
  recipientName: string,
  recipientAddress: string,
  recipientCity: string,
  recipientState: string,
  alternativePhone?: string,
  session?: mongoose.ClientSession,
): Promise<mongoose.Types.ObjectId> {
  const normalizedPhone = normalizePhone(recipientPhone);
  const normalizedAltPhone = alternativePhone ? normalizePhone(alternativePhone) : undefined;
  

  const existingClient = await userModel.findOne({ 
    phone: normalizedPhone,
    role: "client" 
  }).session(session || null);
  
  if (existingClient) {

    await clientModel.findOneAndUpdate(
      { userId: existingClient._id },
      {
        $set: {
          deliveryAddresses: [{
            label: 'Latest Delivery Address',
            street: recipientAddress.trim(),
            city: recipientCity.trim(),
            state: recipientState.trim(),
            isDefault: true,
          }],
        },
      },
      { session: session || null, upsert: true }
    );
    
    return existingClient._id;
  }
  

  const nameParts = recipientName.trim().split(' ');
  const firstName = nameParts[0] || 'Client';
  const lastName = nameParts.slice(1).join(' ') || 'Recipient';
  
  const [newClientUser] = await userModel.create(
    [{

      phone: normalizedPhone,
      firstName,
      lastName,
      role: 'client',
      status: 'active',
    }],
    { session: session || null }
  );


  await clientModel.create(
    [{
      userId: newClientUser._id,
      deliveryAddresses: [{
        label: 'Default Delivery Address',
        street: recipientAddress.trim(),
        city: recipientCity.trim(),
        state: recipientState.trim(),
        isDefault: true,
      }],
    }],
    { session: session || null }
  );

  return newClientUser._id;
}


export const createPackage = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
 
    const session = await mongoose.startSession();
    session.startTransaction();

    let transactionCommitted = false;
 
    try {
      const freelancerUserId = req.user?._id;
 
      if(!freelancerUserId){
        return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
      }

      const freelancer = await resolveFreelancer(freelancerUserId, next);
      if (!freelancer) return;
 

      const {
        recipientName,
        recipientPhone,
        alternativePhone,
        recipientAddress,
        recipientCity,
        recipientState,
        recipientPostalCode,
        deliveryNotes,
        weight,
        dimensions,
        isFragile,
        type,
        description,
        declaredValue,
        deliveryType,
        deliveryPriority,
        destinationBranchId,
        totalPrice,
        paymentMethod,
        estimatedDeliveryTime,
        deliveryLat,
        deliveryLon
      } = req.body as ICreatePackageBody;
 

      if (
        !recipientName || !recipientPhone || !recipientAddress ||
        !recipientCity || !recipientState || !weight || !type ||
        !deliveryType || !totalPrice
      ) {

        throw new ErrorHandler(
          "recipientName, recipientPhone, recipientAddress, recipientCity, " +
          "recipientState, weight, type, deliveryType, and totalPrice are required.",
          400,
        );
      }
 

      if (typeof weight !== "number" || weight <= 0) {

        throw new ErrorHandler("weight must be a positive number.", 400);
      }
 
      if (typeof totalPrice !== "number" || totalPrice <= 0) {

        throw new ErrorHandler("totalPrice must be a positive number.", 400);
      }
 
      const VALID_TYPES = ["document", "parcel", "fragile", "heavy", "perishable", "electronic", "clothing"];
      if (!VALID_TYPES.includes(type)) {

        throw new ErrorHandler(`type must be one of: ${VALID_TYPES.join(", ")}`, 400);
      }
 
      if (!["home", "branch_pickup"].includes(deliveryType)) {

        throw new ErrorHandler("deliveryType must be 'home' or 'branch_pickup'.", 400);
      }
 
      if (deliveryType === "branch_pickup" && !destinationBranchId) {

        throw new ErrorHandler("destinationBranchId is required for branch_pickup deliveries.", 400);
      }
 
      if (
        destinationBranchId &&
        !mongoose.Types.ObjectId.isValid(destinationBranchId)
      ) {

        throw new ErrorHandler("Invalid destinationBranchId.", 400);
      }
 
      if (
        deliveryPriority &&
        !["standard", "express", "same_day"].includes(deliveryPriority)
      ) {

        throw new ErrorHandler("deliveryPriority must be standard, express, or same_day.", 400);
      }
 

      let normalizedRecipientPhone: string;
      let normalizedAlternativePhone: string | undefined;
      
      try {
        normalizedRecipientPhone = normalizePhone(recipientPhone);
        if (alternativePhone) {
          normalizedAlternativePhone = normalizePhone(alternativePhone);
        }
      } catch (error: any) {

        throw new ErrorHandler(error.message || "Invalid phone number format.", 400);
      }
 

      const originBranchId = freelancer.defaultOriginBranchId;
 
      if (!originBranchId) {
        throw new ErrorHandler(
          "Your freelancer profile has no default origin branch set. Contact support.",
          400,
        );
      }
 

      const branchQueries: Promise<any>[] = [
        BranchModel.findById(originBranchId).session(session).lean(),
      ];
 
      if (destinationBranchId) {
        branchQueries.push(
          BranchModel.findById(destinationBranchId).session(session).lean(),
        );
      }
 
      const [originBranch, destinationBranch] = await Promise.all(branchQueries);
 
      if (!originBranch) {

        throw new ErrorHandler("Origin branch not found.", 404);
      }
 
      if (originBranch.status !== "active") {

        throw new ErrorHandler("Your origin branch is not currently active.", 400);
      }
 
      if (destinationBranchId && !destinationBranch) {

        throw new ErrorHandler("Destination branch not found.", 404);
      }
 
      if (destinationBranch && destinationBranch.status !== "active") {

        throw new ErrorHandler("The selected destination branch is not currently active.", 400);
      }
 

      // ── Same-branch intelligence ────────────────────────────────────────
      // When origin and destination are the same branch:
      //   • branch_pickup → skip transport, package is already at destination
      //   • home delivery → allowed (stays at origin, deliverer picks up from here)
      const isSameBranch =
        destinationBranchId &&
        originBranchId.toString() === destinationBranchId.toString();

      if (isSameBranch && deliveryType === "home") {
        throw new ErrorHandler(
          "For home delivery, you don't need to specify the same branch as destination. " +
          "Leave destinationBranchId empty.",
          400,
        );
      }

      // Determine initial status based on same-branch logic
      const initialStatus: PackageStatus = isSameBranch
        ? "at_destination_branch"
        : "pending";
 
   
      const destination = {
        recipientName: recipientName.trim(),
        recipientPhone: normalizedRecipientPhone,
        alternativePhone: normalizedAlternativePhone,
        address: recipientAddress.trim(),
        city: recipientCity.trim(),
        state: recipientState.trim(),
        postalCode: recipientPostalCode?.trim(),
        notes: deliveryNotes?.trim(),

        ...(deliveryLat !== undefined && deliveryLon !== undefined && {
          location: {
            type: "Point" as const,
            coordinates: [deliveryLon, deliveryLat] as [number, number],
          },
        }),
      };
 

      const trackingNumber = generateTrackingNumber();
 

      const clientId = await resolveClientByPhone(
        recipientPhone,
        recipientName,
        recipientAddress,
        recipientCity,
        recipientState,
        alternativePhone,
        session,
      );
 

      const [packageDoc] = await PackageModel.create(
        [
          {
            trackingNumber,
            companyId: freelancer.companyId,
            senderId: freelancerUserId,
            senderType: "freelancer",
            clientId, 
 
            weight,
            dimensions,
            isFragile: isFragile ?? false,
            type,
            description: description?.trim(),
            declaredValue,
 
            originBranchId,
            currentBranchId: originBranchId,   
            destinationBranchId: destinationBranchId ?? undefined,
 
            destination,
 
            status: initialStatus,
            deliveryType,
            deliveryPriority: deliveryPriority ?? "standard",
 
            totalPrice,
            paymentStatus: "pending",
            paymentMethod: paymentMethod ?? (deliveryType === "home" ? "cod" : "branch_payment"),
 
            maxAttempts: 3,
            attemptCount: 0,
            issues: [],
            returnInfo: { isReturn: false },
 
            estimatedDeliveryTime: estimatedDeliveryTime
              ? new Date(estimatedDeliveryTime)
              : undefined,
 
            trackingHistory: [
              {
                status: initialStatus,
                branchId: originBranchId,
                userId: freelancerUserId,
                notes: isSameBranch
                  ? "Package is at destination branch (same as origin). Ready for pickup."
                  : "Package registered by freelancer. Awaiting counter drop-off.",
                timestamp: new Date(),
              },
            ],
          },
        ],
        { session },
      );
 

      await PackageHistoryModel.create(
        [
          {
            packageId: packageDoc._id,
            status: initialStatus as PackageStatus,
            branchId: originBranchId,
            handledBy: freelancerUserId,
            handlerRole: "freelancer",
            notes: isSameBranch
              ? "Package created at destination branch (same as origin). Ready for pickup."
              : "Package registered by freelancer via mobile app.",
            timestamp: new Date(),
          },
        ],
        { session },
      );
 

      await PaymentModel.create(
        [
          {
            companyId: freelancer.companyId,
            packageId: packageDoc._id,
            trackingNumber,
            branchId: originBranchId,
            clientId,                   
            senderId: freelancerUserId,
            collectionMethod:
              deliveryType === "home" ? "home_delivery" : "branch_pickup",
            amount: totalPrice,
            paymentMethod: paymentMethod ?? (deliveryType === "home" ? "cod" : "branch_payment"),
            status: "pending",
          },
        ],
        { session },
      );
 

      await FreelancerModel.findByIdAndUpdate(
        freelancer._id,
        {
          $inc: { "statistics.totalPackagesSent": 1 },
          $set: { lastActiveAt: new Date() },
        },
        { session },
      );
 
      await session.commitTransaction();
      transactionCommitted = true;


      sendPackageCreatedNotification(
        freelancerUserId.toString(),
        "freelancer",
        packageDoc._id.toString(),
        trackingNumber
      ).catch(error => {
        console.error('Package created notification failed:', error);
      });
 

      return res.status(201).json({
        success: true,
        message: isSameBranch
          ? "Package registered successfully. It is already at the destination branch — ready for pickup."
          : "Package registered successfully. Please print the bordereau and bring the package to your branch counter.",
        data: {
          packageId: packageDoc._id,
          status: initialStatus,

          bordereau: {
            trackingNumber,
            barcodeFormat: "CODE128",
            generatedAt: new Date().toISOString(),
 
            sender: {
              businessName: freelancer.businessName ?? null,
              phone: (req.user as any)?.phone ?? null,
            },
 
            recipient: {
              name: destination.recipientName,
              phone: destination.recipientPhone,
              address: destination.address,
              city: destination.city,
              state: destination.state,
              postalCode: destination.postalCode ?? null,
            },
 
            package: {
              weight,
              type,
              isFragile: isFragile ?? false,
              declaredValue: declaredValue ?? null,
              deliveryType,
              deliveryPriority: deliveryPriority ?? "standard",
            },
 
            originBranch: {
              id: originBranch._id,
              name: originBranch.name,
              code: originBranch.code,
              address: originBranch.address,
            },
 
            destinationBranch: destinationBranch
              ? {
                  id: destinationBranch._id,
                  name: destinationBranch.name,
                  code: destinationBranch.code,
                  address: destinationBranch.address,
                }
              : null,
 
            totalPrice,
            paymentMethod: paymentMethod ?? (deliveryType === "home" ? "cod" : "branch_payment"),
          },
 
          createdAt: packageDoc.createdAt,
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
 
      return next(error);
 
    } finally {
      if (!transactionCommitted) {
        await session.abortTransaction().catch(() => {});
      }
      await session.endSession();
    }
  },
);

