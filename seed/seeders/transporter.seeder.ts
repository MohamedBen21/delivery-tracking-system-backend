import mongoose from "mongoose";

import userModel from "../../models/user.model";
import TransporterModel from "../../models/transporter.model";

import { SEED_CONFIG } from "../constants";
import { buildUserPayload, createOne } from "../seed.helpers";

/** Seeds N transporters (with backing users) for a company, optionally attached to a home branch. */
export async function seedTransportersForCompany(
    companyId: mongoose.Types.ObjectId,
    homeBranches: any[],
    session: mongoose.ClientSession,
): Promise<any[]> {
    const transporters: any[] = [];

    for (let i = 0; i < SEED_CONFIG.TRANSPORTERS_PER_COMPANY; i++) {
        const transporterUser = await createOne(userModel, buildUserPayload("transporter", "trp"), session);

        const homeBranch = homeBranches[i % homeBranches.length];

        const transporter = await createOne(
            TransporterModel,
            {
                userId: transporterUser._id,
                companyId,
                currentBranchId: homeBranch?._id,
                availabilityStatus: "off_duty",
                verificationStatus: "verified",
                isActive: true,
            },
            session,
        );

        transporters.push(transporter);
    }

    return transporters;
}