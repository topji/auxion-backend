const express = require('express');
const { ethers } = require('ethers');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const contractABI = require('./contractABI.json');

dotenv.config();

const app = express();

// CORS configuration
app.use(cors({
  origin: '*',  // Allows all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Add headers to all responses
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
}).catch((error) => {
  console.error('MongoDB connection error:', error);
});

// Order Schema
const orderSchema = new mongoose.Schema({
  creator: String,
  orderId: Number,
  amountInPi: String,
  amountPaidInUSDT: String,
  feePaid: String,
  buyerPichainAddress: String,
  sellerAddress: String,
  sellerPiChainAddress: String,
  status: Number,
  createdAt: Number,
  lockedBy: String,
  lockedAt: Number,
  lastUpdated: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', orderSchema);

// Ethereum provider setup
const provider = new ethers.providers.JsonRpcProvider(process.env.PROVIDER_URL);
const contractAddress = process.env.CONTRACT_ADDRESS;
const contract = new ethers.Contract(contractAddress, contractABI, provider);

// Add wallet setup with private key
console.log(process.env.SERVER_PRIVATE_KEY);
const wallet = new ethers.Wallet(process.env.SERVER_PRIVATE_KEY, provider);
const walletAddress = wallet.address;
console.log(walletAddress);
const contractWithSigner = contract.connect(wallet);

// Admin Order Schema
const adminOrderSchema = new mongoose.Schema({
  orderId: String,
  sellerAddress: String,
  orderCreator: String,
  txHash: String,
  acceptanceStatus: {type: Boolean, default: false},
  isRejected: {type: Boolean, default: false},
  createdAt: { type: Date, default: Date.now }
});

const AdminOrder = mongoose.model('AdminOrder', adminOrderSchema);

app.get('/api/fetchPendingOrders', async (req, res) => {
  try {
    let orderId = 1;
    
    while (true) {
      try {
        const order = await contract.orders(orderId);
        
        // Break the loop if we find an order with createdAt = 0
        if (order.createdAt.toString() === '0') {
          break;
        }

        await Order.findOneAndUpdate(
          { orderId: orderId.toString() },
          {
            creator: order.creator.toLowerCase(),
            orderId: orderId.toString(),
            amountInPi: order.amountInPi.toString(),
            amountPaidInUSDT: order.amountPaidInUSDT.toString(),
            feePaid: order.feePaid.toString(),
            buyerPichainAddress: order.buyerPichainAddress,
            sellerAddress: order.sellerAddress.toLowerCase(),
            sellerPiChainAddress: order.sellerPiChainAddress,
            status: order.status,
            createdAt: order.createdAt.toString(),
            lockedBy: order.lockedBy.toLowerCase(),
            lockedAt: order.lockedAt.toString(),
            lastUpdated: new Date()
          },
          { upsert: true }
        );

        orderId++;
      } catch (error) {
        // If there's an error fetching the order, assume we've reached the end
        break;
      }
    }

    // Fetch only pending orders (status = 0) and not locked
    const pendingOrders = await Order.find({
      status: 0,
      $or: [
        { lockedBy: '0x0000000000000000000000000000000000000000' },
        { lockedBy: null }
      ]
    });

    res.json({
      success: true,
      data: pendingOrders
    });

  } catch (error) {
    console.error('Error fetching pending orders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending orders'
    });
  }
});

app.get('/api/fetchOrdersByUser/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    // Validate wallet address format
    if (!ethers.utils.isAddress(walletAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid wallet address format'
      });
    }

    const normalizedAddress = walletAddress.toLowerCase();
    // Find orders where the wallet address matches either creator, sellerAddress, or lockedBy
    const userOrders = await Order.find({creator: normalizedAddress}).sort({ createdAt: -1 }); // Sort by createdAt in descending order

    res.json({
      success: true,
      data: userOrders
    });

  } catch (error) {
    console.error('Error fetching user orders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user orders'
    });
  }
});

