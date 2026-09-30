const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', '.cache');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function getCacheFilePath(namespace, key) {
  const nsDir = path.join(CACHE_DIR, namespace);
  if (!fs.existsSync(nsDir)) {
    fs.mkdirSync(nsDir, { recursive: true });
  }
  return path.join(nsDir, `${hashKey(key)}.json`);
}

/**
 * Disk-based Cache with TTL support
 */
class DiskCache {
  /**
   * Get cached item
   * @param {string} namespace 
   * @param {string} key 
   * @returns {any|null}
   */
  static get(namespace, key) {
    try {
      const filePath = getCacheFilePath(namespace, key);
      if (!fs.existsSync(filePath)) return null;

      const raw = fs.readFileSync(filePath, 'utf8');
      const item = JSON.parse(raw);

      if (item.expiresAt && Date.now() > item.expiresAt) {
        fs.unlinkSync(filePath);
        return null;
      }

      return item.data;
    } catch (err) {
      return null;
    }
  }

  /**
   * Save item to cache
   * @param {string} namespace 
   * @param {string} key 
   * @param {any} data 
   * @param {number} ttlMs Default 7 days
   */
  static set(namespace, key, data, ttlMs = 7 * 24 * 60 * 60 * 1000) {
    try {
      const filePath = getCacheFilePath(namespace, key);
      const item = {
        key,
        savedAt: Date.now(),
        expiresAt: ttlMs ? Date.now() + ttlMs : null,
        data
      };
      fs.writeFileSync(filePath, JSON.stringify(item), 'utf8');
    } catch (err) {
      console.warn(`[Cache] Failed to write cache for ${namespace}:${key}`, err.message);
    }
  }

  /**
   * Check if key exists and is valid
   */
  static has(namespace, key) {
    return DiskCache.get(namespace, key) !== null;
  }
}

module.exports = DiskCache;
