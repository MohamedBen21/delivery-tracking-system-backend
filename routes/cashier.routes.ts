import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  lookupFreelancer,
  claimPackage,
  acceptPackage,
  rejectPackage,
  checkIn,
  checkOut,
  getMyShift,
  getPendingPackages,
  printSingleBordereau,
  printBulkBordereau,
} from "../controllers/cashier.controller";

const cashierRouter = Router();

// All cashier routes require authentication and cashier role
cashierRouter.use(isAuthenticated, authorizeRoles("cashier"));

// Shift management
cashierRouter.post("/check-in", checkIn);
cashierRouter.post("/check-out", checkOut);
cashierRouter.get("/my-shift", getMyShift);

// Freelancer lookup and package management
cashierRouter.get("/freelancer-lookup", lookupFreelancer);
cashierRouter.get("/pending-packages", getPendingPackages);

// Package operations (claim → accept → reject flow)
cashierRouter.post("/claim-package", claimPackage);
cashierRouter.post("/accept-package", acceptPackage);
cashierRouter.post("/reject-package", rejectPackage);

// Bordereau printing
cashierRouter.get("/bordereau/:trackingNumber", printSingleBordereau);
cashierRouter.post("/bordereau/bulk", printBulkBordereau);

export default cashierRouter;