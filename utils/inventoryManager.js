const Product = require('../models/Product');

/**
 * Reduce inventory for products in an invoice
 * @param {Array} items - Invoice items with product and quantity
 * @param {Object} io - Socket.IO instance
 * @returns {Object} Result with success status and affected products
 */
async function reduceInventory(items, io) {
  const affectedProducts = [];
  const lowStockProducts = [];
  
  try {
    for (const item of items) {
      if (!item.product) {
        console.warn(`⚠️ Skipping inventory reduction - item "${item.productName || 'Unknown'}" has no product ID`);
        continue; // Skip if no product reference
      }
      
      const product = await Product.findById(item.product);
      
      if (!product) {
        console.warn(`⚠️ Product ${item.product} not found for inventory reduction`);
        continue;
      }
      
      // Only reduce if inventory tracking is enabled (not null)
      if (product.inventory !== null && product.inventory !== undefined) {
        const oldInventory = product.inventory;
        const newInventory = Math.max(0, product.inventory - item.quantity);
        console.log(`📉 Reducing inventory for "${product.name}": ${oldInventory} - ${item.quantity} = ${newInventory}`);
        
        product.inventory = newInventory;
        await product.save();
        
        affectedProducts.push({
          _id: product._id,
          name: product.name,
          oldInventory,
          newInventory: product.inventory,
          quantityReduced: item.quantity
        });
        
        // Check if product is now low stock
        if (product.inventory < 10) {
          lowStockProducts.push({
            _id: product._id,
            name: product.name,
            inventory: product.inventory,
            category: product.category
          });
        }
        
        // Emit real-time event for this product
        if (io) {
          io.emit('product:inventory-updated', { 
            product: {
              _id: product._id,
              name: product.name,
              inventory: product.inventory,
              category: product.category,
              price: product.price
            }
          });
        }
      } else {
        console.warn(`⚠️ Product "${product.name}" has inventory tracking disabled (inventory: ${product.inventory}) - skipping`);
      }
    }
    
    // Emit low stock alert if any products are low
    if (io && lowStockProducts.length > 0) {
      io.emit('inventory:low-stock-alert', { products: lowStockProducts });
    }
    
    return {
      success: true,
      affectedProducts,
      lowStockProducts
    };
  } catch (error) {
    console.error('Error reducing inventory:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Restore inventory for products when invoice is cancelled
 * NOTE: This is only used for CANCELLATION, not deletion
 * @param {Array} items - Invoice items with product and quantity
 * @param {Object} io - Socket.IO instance
 * @returns {Object} Result with success status and affected products
 */
async function restoreInventory(items, io) {
  const affectedProducts = [];
  
  try {
    console.log(`📦 Attempting to restore inventory for ${items.length} items`);
    
    for (const item of items) {
      // Handle both ObjectId and string product references
      const productId = item.product?._id || item.product || null;
      
      if (!productId) {
        console.warn(`⚠️ Skipping inventory restoration - item "${item.productName || 'Unknown'}" has no product ID`);
        continue; // Skip if no product reference
      }
      
      const product = await Product.findById(productId);
      
      if (!product) {
        console.warn(`⚠️ Product ${productId} not found for inventory restoration`);
        continue;
      }
      
      // Only restore if inventory tracking is enabled (not null)
      if (product.inventory !== null && product.inventory !== undefined) {
        const oldInventory = product.inventory;
        const newInventory = product.inventory + item.quantity;
        console.log(`📈 Restoring inventory for "${product.name}": ${oldInventory} + ${item.quantity} = ${newInventory}`);
        
        product.inventory = newInventory;
        await product.save();
        
        affectedProducts.push({
          _id: product._id,
          name: product.name,
          oldInventory,
          newInventory: product.inventory,
          quantityRestored: item.quantity
        });
        
        // Emit real-time event for this product
        if (io) {
          io.emit('product:inventory-updated', { 
            product: {
              _id: product._id,
              name: product.name,
              inventory: product.inventory,
              category: product.category,
              price: product.price
            }
          });
        }
      } else {
        console.warn(`⚠️ Product "${product.name}" has inventory tracking disabled (inventory: ${product.inventory}) - skipping`);
      }
    }
    
    if (affectedProducts.length > 0) {
      console.log(`✅ Inventory restored for ${affectedProducts.length} products:`);
      affectedProducts.forEach(p => {
        console.log(`   - ${p.name}: ${p.oldInventory} → ${p.newInventory} (restored ${p.quantityRestored})`);
      });
    } else {
      console.warn(`⚠️ No inventory was restored. Check if products have inventory tracking enabled.`);
    }
    
    return {
      success: true,
      affectedProducts
    };
  } catch (error) {
    console.error('❌ Error restoring inventory:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Adjust inventory when invoice items are updated
 * @param {Array} oldItems - Original invoice items
 * @param {Array} newItems - Updated invoice items
 * @param {Object} io - Socket.IO instance
 * @returns {Object} Result with success status and affected products
 */
async function adjustInventory(oldItems, newItems, io) {
  const affectedProducts = [];
  const lowStockProducts = [];
  
  try {
    // Create maps for easier comparison
    const oldItemsMap = new Map();
    const newItemsMap = new Map();
    
    oldItems.forEach(item => {
      if (item.product) {
        oldItemsMap.set(item.product.toString(), item.quantity);
      }
    });
    
    newItems.forEach(item => {
      if (item.product) {
        newItemsMap.set(item.product.toString(), item.quantity);
      }
    });
    
    // Get all unique product IDs
    const allProductIds = new Set([...oldItemsMap.keys(), ...newItemsMap.keys()]);
    
    for (const productId of allProductIds) {
      const oldQty = oldItemsMap.get(productId) || 0;
      const newQty = newItemsMap.get(productId) || 0;
      const difference = newQty - oldQty;
      
      if (difference === 0) continue; // No change
      
      const product = await Product.findById(productId);
      
      if (!product) {
        console.warn(`Product ${productId} not found for inventory adjustment`);
        continue;
      }
      
      // Only adjust if inventory tracking is enabled
      if (product.inventory !== null && product.inventory !== undefined) {
        const oldInventory = product.inventory;
        // If difference is positive, we need MORE items (reduce inventory)
        // If difference is negative, we need LESS items (increase inventory)
        product.inventory = Math.max(0, product.inventory - difference);
        await product.save();
        
        affectedProducts.push({
          _id: product._id,
          name: product.name,
          oldInventory,
          newInventory: product.inventory,
          adjustment: -difference
        });
        
        // Check if product is now low stock
        if (product.inventory < 10) {
          lowStockProducts.push({
            _id: product._id,
            name: product.name,
            inventory: product.inventory,
            category: product.category
          });
        }
        
        // Emit real-time event for this product
        if (io) {
          io.emit('product:inventory-updated', { 
            product: {
              _id: product._id,
              name: product.name,
              inventory: product.inventory,
              category: product.category,
              price: product.price
            }
          });
        }
      }
    }
    
    // Emit low stock alert if any products are low
    if (io && lowStockProducts.length > 0) {
      io.emit('inventory:low-stock-alert', { products: lowStockProducts });
    }
    
    return {
      success: true,
      affectedProducts,
      lowStockProducts
    };
  } catch (error) {
    console.error('Error adjusting inventory:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get low stock products (inventory < threshold)
 * @param {Number} threshold - Inventory threshold (default: 10)
 * @returns {Array} Low stock products
 */
async function getLowStockProducts(threshold = 10) {
  try {
    const products = await Product.find({
      isActive: true,
      inventory: { $ne: null, $lt: threshold, $gte: 0 }
    })
    .select('name inventory category unit price')
    .sort('inventory')
    .lean();
    
    return products;
  } catch (error) {
    console.error('Error getting low stock products:', error);
    return [];
  }
}

module.exports = {
  reduceInventory,
  restoreInventory,
  adjustInventory,
  getLowStockProducts
};

