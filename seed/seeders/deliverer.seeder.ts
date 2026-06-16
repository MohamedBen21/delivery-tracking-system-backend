import mongoose from "mongoose";

import userModel from "../../models/user.model";
import DelivererModel from "../../models/deliverer.model";

import { SEED_CONFIG } from "../constants";
import { buildUserPayload, createOne, randomPoint } from "../seed.helpers";

/** Seeds N deliverers (with backing users) per given branch. */
export async function seedDeliverersForBranches(
    companyId: mongoose.Types.ObjectId,
    branches: any[],
    session: mongoose.ClientSession,
): Promise<any[]> {
    const deliverers: any[] = [];

    for (const branch of branches) {
        for (let i = 0; i < SEED_CONFIG.DELIVERERS_PER_BRANCH; i++) {
            const delivererUser = await createOne(userModel, buildUserPayload("deliverer", "delv"), session);

            const deliverer = await createOne(
                DelivererModel,
                {
                    userId: delivererUser._id,
                    companyId,
                    branchId: branch._id,
                    currentLocation: randomPoint(),
                    availabilityStatus: "off_duty",
                    verificationStatus: "verified",
                    isActive: true,
                },
                session,
            );

            deliverers.push(deliverer);
        }
    }

    return deliverers;
}