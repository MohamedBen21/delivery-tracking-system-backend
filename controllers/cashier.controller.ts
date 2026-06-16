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
import QRCode from "qrcode";
import SupervisorModel from "../models/supervisor.model";

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



const results = await FreelancerModel.aggregate([
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


const enriched = await Promise.all(
    results.map(async (f: any) => {
    const pendingPackages = await PackageModel.find({
        senderId: f.userId,
        senderType: "freelancer",
        originBranchId: cashier.assignedBranchId,
        status: "pending",           
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


    if (
    packageDoc.originBranchId.toString() !==
    cashier.assignedBranchId.toString()
    ) {

    throw new ErrorHandler(
        "This package belongs to a different branch and cannot be claimed here.",
        403,
    );
    }


    if (packageDoc.status !== "pending") {

    throw new ErrorHandler(
        `Package is already in status '${packageDoc.status}' and cannot be claimed again.`,
        400,
    );
    }

    const noteText =
    notes?.trim() ||
    `Package physically received at counter by cashier. Bordereau verified.`;


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


    await BranchModel.findByIdAndUpdate(
    cashier.assignedBranchId,
    { $inc: { currentLoad: 1 } },
    { session },
    );


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
            $slice: -200,  
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
  if (!transactionCommitted && session.inTransaction()) { 
    await session.abortTransaction().catch(() => {});
  }
  await session.endSession();
}
},
);






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


      const isSameBranch =
        packageDoc.destinationBranchId &&
        packageDoc.originBranchId.toString() === packageDoc.destinationBranchId.toString();

      const noteText =
        notes?.trim() ||
        `Package inspected and accepted into branch stock.${
          verifiedWeight ? ` Verified weight: ${verifiedWeight}kg.` : ""
        }`;


      let finalStatus: PackageStatus;
      let trackingNote: string;

      if (isSameBranch) {
        finalStatus = "at_destination_branch";
        trackingNote = "Package is at destination branch (same as origin). Ready for pickup — no transport needed.";
      } else {
        finalStatus = "at_origin_branch";
        trackingNote = noteText;
      }

      const updateFields: Record<string, any> = {
        status: finalStatus,
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
              status: finalStatus,
              branchId: cashier.assignedBranchId,
              userId: cashierUserId,
              notes: trackingNote,
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
            status: finalStatus as PackageStatus,
            branchId: cashier.assignedBranchId,
            handledBy: cashierUserId,
            handlerName: `${(req.user as any)?.firstName} ${(req.user as any)?.lastName}`,
            handlerRole: "cashier",
            notes: isSameBranch
              ? "Package accepted at destination branch (same as origin). Ready for pickup."
              : noteText,
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
                  notes: trackingNote,
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
      });

      return res.status(200).json({
        success: true,
        message: isSameBranch
          ? "Package accepted. It is already at the destination branch — ready for pickup."
          : "Package accepted into branch stock.",
        data: {
          packageId: packageDoc._id,
          trackingNumber: packageDoc.trackingNumber,
          previousStatus: "cashier_claimed",
          currentStatus: finalStatus,
          acceptedAt: now,
          verifiedWeight: verifiedWeight ?? null,
          sameBranchPickup: isSameBranch,
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
      if (!transactionCommitted && session.inTransaction()) { 
        await session.abortTransaction().catch(() => {});
      }
      await session.endSession();
    }
  },
);





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
    if (!transactionCommitted && session.inTransaction()) { 
      await session.abortTransaction().catch(() => {});
    }
    await session.endSession();
}
},
);






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











const COLORS = {
  primary: "#1a1a1a",        
  accent: "#d4a017",         
  light: "#fff3e0",          
  separator: "#e0a800",      
  text: "#1a1a1a",          
  muted: "#666666",          
  white: "#ffffff",
  danger: "#dc3545",         
  headerBg: "#1a1a1a",     
  sectionBg: "#f5e6d3",    
};


const A6_W = 297.6;
const A6_H = 419.5;

interface IBordereauData {
  trackingNumber: string;
  generatedAt: Date;
  sender: {
    businessName: string | null;
    phone: string | null;
    firstName: string;
    lastName: string;
  };
  recipient: {
    name: string;
    phone: string;
    alternativePhone?: string;
    address: string;
    city: string;
    state: string;
    postalCode?: string;
    notes?: string;
  };
  pkg: {
    weight: number;
    type: string;
    isFragile: boolean;
    declaredValue: number | null;
    deliveryType: string;
    deliveryPriority: string;
    description?: string;
  };
  originBranch: {
    name: string;
    code: string;
    address?: string;
  };
  destinationBranch: {
    name: string;
    code: string;
    address?: string;
  } | null;
  totalPrice: number;
  paymentMethod: string;
}

