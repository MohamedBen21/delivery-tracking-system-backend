import { Request, Response } from 'express';
import mongoose from 'mongoose';
import PackageModel from '../models/package.model';
import ManifestModel from '../models/manifest.model';
import RouteModel from '../models/route.model';
import TransporterModel from '../models/transporter.model';
import DelivererModel from '../models/deliverer.model';
import BranchModel from '../models/branch.model';
import UserModel from '../models/user.model';
import { SocketService } from '../services/socket.service';


const RESTRICTED_STATUSES = new Set([
  'cancelled',
  'lost',
  'damaged',
  'failed_delivery',
]);


const TERMINAL_STATUSES = new Set([
  'delivered',
  'returned',
  'cancelled',
  'lost',
]);

export class TrackingController {
  private socketService: SocketService;

  constructor(socketService: SocketService) {
    this.socketService = socketService;
  }


  trackPackage = async (req: Request, res: Response) => {
    try {
      const { trackingNumber } = req.params;
      const { clientId } = req.query;

      if (!trackingNumber) {
        return res.status(400).json({
          success: false,
          message: 'Tracking number is required',
        });
      }


      const pkg = await PackageModel.findOne({ 
        trackingNumber: trackingNumber.toString().toUpperCase() 
      })
        .populate('originBranchId', 'name address location phone')
        .populate('destinationBranchId', 'name address location phone')
        .populate('senderId', 'name email')
        .lean();

      if (!pkg) {
        return res.status(404).json({
          success: false,
          message: 'Package not found with this tracking number',
        });
      }


      if (RESTRICTED_STATUSES.has(pkg.status)) {
        return res.status(403).json({
          success: false,
          message: `This package has been ${pkg.status}. Please contact support for more information.`,
          status: pkg.status,
          restricted: true,
        });
      }


      const trackingResponse = await this.buildTrackingResponse(pkg);


      const isActive = !TERMINAL_STATUSES.has(pkg.status);
      
      res.status(200).json({
        success: true,
        data: trackingResponse,
        canSubscribe: isActive,
        message: isActive 
          ? 'Package found. Real-time tracking available.'
          : 'Package found. Final status displayed.',
      });

    } catch (error: any) {
      console.error('[TrackingController] trackPackage error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to track package',
        error: error.message,
      });
    }
  };


  subscribeToTracking = async (req: Request, res: Response) => {
    try {
      const { trackingNumber } = req.params;

      if (!trackingNumber) {
        return res.status(400).json({
          success: false,
          message: 'Tracking number is required',
        });
      }

      const pkg = await PackageModel.findOne({ 
        trackingNumber: trackingNumber.toString().toUpperCase() 
      }).lean();

      if (!pkg) {
        return res.status(404).json({
          success: false,
          message: 'Package not found',
        });
      }


      if (RESTRICTED_STATUSES.has(pkg.status)) {
        return res.status(403).json({
          success: false,
          message: `Cannot track: package is ${pkg.status}`,
        });
      }


      const locationData = await this.getCurrentLocationData(pkg);

      res.status(200).json({
        success: true,
        data: {
          packageId: pkg._id,
          trackingNumber: pkg.trackingNumber,
          status: pkg.status,
          room: `package_${pkg._id}`,
          currentLocation: locationData,
          estimatedDeliveryTime: pkg.estimatedDeliveryTime,
          trackingHistory: (pkg.trackingHistory || []).slice(-10),
        },
      });

    } catch (error: any) {
      console.error('[TrackingController] subscribeToTracking error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to subscribe to tracking',
      });
    }
  };


  private async getCurrentLocationData(pkg: any): Promise<any> {
    const status = pkg.status;

    if (status === 'at_origin_branch' && pkg.originBranchId) {
      const branch = await BranchModel.findById(pkg.originBranchId)
        .select('name address location phone')
        .lean();
      return {
        type: 'branch',
        branchId: branch?._id,
        name: branch?.name,
        address: branch?.address,
        coordinates: branch?.location?.coordinates,
        phone: branch?.phone,
        message: `Package is ready at ${branch?.name || 'origin branch'}`,
        isOrigin: true,
      };
    }

    if (status === 'at_destination_branch' && pkg.destinationBranchId) {
      const branch = await BranchModel.findById(pkg.destinationBranchId)
        .select('name address location phone')
        .lean();
      return {
        type: 'branch',
        branchId: branch?._id,
        name: branch?.name,
        address: branch?.address,
        coordinates: branch?.location?.coordinates,
        phone: branch?.phone,
        message: `Package is ready for pickup at ${branch?.name || 'destination branch'}`,
        isOrigin: false,
      };
    }


    if (status === 'in_transit_to_branch') {

      const manifest = await ManifestModel.findOne({
        'packages.packageId': pkg._id,
        status: { $in: ['in_transit', 'arrived', 'loaded', 'sealed'] },
      })
        .populate('originBranchId', 'name address location')
        .populate('destinationBranchId', 'name address location')
        .lean();

      if (manifest) {

        const route = await RouteModel.findOne({
          'stops.manifestIds': manifest._id,
          status: { $in: ['active', 'in_transit'] },
        })
          .populate('assignedTransporterId', 'userId')
          .lean();


        let currentStopLocation = null;
        let estimatedArrival = manifest.estimatedArrival;
        
        if (route && route.currentStopIndex !== undefined) {
          const currentStop = route.stops[route.currentStopIndex];
          if (currentStop?.location?.coordinates) {
            currentStopLocation = currentStop.location.coordinates;
          }
          if (currentStop?.expectedArrival) {
            estimatedArrival = currentStop.expectedArrival;
          }
        }


        const destBranch = manifest.destinationBranchId as any;
        
        return {
          type: 'transit',
          manifestCode: manifest.manifestCode,
          originBranch: manifest.originBranchId ? {
            name: (manifest.originBranchId as any)?.name,
            address: (manifest.originBranchId as any)?.address,
          } : null,
          destinationBranch: destBranch ? {
            id: destBranch._id,
            name: destBranch.name,
            address: destBranch.address,
            coordinates: destBranch.location?.coordinates,
          } : null,
          currentStopLocation,
          estimatedArrival,
          status: manifest.status,
          message: 'Package is in transit',
        };
      }
      

      if (pkg.destinationBranchId) {
        const branch = await BranchModel.findById(pkg.destinationBranchId)
          .select('name address location')
          .lean();
        if (branch) {
          return {
            type: 'branch',
            branchId: branch._id,
            name: branch.name,
            address: branch.address,
            coordinates: branch.location?.coordinates,
            message: 'Package en route to destination branch',
            isOrigin: false,
          };
        }
      }
    }


    if (status === 'out_for_delivery' && pkg.assignedDelivererId) {
      const deliverer = await DelivererModel.findOne({ 
        userId: pkg.assignedDelivererId 
      })
        .populate('userId', 'name phone')
        .select('currentLocation lastLocationUpdate availabilityStatus')
        .lean();

      if (deliverer?.currentLocation?.coordinates) {
        const user = deliverer.userId as any;
        return {
          type: 'deliverer',
          delivererId: deliverer.userId?._id || deliverer.userId,
          name: user?.name || 'Deliverer',
          phone: user?.phone,
          coordinates: deliverer.currentLocation.coordinates,
          lastUpdate: deliverer.lastLocationUpdate || deliverer.lastActiveAt,
          status: deliverer.availabilityStatus,
          message: 'Out for delivery',
        };
      }
      

      if (pkg.destination?.location?.coordinates) {
        return {
          type: 'destination',
          address: pkg.destination.address,
          coordinates: pkg.destination.location.coordinates,
          recipientName: pkg.destination.recipientName,
          message: 'Delivery destination',
        };
      }
    }


    if (pkg.destination?.location?.coordinates) {
      return {
        type: 'destination',
        address: pkg.destination.address,
        coordinates: pkg.destination.location.coordinates,
        recipientName: pkg.destination.recipientName,
        message: 'Delivery destination',
      };
    }

    return null;
  }


  private async buildTrackingResponse(pkg: any): Promise<any> {

    let originBranch = null;
    if (pkg.originBranchId) {
      const branch = await BranchModel.findById(pkg.originBranchId)
        .select('name address phone location')
        .lean();
      originBranch = branch;
    }


    let destinationBranch = null;
    if (pkg.deliveryType === 'branch_pickup' && pkg.destinationBranchId) {
      const branch = await BranchModel.findById(pkg.destinationBranchId)
        .select('name address phone location')
        .lean();
      destinationBranch = branch;
    }

    const currentLocation = await this.getCurrentLocationData(pkg);


    const canTrackRealTime = !TERMINAL_STATUSES.has(pkg.status) && 
      !RESTRICTED_STATUSES.has(pkg.status);

    return {
      packageId: pkg._id,
      trackingNumber: pkg.trackingNumber,
      status: pkg.status,
      statusDisplay: this.getStatusDisplay(pkg.status),
      statusColor: this.getStatusColor(pkg.status),
      progress: this.getProgressPercentage(pkg.status),
      
      currentLocation,
      
      origin: {
        branchId: originBranch?._id,
        name: originBranch?.name,
        address: originBranch?.address,
        phone: originBranch?.phone,
        coordinates: originBranch?.location?.coordinates,
      },
      
      destination: {
        type: pkg.deliveryType,
        recipientName: pkg.destination.recipientName,
        recipientPhone: this.maskPhoneNumber(pkg.destination.recipientPhone),
        address: pkg.destination.address,
        city: pkg.destination.city,
        state: pkg.destination.state,
        postalCode: pkg.destination.postalCode,
        coordinates: pkg.destination.location?.coordinates,
      },
      
      destinationBranch: destinationBranch ? {
        id: destinationBranch._id,
        name: destinationBranch.name,
        address: destinationBranch.address,
        phone: destinationBranch.phone,
        coordinates: destinationBranch.location?.coordinates,
      } : null,
      
      packageInfo: {
        weight: pkg.weight,
        type: pkg.type,
        isFragile: pkg.isFragile,
        description: pkg.description,
        declaredValue: pkg.declaredValue,
      },
      
      timing: {
        createdAt: pkg.createdAt,
        estimatedDelivery: pkg.estimatedDeliveryTime,
        deliveredAt: pkg.deliveredAt,
      },
      
      trackingHistory: (pkg.trackingHistory || []).map((event: any, index: number, arr: any[]) => ({
        status: event.status,
        statusDisplay: this.getStatusDisplay(event.status),
        location: event.location,
        notes: event.notes,
        timestamp: event.timestamp,
        isCurrent: index === arr.length - 1,
      })),
      
      canTrackRealTime,
    };
  }

  private getStatusDisplay(status: string): string {
    const statusMap: Record<string, string> = {
      pending: 'Pending',
      accepted: 'Accepted',
      cashier_claimed: 'Processing',
      at_origin_branch: 'At Origin Branch',
      manifested: 'In Manifest',
      in_transit_to_branch: 'In Transit',
      at_destination_branch: 'At Destination Branch',
      out_for_delivery: 'Out for Delivery',
      delivered: 'Delivered',
      failed_delivery: 'Delivery Failed',
      failed_delivery_attempt: 'Delivery Attempt Failed',
      cancelled: 'Cancelled',
      returned: 'Returned',
      lost: 'Lost',
      damaged: 'Damaged',
      on_hold: 'On Hold',
      rescheduled: 'Rescheduled',
    };
    return statusMap[status] || status;
  }

  private getStatusColor(status: string): string {
    const colorMap: Record<string, string> = {
      pending: '#F59E0B',
      accepted: '#3B82F6',
      cashier_claimed: '#8B5CF6',
      at_origin_branch: '#3B82F6',
      manifested: '#6366F1',
      in_transit_to_branch: '#8B5CF6',
      at_destination_branch: '#F97316',
      out_for_delivery: '#F97316',
      delivered: '#10B981',
      failed_delivery: '#EF4444',
      failed_delivery_attempt: '#EF4444',
      cancelled: '#6B7280',
      returned: '#6B7280',
      lost: '#EF4444',
      damaged: '#EF4444',
      on_hold: '#F59E0B',
      rescheduled: '#F59E0B',
    };
    return colorMap[status] || '#6B7280';
  }

  private getProgressPercentage(status: string): number {
    const progressMap: Record<string, number> = {
      pending: 5,
      accepted: 10,
      cashier_claimed: 15,
      at_origin_branch: 20,
      manifested: 30,
      in_transit_to_branch: 50,
      at_destination_branch: 75,
      out_for_delivery: 85,
      delivered: 100,
    };
    return progressMap[status] || 0;
  }

  private maskPhoneNumber(phone: string): string {
    if (!phone || phone.length < 8) return phone || 'Not provided';
    return phone.slice(0, 3) + '****' + phone.slice(-3);
  }
}

export default TrackingController;