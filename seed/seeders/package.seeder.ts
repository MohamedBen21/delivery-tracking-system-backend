import mongoose from "mongoose";
import { faker } from "@faker-js/faker";

import userModel from "../../models/user.model";
import clientModel from "../../models/client.model";
import FreelancerModel from "../../models/freelancer.model";
import PackageModel from "../../models/package.model";

import PaymentModel from "../../models/payment.model";

import { SEED_CONFIG, PACKAGE_TYPES, DELIVERY_TYPES, DELIVERY_PRIORITIES } from "../constants";
import { createOne, getSafeCity, randomPoint, fakePhone, normalizeAlgerianPhone } from "../seed.helpers";
import PackageHistoryModel from "../../models/package-history.model";

const usedTrackingNumbers = new Set<string>();

/** Mirrors createPackage's generateTrackingNumber, with in-run uniqueness guaranteed. */
function generateUniqueTrackingNumber(): string {
    let trackingNumber: string;
    do {
        const timestamp = Date.now().toString().slice(-6);
        const random = faker.number.int({ min: 1000, max: 9999 });
        trackingNumber = `PKG${timestamp}${random}`;
    } while (usedTrackingNumbers.has(trackingNumber));

    usedTrackingNumbers.add(trackingNumber);
    return trackingNumber;
}

function safeName(name: string, fallback: string): string {
    return name.trim().length >= 3 ? name.trim() : `${name.trim()}${fallback}`;
}

/** Mirrors createPackage's resolveClientByPhone: find-or-create the recipient as a `client` user. */
async function resolveOrCreateClient(
    recipientName: string,
    recipientPhone: string,
    recipientAddress: string,
    recipientCity: string,
    recipientState: string,
    session: mongoose.ClientSession,
): Promise<mongoose.Types.ObjectId> {
    const existingClient = await userModel.findOne({ phone: recipientPhone, role: "client" }).session(session);

    if (existingClient) {
        await clientModel.findOneAndUpdate(
            { userId: existingClient._id },
            {
                $set: {
                    deliveryAddresses: [
                        {
                            label: "Latest Delivery Address",
                            street: recipientAddress,
                            city: recipientCity,
                            state: recipientState,
                            isDefault: true,
                        },
                    ],
                },
            },
            { session, upsert: true },
        );

        return existingClient._id;
    }

    const nameParts = recipientName.trim().split(" ");
    const firstName = safeName(nameParts[0] || "", "Client");
    const lastName = safeName(nameParts.slice(1).join(" ") || "", "Recipient");

    const newClientUser = await createOne(
        userModel,
        { phone: recipientPhone, firstName, lastName, role: "client", status: "active" },
        session,
    );

    await createOne(
        clientModel,
        {
            userId: newClientUser._id,
            deliveryAddresses: [
                {
                    label: "Default Delivery Address",
                    street: recipientAddress,
                    city: recipientCity,
                    state: recipientState,
                    isDefault: true,
                },
            ],
        },
        session,
    );

    return newClientUser._id;
}

