const Product = require('../models/Product');

/**
 * ATOMIC Inventory Manager v2.0
 * 
 * Uses MongoDB atomic operations ($inc with $gte guard) to prevent race conditions
 * when 5-10 employees create orders simultaneously.
 * 
 * OLD approach (race condition):
 *   const product = await Product.findById(id);     // Employee A reads inventory=3
 *   product.inventory -= 2;                          // Employee B also reads inventory=3
 *   await product.save();                            // Both save inventory=1 → sold 4 items with only 3!
 * 
 * NEW approach (atomic, no race condition):
 *   Product.findOneAndUpdate(
 *     { _id: id, inventory: { $gte: 2 } },          // Guard: only if enough stock
 *     { $inc: { inventory: -2 } },                   // Atomic decrement
 *   );
 *   → MongoDB guarantees only one operation succeeds at a time
 */

const LOW_STOCK_THRESHOLD = 10;

/**
 * Rollback inventory reductions that were already applied
 * Used when a later item in the batch fails the inventory check
 * @param {Array} reducedItems - Items that were successfully reduced
 */
async function rollbackReductions(reducedItems) {
  if (!reducedItems || reducedItems.length === 0) return;
  
  console.log(`🔄 Rolling back inventory for ${reducedItems.length} items...`);
  
  for (const item of reducedItems) {
    try {
      await Product.findByIdAndUpdate(
        item._id,
        { $inc: { inventory: item.quantityReduced } }
      );
      console.log(`   ↩️ ${item.name}: +${item.quantityReduced} (restored to ~${item.oldInventory})`);
    } catch (err) {
      console.error(`   ❌ Failed to rollback "${item.name}":`, err.message);
    }
  }
}

/**
 * Reduce inventory using ATOMIC operations
 * Uses findOneAndUpdate with $inc and $gte guard — no race conditions even with 10 concurrent users
 * 
 * If any item has insufficient stock AND allowPartial=false, ALL reductions are rolled back.
 * This ensures order creation is all-or-nothing for inventory.
 * 
 * @param {Array} items - Order/invoice items with { product, productName, quantity }
 * @param {Object} io - Socket.IO instance for real-time updates
 * @param {Object} options - { allowPartial: false } — if true, skip insufficient items instead of failing
 * @returns {Object} { success, affectedProducts, lowStockProducts, error?, insufficientItem? }
 */
