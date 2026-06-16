import express from 'express';
import TrackingController from '../controllers/tracking.controller';
import { SocketService } from '../services/socket.service';
import rateLimit from 'express-rate-limit';

const router = express.Router();


const trackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 30,
  message: 'Too many tracking requests, please try again later',
});

const subscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many subscription attempts, please wait',
});

export function setupTrackingRoutes(socketService: SocketService) {
  const trackingController = new TrackingController(socketService);


  router.get(
    '/track/:trackingNumber',
    trackingLimiter,
    trackingController.trackPackage
  );

  router.post(
    '/track/:trackingNumber/subscribe',
    subscribeLimiter,
    trackingController.subscribeToTracking
  );

  return router;
}

export default setupTrackingRoutes;