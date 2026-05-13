import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  arrivedAtBranchOutForDelivery,
  deliverPackageFail,
  deliveryReturnPackage,
  getDeliveryHistory,
  getManifestsPaginated,
  getMyDeliveries,
  getMyDeliveryById,
  getTodayDeliveries,
  toggleOnlineStatus,
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
delivererRouter.patch("/online/toggle", ...chain, toggleOnlineStatus);


delivererRouter.get("/deliverer/deliveries", ...chain , getMyDeliveries);

delivererRouter.get("/deliverer/deliveries", ...chain , getMyDeliveryById);


delivererRouter.get(
  "/deliveries/today",
  ...chain,
  getTodayDeliveries,
);

delivererRouter.get(
  "/deliveries/history",
  ...chain,
  getDeliveryHistory,
);

delivererRouter.get(
  "/manifests",
  ...chain,
  getManifestsPaginated,
);

export default delivererRouter;