async function reduceInventory(items, io, options = {}) {
  const { allowPartial = false } = options;
  const affectedProducts = [];
  const lowStockProducts = [];
  
  try {
    for (const item of items) {
      if (!item.product) {
        console.warn(`⚠️ Skipping inventory — "${item.productName || 'Unknown'}" has no product ID`);
        continue;
      }
      
      // ═══════════════════════════════════════════════════════════════════
      // ATOMIC OPERATION: Single DB call that checks AND decrements
      // MongoDB guarantees this is atomic — no race condition possible
      // ═══════════════════════════════════════════════════════════════════
      const result = await Product.findOneAndUpdate(
        {
          _id: item.product,
          inventory: { $ne: null, $gte: item.quantity }  // tracking enabled AND enough stock
        },
        { $inc: { inventory: -item.quantity } },
        { new: true, lean: true }
      );
      
      if (!result) {
        // Atomic update didn't match — determine why
        const product = await Product.findById(item.product)
          .select('inventory name isActive')
          .lean();
        
        if (!product) {
          console.warn(`⚠️ Product ${item.product} not found — skipping`);
          continue;
        }
        
        // Inventory tracking disabled (null) — skip silently, this is normal
        if (product.inventory === null || product.inventory === undefined) {
          continue;
        }
        
        // ═══════════════════════════════════════════════════════════════
        // INSUFFICIENT STOCK — the critical failure case
        // ═══════════════════════════════════════════════════════════════
        if (!allowPartial) {
          // Strict mode: ROLLBACK everything and fail
          console.error(`❌ Insufficient stock: "${product.name}" has ${product.inventory}, need ${item.quantity}`);
          await rollbackReductions(affectedProducts);
          
          return {
            success: false,
            error: `Insufficient stock for "${product.name}". Available: ${product.inventory}, Requested: ${item.quantity}`,
            insufficientItem: {
              productId: product._id,
              productName: product.name,
              available: product.inventory,
              requested: item.quantity
            }
          };
        }
        
        // Partial mode: skip this item, continue with others
        console.warn(`⚠️ Skipping "${product.name}" — insufficient stock (${product.inventory} < ${item.quantity})`);
        continue;
      }
      
      // ═══════════════════════════════════════════════════════════════════
      // SUCCESS — inventory was atomically decremented
      // ═══════════════════════════════════════════════════════════════════
      const oldInventory = result.inventory + item.quantity; // calculate from new value
      
      affectedProducts.push({
        _id: result._id,
        name: result.name,
        oldInventory,
        newInventory: result.inventory,
        quantityReduced: item.quantity
      });
      
      // Low stock warning
      if (result.inventory < LOW_STOCK_THRESHOLD) {
        lowStockProducts.push({
          _id: result._id,
          name: result.name,
          inventory: result.inventory,
          category: result.category
        });
      }
      
      // Real-time inventory update to all connected apps
      if (io) {
        io.emit('product:inventory-updated', {
          product: {
            _id: result._id,
            name: result.name,
            inventory: result.inventory,
            category: result.category,
            price: result.price
          }
        });
      }
    }
    
    // Batch low stock alert
    if (io && lowStockProducts.length > 0) {
      io.emit('inventory:low-stock-alert', { products: lowStockProducts });
    }
    
    return {
      success: true,
      affectedProducts,
      lowStockProducts
    };
  } catch (error) {
    // Unexpected error — rollback what we've done so far
    console.error('❌ Unexpected error in reduceInventory:', error);
    if (affectedProducts.length > 0) {
      await rollbackReductions(affectedProducts);
    }
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Restore inventory using ATOMIC operations (for cancellation only)
 * Uses $inc to atomically add back inventory — safe for concurrent access
 * 
 * @param {Array} items - Items with { product, productName, quantity }
 * @param {Object} io - Socket.IO instance
 * @returns {Object} { success, affectedProducts }
 */
async function restoreInventory(items, io) {
  const affectedProducts = [];
  
  try {
    console.log(`📦 Restoring inventory for ${items.length} items (atomic)`);
    
    for (const item of items) {
      // Handle both ObjectId and populated product references
      const productId = item.product?._id || item.product || null;
      
      if (!productId) {
        console.warn(`⚠️ Skipping restoration — "${item.productName || 'Unknown'}" has no product ID`);
        continue;
      }
      
      // ATOMIC: Add back inventory (only if tracking is enabled)
      const result = await Product.findOneAndUpdate(
        {
          _id: productId,
          inventory: { $ne: null }  // only if tracking is enabled
        },
        { $inc: { inventory: item.quantity } },
        { new: true, lean: true }
      );
      
      if (!result) {
        const product = await Product.findById(productId).select('name inventory').lean();
        if (!product) {
          console.warn(`⚠️ Product ${productId} not found for restoration`);
        } else {
          // Inventory tracking disabled — not an error, just skip
        }
        continue;
      }
      
      affectedProducts.push({
        _id: result._id,
        name: result.name,
        oldInventory: result.inventory - item.quantity,
        newInventory: result.inventory,
        quantityRestored: item.quantity
      });
      
      if (io) {
        io.emit('product:inventory-updated', {
          product: {
            _id: result._id,
            name: result.name,
            inventory: result.inventory,
            category: result.category,
            price: result.price
          }
        });
      }
    }
    
    if (affectedProducts.length > 0) {
      console.log(`✅ Inventory restored for ${affectedProducts.length} products:`);
      affectedProducts.forEach(p => {
        console.log(`   ${p.name}: ${p.oldInventory} → ${p.newInventory} (+${p.quantityRestored})`);
      });
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
 * Adjust inventory using ATOMIC operations (for invoice/order item edits)
 * Calculates diff between old and new quantities, applies atomic increments/decrements
 * 
 * @param {Array} oldItems - Original items
 * @param {Array} newItems - Updated items
 * @param {Object} io - Socket.IO instance
 * @returns {Object} { success, affectedProducts, lowStockProducts }
 */
async function adjustInventory(oldItems, newItems, io) {
  const affectedProducts = [];
  const lowStockProducts = [];
  
  try {
    // Build quantity maps for comparison
    const oldMap = new Map();
    const newMap = new Map();
    
    oldItems.forEach(item => {
      if (item.product) oldMap.set(item.product.toString(), item.quantity);
    });
    
    newItems.forEach(item => {
      if (item.product) newMap.set(item.product.toString(), item.quantity);
    });
    
    const allProductIds = new Set([...oldMap.keys(), ...newMap.keys()]);
    
    for (const productId of allProductIds) {
      const oldQty = oldMap.get(productId) || 0;
      const newQty = newMap.get(productId) || 0;
      const difference = newQty - oldQty; // positive = need more, negative = need less
      
      if (difference === 0) continue;
      
      if (difference > 0) {
        // Need MORE items → reduce inventory (with guard)
        const result = await Product.findOneAndUpdate(
          {
            _id: productId,
            inventory: { $ne: null, $gte: difference }
          },
          { $inc: { inventory: -difference } },
          { new: true, lean: true }
        );
        
        if (!result) {
          const product = await Product.findById(productId).select('inventory name').lean();
          if (!product) continue;
          if (product.inventory === null || product.inventory === undefined) continue;
          
          // ROLLBACK all adjustments made so far before failing
          // Without this, previously adjusted products would have wrong inventory
          if (affectedProducts.length > 0) {
            console.log(`🔄 Rolling back ${affectedProducts.length} inventory adjustments due to insufficient stock...`);
            await rollbackAdjustments(affectedProducts);
          }
          
          return {
            success: false,
            error: `Insufficient stock for "${product.name}". Available: ${product.inventory}, Need additional: ${difference}`
          };
        }
        
        affectedProducts.push({
          _id: result._id,
          name: result.name,
          oldInventory: result.inventory + difference,
          newInventory: result.inventory,
          adjustment: -difference
        });
        
        if (result.inventory < LOW_STOCK_THRESHOLD) {
          lowStockProducts.push({ _id: result._id, name: result.name, inventory: result.inventory, category: result.category });
        }
        
        if (io) {
          io.emit('product:inventory-updated', {
            product: { _id: result._id, name: result.name, inventory: result.inventory, category: result.category, price: result.price }
          });
        }
      } else {
        // Need LESS items → restore inventory (always safe, no guard needed)
        const absDiff = Math.abs(difference);
        const result = await Product.findOneAndUpdate(
          { _id: productId, inventory: { $ne: null } },
          { $inc: { inventory: absDiff } },
          { new: true, lean: true }
        );
        
        if (result) {
          affectedProducts.push({
            _id: result._id,
            name: result.name,
            oldInventory: result.inventory - absDiff,
            newInventory: result.inventory,
            adjustment: absDiff
          });
          
          if (io) {
            io.emit('product:inventory-updated', {
              product: { _id: result._id, name: result.name, inventory: result.inventory, category: result.category, price: result.price }
            });
          }
        }
      }
    }
    
    if (io && lowStockProducts.length > 0) {
      io.emit('inventory:low-stock-alert', { products: lowStockProducts });
    }
    
    return {
      success: true,
      affectedProducts,
      lowStockProducts
    };
  } catch (error) {
    console.error('❌ Error adjusting inventory:', error);
    // Rollback all adjustments on unexpected error
    if (affectedProducts.length > 0) {
      console.log(`🔄 Rolling back ${affectedProducts.length} inventory adjustments due to error...`);
      await rollbackAdjustments(affectedProducts);
    }
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Rollback inventory adjustments (reverses both reductions and restorations)
 * adjustment < 0 means we reduced → add back (reverse = positive)
 * adjustment > 0 means we restored → take back (reverse = negative)
 * Formula: $inc: { inventory: -adjustment } handles both cases
 */
async function rollbackAdjustments(adjustedItems) {
  if (!adjustedItems || adjustedItems.length === 0) return;
  
  console.log(`🔄 Rolling back inventory adjustments for ${adjustedItems.length} products...`);
  
  for (const item of adjustedItems) {
    try {
      // Reverse the adjustment: -(-3)=+3 for reductions, -(+2)=-2 for restorations
      await Product.findByIdAndUpdate(
        item._id,
        { $inc: { inventory: -item.adjustment } }
      );
      console.log(`   ↩️ ${item.name}: reversed ${item.adjustment > 0 ? '+' : ''}${item.adjustment} → back to ~${item.oldInventory}`);
    } catch (err) {
      console.error(`   ❌ Failed to rollback adjustment for "${item.name}":`, err.message);
    }
  }
}

/**
 * Get low stock products (inventory < threshold)
 * Already optimized — uses indexed query with lean()
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
  rollbackReductions,
  rollbackAdjustments,
  getLowStockProducts
};
