import { useCallback, useEffect, useState } from 'react';
import * as api from '../api/client.js';

export function useConversations() {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listConversations();
      setConversations(list);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(async (payload) => {
    const convo = await api.createConversation(payload);
    await refresh();
    return convo;
  }, [refresh]);

  const rename = useCallback(async (id, title) => {
    await api.patchConversation(id, { title });
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id) => {
    await api.deleteConversation(id);
    await refresh();
  }, [refresh]);

  const patch = useCallback(async (id, payload) => {
    await api.patchConversation(id, payload);
    await refresh();
  }, [refresh]);

  return { conversations, loading, error, refresh, create, rename, remove, patch };
}