async function seedOnePackage(
    companyId: mongoose.Types.ObjectId,
    branches: any[],
    freelancer: any,
    cashiers: any[],
    session: mongoose.ClientSession,
): Promise<any> {
    const originBranchId = freelancer.defaultOriginBranchId;
    const hubBranch = branches.find((b) => b.branchType === "regional_main_hub") ?? branches[0];

    const deliveryType = faker.helpers.arrayElement(DELIVERY_TYPES);
    const pickupCandidates = branches.filter((b) => String(b._id) !== String(originBranchId));
    const destinationBranch =
        deliveryType === "branch_pickup"
            ? faker.helpers.arrayElement(pickupCandidates.length ? pickupCandidates : branches)
            : hubBranch;

    // ── Recipient / client ──────────────────────────────────────────────
    const recipientName = `${faker.person.firstName()} ${faker.person.lastName()}`;
    const recipientPhone = normalizeAlgerianPhone(fakePhone(faker.helpers.arrayElement(["06", "07"])));
    const alternativePhone = faker.datatype.boolean({ probability: 0.3 })
        ? normalizeAlgerianPhone(fakePhone("05"))
        : undefined;
    const recipientCity = getSafeCity();
    const recipientState = faker.location.state();
    const recipientAddress = faker.location.streetAddress();
    const recipientPostalCode = faker.datatype.boolean({ probability: 0.5 })
        ? faker.location.zipCode("#####")
        : undefined;

    const clientId = await resolveOrCreateClient(
        recipientName,
        recipientPhone,
        recipientAddress,
        recipientCity,
        recipientState,
        session,
    );

    // ── Package contents ─────────────────────────────────────────────────
    const type = faker.helpers.arrayElement(PACKAGE_TYPES);
    const isFragile = type === "fragile" || faker.datatype.boolean({ probability: 0.1 });
    const weight = faker.number.float({ min: 0.2, max: 50, fractionDigits: 1 });
    const dimensions = faker.datatype.boolean({ probability: 0.7 })
        ? {
            length: faker.number.int({ min: 5, max: 120 }),
            width: faker.number.int({ min: 5, max: 100 }),
            height: faker.number.int({ min: 5, max: 100 }),
        }
        : undefined;
    const declaredValue = faker.datatype.boolean({ probability: 0.4 })
        ? faker.number.int({ min: 1000, max: 50000 })
        : undefined;
    const description = faker.datatype.boolean({ probability: 0.5 }) ? faker.commerce.productName() : undefined;

    const deliveryPriority = faker.helpers.arrayElement(DELIVERY_PRIORITIES);
    const totalPrice = faker.number.int({ min: 300, max: 1500 });

    const daysAhead =
        deliveryPriority === "same_day" ? 0 : deliveryPriority === "express" ? 1 : faker.number.int({ min: 2, max: 5 });
    const estimatedDeliveryTime = new Date();
    estimatedDeliveryTime.setDate(estimatedDeliveryTime.getDate() + daysAhead);

    // ── Who registered it ───────────────────────────────────────────────
    // Mirrors createPackage's split: freelancer self-submissions start "pending",
    // cashier-registered ones start "at_origin_branch". Those are the only two statuses
    // I've seen in your controller — add more here if your PackageStatus enum has
    // additional in-transit/delivered/returned states you want represented.
    const branchCashiers = cashiers.filter((c) => String(c.assignedBranchId) === String(originBranchId));
    const eligibleCashiers = branchCashiers.length ? branchCashiers : cashiers;
    const useCashier =
        eligibleCashiers.length > 0 &&
        faker.datatype.boolean({ probability: SEED_CONFIG.CASHIER_CREATED_PACKAGE_RATE });

    const createdByRole: "freelancer" | "cashier" = useCashier ? "cashier" : "freelancer";
    const createdBy = useCashier ? faker.helpers.arrayElement(eligibleCashiers).userId : freelancer.userId;
    const initialStatus = createdByRole === "freelancer" ? "pending" : "at_origin_branch";

    const trackingNumber = generateUniqueTrackingNumber();

    const destination = {
        recipientName,
        recipientPhone,
        alternativePhone,
        address: recipientAddress,
        city: recipientCity,
        state: recipientState,
        postalCode: recipientPostalCode,
        ...(deliveryType === "home" && { location: randomPoint() }),
    };

    const historyNote =
        createdByRole === "cashier"
            ? "Package registered by cashier for freelancer."
            : "Package registered by freelancer via mobile app.";

    const packageDoc = await createOne(
        PackageModel,
        {
            trackingNumber,
            companyId,
            senderId: freelancer.userId,
            senderType: "freelancer",
            createdBy,
            createdByRole,
            clientId,
            weight,
            dimensions,
            isFragile,
            type,
            description,
            declaredValue,
            originBranchId,
            currentBranchId: originBranchId,
            destinationBranchId: destinationBranch?._id,
            destination,
            status: initialStatus,
            deliveryType,
            deliveryPriority,
            totalPrice,
            paymentStatus: "pending",
            paymentMethod: deliveryType === "home" ? "cod" : "branch_payment",
            maxAttempts: 3,
            attemptCount: 0,
            issues: [],
            returnInfo: { isReturn: false },
            estimatedDeliveryTime,
            trackingHistory: [
                {
                    status: initialStatus,
                    branchId: originBranchId,
                    userId: createdBy,
                    notes: historyNote,
                    timestamp: new Date(),
                },
            ],
        },
        session,
    );

    await createOne(
        PackageHistoryModel,
        {
            packageId: packageDoc._id,
            status: initialStatus,
            branchId: originBranchId,
            handledBy: createdBy,
            handlerRole: createdByRole,
            notes: historyNote,
            timestamp: new Date(),
        },
        session,
    );

    await createOne(
        PaymentModel,
        {
            companyId,
            packageId: packageDoc._id,
            trackingNumber,
            branchId: originBranchId,
            clientId,
            senderId: freelancer.userId,
            collectionMethod: deliveryType === "home" ? "home_delivery" : "branch_pickup",
            amount: totalPrice,
            paymentMethod: deliveryType === "home" ? "cod" : "branch_payment",
            status: "pending",
        },
        session,
    );

    await FreelancerModel.findByIdAndUpdate(
        freelancer._id,
        { $inc: { "statistics.totalPackagesSent": 1 }, $set: { lastActiveAt: new Date() } },
        { session },
    );

    return packageDoc;
}

/** Seeds packages for every freelancer in the company, with matching PackageHistory + Payment records. */
export async function seedPackagesForCompany(
    companyId: mongoose.Types.ObjectId,
    branches: any[],
    freelancers: any[],
    cashiers: any[],
    session: mongoose.ClientSession,
): Promise<any[]> {
    const packages: any[] = [];

    for (const freelancer of freelancers) {
        for (let i = 0; i < SEED_CONFIG.PACKAGES_PER_FREELANCER; i++) {
            const pkg = await seedOnePackage(companyId, branches, freelancer, cashiers, session);
            packages.push(pkg);
        }
    }

    return packages;
}