// Add the lockOrder endpoint
app.post('/api/lockOrder', async (req, res) => {
  try {
    const { orderId, walletAddress } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: 'Order ID is required'
      });
    }

    // Check if order exists and is pending
    const order = await contract.orders(orderId);
    const isPending = await contract.isOrderPending(orderId);
    const isLocked = order.lockedBy.toLowerCase() !== '0x0000000000000000000000000000000000000000';

    if (isLocked) {
      return res.status(400).json({
        success: false,
        error: 'Order is already locked'
      });
    }

    if (!isPending) {
      return res.status(400).json({
        success: false,
        error: 'Order is not pending'
      });
    }

    // Get gas price
    const gasPrice = await provider.getGasPrice();
    
    // Estimate gas limit for the transaction
    const gasLimit = await contract.estimateGas.lockOrder(orderId, walletAddress);
    
    // Lock the order with proper gas parameters
    const tx = await contractWithSigner.lockOrder(
      orderId, 
      walletAddress,
      {
        gasLimit: gasLimit,
        gasPrice: gasPrice
      });
    
    await tx.wait(); // Wait for transaction to be mined

    // Update order in MongoDB
    await Order.findOneAndUpdate(
      { orderId: orderId.toString() },
      {
        lockedBy: walletAddress.toLowerCase(),
        lockedAt: Math.floor(Date.now() / 1000),
        lastUpdated: new Date()
      }
    );

    res.json({
      success: true,
      data: {
        orderId,
        lockedBy: walletAddress,
        txHash: tx.hash,
        gasUsed: gasLimit.toString(),
        gasPrice: gasPrice.toString()
      }
    });

  } catch (error) {
    console.error('Error locking order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to lock order',
      details: error.message
    });
  }
});

app.post('/api/fetchOrdersForSeller', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    
    // Validate wallet address format
    if (!ethers.utils.isAddress(walletAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid wallet address format'
      });
    }

    const normalizedAddress = walletAddress.toLowerCase();
    // Find orders where the wallet address matches either sellerAddress or lockedBy
    const sellerOrders = await Order.find({
      $or: [
        { sellerAddress: normalizedAddress },
        { lockedBy: normalizedAddress }
      ]
    }).sort({ createdAt: -1 }); // Sort by createdAt in descending order
    // Get corresponding admin orders for status display
    const adminOrders = await AdminOrder.find({
      orderId: { $in: sellerOrders.map(order => order.orderId) }
    });

    // Enhance seller orders with admin order status
    const enhancedSellerOrders = sellerOrders.map(order => {
      const adminOrder = adminOrders.find(ao => ao.orderId === order.orderId.toString());
      return {
        ...order.toObject(),
        adminStatus: adminOrder ? 
          (adminOrder.isRejected ? 'rejected' : 
           !adminOrder.acceptanceStatus ? 'pending_approval' : 'approved') 
          : null
      };
    });

    res.json({
      success: true,
      data: enhancedSellerOrders
    });

  } catch (error) {
    console.error('Error fetching seller orders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch seller orders',
      details: error.message
    });
  }
});

// Add the sendForAuthorization endpoint
app.post('/api/sendForAuthorization', async (req, res) => {
  try {
    const { walletAddress, orderId, txHash } = req.body;

    // Validate inputs
    if (!walletAddress || !orderId || !txHash) {
      return res.status(400).json({
        success: false,
        error: 'All fields (walletAddress, orderId, txHash) are required'
      });
    }

    // Validate wallet address format
    if (!ethers.utils.isAddress(walletAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid wallet address format'
      });
    }

    // Check if an admin order with pending status already exists for this orderId
    const existingAdminOrder = await AdminOrder.findOne({
      orderId: orderId,
      acceptanceStatus: false,
      isRejected: false
    });

    if (existingAdminOrder) {
      return res.status(400).json({
        success: false,
        error: 'An pending authorization request already exists for this order'
      });
    }

    // Get the original order to fetch the creator
    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(400).json({
        success: false,
        error: 'Order not found'
      });
    }

    // Create new admin order
    const adminOrder = new AdminOrder({
      orderId: orderId,
      sellerAddress: walletAddress.toLowerCase(),
      orderCreator: order.creator,
      txHash: txHash,
      acceptanceStatus: false,
      isRejected: false
    });

    await adminOrder.save();

    res.json({
      success: true,
      data: {
        orderId,
        sellerAddress: walletAddress.toLowerCase(),
        orderCreator: order.creator,
        txHash
      }
    });

  } catch (error) {
    console.error('Error sending for authorization:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send for authorization',
      details: error.message
    });
  }
});

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
