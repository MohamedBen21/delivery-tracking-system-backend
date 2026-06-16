import mongoose from "mongoose";
import { faker } from "@faker-js/faker";

import TariffModel from "../../models/tariff.model";

import { SEED_CONFIG } from "../constants";
import { isValidWilayaCode } from "../../utils/wilaya";

export async function seedTariffsForCompany(
    companyId: mongoose.Types.ObjectId,
    managerId: mongoose.Types.ObjectId,
    session: mongoose.ClientSession,
): Promise<void> {
    const usedPairs = new Set<string>();
    let created = 0;

    while (created < SEED_CONFIG.TARIFF_ROUTES_PER_COMPANY) {
        const wilayaFrom = faker.number.int({ min: 1, max: SEED_CONFIG.WILAYA_COUNT });
        const wilayaTo = faker.number.int({ min: 1, max: SEED_CONFIG.WILAYA_COUNT });

        if (!isValidWilayaCode(wilayaFrom) || !isValidWilayaCode(wilayaTo)) continue;

        const [a, b] = wilayaFrom <= wilayaTo ? [wilayaFrom, wilayaTo] : [wilayaTo, wilayaFrom];
        const pairKey = `${a}-${b}`;
        if (usedPairs.has(pairKey)) continue;
        usedPairs.add(pairKey);

        const stopdesk = faker.number.int({ min: 300, max: 800 });
        const domicile = stopdesk + faker.number.int({ min: 100, max: 400 });

        await TariffModel.setPrice(
            companyId.toString(),
            wilayaFrom,
            wilayaTo,
            { stopdesk, domicile },
            managerId.toString(),
            // NOTE: pass { session } here too if your setPrice implementation
            // accepts a mongoose session/options parameter, to keep this seeder
            // fully transactional like the rest of the seed run.
        );

        created++;
    }
}