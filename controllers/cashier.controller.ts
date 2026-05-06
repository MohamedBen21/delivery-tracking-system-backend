import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import PackageModel, { PackageStatus } from "../models/package.model";
import PackageHistoryModel from "../models/package-history.model";
import CashierModel from "../models/cashier.model";
import FreelancerModel from "../models/freelancer.model";
import BranchModel from "../models/branch.model";
import userModel from "../models/user.model";
import PaymentModel from "../models/payment.model";


async function resolveCashier(
userId: any,
next: NextFunction,
session?: mongoose.ClientSession,
) {
if (!userId) {
next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
return null;
}

const query = CashierModel.findOne({ userId, status: "active" });
if (session) query.session(session);
const cashier = await query.lean();

if (!cashier) {
next(new ErrorHandler("Active cashier profile not found.", 404));
return null;
}


if (
!cashier.currentShift ||
(cashier.currentShift as any).status !== "active"
) {
next(
    new ErrorHandler(
    "You must be checked in to an active shift before performing operations.",
    403,
    ),
);
return null;
}

return cashier as any;
}


//     GET /cashier/freelancer-lookup?q=<businessName|email|phone>
//     The cashier types the merchant's business name, email, or phone in the
//     search box. This returns their profile and pending packages so the cashier
//     can choose which ones the merchant is handing over today.


export const lookupFreelancer = catchAsyncError(
async (req: Request, res: Response, next: NextFunction) => {
const cashierUserId = req.user?._id;

const cashier = await resolveCashier(cashierUserId, next);
if (!cashier) return;

const { q } = req.query as { q?: string };

if (!q || q.trim().length < 2) {
    return next(
    new ErrorHandler(
        "Query parameter 'q' is required and must be at least 2 characters.",
        400,
    ),
    );
}

const search = q.trim();

// Search against the User collection (email, phone) and Freelancer (businessName)
// We join them via a pipeline for a single atomic query.

const results = await FreelancerModel.aggregate([
    // Match freelancer by businessName (case-insensitive)
    {
    $match: {
        status: "active",
        $or: [
        { businessName: { $regex: search, $options: "i" } },
        ],
    },
    },


    {
    $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "user",
        pipeline: [
        {
            $project: {
            firstName: 1, lastName: 1, email: 1, phone: 1, status: 1,
            },
        },
        ],
    },
    },
    { $unwind: "$user" },


    {
    $match: {
        $or: [
        { businessName: { $regex: search, $options: "i" } },
        { "user.email": { $regex: search, $options: "i" } },
        { "user.phone": { $regex: search, $options: "i" } },
        ],
    },
    },


    {
    $match: {
        defaultOriginBranchId: cashier.assignedBranchId,
    },
    },

    {
    $project: {
        _id: 1,
        businessName: 1,
        businessType: 1,
        status: 1,
        userId: 1,
        "user.firstName": 1,
        "user.lastName": 1,
        "user.email": 1,
        "user.phone": 1,
    },
    },

    { $limit: 10 },
]);

if (!results.length) {
    return res.status(200).json({
    success: true,
    message: "No active freelancers found matching your search.",
    data: [],
    });
}

// For each result, attach their pending packages (status = 'pending')
const enriched = await Promise.all(
    results.map(async (f: any) => {
    const pendingPackages = await PackageModel.find({
        senderId: f.userId,
        senderType: "freelancer",
        originBranchId: cashier.assignedBranchId,
        status: "pending",            // only pre-registered, unclaimed packages
    })
        .select(
        "trackingNumber weight type isFragile totalPrice " +
        "deliveryType destination createdAt",
        )
        .sort({ createdAt: -1 })
        .lean();

    return {
        freelancerId: f._id,
        userId: f.userId,
        businessName: f.businessName ?? null,
        businessType: f.businessType ?? null,
        firstName: f.user.firstName,
        lastName: f.user.lastName,
        email: f.user.email,
        phone: f.user.phone,
        pendingPackages,
        pendingCount: pendingPackages.length,
    };
    }),
);

return res.status(200).json({
    success: true,
    data: enriched,
});
},
);

