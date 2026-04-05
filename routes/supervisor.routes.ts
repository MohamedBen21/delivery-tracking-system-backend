import express from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  createDeliverer,
  updateDeliverer,
  toggleBlockDeliverer,
  getDeliverer,
  getMyDeliverers,
  createTransporter,
  updateTransporter,
  toggleBlockTransporter,
  getTransporter,
  getMyTransporters,
  createPackage,
  updatePackage,
  toggleCancelPackage,
  getPackage,
  getMyBranchPackages,
  addPackageIssue,
  resolvePackageIssue,
  createFreelancer,
  updateFreelancer,
  toggleBlockFreelancer,
  getFreelancer,
  getMyFreelancers,
  assignDeliverer,
} from "../controllers/supervisor.controller";

const supervisorRouter = express.Router();

// ── Deliverer routes ──
supervisorRouter.post(
  "/branch/:branchId/deliverer",
  isAuthenticated,
  authorizeRoles("supervisor"),
  createDeliverer
);

supervisorRouter.put(
  "/branch/:branchId/deliverer/:delivererId",
  isAuthenticated,
  authorizeRoles("supervisor"),
  updateDeliverer
);

supervisorRouter.patch(
  "/branch/:branchId/deliverer/:delivererId/toggle-block",
  isAuthenticated,
  authorizeRoles("supervisor", "admin"),
  toggleBlockDeliverer
);

supervisorRouter.get(
  "/branch/:branchId/deliverer/:delivererId",
  isAuthenticated,
  authorizeRoles("supervisor", "admin"),
  getDeliverer
);

supervisorRouter.get(
  "/branch/:branchId/deliverers",
  isAuthenticated,
  authorizeRoles("supervisor"),
  getMyDeliverers
);

// ── Transporter routes ──
supervisorRouter.post(
  "/company/:companyId/transporter",
  isAuthenticated,
  authorizeRoles("supervisor", "manager"),
  createTransporter
);

supervisorRouter.put(
  "/company/:companyId/transporter/:transporterId",
  isAuthenticated,
  authorizeRoles("supervisor", "manager"),
  updateTransporter
);

supervisorRouter.patch(
  "/company/:companyId/transporter/:transporterId/toggle-block",
  isAuthenticated,
  authorizeRoles("supervisor", "manager", "admin"),
  toggleBlockTransporter
);

supervisorRouter.get(
  "/company/:companyId/transporter/:transporterId",
  isAuthenticated,
  authorizeRoles("supervisor", "manager", "admin"),
  getTransporter
);

supervisorRouter.get(
  "/company/:companyId/transporters",
  isAuthenticated,
  authorizeRoles("supervisor", "manager"),
  getMyTransporters
);

// ── Package routes ──
supervisorRouter.post(
  "/branch/:branchId/package",
  isAuthenticated,
  authorizeRoles("supervisor"),
  createPackage
);

supervisorRouter.put(
  "/branch/:branchId/package/:packageId",
  isAuthenticated,
  authorizeRoles("supervisor"),
  updatePackage
);

supervisorRouter.patch(
  "/branch/:branchId/package/:packageId/toggle-cancel",
  isAuthenticated,
  authorizeRoles("supervisor", "admin"),
  toggleCancelPackage
);

supervisorRouter.get(
  "/branch/:branchId/package/:packageId",
  isAuthenticated,
  authorizeRoles("supervisor", "admin"),
  getPackage
);

supervisorRouter.get(
  "/branch/:branchId/packages",
  isAuthenticated,
  authorizeRoles("supervisor"),
  getMyBranchPackages
);

// ── Package issues ──
supervisorRouter.post(
  "/branch/:branchId/package/:packageId/issue",
  isAuthenticated,
  authorizeRoles("supervisor"),
  addPackageIssue
);

supervisorRouter.patch(
  "/branch/:branchId/package/:packageId/issue/:issueIndex/resolve",
  isAuthenticated,
  authorizeRoles("supervisor"),
  resolvePackageIssue
);

// ── Freelancer routes ──
supervisorRouter.post(
  "/branch/:branchId/freelancer",
  isAuthenticated,
  authorizeRoles("supervisor"),
  createFreelancer
);

supervisorRouter.put(
  "/branch/:branchId/freelancer/:freelancerId",
  isAuthenticated,
  authorizeRoles("supervisor"),
  updateFreelancer
);

supervisorRouter.patch(
  "/branch/:branchId/freelancer/:freelancerId/toggle-block",
  isAuthenticated,
  authorizeRoles("supervisor", "admin"),
  toggleBlockFreelancer
);

supervisorRouter.get(
  "/branch/:branchId/freelancer/:freelancerId",
  isAuthenticated,
  authorizeRoles("supervisor", "admin"),
  getFreelancer
);

supervisorRouter.get(
  "/branch/:branchId/freelancers",
  isAuthenticated,
  authorizeRoles("supervisor"),
  getMyFreelancers
);

// ── Assign deliverer ──
supervisorRouter.post(
  "/branch/:branchId/assign-deliverer",
  isAuthenticated,
  authorizeRoles("supervisor"),
  assignDeliverer
);

export default supervisorRouter;
