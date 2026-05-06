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



//     POST /cashier/claim-package
//     The cashier scans the barcode on the bordereau. The system:
//       a) Validates the package belongs to this branch and is still 'pending'
//       b) Updates status → 'cashier_claimed'
//       c) Stamps the package with claimedByCashierId + claimedAt
//       d) Writes a PackageHistory record
//       e) Logs the action on the cashier's shift stats
//
//     This is intentionally a single-package operation — each barcode scan
//     is one atomic action.  The cashier scans all packages one by one.


export const claimPackage = catchAsyncError(
async (req: Request, res: Response, next: NextFunction) => {

const session = await mongoose.startSession();
session.startTransaction();
let transactionCommitted = false;

try {
    const cashierUserId = req.user?._id;
    const cashier = await resolveCashier(cashierUserId, next, session);
    if (!cashier) return;

    const { trackingNumber, notes } = req.body as {
    trackingNumber: string;
    notes?: string;
    };

    if (!trackingNumber?.trim()) {
    return next(new ErrorHandler("trackingNumber is required.", 400));
    }

    const now = new Date();


    const packageDoc = await PackageModel.findOne({
    trackingNumber: trackingNumber.trim().toUpperCase(),
    }).session(session);

    if (!packageDoc) {
    return next(
        new ErrorHandler(
        `No package found with tracking number ${trackingNumber}.`,
        404,
        ),
    );
    }

    // ── Guard: must be at this cashier's branch
    if (
    packageDoc.originBranchId.toString() !==
    cashier.assignedBranchId.toString()
    ) {
    return next(
        new ErrorHandler(
        "This package belongs to a different branch and cannot be claimed here.",
        403,
        ),
    );
    }

    // ── Guard: must be 'pending' (not already claimed or further)
    if (packageDoc.status !== "pending") {
    return next(
        new ErrorHandler(
        `Package is already in status '${packageDoc.status}' and cannot be claimed again.`,
        400,
        ),
    );
    }

    const noteText =
    notes?.trim() ||
    `Package physically received at counter by cashier. Bordereau verified.`;

    //  Update the package 
    await PackageModel.findByIdAndUpdate(
    packageDoc._id,
    {
        $set: {
        status: "cashier_claimed" as PackageStatus,
        claimedByCashierId: cashier._id,
        claimedAt: now,
        },
        $push: {
        trackingHistory: {
            status: "cashier_claimed",
            branchId: cashier.assignedBranchId,
            userId: cashierUserId,
            notes: noteText,
            timestamp: now,
        },
        },
    },
    { session },
    );

    // PackageHistory record
    await PackageHistoryModel.create(
    [
        {
        packageId: packageDoc._id,
        status: "cashier_claimed" as PackageStatus,
        branchId: cashier.assignedBranchId,
        handledBy: cashierUserId,
        handlerName: `${(req.user as any)?.firstName} ${(req.user as any)?.lastName}`,
        handlerRole: "cashier",
        notes: noteText,
        timestamp: now,
        },
    ],
    { session },
    );

    // ── Increment branch currentLoad (package is now physically at branch) 
    await BranchModel.findByIdAndUpdate(
    cashier.assignedBranchId,
    { $inc: { currentLoad: 1 } },
    { session },
    );

    // ── Update cashier shift counters + recentScans 
    await CashierModel.findByIdAndUpdate(
    cashier._id,
    {
        $inc: {
        "currentShift.packagesClaimedCount": 1,
        "stats.totalPackagesClaimed": 1,
        },
        $set: {
        "stats.lastActiveAt": now,
        },
        $push: {
        recentScans: {
            $each: [
            {
                action: "claim_package",
                packageId: packageDoc._id,
                trackingNumber: packageDoc.trackingNumber,
                branchId: cashier.assignedBranchId,
                timestamp: now,
                notes: noteText,
                success: true,
            },
            ],
            $slice: -200,   // keep last 200 scans (most recent at the end)
            $position: 0,
        },
        },
    },
    { session },
    );

    await session.commitTransaction();
    transactionCommitted = true;

    return res.status(200).json({
    success: true,
    message: "Package claimed successfully.",
    data: {
        packageId: packageDoc._id,
        trackingNumber: packageDoc.trackingNumber,
        previousStatus: "pending",
        currentStatus: "cashier_claimed",
        claimedAt: now,
        package: {
        type: packageDoc.type,
        weight: packageDoc.weight,
        isFragile: packageDoc.isFragile,
        declaredValue: (packageDoc as any).declaredValue ?? null,
        deliveryType: packageDoc.deliveryType,
        totalPrice: (packageDoc as any).totalPrice,
        recipient: {
            name: packageDoc.destination.recipientName,
            phone: packageDoc.destination.recipientPhone,
            city: packageDoc.destination.city,
            state: packageDoc.destination.state,
        },
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
    return next(error);
} finally {
    if (!transactionCommitted) {
    await session.abortTransaction().catch(() => {});
    }
    await session.endSession();
}
},
);




