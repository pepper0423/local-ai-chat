import anthropic from './anthropic.js';
import openai from './openai.js';
import gemini from './gemini.js';
import openaiCompatible from './openaiCompatible.js';

/** Static provider metadata — labels/urls only, NEVER hardcoded model IDs.
 * Model lists always come live from each provider's /models endpoint (see routes/models.js). */
const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', requiresKey: true, configurableBaseUrl: false, capabilities: { images: true, tools: true } },
  { id: 'openai', label: 'OpenAI', requiresKey: true, configurableBaseUrl: false, capabilities: { images: true, tools: true } },
  { id: 'gemini', label: 'Gemini', requiresKey: true, configurableBaseUrl: false, capabilities: { images: true, tools: true } },
  // custom's capabilities.images is config-overridable (custom.supportsImages) — both
  // default off, see routes/models.js for the merge and chat.js for the server-side backstop.
  { id: 'custom', label: 'Custom (OpenAI-compatible)', requiresKey: false, configurableBaseUrl: true, capabilities: { images: false, tools: false } },
];

const ADAPTERS = {
  anthropic,
  openai,
  gemini,
  custom: openaiCompatible,
};

function getAdapter(id) {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`unknown provider: ${id}`);
  return adapter;
}

/** Effective capabilities for a provider, folding in custom's config-driven overrides.
 * `cfg` is the raw (unmasked) provider config from resolveProvider() — only custom's
 * supportsImages/supportsTools flags are read here; everything else is the static
 * PROVIDERS default. Both custom flags default off — see routes/chat.js for the
 * server-side backstops and Security notes for why tools especially stays opt-in. */
function getCapabilities(id, cfg) {
  const meta = PROVIDERS.find((p) => p.id === id);
  if (!meta) return { images: false, tools: false };
  if (id === 'custom') {
    return { ...meta.capabilities, images: Boolean(cfg?.supportsImages), tools: Boolean(cfg?.supportsTools) };
  }
  return meta.capabilities;
}

export { PROVIDERS, getAdapter, getCapabilities };
