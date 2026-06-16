import mongoose from "mongoose";
import { faker } from "@faker-js/faker";

import VehicleModel from "../../models/vehicle.model";

import { SEED_CONFIG, VEHICLE_TYPES } from "../constants";
import { getMaxWeight } from "../seed.helpers";

export async function seedVehiclesForCompany(
    companyId: mongoose.Types.ObjectId,
    branches: any[],
    session: mongoose.ClientSession,
): Promise<any[]> {
    const vehicles: any[] = [];




    for (let i = 0; i < SEED_CONFIG.VEHICLES_PER_COMPANY; i++) {
        const type = faker.helpers.arrayElement(VEHICLE_TYPES);
        const branch = branches[i % branches.length];
        const maxWeight = getMaxWeight(type);

        const [vehicle] = await VehicleModel.create(
            [
                {
                    companyId,
                    type,
                    registrationNumber: faker.vehicle.vrm().toUpperCase(),
                    brand: faker.vehicle.manufacturer(),
                    modelName: faker.vehicle.model(),
                    year: faker.number.int({ min: 2010, max: new Date().getFullYear() }),
                    color: faker.vehicle.color(),
                    maxWeight,
                    maxVolume: faker.number.float({ min: 1, max: 60, fractionDigits: 1 }),
                    supportsFragile: true,
                    currentBranchId: branch?._id,
                    status: "available",
                },
            ],
            { session },
        );

        vehicles.push(vehicle);
    }

    return vehicles;
}