function line(doc: PDFKit.PDFDocument, M: number, yPos: number, W: number) {
  doc
    .moveTo(M, yPos)
    .lineTo(A6_W - M, yPos)
    .strokeColor(COLORS.separator)
    .lineWidth(0.5)
    .stroke();
}

function sectionHeader(doc: PDFKit.PDFDocument, label: string, M: number, W: number, yPos: number): number {
  doc
    .rect(M, yPos, W, 13)
    .fill(COLORS.accent);
  doc
    .font("Helvetica-Bold")
    .fontSize(6.5)
    .fillColor(COLORS.white)
    .text(label.toUpperCase(), M + 4, yPos + 3.5, { width: W - 8 });
  return yPos + 13;
}

function row(doc: PDFKit.PDFDocument, label: string, value: string, M: number, W: number, yPos: number, indent = 0): number {
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
}

async function drawBordereau(doc: PDFKit.PDFDocument, data: IBordereauData, isFirst: boolean): Promise<void> {
  if (!isFirst) doc.addPage();

  const M = 14;
  const W = A6_W - M * 2;
  let y = M;


  doc.rect(0, 0, A6_W, 28).fill(COLORS.headerBg);

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(COLORS.accent)
    .text("BORDEREAU D'EXPÉDITION", M, 6, { width: W * 0.55 });

  doc
    .font("Helvetica")
    .fontSize(6)
    .fillColor(COLORS.light)
    .text(`Généré le ${data.generatedAt.toLocaleDateString("fr-DZ")}`, M, 18, { width: W * 0.55 });


  const QR_SIZE = 24;
  const qrX = A6_W - M - QR_SIZE;
  const qrY = 2;

  try {
    const qrBuffer = await QRCode.toBuffer(data.trackingNumber, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 4,
    });

    doc.rect(qrX - 2, qrY, QR_SIZE + 4, QR_SIZE + 4).fill(COLORS.white);
    doc.image(qrBuffer, qrX, qrY + 2, { width: QR_SIZE, height: QR_SIZE });
  } catch {

    doc
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .fillColor(COLORS.accent)
      .text(data.trackingNumber, M + W * 0.65, 10, { width: W * 0.3, align: "right" });
  }

  y = 34;


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


  y = sectionHeader(doc, "Expéditeur (Sender)", M, W, y);
  y += 3;
  const senderName = data.sender.businessName
    ? `${data.sender.businessName} (${data.sender.firstName} ${data.sender.lastName})`
    : `${data.sender.firstName} ${data.sender.lastName}`;
  y = row(doc, "Nom / Name", senderName, M, W, y);
  y = row(doc, "Téléphone", data.sender.phone ?? "", M, W, y);
  y += 2;
  line(doc, M, y, W);
  y += 4;


  y = sectionHeader(doc, "Destinataire (Recipient)", M, W, y);
  y += 3;
  y = row(doc, "Nom / Name", data.recipient.name, M, W, y);
  y = row(doc, "Téléphone", data.recipient.phone, M, W, y);
  if (data.recipient.alternativePhone) {
    y = row(doc, "Tél. alt.", data.recipient.alternativePhone, M, W, y);
  }
  y = row(doc, "Adresse", data.recipient.address, M, W, y);
  y = row(doc, "Ville/État", `${data.recipient.city}, ${data.recipient.state}`, M, W, y);
  if (data.recipient.postalCode) {
    y = row(doc, "Code postal", data.recipient.postalCode, M, W, y);
  }
  if (data.recipient.notes) {
    y = row(doc, "Notes livr.", data.recipient.notes, M, W, y);
  }
  y += 2;
  line(doc, M, y, W);
  y += 4;


  y = sectionHeader(doc, "Détails du Colis (Package)", M, W, y);
  y += 3;
  y = row(doc, "Type", data.pkg.type.charAt(0).toUpperCase() + data.pkg.type.slice(1), M, W, y);
  y = row(doc, "Poids", `${data.pkg.weight} kg`, M, W, y);
  y = row(doc, "Priorité", data.pkg.deliveryPriority.replace("_", " "), M, W, y);
  if (data.pkg.description) {
    y = row(doc, "Description", data.pkg.description, M, W, y);
  }
  if (data.pkg.declaredValue) {
    y = row(doc, "Valeur décl.", `${data.pkg.declaredValue.toLocaleString("fr-DZ")} DA`, M, W, y);
  }
  y += 2;
  line(doc, M, y, W);
  y += 4;


  y = sectionHeader(doc, "Itinéraire (Route)", M, W, y);
  y += 3;
  y = row(doc, "Origine", `[${data.originBranch.code}] ${data.originBranch.name}`, M, W, y);
  if (data.destinationBranch) {
    y = row(doc, "Destination", `[${data.destinationBranch.code}] ${data.destinationBranch.name}`, M, W, y);
  } else {
    y = row(doc, "Destination", "Livraison à domicile", M, W, y);
  }
  y = row(doc, "Mode livr.", data.pkg.deliveryType === "home" ? "À domicile" : "Retrait agence", M, W, y);
  y += 2;
  line(doc, M, y, W);
  y += 4;


  const footerH = 22;
  const footerY = A6_H - footerH - 2;

  doc.rect(M, footerY, W, footerH).fill(COLORS.light);


  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(COLORS.accent)
    .text(`${data.totalPrice.toLocaleString("fr-DZ")} DA`, M + 4, footerY + 5, { width: W * 0.45 });


  const methodLabel = data.paymentMethod.toUpperCase().replace("_", " ");
  doc
    .rect(M + W * 0.5, footerY + 3, W * 0.5, 16)
    .fill(COLORS.primary);
  doc
    .font("Helvetica-Bold")
    .fontSize(7)
    .fillColor(COLORS.accent)
    .text(methodLabel, M + W * 0.5 + 4, footerY + 7.5, { width: W * 0.5 - 8, align: "center" });


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




