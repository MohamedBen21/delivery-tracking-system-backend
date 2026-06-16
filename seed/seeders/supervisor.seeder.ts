import mongoose from "mongoose";

import userModel from "../../models/user.model";
import SupervisorModel from "../../models/supervisor.model";

import { buildUserPayload, createOne } from "../seed.helpers";

/** Seeds one active supervisor (with a backing user) per given branch. */
export async function seedSupervisorsForBranches(
    companyId: mongoose.Types.ObjectId,
    branches: any[],
    session: mongoose.ClientSession,
): Promise<any[]> {
    const supervisors: any[] = [];

    for (const branch of branches) {
        const supUser = await createOne(userModel, buildUserPayload("supervisor", "sup"), session);

        const supervisor = await createOne(
            SupervisorModel,
            {
                userId: supUser._id,
                companyId,
                branchId: branch._id,
                permissions: ["can_manage_deliverers"],
                isActive: true,
            },
            session,
        );

        supervisors.push(supervisor);
    }

    return supervisors;
}