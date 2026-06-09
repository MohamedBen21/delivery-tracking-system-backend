import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import { getMyTariffs, getTariffPrice, upsertTariff, bulkUpsertTariffs, deleteTariff } from "../controllers/manager.controller";

const tarrifRouter = Router();

const manager = [isAuthenticated, authorizeRoles("manager")] as const;

tarrifRouter.post("", ...manager, upsertTariff)
tarrifRouter.post("/bulk", ...manager, bulkUpsertTariffs)
tarrifRouter.get("", ...manager, getMyTariffs)
tarrifRouter.get("/price", ...manager, getTariffPrice)
tarrifRouter.delete("", ...manager, deleteTariff)

export default tarrifRouter;


