const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const SECRET = process.env.STORAGE_SECRET || 'instagram-phase2-local-storage-secret';
const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

// Ensure the local object storage directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Generate a pre-signed upload URL and secure HMAC token for local object storage.
 * Simulates AWS S3 putObject presigned URL locally.
 */
function createPresignedUpload({ filename, fileType, userId }) {
  const ext = path.extname(filename || '') || (fileType?.startsWith('video/') ? '.mp4' : '.jpg');
  const uniqueKey = `post-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const mediaType = fileType?.startsWith('video/') ? 'VIDEO' : 'PHOTO';
  const expiresAt = Date.now() + TOKEN_EXPIRY_MS;

  const payload = JSON.stringify({
    key: uniqueKey,
    mediaType,
    userId: userId ? userId.toString() : null,
    expiresAt,
  });

  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(base64Payload)
    .digest('base64url');

  const token = `${base64Payload}.${signature}`;

  return {
    upload_url: `/api/v1/posts/upload/${token}`,
    media_url: `/uploads/${uniqueKey}`,
    media_type: mediaType,
    key: uniqueKey,
    token,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

/**
 * Verify HMAC signature and expiration on the pre-signed token.
 */
function verifyUploadToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [base64Payload, signature] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', SECRET)
    .update(base64Payload)
    .digest('base64url');

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(base64Payload, 'base64url').toString('utf8'));
    if (Date.now() > payload.expiresAt) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Stream binary upload directly from the incoming HTTP request stream to disk.
 * Bypasses multipart parsing and in-memory buffering to avoid choking the event loop.
 */
function streamUploadToDisk(req, token) {
  return new Promise((resolve, reject) => {
    const tokenData = verifyUploadToken(token);
    if (!tokenData) {
      const err = new Error('Invalid or expired upload token');
      err.status = 403;
      return reject(err);
    }

    const targetPath = path.join(UPLOAD_DIR, tokenData.key);
    const writeStream = fs.createWriteStream(targetPath);

    let bytesWritten = 0;
    const maxSizeBytes = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 15) * 1024 * 1024;

    req.on('data', (chunk) => {
      bytesWritten += chunk.length;
      if (bytesWritten > maxSizeBytes) {
        req.pause();
        writeStream.destroy();
        fs.unlink(targetPath, () => {});
        const err = new Error(`File size exceeds maximum allowed limit of ${maxSizeBytes / (1024 * 1024)}MB`);
        err.status = 413;
        reject(err);
      }
    });

    req.pipe(writeStream);

    writeStream.on('finish', () => {
      resolve({
        key: tokenData.key,
        media_url: `/uploads/${tokenData.key}`,
        media_type: tokenData.mediaType,
        size_bytes: bytesWritten,
      });
    });

    writeStream.on('error', (err) => {
      fs.unlink(targetPath, () => {});
      reject(err);
    });

    req.on('error', (err) => {
      writeStream.destroy();
      fs.unlink(targetPath, () => {});
      reject(err);
    });
  });
}

/**
 * Verify whether an uploaded file exists in the local object storage directory.
 */
function fileExists(mediaUrl) {
  if (!mediaUrl) return false;
  const filename = path.basename(mediaUrl);
  const fullPath = path.join(UPLOAD_DIR, filename);
  return fs.existsSync(fullPath);
}

module.exports = {
  createPresignedUpload,
  verifyUploadToken,
  streamUploadToDisk,
  fileExists,
  UPLOAD_DIR,
};
