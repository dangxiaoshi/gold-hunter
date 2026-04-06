const fs = require('fs');
const { DB_PATH } = require('../constants');

let dbCache = null;
let enrichedCache = null;

function loadDB() {
  if (dbCache) return dbCache;
  if (!fs.existsSync(DB_PATH)) {
    dbCache = { customers: {} };
    return dbCache;
  }
  try {
    dbCache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return dbCache;
  } catch {
    dbCache = { customers: {} };
    return dbCache;
  }
}

function saveDB(db) {
  dbCache = db;
  enrichedCache = null;
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getEnrichedCache() {
  return enrichedCache;
}

function setEnrichedCache(value) {
  enrichedCache = value;
}

function clearEnrichedCache() {
  enrichedCache = null;
}

module.exports = {
  loadDB,
  saveDB,
  getEnrichedCache,
  setEnrichedCache,
  clearEnrichedCache,
};
