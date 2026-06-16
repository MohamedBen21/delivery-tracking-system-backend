import mongoose from "mongoose";

import userModel from "../../models/user.model";
import CashierModel from "../../models/cashier.model";

import { SEED_CONFIG } from "../constants";
import { buildUserPayload, createOne } from "../seed.helpers";
import { generateEmployeeCode } from "../../controllers/supervisor.controller";

/** Seeds N cashiers (with backing users) per given branch. */
export async function seedCashiersForBranches(
    companyId: mongoose.Types.ObjectId,
    branches: any[],
    session: mongoose.ClientSession,
): Promise<any[]> {
    const cashiers: any[] = [];

    for (const branch of branches) {
        for (let i = 0; i < SEED_CONFIG.CASHIERS_PER_BRANCH; i++) {
            const cashierUser = await createOne(userModel, buildUserPayload("cashier", "csh"), session);

            const employeeCode = await generateEmployeeCode("CSH", branch.code || branch.name, CashierModel);

            const cashier = await createOne(
                CashierModel,
                {
                    userId: cashierUser._id,
                    companyId,
                    assignedBranchId: branch._id,
                    employeeCode,
                    counterNumber: i + 1,
                    status: "active",
                },
                session,
            );

            cashiers.push(cashier);
        }
    }

    return cashiers;
}