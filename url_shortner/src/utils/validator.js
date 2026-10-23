/**
 * Reserved keywords and application routes that cannot be used as custom aliases.
 * This prevents short codes from colliding with system routing (Section 6.3).
 */
const RESERVED_WORDS = new Set([
  'health',
  'shorten',
  'analytics',
  'api',
  'admin',
  'login',
  'logout',
  'dashboard',
  'help',
  'contact',
  'terms',
  'privacy',
  'favicon.ico',
  'robots.txt',
  'static',
  'public',
]);

/**
 * Validates whether a string is a valid HTTP/HTTPS URL.
 * Rejects javascript:, file:, data:, or malformed protocols.
 * @param {string} urlString
 * @returns {boolean}
 */
function isValidUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(urlString);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

/**
 * Validates a custom alias against length limits, URL-safe characters, and reserved word blocklist.
 * @param {string} alias
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCustomAlias(alias) {
  if (!alias || typeof alias !== 'string') {
    return { valid: false, error: 'Custom alias must be a valid non-empty string.' };
  }

  const trimmed = alias.trim();

  // Length check: 3 to 50 characters
  if (trimmed.length < 3 || trimmed.length > 50) {
    return {
      valid: false,
      error: 'Custom alias must be between 3 and 50 characters in length.',
    };
  }

  // Character set check: alphanumeric, hyphen, underscore
  const ALIAS_REGEX = /^[a-zA-Z0-9_-]+$/;
  if (!ALIAS_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: 'Custom alias must contain only letters, numbers, hyphens (-), and underscores (_).',
    };
  }

  // Reserved keyword blocklist check (case-insensitive)
  if (RESERVED_WORDS.has(trimmed.toLowerCase())) {
    return {
      valid: false,
      error: `The custom alias '${trimmed}' is a reserved keyword and cannot be used.`,
    };
  }

  return { valid: true };
}

module.exports = {
  isValidUrl,
  validateCustomAlias,
  RESERVED_WORDS,
};