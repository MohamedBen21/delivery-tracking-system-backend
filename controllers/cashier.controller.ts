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
import { sendPackageAcceptedIntoBranchNotification, sendPackageClaimedByCashierNotification, sendPackageRejectedByCashierNotification } from "../services/notification.service";
import PDFDocument from "pdfkit";


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
throw new ErrorHandler("Active cashier profile not found.", 404);
return null;
}


if (
!cashier.currentShift ||
(cashier.currentShift as any).status !== "active"
) {

throw  new ErrorHandler(
    "You must be checked in to an active shift before performing operations.",
    403,
);
return null;
}

return cashier;
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

    let search = q.trim();


    const phoneRegex = /^0(5|6|7)[0-9]{8}$/;
    if (phoneRegex.test(search)) {
        search = '+213' + search.substring(1);
    }

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

    throw new ErrorHandler("trackingNumber is required.", 400);
    }

    const now = new Date();


    const packageDoc = await PackageModel.findOne({
    trackingNumber: trackingNumber.trim().toUpperCase(),
    }).session(session);

    if (!packageDoc) {

    throw new ErrorHandler(
        `No package found with tracking number ${trackingNumber}.`,
        404,
    );
    }

    // ── Guard: must be at this cashier's branch
    if (
    packageDoc.originBranchId.toString() !==
    cashier.assignedBranchId.toString()
    ) {

    throw new ErrorHandler(
        "This package belongs to a different branch and cannot be claimed here.",
        403,
    );
    }

    // ── Guard: must be 'pending' (not already claimed or further)
    if (packageDoc.status !== "pending") {

    throw new ErrorHandler(
        `Package is already in status '${packageDoc.status}' and cannot be claimed again.`,
        400,
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



    sendPackageClaimedByCashierNotification(

    packageDoc.senderId.toString(),
    packageDoc.senderType,
    packageDoc._id.toString(),
    packageDoc.trackingNumber,
    (cashier as any).branchName || "Branch"  

    ).catch(error => {
    console.error('Package claimed notification sending failed:', error);

    });

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



//     POST /cashier/accept-package
//     After claiming, the cashier does a final check (weight verified, label
//     confirmed) and accepts the package into the branch stock.
//     Status → 'at_origin_branch'
//
//     This two-step claim → accept gives the cashier a chance to weigh/inspect
//     before committing. They can also reject here (see rejectPackage below).


export const acceptPackage = catchAsyncError(
async (req: Request, res: Response, next: NextFunction) => {

const session = await mongoose.startSession();
session.startTransaction();
let transactionCommitted = false;

try {
    const cashierUserId = req.user?._id;
    const cashier = await resolveCashier(cashierUserId, next, session);
    if (!cashier) return;

    const { trackingNumber, verifiedWeight, notes } = req.body as {
    trackingNumber: string;
    verifiedWeight?: number;  
    notes?: string;
    };

    if (!trackingNumber?.trim()) {

    throw new ErrorHandler("trackingNumber is required.", 400);
    }

    const now = new Date();

    const packageDoc = await PackageModel.findOne({
    trackingNumber: trackingNumber.trim().toUpperCase(),
    originBranchId: cashier.assignedBranchId,
    }).session(session);

    if (!packageDoc) {

    throw new ErrorHandler(
        `Package ${trackingNumber} not found at your branch.`,
        404,
    );
    }

    if (packageDoc.status !== "cashier_claimed") {

    throw new ErrorHandler(
        `Package must be in 'cashier_claimed' status to accept. Current status: '${packageDoc.status}'.`,
        400,
    );
    }

    const noteText =
    notes?.trim() ||
    `Package inspected and accepted into branch stock.${
        verifiedWeight ? ` Verified weight: ${verifiedWeight}kg.` : ""
    }`;

    const updateFields: Record<string, any> = {
    status: "at_origin_branch" as PackageStatus,
    currentBranchId: cashier.assignedBranchId,
    };


    if (verifiedWeight && typeof verifiedWeight === "number" && verifiedWeight > 0) {
    updateFields.weight = verifiedWeight;
    }

    await PackageModel.findByIdAndUpdate(
    packageDoc._id,
    {
        $set: updateFields,
        $push: {
        trackingHistory: {
            status: "at_origin_branch",
            branchId: cashier.assignedBranchId,
            userId: cashierUserId,
            notes: noteText,
            timestamp: now,
        },
        },
    },
    { session },
    );

    await PackageHistoryModel.create(
    [
        {
        packageId: packageDoc._id,
        status: "at_origin_branch" as PackageStatus,
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

  
    await CashierModel.findByIdAndUpdate(
    cashier._id,
    {
        $inc: { "stats.totalLabelsIssued": 1 },
        $set: { "stats.lastActiveAt": now },
        $push: {
        recentScans: {
            $each: [
            {
                action: "print_label",
                packageId: packageDoc._id,
                trackingNumber: packageDoc.trackingNumber,
                branchId: cashier.assignedBranchId,
                timestamp: now,
                notes: noteText,
                success: true,
            },
            ],
            $slice: -200,
            $position: 0,
        },
        },
    },
    { session },
    );

    await session.commitTransaction();
    transactionCommitted = true;


    sendPackageAcceptedIntoBranchNotification(

    packageDoc.senderId.toString(),
    packageDoc.senderType,
    packageDoc._id.toString(),
    packageDoc.trackingNumber,
    (cashier as any).branchName || "Branch" 
    
    ).catch(error => {

    console.error('Package accepted notification sending failed:', error);
    // Will implement proper logging later
    });

    return res.status(200).json({
    success: true,
    message: "Package accepted into branch stock.",
    data: {
        packageId: packageDoc._id,
        trackingNumber: packageDoc.trackingNumber,
        previousStatus: "cashier_claimed",
        currentStatus: "at_origin_branch",
        acceptedAt: now,
        verifiedWeight: verifiedWeight ?? null,
    },
    });

} catch (error: any) {
    if (error.name === "ValidationError") {
    return next(
        new ErrorHandler(
        Object.values(error.errors).map((e: any) => e.message).join(", "),
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


//     POST /cashier/reject-package
//
//     Called when the package fails physical inspection after being claimed.
//     Status → 'cancelled'. BranchModel currentLoad is decremented because
//     the package never made it into stock.


type RejectionReason =
| "damaged_on_arrival"
| "prohibited_item"
| "wrong_dimensions"
| "overweight"
| "missing_documentation"
| "payment_declined"
| "address_unserviceable"
| "duplicate_package"
| "other";

const VALID_REJECTION_REASONS: RejectionReason[] = [
"damaged_on_arrival", "prohibited_item", "wrong_dimensions",
"overweight", "missing_documentation", "payment_declined",
"address_unserviceable", "duplicate_package", "other",
];


export const rejectPackage = catchAsyncError(
async (req: Request, res: Response, next: NextFunction) => {

const session = await mongoose.startSession();
session.startTransaction();
let transactionCommitted = false;

try {
    const cashierUserId = req.user?._id;
    const cashier = await resolveCashier(cashierUserId, next, session);
    if (!cashier) return;

    const { trackingNumber, rejectionReason, notes } = req.body as {
    trackingNumber: string;
    rejectionReason: RejectionReason;
    notes?: string;
    };

    if (!trackingNumber?.trim()) {

    throw new ErrorHandler("trackingNumber is required.", 400);
    }

    if (!rejectionReason || !VALID_REJECTION_REASONS.includes(rejectionReason)) {

    throw new ErrorHandler(
        `rejectionReason must be one of: ${VALID_REJECTION_REASONS.join(", ")}`,
        400,
    );
    }

    const now = new Date();

    const packageDoc = await PackageModel.findOne({
    trackingNumber: trackingNumber.trim().toUpperCase(),
    originBranchId: cashier.assignedBranchId,
    }).session(session);

    if (!packageDoc) {

    throw new ErrorHandler(`Package ${trackingNumber} not found at your branch.`, 404);
    }


    if (packageDoc.status !== "cashier_claimed") {
        
    throw new ErrorHandler(
        `Only packages in 'cashier_claimed' status can be rejected. Current status: '${packageDoc.status}'.`,
        400,
    );
    }

    const noteText = `Rejected at counter. Reason: ${rejectionReason}.${
    notes?.trim() ? ` Notes: ${notes.trim()}` : ""
    }`;

    await Promise.all([

    PackageModel.findByIdAndUpdate(
        packageDoc._id,
        {
        $set: { status: "cancelled" as PackageStatus },
        $push: {
            trackingHistory: {
            status: "cancelled",
            branchId: cashier.assignedBranchId,
            userId: cashierUserId,
            notes: noteText,
            timestamp: now,
            },
        },
        },
        { session },
    ),

    PackageHistoryModel.create(
        [
        {
            packageId: packageDoc._id,
            status: "cancelled" as PackageStatus,
            branchId: cashier.assignedBranchId,
            handledBy: cashierUserId,
            handlerName: `${(req.user as any)?.firstName} ${(req.user as any)?.lastName}`,
            handlerRole: "cashier",
            notes: noteText,
            timestamp: now,
        },
        ],
        { session },
    ),


    BranchModel.findByIdAndUpdate(
        cashier.assignedBranchId,
        { $inc: { currentLoad: -1 } },
        { session },
    ),

    PaymentModel.findOneAndUpdate(
        { packageId: packageDoc._id },
        { $set: { status: "cancelled" } },
        { session },
    ),

    CashierModel.findByIdAndUpdate(
        cashier._id,
        {
        $inc: {
            "currentShift.packagesRejectedCount": 1,
            "stats.totalPackagesRejected": 1,
        },
        $set: { "stats.lastActiveAt": now },
        $push: {
            recentScans: {
            $each: [
                {
                action: "reject_package",
                packageId: packageDoc._id,
                trackingNumber: packageDoc.trackingNumber,
                branchId: cashier.assignedBranchId,
                timestamp: now,
                notes: noteText,
                rejectionReason,
                success: true,
                },
            ],
            $slice: -200,
            $position: 0,
            },
        },
        },
        { session },
    ),
    ]);

    await session.commitTransaction();
    transactionCommitted = true;


    sendPackageRejectedByCashierNotification(

    packageDoc.senderId.toString(),
    packageDoc.senderType,
    packageDoc._id.toString(),
    packageDoc.trackingNumber,
    rejectionReason

    ).catch(error => {

    console.error('Package rejected notification sending failed:', error);

    });


    return res.status(200).json({
    success: true,
    message: "Package rejected and cancelled.",
    data: {
        packageId: packageDoc._id,
        trackingNumber: packageDoc.trackingNumber,
        previousStatus: "cashier_claimed",
        currentStatus: "cancelled",
        rejectionReason,
        rejectedAt: now,
    },
    });

} catch (error: any) {
    if (error.name === "ValidationError") {
    return next(
        new ErrorHandler(
        Object.values(error.errors).map((e: any) => e.message).join(", "),
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




//     POST /cashier/check-in
//     POST /cashier/check-out

export const checkIn = catchAsyncError(
async (req: Request, res: Response, next: NextFunction) => {
const cashierUserId = req.user?._id;

if (!cashierUserId) {
    return next(new ErrorHandler("Unauthorized.", 401));
}

const cashier = await CashierModel.findOne({
    userId: cashierUserId,
    status: "active",
});

if (!cashier) {
    return next(new ErrorHandler("Active cashier profile not found.", 404));
}

if (cashier.currentShift && (cashier.currentShift as any).status === "active") {
    return next(new ErrorHandler("You already have an active shift.", 400));
}

await cashier.checkIn(cashier.assignedBranchId);

return res.status(200).json({
    success: true,
    message: "Shift started. You are now checked in.",
    data: {
    branchId: cashier.assignedBranchId,
    shiftStartedAt: (cashier.currentShift as any)?.startedAt ?? new Date(),
    },
});
},
);


export const checkOut = catchAsyncError(
async (req: Request, res: Response, next: NextFunction) => {
const cashierUserId = req.user?._id;

if (!cashierUserId) {
    return next(new ErrorHandler("Unauthorized.", 401));
}

const { notes } = req.body as { notes?: string };

const cashier = await CashierModel.findOne({
    userId: cashierUserId,
    status: "active",
});

if (!cashier) {
    return next(new ErrorHandler("Active cashier profile not found.", 404));
}

if (!cashier.currentShift || (cashier.currentShift as any).status !== "active") {
    return next(new ErrorHandler("No active shift to end.", 400));
}

const shiftSnapshot = { ...cashier.currentShift } as any;

await cashier.checkOut(notes);

return res.status(200).json({
    success: true,
    message: "Shift ended. You are now checked out.",
    data: {
    shiftSummary: {
        startedAt: shiftSnapshot.startedAt,
        endedAt: new Date(),
        packagesClaimedCount: shiftSnapshot.packagesClaimedCount,
        packagesRejectedCount: shiftSnapshot.packagesRejectedCount,
        labelsIssuedCount: shiftSnapshot.labelsIssuedCount,
        paymentsCollectedCount: shiftSnapshot.paymentsCollectedCount,
        totalAmountCollected: shiftSnapshot.totalAmountCollected,
    },
    },
});
},
);


//     GET /cashier/my-shift
//     Returns the cashier's current shift stats and the last 20 scan actions,
//     so the mobile app can show a live counter view.


export const getMyShift = catchAsyncError(
async (req: Request, res: Response, next: NextFunction) => {
const cashierUserId = req.user?._id;

if (!cashierUserId) {
    return next(new ErrorHandler("Unauthorized.", 401));
}

const cashier = await CashierModel.findOne({
    userId: cashierUserId,
    status: "active",
})
    .populate("assignedBranchId", "name code address")
    .lean();

if (!cashier) {
    return next(new ErrorHandler("Active cashier profile not found.", 404));
}

const isCheckedIn =
    !!cashier.currentShift &&
    (cashier.currentShift as any).status === "active";

const durationMinutes = isCheckedIn
    ? Math.round(
        (Date.now() -
        new Date((cashier.currentShift as any).startedAt).getTime()) /
        60000,
    )
    : null;

return res.status(200).json({
    success: true,
    data: {
    isCheckedIn,
    branch: cashier.assignedBranchId,
    currentShift: isCheckedIn
        ? {
            ...(cashier.currentShift as any),
            durationMinutes,
        }
        : null,
    recentScans: (cashier.recentScans as any[]).slice(0, 20),
    stats: cashier.stats,
    },
});
},
);


//     GET /cashier/pending-packages
//     All 'pending' packages registered for this branch but not yet claimed.
//     Useful for the cashier to see what's expected today before merchants arrive.


export const getPendingPackages = catchAsyncError(
async (req: Request, res: Response, next: NextFunction) => {
const cashierUserId = req.user?._id;

const cashier = await resolveCashier(cashierUserId, next);
if (!cashier) return;

const { page, limit } = req.query as Record<string, string | undefined>;
const pageNum  = Math.max(1, parseInt(page  ?? "1",  10));
const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? "20", 10)));
const skip = (pageNum - 1) * limitNum;

const [packages, total] = await Promise.all([
    PackageModel.find({
    originBranchId: cashier.assignedBranchId,
    status: "pending",
    })
    .select(
        "trackingNumber weight type isFragile totalPrice deliveryType " +
        "destination senderId createdAt",
    )
    .populate("senderId", "firstName lastName phone")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .lean(),

    PackageModel.countDocuments({
    originBranchId: cashier.assignedBranchId,
    status: "pending",
    }),
]);

const totalPages = Math.ceil(total / limitNum);

return res.status(200).json({
    success: true,
    data: packages,
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









// ─── Shared helper: build a single bordereau page into a PDFDocument ─────────
//
//  Layout (A6 thermal-friendly, 105 × 148 mm):
//
//  ┌─────────────────────────────────────────┐
//  │  COMPANY LOGO / NAME          [BARCODE] │
//  │─────────────────────────────────────────│
//  │  SENDER                                 │
//  │  Business name · phone                  │
//  │─────────────────────────────────────────│
//  │  RECIPIENT                              │
//  │  Name · phone · address                 │
//  │─────────────────────────────────────────│
//  │  PACKAGE DETAILS                        │
//  │  Type · Weight · Priority · Fragile     │
//  │─────────────────────────────────────────│
//  │  ORIGIN BRANCH → DESTINATION BRANCH    │
//  │─────────────────────────────────────────│
//  │  PRICE  [amount]   METHOD  [method]     │
//  │  DELIVERY TYPE  [home / branch_pickup]  │
//  └─────────────────────────────────────────┘

interface IBordereauData {
  trackingNumber:    string;
  generatedAt:       Date;
  sender: {
    businessName:    string | null;
    phone:           string | null;
    firstName:       string;
    lastName:        string;
  };
  recipient: {
    name:            string;
    phone:           string;
    alternativePhone?: string;
    address:         string;
    city:            string;
    state:           string;
    postalCode?:     string;
    notes?:          string;
  };
  pkg: {
    weight:          number;
    type:            string;
    isFragile:       boolean;
    declaredValue:   number | null;
    deliveryType:    string;
    deliveryPriority: string;
    description?:    string;
  };
  originBranch: {
    name:  string;
    code:  string;
    address?: string;
  };
  destinationBranch: {
    name:  string;
    code:  string;
    address?: string;
  } | null;
  totalPrice:    number;
  paymentMethod: string;
}

// A6 in points  (1 mm = 2.8346 pt)
const A6_W = 297.6;   // 105 mm
const A6_H = 419.5;   // 148 mm

const COLORS = {
  primary:   "#1a237e",   // deep navy
  accent:    "#0d47a1",
  light:     "#e8eaf6",
  separator: "#c5cae9",
  text:      "#212121",
  muted:     "#757575",
  white:     "#ffffff",
  danger:    "#b71c1c",
};

function drawBordereau(doc: PDFKit.PDFDocument, data: IBordereauData, isFirst: boolean) {

  if (!isFirst) doc.addPage();

  const M   = 14;           // margin
  const W   = A6_W - M * 2; // usable width
  let   y   = M;

  // ── helper lambdas ──────────────────────────────────────────────────────────

  const line = (yPos: number) => {
    doc
      .moveTo(M, yPos)
      .lineTo(A6_W - M, yPos)
      .strokeColor(COLORS.separator)
      .lineWidth(0.5)
      .stroke();
  };

  const sectionHeader = (label: string, yPos: number): number => {
    doc
      .rect(M, yPos, W, 13)
      .fill(COLORS.primary);
    doc
      .font("Helvetica-Bold")
      .fontSize(6.5)
      .fillColor(COLORS.white)
      .text(label.toUpperCase(), M + 4, yPos + 3.5, { width: W - 8 });
    return yPos + 13;
  };

  const row = (label: string, value: string, yPos: number, indent = 0): number => {
    doc
      .font("Helvetica-Bold")
      .fontSize(6)
      .fillColor(COLORS.muted)
      .text(label, M + indent, yPos, { width: 60 });
    doc
      .font("Helvetica")
      .fontSize(6.5)
      .fillColor(COLORS.text)
      .text(value, M + indent + 62, yPos, { width: W - 62 - indent });
    return yPos + 10;
  };

  // ── HEADER BAND ─────────────────────────────────────────────────────────────
  doc.rect(0, 0, A6_W, 28).fill(COLORS.primary);

  // Company label
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(COLORS.white)
    .text("BORDEREAU D'EXPÉDITION", M, 6, { width: W * 0.65 });

  doc
    .font("Helvetica")
    .fontSize(6)
    .fillColor(COLORS.light)
    .text(`Généré le ${data.generatedAt.toLocaleDateString("fr-DZ")}`, M, 18, { width: W * 0.65 });

  // Tracking number block (top-right)
  const tnX = M + W * 0.67;
  doc
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .fillColor(COLORS.white)
    .text(data.trackingNumber, tnX, 8, { width: W * 0.33, align: "right" });

  y = 34;

  // ── FRAGILE BADGE ───────────────────────────────────────────────────────────
  if (data.pkg.isFragile) {
    doc
      .rect(M, y, W, 11)
      .fill(COLORS.danger);
    doc
      .font("Helvetica-Bold")
      .fontSize(7)
      .fillColor(COLORS.white)
      .text("⚠  FRAGILE — HANDLE WITH CARE", M + 4, y + 2.5, { width: W - 8, align: "center" });
    y += 14;
  }

  // ── SENDER SECTION ──────────────────────────────────────────────────────────
  y = sectionHeader("Expéditeur (Sender)", y);
  y += 3;
  const senderName = data.sender.businessName
    ? `${data.sender.businessName} (${data.sender.firstName} ${data.sender.lastName})`
    : `${data.sender.firstName} ${data.sender.lastName}`;
  y = row("Nom / Name",  senderName,             y);
  y = row("Téléphone",   data.sender.phone ?? "", y);
  y += 2;
  line(y); y += 4;

  // ── RECIPIENT SECTION ───────────────────────────────────────────────────────
  y = sectionHeader("Destinataire (Recipient)", y);
  y += 3;
  y = row("Nom / Name",  data.recipient.name,  y);
  y = row("Téléphone",   data.recipient.phone, y);
  if (data.recipient.alternativePhone) {
    y = row("Tél. alt.", data.recipient.alternativePhone, y);
  }
  y = row("Adresse",     data.recipient.address, y);
  y = row("Ville/État",  `${data.recipient.city}, ${data.recipient.state}`, y);
  if (data.recipient.postalCode) {
    y = row("Code postal", data.recipient.postalCode, y);
  }
  if (data.recipient.notes) {
    y = row("Notes livr.", data.recipient.notes, y);
  }
  y += 2;
  line(y); y += 4;

  // ── PACKAGE SECTION ─────────────────────────────────────────────────────────
  y = sectionHeader("Détails du Colis (Package)", y);
  y += 3;
  y = row("Type",        data.pkg.type.charAt(0).toUpperCase() + data.pkg.type.slice(1), y);
  y = row("Poids",       `${data.pkg.weight} kg`,    y);
  y = row("Priorité",    data.pkg.deliveryPriority.replace("_", " "), y);
  if (data.pkg.description) {
    y = row("Description", data.pkg.description, y);
  }
  if (data.pkg.declaredValue) {
    y = row("Valeur décl.", `${data.pkg.declaredValue.toLocaleString("fr-DZ")} DA`, y);
  }
  y += 2;
  line(y); y += 4;

  // ── ROUTE SECTION ───────────────────────────────────────────────────────────
  y = sectionHeader("Itinéraire (Route)", y);
  y += 3;
  y = row("Origine",       `[${data.originBranch.code}] ${data.originBranch.name}`, y);
  if (data.destinationBranch) {
    y = row("Destination", `[${data.destinationBranch.code}] ${data.destinationBranch.name}`, y);
  } else {
    y = row("Destination",  "Livraison à domicile", y);
  }
  y = row("Mode livr.",    data.pkg.deliveryType === "home" ? "À domicile" : "Retrait agence", y);
  y += 2;
  line(y); y += 4;

  // ── PAYMENT FOOTER BAND ─────────────────────────────────────────────────────
  const footerH = 22;
  const footerY = A6_H - footerH - 2;

  doc.rect(M, footerY, W, footerH).fill(COLORS.light);

  // Price block
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(COLORS.primary)
    .text(`${data.totalPrice.toLocaleString("fr-DZ")} DA`, M + 4, footerY + 5, { width: W * 0.45 });

  // Payment method block
  const methodLabel = data.paymentMethod.toUpperCase().replace("_", " ");
  doc
    .rect(M + W * 0.5, footerY + 3, W * 0.5, 16)
    .fill(COLORS.primary);
  doc
    .font("Helvetica-Bold")
    .fontSize(7)
    .fillColor(COLORS.white)
    .text(methodLabel, M + W * 0.5 + 4, footerY + 7.5, { width: W * 0.5 - 8, align: "center" });

  // ── BARCODE TEXT (CODE128 stub — real barcode needs barcode128 pkg) ──────────
  // In production swap this block for an actual barcode image rendered with
  // the `bwip-js` package:  bwip.toBuffer({ bcid:'code128', text: trackingNumber })
  // then doc.image(barcodeBuffer, x, y, { width, height })
  doc
    .rect(M, footerY - 16, W, 14)
    .fill(COLORS.white)
    .stroke();
  doc
    .font("Courier-Bold")
    .fontSize(8)
    .fillColor(COLORS.text)
    .text(`||||| ${data.trackingNumber} |||||`, M + 2, footerY - 13, {
      width: W - 4,
      align: "center",
    });
}


