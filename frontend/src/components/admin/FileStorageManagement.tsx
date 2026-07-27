import axios from 'axios';
import { File, Hash, HardDrive, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

interface StoredFile {
  publicId: string;
  url: string;
  sizeBytes: number;
  modifiedAt: string;
  messageId: string | null;
  channelId: string | null;
  channelName: string | null;
  senderUsername: string | null;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unitIndex]}`;
};

// publicId is "workspace-uploads/<sanitized-name>-<timestamp>[.ext]" (see
// buildPublicId in upload.middleware.ts) — strip the folder prefix for
// display, the full id is still what's sent to the delete endpoint.
const displayName = (publicId: string) => publicId.split('/').pop() ?? publicId;

export const FileStorageManagement = () => {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const flash = (setter: (v: string | null) => void, text: string) => {
    setter(text);
    setTimeout(() => setter(null), 3000);
  };

  const fetchFiles = async () => {
    setLoading(true);
    try {
      const res = await axios.get<StoredFile[]>('/api/admin/files');
      setFiles(res.data);
    } catch (err) {
      console.error('Failed to fetch files', err);
      flash(setError, 'Failed to load files');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  const handleDelete = async (file: StoredFile) => {
    const warning = file.messageId
      ? `Delete "${displayName(file.publicId)}"? This will also delete the message it's attached to in #${file.channelName ?? 'a channel'}.`
      : `Permanently delete "${displayName(file.publicId)}" from Cloudinary?`;
    if (!confirm(warning)) return;

    setDeletingId(file.publicId);
    try {
      await axios.delete(`/api/admin/files/${encodeURIComponent(file.publicId)}`);
      setFiles(prev => prev.filter(f => f.publicId !== file.publicId));
      flash(setSuccess, 'File deleted');
    } catch (err: any) {
      flash(setError, err.response?.data?.error || 'Failed to delete file');
    } finally {
      setDeletingId(null);
    }
  };

  const totalSize = files.reduce((sum, f) => sum + f.sizeBytes, 0);

  return (
    <div className="p-8 h-full flex flex-col bg-gray-50">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight flex items-center gap-3">
            <div className="p-2 bg-violet-100 rounded-lg">
              <HardDrive className="text-violet-600" size={28} />
            </div>
            File Storage
          </h1>
          <p className="text-gray-600 font-medium text-sm mt-2">
            {files.length} file{files.length === 1 ? '' : 's'} in Cloudinary · {formatBytes(totalSize)} total
          </p>
        </div>
        <button
          onClick={fetchFiles}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 rounded-lg text-sm font-bold text-gray-700 hover:bg-gray-50 transition-all disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg font-medium">{error}</div>
      )}
      {success && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 text-green-700 rounded-lg font-medium">{success}</div>
      )}

      <div className="flex-1 bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm flex flex-col">
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">File</th>
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Used In</th>
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Size</th>
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Uploaded</th>
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <Loader2 className="animate-spin text-violet-500 mx-auto" size={24} />
                  </td>
                </tr>
              ) : files.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-gray-600 font-medium text-sm uppercase tracking-wider">
                    No uploaded files found
                  </td>
                </tr>
              ) : (
                files.map((file) => (
                  <tr key={file.publicId} className="hover:bg-gray-50 transition-colors group">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-violet-50 border border-violet-100 flex items-center justify-center text-violet-500 shrink-0">
                          <File size={18} />
                        </div>
                        <div className="min-w-0">
                          <a
                            href={file.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm font-semibold text-gray-900 truncate max-w-xs block hover:text-violet-600 hover:underline"
                          >
                            {displayName(file.publicId)}
                          </a>
                          {file.senderUsername && <div className="text-xs text-gray-400">by {file.senderUsername}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {file.channelName ? (
                        <span className="px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider bg-gray-100 text-gray-600 border border-gray-200 flex items-center gap-1 w-fit">
                          <Hash size={10} /> {file.channelName}
                        </span>
                      ) : (
                        <span className="px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider bg-yellow-100 text-yellow-700 border border-yellow-200 w-fit inline-block">
                          Orphaned
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm font-bold text-gray-900">{formatBytes(file.sizeBytes)}</td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {new Date(file.modifiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => handleDelete(file)}
                        disabled={deletingId === file.publicId}
                        className="p-2.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all disabled:opacity-50"
                        title="Delete file"
                      >
                        {deletingId === file.publicId ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
