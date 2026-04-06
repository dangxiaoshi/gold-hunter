const fs = require('fs');
const { CONFIG_PATH } = require('../constants');

function readConfigFile() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function modelEnvPrefix(id) {
  return `GH2_MODEL_${String(id || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()}`;
}

function applyEnvOverrides(cfg) {
  const next = JSON.parse(JSON.stringify(cfg || {}));
  if (process.env.GH2_PASSWORD) next.password = process.env.GH2_PASSWORD;
  if (process.env.GH2_ACTIVE_MODEL) next.activeModel = process.env.GH2_ACTIVE_MODEL;

  next.models = (next.models || []).map(model => {
    const prefix = modelEnvPrefix(model.id);
    return {
      ...model,
      apiKey: process.env[`${prefix}_API_KEY`] || model.apiKey,
      baseUrl: process.env[`${prefix}_BASE_URL`] || model.baseUrl
    };
  });

  return next;
}

function loadConfig() {
  return applyEnvOverrides(readConfigFile());
}

function loadEditableConfig() {
  return readConfigFile();
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

module.exports = {
  readConfigFile,
  loadConfig,
  loadEditableConfig,
  saveConfig,
};
