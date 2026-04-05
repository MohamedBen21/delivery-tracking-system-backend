import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  arrivedAtBranchOutForDelivery,
  deliverPackageFail,
  deliveryReturnPackage,
} from "../controllers/supervisor.controller";

const delivererRouter = Router();

const chain = [isAuthenticated, authorizeRoles("deliverer")] as const;

delivererRouter.post(
  "/branches/:branchId/packages/out-for-delivery",
  ...chain,
  arrivedAtBranchOutForDelivery,
);
delivererRouter.post(
  "/branches/:branchId/packages/:packageId/fail",
  ...chain,
  deliverPackageFail,
);
delivererRouter.post(
  "/branches/:branchId/packages/:packageId/return",
  ...chain,
  deliveryReturnPackage,
);

export default delivererRouter;
