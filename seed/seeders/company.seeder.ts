import mongoose from "mongoose";
import { faker } from "@faker-js/faker";

import userModel from "../../models/user.model";
import CompanyModel from "../../models/company.model";
import ManagerModel from "../../models/manager.model";
import BranchModel from "../../models/branch.model";

import { SEED_CONFIG } from "../constants";
import { buildUserPayload, createOne, generateCode, getSafeCity, randomPoint, fakePhone } from "../seed.helpers";

export interface SeededCompany {
    company: any;
    managerUser: any;
    hub: any;
    localBranches: any[];
    allBranches: any[];
}

/**
 * Seeds a single company: its owning manager user, the Company doc,
 * the Manager role doc, one regional hub branch, and N local branches.
 */
export async function seedCompanyWithBranches(
    companyIndex: number,
    session: mongoose.ClientSession,
): Promise<SeededCompany> {
    // 1. Manager user
    const managerUser = await createOne(
        userModel,
        { ...buildUserPayload("manager", `manager_${companyIndex}`) },
        session,
    );

    // 2. Company
    const company = await createOne(
        CompanyModel,
        {
            name: `Company_${faker.company.name()}_${companyIndex}`,
            businessType: "company",
            registrationNumber: `RC-${faker.string.alphanumeric(10)}`,
            userId: managerUser._id,
            status: "active",
        },
        session,
    );

    // 3. Manager role
    await createOne(
        ManagerModel,
        {
            userId: managerUser._id,
            companyId: company._id,
            accessLevel: "full",
            isActive: true,
            branchAccess: { allBranches: true, specificBranches: [] },
        },
        session,
    );

    // 4. Hub branch
    const hubCity = getSafeCity();
    const hub = await createOne(
        BranchModel,
        {
            companyId: company._id,
            name: `Hub_${hubCity}`,
            code: generateCode("HUB", companyIndex + 1),
            address: {
                street: faker.location.streetAddress(),
                city: hubCity,
                state: faker.location.state(),
            },
            location: randomPoint(),
            phone: fakePhone("05"),
            email: faker.internet.email(),
            branchType: "regional_main_hub",
            status: "active",
        },
        session,
    );

    // 5. Local branches
    const localBranches: any[] = [];
    for (let i = 0; i < SEED_CONFIG.LOCAL_BRANCHES_PER_COMPANY; i++) {
        const city = getSafeCity();
        const branch = await createOne(
            BranchModel,
            {
                companyId: company._id,
                name: `Branch_${city}_${i}`,
                code: generateCode(city, i + 1),
                address: {
                    street: faker.location.streetAddress(),
                    city,
                    state: faker.location.state(),
                },
                location: randomPoint(),
                phone: fakePhone("05"),
                email: faker.internet.email(),
                branchType: "local_branch",
                parentHubId: hub._id,
                status: "active",
            },
            session,
        );
        localBranches.push(branch);
    }

    return {
        company,
        managerUser,
        hub,
        localBranches,
        allBranches: [hub, ...localBranches],
    };
}