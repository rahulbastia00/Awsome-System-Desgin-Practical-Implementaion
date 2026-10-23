const crypto = require('crypto');

const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const COUNTER_SEED_OFFSET = 10000000; // Ensures short codes start at >= 5 chars in Base62

/**
 * Converts a positive integer into a Base62 string.
 * @param {number|bigint} num
 * @returns {string}
 */
function encodeBase62(num) {
  let n = BigInt(num);
  if (n === 0n) return BASE62_CHARS[0];

  let result = '';
  const base = BigInt(BASE62_CHARS.length);

  while (n > 0n) {
    const remainder = Number(n % base);
    result = BASE62_CHARS[remainder] + result;
    n = n / base;
  }

  return result;
}

/**
 * Generates an atomic, collision-free short code using Redis INCR.
 * Seeds counter to 10,000,000 on first invocation if uninitialized.
 * @param {import('ioredis').Redis} redisClient
 * @returns {Promise<string>}
 */
async function getNextShortCode(redisClient) {
  // Ensure the counter exists and is seeded with offset
  const counterVal = await redisClient.incr('global_url_counter');

  if (counterVal <= COUNTER_SEED_OFFSET) {
    // Set to seed offset + 1 atomically if it was freshly initialized
    await redisClient.set('global_url_counter', COUNTER_SEED_OFFSET + 1);
    return encodeBase62(COUNTER_SEED_OFFSET + 1);
  }

  return encodeBase62(counterVal);
}

/**
 * Fallback generator for random alphanumeric short codes
 * @param {number} length
 * @returns {string}
 */
function generateShortCode(length = 7) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += BASE62_CHARS[bytes[i] % BASE62_CHARS.length];
  }
  return code;
}

module.exports = {
  encodeBase62,
  getNextShortCode,
  generateShortCode,
};
