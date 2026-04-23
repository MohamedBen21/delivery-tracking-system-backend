import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  toggleOnlineStatus,
  transporterMarkPackagesArrivedAtBranch,
  transporterMarkPackagesInTransit,
} from "../controllers/supervisor.controller";

const transporterRouter = Router();

const chain = [isAuthenticated, authorizeRoles("transporter")] as const;

transporterRouter.post("/routes/:routeId/start-transit", ...chain, transporterMarkPackagesInTransit);
transporterRouter.post(
  "/routes/:routeId/stops/:stopId/arrive",
  ...chain,
  transporterMarkPackagesArrivedAtBranch,
);
transporterRouter.patch("/online/toggle", ...chain, toggleOnlineStatus);

export default transporterRouter;

