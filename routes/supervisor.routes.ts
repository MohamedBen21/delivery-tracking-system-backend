import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  addPackageIssue,
  assignDeliverer,
  assignFreelancer,
  cancelPackage,
  createCashier,
  createDeliverer,
  createFreelancer,
  createLoader,
  createPackage,
  getActiveRoutes,
  getBranchPackages,
  getCashier,
  getDeliverer,
  getFreelancer,
  getLoader,
  getMeSupervisor,
  getMyBranchPackages,
  getMyCashiers,
  getMyDeliverers,
  getMyFreelancers,
  getMyLoaders,
  getMyRoutes,
  getPackage,
  getPackageHistory,
  getPackagesByBranch,
  getPackagesByReceiver,
  getPackagesBySender,
  getPackagesByStatus,
  getPackagesPaginated,
  getPackageTracking,
  getRoute,
  getRoutes,
  getRoutesByBranch,
  resolvePackageIssue,
  searchPackages,
  toggleBlockCashier,
  toggleBlockDeliverer,
  toggleBlockFreelancer,
  toggleBlockLoader,
  toggleCancelPackage,
  toggleCancelRoute,
  updateCashier,
  updateDeliverer,
  updateFreelancer,
  updateLoader,
  updateMeSupervisor,
  updatePackage,
  updateRoute,
} from "../controllers/supervisor.controller";

const supervisorRouter = Router();

const supOrAdmin = [isAuthenticated, authorizeRoles("supervisor", "admin")] as const;

const supAdminDelTrans = [
  isAuthenticated, 
  authorizeRoles("supervisor", "admin", "deliverer", "transporter")
] as const;

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
// supervisorRouter.get("/branches/:branchId/routes", ...supOrAdmin, getRoutes);
supervisorRouter.get("/branches/:branchId/routes", ...supAdminDelTrans, getRoutes);
supervisorRouter.get("/branches/:branchId/routes/:routeId", ...supOrAdmin, getRoute);
supervisorRouter.patch("/branches/:branchId/routes/:routeId", ...supOrAdmin, updateRoute);
supervisorRouter.patch(
  "/branches/:branchId/routes/:routeId/toggle-cancel",
  ...supOrAdmin,
  toggleCancelRoute,
);

supervisorRouter.get("/packages/search", isAuthenticated, searchPackages);
supervisorRouter.get("/packages", isAuthenticated, getPackagesPaginated);


// Role-based middleware for supervisor, manager, or admin
const supMgrAdmin = [isAuthenticated, authorizeRoles("supervisor", "manager", "admin")] as const;



/**
 * @route   POST /api/supervisor/branches/:branchId/cashiers
 * @desc    Create a new cashier for a specific branch
 * @access  Supervisor, Manager, Admin
 */
supervisorRouter.post(
  "/branches/:branchId/cashiers",
  ...supMgrAdmin,
  createCashier
);

/**
 * @route   GET /api/supervisor/branches/:branchId/cashiers
 * @desc    Get all cashiers of a specific branch (with optional filters)
 * @access  Supervisor, Manager, Admin
 */
supervisorRouter.get(
  "/branches/:branchId/cashiers",
  ...supMgrAdmin,
  getMyCashiers
);

/**
 * @route   GET /api/supervisor/branches/:branchId/cashiers/:cashierId
 * @desc    Get a specific cashier by ID
 * @access  Supervisor, Manager, Admin
 */
supervisorRouter.get(
  "/branches/:branchId/cashiers/:cashierId",
  ...supMgrAdmin,
  getCashier
);

/**
 * @route   PATCH /api/supervisor/branches/:branchId/cashiers/:cashierId
 * @desc    Update a cashier's information
 * @access  Supervisor, Manager, Admin
 */
supervisorRouter.patch(
  "/branches/:branchId/cashiers/:cashierId",
  ...supMgrAdmin,
  updateCashier
);

/**
 * @route   PATCH /api/supervisor/branches/:branchId/cashiers/:cashierId/toggle-block
 * @desc    Toggle cashier status (activate/suspend)
 * @access  Supervisor, Manager, Admin
 */
supervisorRouter.patch(
  "/branches/:branchId/cashiers/:cashierId/toggle-block",
  ...supMgrAdmin,
  toggleBlockCashier
);




/**
 * @route   POST /api/supervisor/branches/:branchId/loaders
 * @desc    Create a new loader for a specific branch
 * @access  Supervisor, Manager, Admin
 */
supervisorRouter.post(
  "/branches/:branchId/loaders",
  ...supMgrAdmin,
  createLoader
);

/**
 * @route   GET /api/supervisor/branches/:branchId/loaders
 * @desc    Get all loaders of a specific branch (with optional filters)
 * @access  Supervisor, Manager, Admin
 */
supervisorRouter.get(
  "/branches/:branchId/loaders",
  ...supMgrAdmin,
  getMyLoaders
);

/**
 * @route   GET /api/supervisor/branches/:branchId/loaders/:loaderId
 * @desc    Get a specific loader by ID
 * @access  Supervisor, Manager, Admin
 */
supervisorRouter.get(
  "/branches/:branchId/loaders/:loaderId",
  ...supMgrAdmin,
  getLoader
);

/**
 * @route   PATCH /api/supervisor/branches/:branchId/loaders/:loaderId
 * @desc    Update a loader's information (including temporary branch assignment)
 * @access  Supervisor, Manager, Admin
 */
supervisorRouter.patch(
  "/branches/:branchId/loaders/:loaderId",
  ...supMgrAdmin,
  updateLoader
);

/**
 * @route   PATCH /api/supervisor/branches/:branchId/loaders/:loaderId/toggle-block
 * @desc    Toggle loader status (activate/suspend)
 * @access  Supervisor, Manager, Admin
 */
supervisorRouter.patch(
  "/branches/:branchId/loaders/:loaderId/toggle-block",
  ...supMgrAdmin,
  toggleBlockLoader
);




supervisorRouter.get(
  "/routes/get-my-routes",
  isAuthenticated, 
  authorizeRoles("supervisor" , "transporter", "deliverer"),
  getMyRoutes
);

export default supervisorRouter;