export const printSingleBordereau = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const cashierUserId = req.user?._id;
    const cashier = await resolveCashier(cashierUserId, next);
    if (!cashier) return;

    const { trackingNumber } = req.params;

    if (!trackingNumber?.toString().trim()) {
      return next(new ErrorHandler("trackingNumber param is required.", 400));
    }

    const pkg = await PackageModel.findOne({
      trackingNumber: trackingNumber.toString().trim().toUpperCase(),
      originBranchId: cashier.assignedBranchId,
      status: "pending"
    }).lean();

    if (!pkg) {
      return next(
        new ErrorHandler(
          `Package ${trackingNumber} not found at your branch or it is already handled.`,
          404,
        ),
      );
    }

    const [freelancer, senderUser, originBranch, destinationBranch] = await Promise.all([
      FreelancerModel.findOne({ userId: pkg.senderId }).lean(),
      userModel.findById(pkg.senderId).select("firstName lastName phone").lean(),
      BranchModel.findById(pkg.originBranchId).select("name code address").lean(),
      pkg.destinationBranchId
        ? BranchModel.findById(pkg.destinationBranchId).select("name code address").lean()
        : Promise.resolve(null),
    ]);

    const data: IBordereauData = {
      trackingNumber: pkg.trackingNumber,
      generatedAt: new Date(),
      sender: {
        businessName: (freelancer as any)?.businessName ?? null,
        phone: (senderUser as any)?.phone ?? null,
        firstName: (senderUser as any)?.firstName ?? "",
        lastName: (senderUser as any)?.lastName ?? "",
      },
      recipient: {
        name: pkg.destination.recipientName,
        phone: pkg.destination.recipientPhone,
        alternativePhone: pkg.destination.alternativePhone,
        address: pkg.destination.address,
        city: pkg.destination.city,
        state: pkg.destination.state,
        postalCode: pkg.destination.postalCode,
        notes: pkg.destination.notes,
      },
      pkg: {
        weight: pkg.weight,
        type: pkg.type,
        isFragile: pkg.isFragile,
        declaredValue: pkg.declaredValue ?? null,
        deliveryType: pkg.deliveryType,
        deliveryPriority: pkg.deliveryPriority,
        description: pkg.description,
      },
      originBranch: {
        name: (originBranch as any)?.name ?? "",
        code: (originBranch as any)?.code ?? "",
        address: (originBranch as any)?.address ?? "",
      },
      destinationBranch: destinationBranch
        ? {
            name: (destinationBranch as any).name,
            code: (destinationBranch as any).code,
            address: (destinationBranch as any).address,
          }
        : null,
      totalPrice: pkg.totalPrice,
      paymentMethod: (pkg as any).paymentMethod ?? "cod",
    };

    const doc = new PDFDocument({
      size: [A6_W, A6_H],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      info: {
        Title: `Bordereau ${pkg.trackingNumber}`,
        Author: "Delivery System",
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="bordereau-${pkg.trackingNumber}.pdf"`);

    doc.pipe(res);
    await drawBordereau(doc, data, true);
    doc.end();
  },
);



export const printBulkBordereau = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const cashierUserId = req.user?._id;
    const cashier = await resolveCashier(cashierUserId, next);
    if (!cashier) return;

    const { trackingNumbers, freelancerUserId } = req.body as {
      trackingNumbers?: string[];
      freelancerUserId?: string;
    };

    if (!trackingNumbers?.length && !freelancerUserId) {
      return next(
        new ErrorHandler(
          "Provide either 'trackingNumbers' (array) or 'freelancerUserId'.",
          400,
        ),
      );
    }

    if (trackingNumbers && trackingNumbers.length > 100) {
      return next(new ErrorHandler("Cannot bulk-print more than 100 bordereaux at once.", 400));
    }

    const baseFilter: Record<string, any> = {
      originBranchId: cashier.assignedBranchId,
    };

    if (trackingNumbers?.length) {
      baseFilter.trackingNumber = {
        $in: trackingNumbers.map((t) => t.trim().toUpperCase()),
      };
    } else if (freelancerUserId) {
      if (!mongoose.Types.ObjectId.isValid(freelancerUserId)) {
        return next(new ErrorHandler("Invalid freelancerUserId.", 400));
      }
      baseFilter.senderId = new mongoose.Types.ObjectId(freelancerUserId);
      baseFilter.senderType = "freelancer";
      baseFilter.status = { $in: ["pending"] };
    }

    const packages = await PackageModel.find(baseFilter)
      .sort({ createdAt: 1 })
      .lean();

    if (!packages.length) {
      return next(new ErrorHandler("No packages found matching your criteria.", 404));
    }

    const branchIds = [
      ...new Set([
        ...packages.map((p) => p.originBranchId?.toString()),
        ...packages
          .filter((p) => p.destinationBranchId)
          .map((p) => p.destinationBranchId!.toString()),
      ]),
    ].filter(Boolean);

    const senderIds = [...new Set(packages.map((p) => p.senderId?.toString()))];

    const [branches, senderUsers, freelancers] = await Promise.all([
      BranchModel.find({ _id: { $in: branchIds } })
        .select("name code address")
        .lean(),
      userModel.find({ _id: { $in: senderIds } })
        .select("firstName lastName phone")
        .lean(),
      FreelancerModel.find({ userId: { $in: senderIds } })
        .select("userId businessName")
        .lean(),
    ]);

    const branchMap = new Map(branches.map((b) => [(b as any)._id.toString(), b]));
    const userMap = new Map(senderUsers.map((u) => [(u as any)._id.toString(), u]));
    const freelancerMap = new Map(freelancers.map((f) => [(f as any).userId.toString(), f]));

    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = freelancerUserId
      ? `bordereaux-freelancer-${timestamp}.pdf`
      : `bordereaux-bulk-${timestamp}.pdf`;

    const doc = new PDFDocument({
      size: [A6_W, A6_H],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      info: {
        Title: `Bordereaux groupés — ${packages.length} colis`,
        Author: "Delivery System",
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    doc.pipe(res);


    for (let index = 0; index < packages.length; index++) {
      const pkg = packages[index];
      const originBranch = branchMap.get(pkg.originBranchId?.toString()) ?? null;
      const destinationBranch = pkg.destinationBranchId
        ? branchMap.get(pkg.destinationBranchId.toString()) ?? null
        : null;
      const senderUser = userMap.get(pkg.senderId?.toString()) ?? null;
      const freelancer = freelancerMap.get(pkg.senderId?.toString()) ?? null;

      const data: IBordereauData = {
        trackingNumber: pkg.trackingNumber,
        generatedAt: new Date(),
        sender: {
          businessName: (freelancer as any)?.businessName ?? null,
          phone: (senderUser as any)?.phone ?? null,
          firstName: (senderUser as any)?.firstName ?? "",
          lastName: (senderUser as any)?.lastName ?? "",
        },
        recipient: {
          name: pkg.destination.recipientName,
          phone: pkg.destination.recipientPhone,
          alternativePhone: pkg.destination.alternativePhone,
          address: pkg.destination.address,
          city: pkg.destination.city,
          state: pkg.destination.state,
          postalCode: pkg.destination.postalCode,
          notes: pkg.destination.notes,
        },
        pkg: {
          weight: pkg.weight,
          type: pkg.type,
          isFragile: pkg.isFragile,
          declaredValue: pkg.declaredValue ?? null,
          deliveryType: pkg.deliveryType,
          deliveryPriority: pkg.deliveryPriority,
          description: pkg.description,
        },
        originBranch: {
          name: (originBranch as any)?.name ?? "",
          code: (originBranch as any)?.code ?? "",
          address: (originBranch as any)?.address ?? "",
        },
        destinationBranch: destinationBranch
          ? {
              name: (destinationBranch as any).name,
              code: (destinationBranch as any).code,
              address: (destinationBranch as any).address,
            }
          : null,
        totalPrice: pkg.totalPrice,
        paymentMethod: (pkg as any).paymentMethod ?? "cod",
      };

      await drawBordereau(doc, data, index === 0);
    }

    doc.end();
  },
);



export const getPackageByTrackingNumber = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const requestingUserId = req.user?._id;
    const { branchId, trackingNumber } = req.params;

    if (!requestingUserId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId.toString())) {
      return next(new ErrorHandler("Invalid branch ID", 400));
    }

    if (!trackingNumber || typeof trackingNumber !== "string" || trackingNumber.trim().length === 0) {
      return next(new ErrorHandler("Valid tracking number is required", 400));
    }

    const requestingUser = await userModel.findById(requestingUserId).select("role").lean();
    if (!requestingUser) {
      return next(new ErrorHandler("User not found", 404));
    }

    const branchOid = new mongoose.Types.ObjectId(branchId.toString());
    let isAuthorized = requestingUser.role === "admin";

    if (!isAuthorized && requestingUser.role === "cashier") {
      const cashier = await CashierModel.findOne({
        userId: requestingUserId,
        assignedBranchId: branchOid,
        status: "active",
      }).lean();
      isAuthorized = !!cashier;
    }

    if (!isAuthorized && requestingUser.role === "supervisor") {
      const supervisor = await SupervisorModel.findOne({
        userId: requestingUserId,
        branchId: branchOid,
        isActive: true,
      }).lean();
      isAuthorized = !!supervisor;
    }

    if (!isAuthorized) {
      return next(new ErrorHandler("Not authorized to scan packages at this branch", 403));
    }


    if (requestingUser.role === "cashier") {
      const cashier = await CashierModel.findOne({
        userId: requestingUserId,
        assignedBranchId: branchOid,
        status: "active",
      }).lean();
      
      if (!cashier?.currentShift || (cashier.currentShift as any)?.status !== "active") {
        return next(new ErrorHandler("You must be checked in to scan packages", 403));
      }
    }

    const packageDoc = await PackageModel.findOne({
      trackingNumber: trackingNumber.toUpperCase().trim(),
    })
      .populate("senderId", "firstName lastName email phone role")
      .populate("clientId", "firstName lastName email phone")
      .populate("originBranchId", "name code address")
      .populate("currentBranchId", "name code address")
      .populate("destinationBranchId", "name code address")
      .populate({
        path: "assignedDelivererId",
        populate: { path: "userId", select: "firstName lastName phone" },
      })
      .lean();

    if (!packageDoc) {
      return next(new ErrorHandler("Package not found", 404));
    }

    const currentBranchId = (packageDoc.currentBranchId as any)?._id?.toString() ?? packageDoc.currentBranchId?.toString();
    const claimableStatuses = ["pending", "accepted"];
    const isAtThisBranch = currentBranchId === branchId.toString();
    const isClaimable = isAtThisBranch && claimableStatuses.includes(packageDoc.status);

    let cannotClaimReason: string | null = null;
    if (!isAtThisBranch) {
      cannotClaimReason = `Package is currently at: ${(packageDoc.currentBranchId as any)?.name ?? "unknown branch"}`;
    } else if (!claimableStatuses.includes(packageDoc.status)) {
      cannotClaimReason = `Package cannot be claimed in its current status: ${packageDoc.status}`;
    }


    const nextAction = isClaimable 
      ? "claim_package" 
      : packageDoc.status === "cashier_claimed" 
        ? "accept_package" 
        : null;

    return res.status(200).json({
      success: true,
      data: {
        package: packageDoc,
        isClaimable,
        cannotClaimReason,
        nextAction, 
      },
    });
  }
);