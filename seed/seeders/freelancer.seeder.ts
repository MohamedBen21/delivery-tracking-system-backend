import mongoose from "mongoose";
import { faker } from "@faker-js/faker";

import userModel from "../../models/user.model";
import FreelancerModel from "../../models/freelancer.model";

import { SEED_CONFIG } from "../constants";
import { buildUserPayload, createOne } from "../seed.helpers";

/** Seeds N freelancers (with backing users) per given branch. */
export async function seedFreelancersForBranches(
    companyId: mongoose.Types.ObjectId,
    branches: any[],
    session: mongoose.ClientSession,
): Promise<any[]> {
    const freelancers: any[] = [];

    for (const branch of branches) {
        for (let i = 0; i < SEED_CONFIG.FREELANCERS_PER_BRANCH; i++) {
            const freelancerUser = await createOne(userModel, buildUserPayload("freelancer", "free"), session);

            const freelancer = await createOne(
                FreelancerModel,
                {
                    userId: freelancerUser._id,
                    companyId,
                    defaultOriginBranchId: branch._id,
                    businessType: faker.helpers.arrayElement(["individual", "small_business"]),
                    preferredDeliveryType: faker.helpers.arrayElement(["home", "branch_pickup"]),
                    status: "active",
                },
                session,
            );

            freelancers.push(freelancer);
        }
    }

    return freelancers;
}