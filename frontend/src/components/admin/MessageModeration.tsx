import axios from 'axios';
import { FileText, Hash, Loader2, MessageSquareOff, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';

interface SearchResultMessage {
  id: string;
  content: string | null;
  fileName: string | null;
  createdAt: string;
  sender: { id: string; username: string };
  channel: { id: string; name: string | null };
}

export const MessageModeration = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const flash = (setter: (v: string | null) => void, text: string) => {
    setter(text);
    setTimeout(() => setter(null), 3000);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await axios.get<SearchResultMessage[]>('/api/admin/messages/search', { params: { q: query.trim() } });
      setResults(res.data);
    } catch (err) {
      console.error('Failed to search messages', err);
      flash(setError, 'Failed to search messages');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (message: SearchResultMessage) => {
    if (!confirm(`Delete this message from #${message.channel.name ?? 'channel'}? This will remove it for everyone instantly.`)) return;
    setDeletingId(message.id);
    try {
      await axios.delete(`/api/admin/messages/${message.id}`);
      setResults(prev => prev.filter(m => m.id !== message.id));
      flash(setSuccess, 'Message deleted');
    } catch (err: any) {
      flash(setError, err.response?.data?.error || 'Failed to delete message');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="p-8 h-full flex flex-col bg-gray-50">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight flex items-center gap-3">
          <div className="p-2 bg-violet-100 rounded-lg">
            <MessageSquareOff className="text-violet-600" size={28} />
          </div>
          Content Moderation
        </h1>
        <p className="text-gray-600 font-medium text-sm mt-2">
          Search every channel for a message and remove it instantly — direct messages are never included.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg font-medium">{error}</div>
      )}
      {success && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 text-green-700 rounded-lg font-medium">{success}</div>
      )}

      <form onSubmit={handleSearch} className="flex gap-3 mb-6">
        <div className="relative flex-1 max-w-lg">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="text"
            placeholder="Search message content across all channels..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-white border border-gray-200 text-gray-900 placeholder:text-gray-400 text-sm rounded-lg pl-10 pr-4 py-3 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100 transition-all shadow-sm"
          />
        </div>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="px-6 py-3 bg-violet-600 text-white font-bold rounded-lg hover:bg-violet-700 transition-all disabled:opacity-50 flex items-center gap-2 text-sm shrink-0"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          Search
        </button>
      </form>

      <div className="flex-1 bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm flex flex-col">
        <div className="overflow-y-auto flex-1">
          {!searched ? (
            <div className="py-16 text-center text-gray-400 font-medium text-sm">
              Enter a search term to find messages across the workspace.
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="animate-spin text-violet-500" size={28} />
            </div>
          ) : results.length === 0 ? (
            <div className="py-16 text-center text-gray-500 font-medium text-sm uppercase tracking-wider">
              No matching messages found
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {results.map((m) => (
                <div key={m.id} className="px-6 py-4 flex items-start gap-4 hover:bg-gray-50 transition-colors group">
                  <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-white text-xs font-black uppercase shrink-0 mt-0.5">
                    {m.sender.username[0] || '?'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-sm font-bold text-gray-900">{m.sender.username}</span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-gray-100 text-gray-600 border border-gray-200 flex items-center gap-1">
                        <Hash size={10} /> {m.channel.name ?? 'unknown'}
                      </span>
                    </div>
                    {m.content ? (
                      <p className="text-sm text-gray-700">{m.content}</p>
                    ) : (
                      <p className="text-sm text-gray-400 italic flex items-center gap-1.5">
                        <FileText size={13} /> {m.fileName ? `Attachment: ${m.fileName}` : 'No text content'}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-gray-400 font-medium whitespace-nowrap">
                      {new Date(m.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                    <button
                      onClick={() => handleDelete(m)}
                      disabled={deletingId === m.id}
                      className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all disabled:opacity-50"
                      title="Delete message"
                    >
                      {deletingId === m.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
