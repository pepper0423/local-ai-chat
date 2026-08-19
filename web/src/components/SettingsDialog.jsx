import { useEffect, useState } from 'react';
import * as api from '../api/client.js';

const PROVIDER_LABELS = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Gemini' };

/** Cheap prefix sniff — not authoritative, just pre-selects the dropdown so the
 * user usually doesn't have to touch it. They can always override before saving. */
function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('AIza')) return 'gemini';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}

export default function SettingsDialog({ onClose, initialTab = 'keys' }) {
  const [tab, setTab] = useState(initialTab);
  const [config, setConfig] = useState(null);

  const [provider, setProvider] = useState('anthropic');
  const [keyValue, setKeyValue] = useState('');
  const [autoDetected, setAutoDetected] = useState(null);

  const [customKeyValue, setCustomKeyValue] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customSupportsImages, setCustomSupportsImages] = useState(false);
  const [customSupportsTools, setCustomSupportsTools] = useState(false);

  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [workspaceMaxFileBytes, setWorkspaceMaxFileBytes] = useState(1048576);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function refreshConfig() {
    const cfg = await api.getConfig();
    setConfig(cfg);
    setCustomBaseUrl(cfg.custom.baseUrl);
    setCustomSupportsImages(Boolean(cfg.custom.supportsImages));
    setCustomSupportsTools(Boolean(cfg.custom.supportsTools));
    setWorkspaceRoot(cfg.workspace.root);
    setWorkspaceMaxFileBytes(cfg.workspace.maxFileBytes);
  }

  useEffect(() => {
    refreshConfig().catch((err) => setError(err.message));
  }, []);

  function handleKeyChange(v) {
    setKeyValue(v);
    const detected = detectProvider(v);
    setAutoDetected(detected);
    if (detected) setProvider(detected);
  }

  async function saveKey() {
    if (!keyValue) return;
    setSaving(true);
    setError(null);
    try {
      await api.setConfigKey(provider, keyValue);
      setKeyValue('');
      setAutoDetected(null);
      await refreshConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function clearKey(p) {
    setSaving(true);
    setError(null);
    try {
      await api.clearConfigKey(p);
      await refreshConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveCustomKey() {
    if (!customKeyValue) return;
    setSaving(true);
    setError(null);
    try {
      await api.setConfigKey('custom', customKeyValue);
      setCustomKeyValue('');
      await refreshConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveCustomBaseUrl() {
    setSaving(true);
    setError(null);
    try {
      await api.setCustomConfig({ baseUrl: customBaseUrl });
      await refreshConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveWorkspaceRoot({ create = false } = {}) {
    setSaving(true);
    setError(null);
    try {
      await api.setWorkspaceConfig({ root: workspaceRoot }, { create });
      await refreshConfig();
    } catch (err) {
      if (err.body?.error === 'workspace_missing' && !create) {
        setError(`Folder does not exist: ${err.body.root}. Use "Create this folder" below if you want it created.`);
      } else {
        setError(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleWorkspaceEnabled(checked) {
    setSaving(true);
    setError(null);
    try {
      await api.setWorkspaceConfig({ enabled: checked });
      await refreshConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveMaxFileBytes() {
    setSaving(true);
    setError(null);
    try {
      await api.setWorkspaceConfig({ maxFileBytes: Number(workspaceMaxFileBytes) });
      await refreshConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[36rem] flex-col rounded-xl bg-neutral-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">Settings</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-100">✕</button>
        </div>

        <div className="flex gap-1 border-b border-neutral-800 px-4 pt-2">
          {['keys', 'custom', 'workspace'].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-t px-3 py-1.5 text-sm capitalize ${
                tab === t ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {t === 'custom' ? 'Custom endpoint' : t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {error && <div className="mb-3 rounded bg-red-950/50 px-3 py-2 text-sm text-red-300">{error}</div>}

          {tab === 'keys' && config && (
            <div className="space-y-4">
              <div>
                <div className="mb-1 text-sm font-medium text-neutral-200">Provider</div>
                <select
                  className="w-full rounded bg-neutral-800 px-2 py-1.5 text-sm text-neutral-100"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                >
                  {Object.entries(PROVIDER_LABELS).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}{config[id].set ? ` — set (…${config[id].last4})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="mb-1 text-sm font-medium text-neutral-200">API key</div>
                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder={config[provider].set ? `set — ...${config[provider].last4}` : 'Paste API key'}
                    className="flex-1 rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100 placeholder-neutral-500"
                    value={keyValue}
                    onChange={(e) => handleKeyChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && keyValue) saveKey(); }}
                  />
                  <button
                    disabled={saving || !keyValue}
                    onClick={saveKey}
                    className="rounded bg-blue-700 px-3 py-1 text-sm text-white hover:bg-blue-600 disabled:opacity-40"
                  >
                    Set
                  </button>
                  {config[provider].set && (
                    <button
                      disabled={saving}
                      onClick={() => clearKey(provider)}
                      className="rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-300 hover:bg-neutral-700"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {autoDetected && (
                  <p className="mt-1 text-xs text-emerald-500">
                    Detected as {PROVIDER_LABELS[autoDetected]} — change the provider above if that's wrong.
                  </p>
                )}
                <p className="mt-2 text-xs text-neutral-500">
                  Paste any key — the provider is guessed from its prefix and the dropdown updates automatically. Pick manually first if you'd rather not rely on that.
                </p>
              </div>
            </div>
          )}

          {tab === 'custom' && config && (
            <div className="space-y-4">
              <div>
                <div className="mb-1 text-sm font-medium text-neutral-200">Base URL</div>
                <div className="flex gap-2">
                  <input
                    className="flex-1 rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveCustomBaseUrl(); }}
                  />
                  <button
                    disabled={saving}
                    onClick={saveCustomBaseUrl}
                    className="rounded bg-blue-700 px-3 py-1 text-sm text-white hover:bg-blue-600 disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
                <p className="mt-1 text-xs text-neutral-500">e.g. http://localhost:11434/v1 for Ollama. Must be http/https and loopback-reachable.</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="custom-supports-images"
                  type="checkbox"
                  checked={customSupportsImages}
                  disabled={saving}
                  onChange={async (e) => {
                    const checked = e.target.checked;
                    setCustomSupportsImages(checked);
                    setSaving(true);
                    setError(null);
                    try {
                      await api.setCustomConfig({ supportsImages: checked });
                      await refreshConfig();
                    } catch (err) {
                      setError(err.message);
                    } finally {
                      setSaving(false);
                    }
                  }}
                />
                <label htmlFor="custom-supports-images" className="text-sm text-neutral-300">
                  This endpoint supports image inputs
                </label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="custom-supports-tools"
                  type="checkbox"
                  checked={customSupportsTools}
                  disabled={saving}
                  onChange={async (e) => {
                    const checked = e.target.checked;
                    setCustomSupportsTools(checked);
                    setSaving(true);
                    setError(null);
                    try {
                      await api.setCustomConfig({ supportsTools: checked });
                      await refreshConfig();
                    } catch (err) {
                      setError(err.message);
                    } finally {
                      setSaving(false);
                    }
                  }}
                />
                <label htmlFor="custom-supports-tools" className="text-sm text-neutral-300">
                  This endpoint supports tool calling (write_file)
                </label>
              </div>
              <p className="text-xs text-neutral-500">
                Off by default — a misconfigured or hostile custom endpoint is effectively an arbitrary
                third party proposing writes to your workspace. Only enable this for an endpoint you trust.
              </p>
              <div>
                <div className="mb-1 text-sm font-medium text-neutral-200">API key (optional)</div>
                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder={config.custom.set ? `sk-...${config.custom.last4}` : 'Leave blank if not required'}
                    className="flex-1 rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100 placeholder-neutral-500"
                    value={customKeyValue}
                    onChange={(e) => setCustomKeyValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && customKeyValue) saveCustomKey(); }}
                  />
                  <button
                    disabled={saving || !customKeyValue}
                    onClick={saveCustomKey}
                    className="rounded bg-blue-700 px-3 py-1 text-sm text-white hover:bg-blue-600 disabled:opacity-40"
                  >
                    Set
                  </button>
                  {config.custom.set && (
                    <button
                      disabled={saving}
                      onClick={() => clearKey('custom')}
                      className="rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-300 hover:bg-neutral-700"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === 'workspace' && config && (
            <div className="space-y-4">
              <p className="text-xs text-neutral-500">
                The AI can propose writing a text file only inside this one folder, and every single
                write requires your explicit approval before it happens (propose → approve/reject →
                only then write). Nothing is ever written without you clicking Approve.
              </p>
              <div>
                <div className="mb-1 text-sm font-medium text-neutral-200">Workspace folder</div>
                <div className="flex gap-2">
                  <input
                    className="flex-1 rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                    placeholder="D:\workspace"
                    value={workspaceRoot}
                    onChange={(e) => setWorkspaceRoot(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && workspaceRoot) saveWorkspaceRoot(); }}
                  />
                  <button
                    disabled={saving || !workspaceRoot}
                    onClick={() => saveWorkspaceRoot()}
                    className="rounded bg-blue-700 px-3 py-1 text-sm text-white hover:bg-blue-600 disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
                <p className="mt-1 text-xs text-neutral-500">Must be an absolute path to an existing, writable folder.</p>
                {config.workspace.root && !config.workspace.exists && (
                  <div className="mt-2 flex items-center gap-2 rounded bg-red-950/50 px-3 py-2 text-xs text-red-300">
                    <span>Folder does not exist.</span>
                    <button
                      disabled={saving}
                      onClick={() => saveWorkspaceRoot({ create: true })}
                      className="rounded bg-red-800 px-2 py-0.5 text-red-100 hover:bg-red-700"
                    >
                      Create this folder
                    </button>
                  </div>
                )}
                {config.workspace.root && config.workspace.exists && !config.workspace.writable && (
                  <div className="mt-2 rounded bg-red-950/50 px-3 py-2 text-xs text-red-300">
                    Folder exists but isn't writable — check permissions.
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  id="workspace-enabled"
                  type="checkbox"
                  checked={Boolean(config.workspace.enabled)}
                  disabled={saving || !config.workspace.root}
                  onChange={(e) => toggleWorkspaceEnabled(e.target.checked)}
                />
                <label htmlFor="workspace-enabled" className="text-sm text-neutral-300">
                  Enable AI file writing
                </label>
              </div>

              <div>
                <div className="mb-1 text-sm font-medium text-neutral-200">Max file size (bytes)</div>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="1"
                    className="w-40 rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                    value={workspaceMaxFileBytes}
                    onChange={(e) => setWorkspaceMaxFileBytes(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveMaxFileBytes(); }}
                  />
                  <button
                    disabled={saving}
                    onClick={saveMaxFileBytes}
                    className="rounded bg-blue-700 px-3 py-1 text-sm text-white hover:bg-blue-600 disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
                <p className="mt-1 text-xs text-neutral-500">Default 1,048,576 (1 MiB). Approve rejects any content larger than this.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
