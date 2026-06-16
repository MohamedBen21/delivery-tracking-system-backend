import "dotenv/config";
import mongoose from "mongoose";

import { dbKeys } from "../conifg/db.keys";
import { SEED_CONFIG } from "./constants";
import { logStep } from "./seed.helpers";

import { seedCompanyWithBranches } from "./seeders/company.seeder";
import { seedSupervisorsForBranches } from "./seeders/supervisor.seeder";
import { seedCashiersForBranches } from "./seeders/cashier.seeder";
import { seedLoadersForBranches } from "./seeders/loader.seeder";
import { seedDeliverersForBranches } from "./seeders/deliverer.seeder";
import { seedTransportersForCompany } from "./seeders/transporter.seeder";
import { seedVehiclesForCompany } from "./seeders/vehicle.seeder";
import { seedTariffsForCompany } from "./seeders/tariff.seeder";
import { seedFreelancersForBranches } from "./seeders/freelancer.seeder";
import { seedPackagesForCompany } from "./seeders/package.seeder";

// ─── Transient error detection ────────────────────────────────────────────────

const TRANSIENT_CODES = new Set([24, 112]); // LockTimeout, WriteConflict

function isTransientError(err: any): boolean {
    return (
        err?.errorLabels?.has?.("TransientTransactionError") ||
        err?.errorResponse?.errorLabels?.includes("TransientTransactionError") ||
        TRANSIENT_CODES.has(err?.code)
    );
}

// ─── Transaction wrapper with retry ──────────────────────────────────────────

async function withTransaction<T>(
    label: string,
    fn: (session: mongoose.ClientSession) => Promise<T>,
    maxRetries = 3,
): Promise<T> {
    let attempt = 0;

    while (attempt <= maxRetries) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const result = await fn(session);
            await session.commitTransaction();
            return result;
        } catch (err: any) {
            await session.abortTransaction();

            if (isTransientError(err) && attempt < maxRetries) {
                attempt++;
                const delay = 200 * attempt; // 200ms → 400ms → 600ms
                logStep(`⚠️  [${label}] transient error, retry ${attempt}/${maxRetries} in ${delay}ms...`);
                await new Promise((r) => setTimeout(r, delay));
            } else {
                throw new Error(
                    `❌ [${label}] failed after ${attempt + 1} attempt(s): ${err.message}`,
                );
            }
        } finally {
            await session.endSession();
        }
    }

    throw new Error(`❌ [${label}] exhausted all retries`);
}

// ─── Pre-create collections to avoid catalog-change locks ────────────────────

async function ensureCollections(): Promise<void> {
    const db = mongoose.connection.db!;
    const existing = new Set(
        (await db.listCollections().toArray()).map((c) => c.name),
    );

    // Must match your actual MongoDB collection names.
    // Mongoose lowercases + pluralizes model names by default.
    const needed = [
        "users",
        "companies",
        "managers",
        "branches",
        "supervisors",
        "freelancers",
        "cashiers",
        "loaders",
        "deliverers",
        "transporters",
        "vehicles",
        "tariffs",
        "packages",
        "packagehistories",
        "payments",
        "clients",
    ];

    for (const name of needed) {
        if (!existing.has(name)) {
            await db.createCollection(name);
            logStep(`📦 Created collection: ${name}`);
        }
    }

    logStep("✅ Collections ready");
}

// ─── Seed one company ─────────────────────────────────────────────────────────

async function seedOneCompany(companyIndex: number): Promise<void> {
    logStep(`\n🏢 Company ${companyIndex + 1}/${SEED_CONFIG.TOTAL_COMPANIES}`);

    try {
        const { company, managerUser, allBranches } = await withTransaction(
            "company+branches",
            (s) => seedCompanyWithBranches(companyIndex, s),
        );

        await withTransaction("supervisors", (s) =>
            seedSupervisorsForBranches(company._id, allBranches, s),
        );

        const freelancers = await withTransaction("freelancers", (s) =>
            seedFreelancersForBranches(company._id, allBranches, s),
        );

        const cashiers = await withTransaction("cashiers", (s) =>
            seedCashiersForBranches(company._id, allBranches, s),
        );

        await withTransaction("loaders", (s) =>
            seedLoadersForBranches(company._id, allBranches, s),
        );

        await withTransaction("deliverers", (s) =>
            seedDeliverersForBranches(company._id, allBranches, s),
        );

        await withTransaction("transporters", (s) =>
            seedTransportersForCompany(company._id, allBranches, s),
        );

        await withTransaction("vehicles", (s) =>
            seedVehiclesForCompany(company._id, allBranches, s),
        );

        await withTransaction("tariffs", (s) =>
            seedTariffsForCompany(company._id, managerUser._id, s),
        );

        // Packages touch many collections — one transaction per freelancer
        // keeps each transaction short and avoids lock contention.
        for (const freelancer of freelancers) {
            await withTransaction(`packages[${freelancer._id}]`, (s) =>
                seedPackagesForCompany(company._id, allBranches, [freelancer], cashiers, s),
            );
        }

        logStep(`✅ Company ${company.name} seeded`);
    } catch (err) {
        console.error((err as Error).message);
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function seed() {
    await mongoose.connect(dbKeys.mongodb.uri);
    logStep("✅ Mongo connected");

    await ensureCollections();

    for (let c = 0; c < SEED_CONFIG.TOTAL_COMPANIES; c++) {
        await seedOneCompany(c);
    }

    await mongoose.disconnect();
    logStep("\n🚀 SEEDING COMPLETED");
}

seed();