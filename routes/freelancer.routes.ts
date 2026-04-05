import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  cancelPackage,
  getMeFreelancer,
  getMyActivePackages,
  getMyDeliveredPackages,
  getMyPackages,
  trackPackage,
  updateMeFreelancer,
} from "../controllers/freelancer.controller";

const freelancerRouter = Router();

freelancerRouter.use(isAuthenticated, authorizeRoles("freelancer"));

freelancerRouter.get("/me", getMeFreelancer);
freelancerRouter.patch("/me", updateMeFreelancer);

freelancerRouter.get("/packages", getMyPackages);
freelancerRouter.get("/packages/active", getMyActivePackages);
freelancerRouter.get("/packages/delivered", getMyDeliveredPackages);
freelancerRouter.get("/packages/:packageId/track", trackPackage);
freelancerRouter.patch("/packages/:packageId/cancel", cancelPackage);

export default freelancerRouter;
