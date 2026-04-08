import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  addPackageIssue,
  assignDeliverer,
  assignFreelancer,
  cancelPackage,
  createDeliverer,
  createFreelancer,
  createPackage,
  getActiveRoutes,
  getBranchPackages,
  getDeliverer,
  getFreelancer,
  getMeSupervisor,
  getMyBranchPackages,
  getMyDeliverers,
  getMyFreelancers,
  getPackage,
  getPackageHistory,
  getPackagesByBranch,
  getPackagesByReceiver,
  getPackagesBySender,
  getPackagesByStatus,
  getPackageTracking,
  getRoute,
  getRoutes,
  getRoutesByBranch,
  resolvePackageIssue,
  toggleBlockDeliverer,
  toggleBlockFreelancer,
  toggleCancelPackage,
  toggleCancelRoute,
  updateDeliverer,
  updateFreelancer,
  updateMeSupervisor,
  updatePackage,
  updateRoute,
} from "../controllers/supervisor.controller";

const supervisorRouter = Router();

const supOrAdmin = [isAuthenticated, authorizeRoles("supervisor", "admin")] as const;

supervisorRouter.get("/me", ...supOrAdmin, getMeSupervisor);
supervisorRouter.patch("/me", ...supOrAdmin, updateMeSupervisor);

supervisorRouter.get("/routes/by-branch", ...supOrAdmin, getRoutesByBranch);

supervisorRouter.post("/branches/:branchId/deliverers", ...supOrAdmin, createDeliverer);
supervisorRouter.get("/branches/:branchId/deliverers", ...supOrAdmin, getMyDeliverers);
supervisorRouter.get("/branches/:branchId/deliverers/:delivererId", ...supOrAdmin, getDeliverer);
supervisorRouter.patch("/branches/:branchId/deliverers/:delivererId", ...supOrAdmin, updateDeliverer);
supervisorRouter.patch(
  "/branches/:branchId/deliverers/:delivererId/toggle-block",
  ...supOrAdmin,
  toggleBlockDeliverer,
);
supervisorRouter.post("/branches/:branchId/deliverers/assign", ...supOrAdmin, assignDeliverer);
supervisorRouter.post("/branches/:branchId/freelancers/assign", ...supOrAdmin, assignFreelancer);

supervisorRouter.post("/branches/:branchId/freelancers", ...supOrAdmin, createFreelancer);
supervisorRouter.get("/branches/:branchId/freelancers", ...supOrAdmin, getMyFreelancers);
supervisorRouter.get("/branches/:branchId/freelancers/:freelancerId", ...supOrAdmin, getFreelancer);
supervisorRouter.patch("/branches/:branchId/freelancers/:freelancerId", ...supOrAdmin, updateFreelancer);
supervisorRouter.patch(
  "/branches/:branchId/freelancers/:freelancerId/toggle-block",
  ...supOrAdmin,
  toggleBlockFreelancer,
);

supervisorRouter.post("/branches/:branchId/packages", ...supOrAdmin, createPackage);
supervisorRouter.get("/branches/:branchId/packages", ...supOrAdmin, getBranchPackages);
supervisorRouter.get("/branches/:branchId/packages/compact", ...supOrAdmin, getMyBranchPackages);
supervisorRouter.get("/branches/:branchId/packages/by-status", ...supOrAdmin, getPackagesByStatus);
supervisorRouter.get("/branches/:branchId/packages/by-branch-role", ...supOrAdmin, getPackagesByBranch);
supervisorRouter.get("/branches/:branchId/packages/by-sender", ...supOrAdmin, getPackagesBySender);
supervisorRouter.get("/branches/:branchId/packages/by-receiver", ...supOrAdmin, getPackagesByReceiver);
supervisorRouter.get("/branches/:branchId/packages/:packageId", ...supOrAdmin, getPackage);
supervisorRouter.patch("/branches/:branchId/packages/:packageId", ...supOrAdmin, updatePackage);
supervisorRouter.patch(
  "/branches/:branchId/packages/:packageId/toggle-cancel",
  ...supOrAdmin,
  toggleCancelPackage,
);
supervisorRouter.patch("/branches/:branchId/packages/:packageId/cancel", ...supOrAdmin, cancelPackage);
supervisorRouter.post("/branches/:branchId/packages/:packageId/issues", ...supOrAdmin, addPackageIssue);
supervisorRouter.patch(
  "/branches/:branchId/packages/:packageId/issues/:issueIndex/resolve",
  ...supOrAdmin,
  resolvePackageIssue,
);
supervisorRouter.get(
  "/branches/:branchId/packages/:packageId/history",
  ...supOrAdmin,
  getPackageHistory,
);
supervisorRouter.get(
  "/branches/:branchId/packages/:packageId/tracking",
  ...supOrAdmin,
  getPackageTracking,
);

supervisorRouter.get("/branches/:branchId/routes/active", ...supOrAdmin, getActiveRoutes);
supervisorRouter.get("/branches/:branchId/routes", ...supOrAdmin, getRoutes);
supervisorRouter.get("/branches/:branchId/routes/:routeId", ...supOrAdmin, getRoute);
supervisorRouter.patch("/branches/:branchId/routes/:routeId", ...supOrAdmin, updateRoute);
supervisorRouter.patch(
  "/branches/:branchId/routes/:routeId/toggle-cancel",
  ...supOrAdmin,
  toggleCancelRoute,
);

export default supervisorRouter;


