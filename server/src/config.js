import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// LOCAL_AI_CHAT_DATA_DIR lets test runs point at a scratch directory instead of the live
// server/data/ — never touch the real one while testing (see README / CLAUDE notes).
const DATA_DIR = process.env.LOCAL_AI_CHAT_DATA_DIR
  ? path.resolve(process.env.LOCAL_AI_CHAT_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const KEYED_PROVIDERS = ['anthropic', 'openai', 'gemini', 'custom'];
const DEFAULT_CUSTOM_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_MAX_FILE_BYTES = 1048576; // 1 MiB

const USE_ENV = process.env.LOCAL_AI_CHAT_KEYS_FROM_ENV === '1';

function emptyConfig() {
  return {
    anthropic: { apiKey: '' },
    openai: { apiKey: '' },
    gemini: { apiKey: '' },
    custom: { apiKey: '', baseUrl: DEFAULT_CUSTOM_BASE_URL, modelsPath: '/models', supportsImages: false, supportsTools: false },
    // Sandboxed AI file-write workspace — see server/src/tools/sandbox.js. root='' means
    // "not configured yet"; enabled must be explicitly turned on even once root is set.
    workspace: { root: '', enabled: false, maxFileBytes: DEFAULT_MAX_FILE_BYTES },
  };
}

function load() {
  if (USE_ENV) {
    return {
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY || '' },
      openai: { apiKey: process.env.OPENAI_API_KEY || '' },
      gemini: { apiKey: process.env.GEMINI_API_KEY || '' },
      custom: {
        apiKey: process.env.CUSTOM_API_KEY || '',
        baseUrl: process.env.CUSTOM_BASE_URL || DEFAULT_CUSTOM_BASE_URL,
        modelsPath: '/models',
        supportsImages: false,
        supportsTools: false,
      },
      workspace: {
        root: process.env.LOCAL_AI_CHAT_WORKSPACE_ROOT || '',
        enabled: process.env.LOCAL_AI_CHAT_WORKSPACE_ENABLED === '1',
        maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      },
    };
  }
  if (!fs.existsSync(CONFIG_PATH)) return emptyConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...emptyConfig(), ...raw };
  } catch (err) {
    console.warn('[config] failed to parse config.json, using empty config:', err.message);
    return emptyConfig();
  }
}

function save(cfg) {
  if (USE_ENV) {
    throw new Error('cannot write config while LOCAL_AI_CHAT_KEYS_FROM_ENV=1');
  }
  // Atomic write: write to temp file then rename, so a crash mid-write can't corrupt config.json.
  const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}

function maskKey(apiKey) {
  if (!apiKey) return { set: false, last4: null };
  const last4 = apiKey.length >= 4 ? apiKey.slice(-4) : apiKey;
  return { set: true, last4 };
}

/** Workspace root/baseUrl are not secrets — returned plainly, unlike API keys. `exists`/
 * `writable` are re-checked live on every call (cheap fs.accessSync) so the Settings UI
 * always reflects the folder's current real-world state, not just what was true at
 * setWorkspace() time (the folder could be deleted/renamed/permissions-changed since). */
function workspaceStatus(ws) {
  let exists = false;
  let writable = false;
  if (ws.root) {
    try {
      exists = fs.statSync(ws.root).isDirectory();
      if (exists) {
        fs.accessSync(ws.root, fs.constants.W_OK);
        writable = true;
      }
    } catch {
      // exists/writable stay false — folder missing, not a directory, or not writable
    }
  }
  return { root: ws.root, enabled: ws.enabled, maxFileBytes: ws.maxFileBytes, exists, writable };
}

function getMaskedConfig() {
  const cfg = load();
  const workspace = cfg.workspace || emptyConfig().workspace;
  return {
    anthropic: maskKey(cfg.anthropic.apiKey),
    openai: maskKey(cfg.openai.apiKey),
    gemini: maskKey(cfg.gemini.apiKey),
    custom: {
      ...maskKey(cfg.custom.apiKey),
      baseUrl: cfg.custom.baseUrl || DEFAULT_CUSTOM_BASE_URL,
      modelsPath: cfg.custom.modelsPath || '/models',
      supportsImages: Boolean(cfg.custom.supportsImages),
      supportsTools: Boolean(cfg.custom.supportsTools),
    },
    workspace: workspaceStatus(workspace),
  };
}

