import mongoose from "mongoose";

import userModel from "../../models/user.model";
import LoaderModel from "../../models/loader.model";

import { SEED_CONFIG } from "../constants";
import { buildUserPayload, createOne } from "../seed.helpers";
import { generateEmployeeCode } from "../../controllers/supervisor.controller";

/** Seeds N loaders (with backing users) per given branch. */
export async function seedLoadersForBranches(
    companyId: mongoose.Types.ObjectId,
    branches: any[],
    session: mongoose.ClientSession,
): Promise<any[]> {
    const loaders: any[] = [];

    for (const branch of branches) {
        for (let i = 0; i < SEED_CONFIG.LOADERS_PER_BRANCH; i++) {
            const loaderUser = await createOne(userModel, buildUserPayload("loader", "ldr"), session);

            const employeeCode = await generateEmployeeCode("LDR", branch.code || branch.name, LoaderModel);

            const loader = await createOne(
                LoaderModel,
                {
                    userId: loaderUser._id,
                    companyId,
                    assignedBranchId: branch._id,
                    employeeCode,
                    status: "active",
                },
                session,
            );

            loaders.push(loader);
        }
    }

    return loaders;
}