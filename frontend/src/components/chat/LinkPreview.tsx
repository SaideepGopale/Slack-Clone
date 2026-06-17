import axios from 'axios';
import { ExternalLink, Globe } from 'lucide-react';
import { useEffect, useState } from 'react';

interface PreviewData {
  title: string;
  description: string;
  image: string;
  url: string;
}

export const LinkPreview = ({ url }: { url: string }) => {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPreview = async () => {
      try {
        const res = await axios.post('/api/preview', { url });
        // Agar real title na mile toh default url hi dikhayenge
        if (res.data) {
          setData(res.data);
        }
      } catch (err) {
        console.error('Preview fetch error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchPreview();
  }, [url]);

  if (loading) {
    return (
      <div className="mt-2 w-full max-w-sm h-24 bg-gray-100 rounded-xl animate-pulse border border-gray-200"></div>
    );
  }

  if (!data || (!data.image && data.title === url)) {
    // Agar API kuch dhang ka return na kare (no image, no proper title)
    return null; 
  }

  return (
    <a 
      href={data.url} 
      target="_blank" 
      rel="noopener noreferrer"
      className="mt-2 flex flex-col sm:flex-row w-full max-w-lg bg-white border border-gray-200 rounded-xl overflow-hidden hover:shadow-md transition-shadow group cursor-pointer text-left"
    >
      {/* Agar image aayi hai toh dikhao */}
      {data.image ? (
        <div className="w-full sm:w-32 h-32 shrink-0 bg-gray-100 border-b sm:border-b-0 sm:border-r border-gray-200 overflow-hidden relative">
          <img 
            src={data.image} 
            alt={data.title} 
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
      ) : (
        <div className="w-full sm:w-32 h-32 shrink-0 bg-gray-50 flex items-center justify-center border-b sm:border-b-0 sm:border-r border-gray-200">
          <Globe size={32} className="text-gray-300" />
        </div>
      )}

      {/* Text Content */}
      <div className="p-3 sm:p-4 flex flex-col justify-center flex-1 min-w-0">
        <h4 className="text-sm font-bold text-gray-900 truncate mb-1 flex items-center gap-1.5">
          {data.title}
          <ExternalLink size={14} className="text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" />
        </h4>
        {data.description && (
          <p className="text-xs text-gray-500 line-clamp-2 mb-2 leading-relaxed">
            {data.description}
          </p>
        )}
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest truncate">
          {new URL(data.url).hostname}
        </span>
      </div>
    </a>
  );
};