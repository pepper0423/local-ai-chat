import { useEffect, useState } from 'react';
import * as api from '../api/client.js';

export default function ModelPicker({ provider, model, onChange, disabled }) {
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState([]);
  const [modelsError, setModelsError] = useState(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [freeText, setFreeText] = useState('');

  useEffect(() => {
    api.getProviders().then(setProviders).catch(() => {});
  }, []);

  useEffect(() => {
    if (!provider) return;
    setLoadingModels(true);
    setModelsError(null);
    api
      .getProviderModels(provider)
      .then((res) => setModels(res.models || []))
      .catch((err) => setModelsError(err.message))
      .finally(() => setLoadingModels(false));
  }, [provider]);

  // No model chosen yet (new chat, or just switched provider) — default to the
  // first one the live list returns. Never overrides a model already set.
  useEffect(() => {
    if (!model && models.length > 0) {
      onChange({ provider, model: models[0].id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <select
        disabled={disabled}
        className="rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 outline-none transition-colors hover:border-neutral-700 disabled:opacity-50"
        value={provider}
        onChange={(e) => onChange({ provider: e.target.value, model: '' })}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}{p.requiresKey && !p.hasKey ? ' (no key)' : ''}
          </option>
        ))}
      </select>

      <select
        disabled={disabled || loadingModels}
        className="min-w-[10rem] rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 outline-none transition-colors hover:border-neutral-700 disabled:opacity-50"
        value={models.some((m) => m.id === model) ? model : ''}
        onChange={(e) => onChange({ provider, model: e.target.value })}
      >
        <option value="" disabled>
          {loadingModels ? 'Loading models…' : modelsError ? 'Failed to load — use free text →' : 'Select a model'}
        </option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label || m.id}
          </option>
        ))}
      </select>

      {/* Live model lists can be stale/incomplete/unreachable — free-text always available. */}
      <input
        className="w-40 rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 outline-none transition-colors placeholder-neutral-600 hover:border-neutral-700 focus:border-neutral-600"
        placeholder="or type model id"
        value={freeText}
        disabled={disabled}
        onChange={(e) => setFreeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && freeText.trim()) {
            onChange({ provider, model: freeText.trim() });
            setFreeText('');
          }
        }}
      />
      {model && <span className="rounded-full bg-neutral-900 px-2.5 py-1 text-[11px] text-neutral-500">current: {model}</span>}
    </div>
  );
}
