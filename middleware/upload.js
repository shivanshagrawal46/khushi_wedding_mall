const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads', 'products');
(async () => {
  try {
    await fs.mkdir(uploadsDir, { recursive: true });
  } catch (error) {
    console.error('Error creating uploads directory:', error);
  }
})();

// Configure multer storage
const storage = multer.memoryStorage(); // Store in memory for processing

// File filter - only allow images
const fileFilter = (req, file, cb) => {
  // Check if file is an image
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'), false);
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max before compression (will be compressed to 50KB)
  }
});

// Middleware to compress and save image
const compressAndSaveImage = async (req, res, next) => {
  if (!req.file) {
    return next(); // No file uploaded, continue
  }

  try {
    const file = req.file;
    
    // Generate unique filename
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const filename = `product_${timestamp}_${randomString}${ext}`;
    const filepath = path.join(uploadsDir, filename);

    // Compress image to max 50KB
    // Try different sizes and quality levels to get under 50KB
    const maxSizeKB = 50;
    const maxSizeBytes = maxSizeKB * 1024;
    let compressedBuffer;
    let finalSize = Infinity;
    
    // Try different combinations of size and quality
    const compressionAttempts = [
      { size: 800, quality: 85 },
      { size: 800, quality: 75 },
      { size: 800, quality: 65 },
      { size: 600, quality: 60 },
      { size: 500, quality: 55 },
      { size: 400, quality: 50 }
    ];

    for (const attempt of compressionAttempts) {
      compressedBuffer = await sharp(file.buffer)
        .resize(attempt.size, attempt.size, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: attempt.quality, mozjpeg: true })
        .toBuffer();

      finalSize = compressedBuffer.length;
      
      // If under 50KB, we're good
      if (finalSize <= maxSizeBytes) {
        break;
      }
    }

    // Final check - if still over 50KB, reject
    if (finalSize > maxSizeBytes) {
      return res.status(400).json({
        success: false,
        error: `Image could not be compressed to under ${maxSizeKB}KB. Please use a smaller or simpler image.`
      });
    }

    // Save compressed image
    await fs.writeFile(filepath, compressedBuffer);

    // Store file info in request
    req.imagePath = `/uploads/products/${filename}`;
    req.imageSize = finalSize;

    next();
  } catch (error) {
    console.error('Image compression error:', error);
    return res.status(500).json({
      success: false,
      error: 'Error processing image: ' + error.message
    });
  }
};

// Middleware to delete old image when updating
const deleteOldImage = async (imagePath) => {
  if (!imagePath) return;
  
  try {
    const fullPath = path.join(__dirname, '..', imagePath);
    await fs.unlink(fullPath);
  } catch (error) {
    // File might not exist (ENOENT), ignore silently - this is normal
    // Only log if it's a different error (permissions, etc.)
    if (error.code !== 'ENOENT') {
      console.warn('⚠️  Could not delete old image:', error.message);
    }
    // Silently ignore ENOENT (file not found) errors - this is expected behavior
  }
};

module.exports = {
  upload: upload.single('image'),
  compressAndSaveImage,
  deleteOldImage
};