/** Raw (unmasked, but nothing secret in it) workspace config — server-side use, read by
 * server/src/tools/sandbox.js on every resolveInWorkspace() call. */
function getWorkspaceConfig() {
  const cfg = load();
  return cfg.workspace || emptyConfig().workspace;
}

function setKey(provider, apiKey) {
  if (!KEYED_PROVIDERS.includes(provider)) {
    throw new Error(`unknown provider: ${provider}`);
  }
  const cfg = load();
  cfg[provider] = { ...cfg[provider], apiKey };
  save(cfg);
}

function clearKey(provider) {
  setKey(provider, '');
}

function setCustom({ baseUrl, apiKey, modelsPath, supportsImages, supportsTools }) {
  const cfg = load();
  const next = { ...cfg.custom };
  if (baseUrl !== undefined) {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error('invalid baseUrl');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('baseUrl must be http or https');
    }
    next.baseUrl = baseUrl;
  }
  if (apiKey !== undefined) next.apiKey = apiKey;
  if (modelsPath !== undefined) next.modelsPath = modelsPath;
  if (supportsImages !== undefined) next.supportsImages = Boolean(supportsImages);
  // Off by default, must be deliberately enabled — a misconfigured/hostile custom baseUrl
  // is an arbitrary third party proposing writes (see routes/chat.js + Security notes).
  if (supportsTools !== undefined) next.supportsTools = Boolean(supportsTools);
  cfg.custom = next;
  save(cfg);
}

/**
 * Set/update the sandboxed AI file-write workspace. Validates at set time: root must be
 * a non-empty absolute path, must exist (unless `create` is passed), must be a directory,
 * and must be writable. Never silently creates the folder unless the caller explicitly
 * opts in via `{create:true}` (routes/config.js exposes this as ?create=1) — the plan's
 * "do not surprise-mkdir" rule.
 */
function setWorkspace({ root, enabled, maxFileBytes }, { create = false } = {}) {
  const cfg = load();
  const next = { ...(cfg.workspace || emptyConfig().workspace) };

  if (root !== undefined) {
    if (typeof root !== 'string' || !root.trim()) {
      throw new Error('workspace root must be a non-empty path');
    }
    if (!path.isAbsolute(root)) {
      throw new Error('workspace root must be an absolute path');
    }
    if (!fs.existsSync(root)) {
      if (create) {
        fs.mkdirSync(root, { recursive: true });
      } else {
        const err = new Error('workspace folder does not exist');
        err.code = 'workspace_missing';
        err.root = root;
        throw err;
      }
    }
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) {
      throw new Error('workspace root is not a directory');
    }
    try {
      fs.accessSync(root, fs.constants.W_OK);
    } catch {
      throw new Error('workspace root is not writable');
    }
    // realpathSync resolves any symlinks in the root itself and throws if it somehow
    // can't be resolved — sandbox.js's containment checks are always done against this
    // resolved form, never the raw user-typed path.
    next.root = fs.realpathSync(root);
  }
  if (enabled !== undefined) next.enabled = Boolean(enabled);
  if (maxFileBytes !== undefined) {
    const n = Number(maxFileBytes);
    if (!Number.isFinite(n) || n <= 0) throw new Error('maxFileBytes must be a positive number');
    next.maxFileBytes = n;
  }

  cfg.workspace = next;
  save(cfg);
  return next;
}

/** Resolve the raw (unmasked) key + baseUrl for a provider — server-side use only, never returned to the client. */
function resolveProvider(provider) {
  const cfg = load();
  if (!KEYED_PROVIDERS.includes(provider)) return null;
  return cfg[provider];
}

export {
  getMaskedConfig,
  setKey,
  clearKey,
  setCustom,
  setWorkspace,
  getWorkspaceConfig,
  resolveProvider,
  KEYED_PROVIDERS,
  DEFAULT_CUSTOM_BASE_URL,
};
