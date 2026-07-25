import { useState, useEffect, useRef } from "react";
import { useLocation, Link } from "wouter";
import Hls from "hls.js";
import { Navbar } from "@/components/layout/Navbar";
import { Search as SearchIcon, Play, ChevronLeft, Calendar, MapPin, Users, X, Quote } from "lucide-react";
import { useSearchMemories, useGetVideo, getSearchMemoriesQueryKey, getGetVideoQueryKey } from "@workspace/api-client-react";
import { Button, Card } from "@/components/ui";

export default function Search() {
  const [location, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const initialQuery = searchParams.get("q") || "";
  
  const [query, setQuery] = useState(initialQuery);
  const [inputValue, setInputValue] = useState(initialQuery);
  const [loadingStep, setLoadingStep] = useState(0);
  const [selectedResultId, setSelectedResultId] = useState<number | null>(null);

  const { data: results, isLoading } = useSearchMemories({ q: query }, { query: { enabled: !!query, queryKey: getSearchMemoriesQueryKey({ q: query }) } });

  // Simulate confident search transition steps
  useEffect(() => {
    if (isLoading) {
      setLoadingStep(1);
      const t1 = setTimeout(() => setLoadingStep(2), 800);
      const t2 = setTimeout(() => setLoadingStep(3), 1800);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    } else if (results) {
      setLoadingStep(4);
    }
    return () => {};
  }, [isLoading, results]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() && inputValue !== query) {
      setLocation(`/search?q=${encodeURIComponent(inputValue)}`);
      setQuery(inputValue);
    }
  };

  const selectedResult = results?.find(r => r.id === selectedResultId);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background relative pb-20">
      <Navbar variant="app" />
      
      <main className="flex-1 max-w-[1000px] w-full mx-auto px-6 md:px-10 pt-32 relative z-10">
        <Link href="/dashboard" className="inline-flex items-center text-sm font-bold text-muted-foreground hover:text-primary mb-8 transition-colors">
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to library
        </Link>

        <form onSubmit={handleSearch} className="relative group mb-12">
          <div className="absolute inset-y-0 left-6 flex items-center pointer-events-none">
            <SearchIcon className="w-6 h-6 text-muted-foreground group-focus-within:text-primary transition-colors" />
          </div>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="w-full h-20 pl-16 pr-8 rounded-full bg-card border border-border shadow-sm text-xl font-medium focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all"
          />
          <Button 
            type="submit" 
            className="absolute right-3 top-3 bottom-3 rounded-full px-8 text-base font-bold shadow-md"
            disabled={!inputValue.trim()}
          >
            Refine
          </Button>
        </form>

        {isLoading || loadingStep < 4 ? (
          <div className="flex flex-col items-center justify-center py-32 animate-in fade-in duration-500">
            <div className="w-16 h-16 border-4 border-secondary border-t-accent rounded-full animate-spin mb-8" />
            <div className="h-8 relative w-full max-w-sm overflow-hidden flex items-center justify-center text-lg font-bold text-muted-foreground">
               <div className={`absolute transition-all duration-500 ${loadingStep === 1 ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'}`}>Understanding your query...</div>
               <div className={`absolute transition-all duration-500 ${loadingStep === 2 ? 'opacity-100 translate-y-0' : loadingStep < 2 ? 'opacity-0 translate-y-4' : 'opacity-0 -translate-y-4'}`}>Searching your archive...</div>
               <div className={`absolute transition-all duration-500 ${loadingStep === 3 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>Finding the exact moments...</div>
            </div>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-extrabold">Found {results?.length || 0} matches</h2>
              <span className="text-sm font-semibold text-muted-foreground bg-secondary px-3 py-1 rounded-full">Sorted by relevance</span>
            </div>

            {results?.length === 0 ? (
              <div className="py-20 text-center text-muted-foreground font-medium">
                No memories found for "{query}". Try searching for something else.
              </div>
            ) : (
              <div className="space-y-4">
                {results?.map((result) => (
                  <Card 
                    key={result.id} 
                    className="p-4 flex gap-6 hover:shadow-md transition-all cursor-pointer border-border/60 hover:border-primary/20 rounded-[20px] group"
                    onClick={() => setSelectedResultId(result.id)}
                  >
                    <div className="w-48 aspect-video rounded-xl overflow-hidden bg-secondary shrink-0 relative">
                      {result.thumbnailUrl ? (
                        <img src={result.thumbnailUrl} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" alt="" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
                          <Play className="w-8 h-8" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/10 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                        <div className="w-10 h-10 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity transform group-hover:scale-100 scale-90">
                          <Play className="w-4 h-4 text-white fill-white" />
                        </div>
                      </div>
                      <div className="absolute bottom-2 right-2 px-1.5 py-0.5 bg-black/60 backdrop-blur-md rounded text-[10px] font-mono font-bold text-white">
                        {Math.floor(result.timestampSeconds / 60)}:{(result.timestampSeconds % 60).toString().padStart(2, '0')}
                      </div>
                    </div>
                    
                    <div className="flex-1 min-w-0 py-1">
                      <div className="flex items-start justify-between mb-2">
                        <h3 className="font-bold text-lg truncate pr-4 group-hover:text-accent transition-colors">{result.videoTitle}</h3>
                        <div className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-[10px] font-bold uppercase tracking-wider shrink-0">
                          {result.matchType} match
                        </div>
                      </div>
                      
                      <div className="text-sm font-serif italic text-muted-foreground/80 mb-3 border-l-2 border-accent/30 pl-3">
                        "{result.snippet}"
                      </div>
                      
                      <div className="flex items-center gap-4 text-xs font-semibold text-muted-foreground mt-auto">
                        {result.recordedAt && (
                          <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" /> {new Date(result.recordedAt).toLocaleDateString()}</span>
                        )}
                        {result.location && (
                          <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> {result.location}</span>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Player Dialog Overlay */}
      {selectedResult && (
        <PlayerOverlay 
          result={selectedResult} 
          onClose={() => setSelectedResultId(null)} 
        />
      )}
    </div>
  )
}

/**
 * Real HLS playback for VideoDB streams. Seeks straight to the matched
 * moment once the stream is ready. Safari plays HLS natively; other
 * browsers go through hls.js.
 */
function VideoPlayer({ src, startAt, poster }: { src: string; startAt: number; poster?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let hls: Hls | null = null;
    const seekToMatch = () => {
      video.currentTime = startAt;
      void video.play().catch(() => {
        // Autoplay blocked — the user can press play; we stay seeked.
      });
    };
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.addEventListener("loadedmetadata", seekToMatch, { once: true });
    } else if (Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, seekToMatch);
    } else {
      video.src = src;
      video.addEventListener("loadedmetadata", seekToMatch, { once: true });
    }
    return () => {
      video.removeEventListener("loadedmetadata", seekToMatch);
      if (hls) hls.destroy();
    };
  }, [src, startAt]);

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      poster={poster}
      className="absolute inset-0 w-full h-full"
    />
  );
}

function PlayerOverlay({ result, onClose }: { result: any, onClose: () => void }) {
  const { data: videoDetail } = useGetVideo(result.videoId, { query: { enabled: !!result.videoId, queryKey: getGetVideoQueryKey(result.videoId) } });

  // Calculate position of the match on the timeline
  const matchPercent = result.durationSeconds > 0 ? (result.timestampSeconds / result.durationSeconds) * 100 : 0;
  
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-10 animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-background/90 backdrop-blur-xl" onClick={onClose} />
      
      <div className="w-full max-w-[1200px] bg-card border border-border shadow-2xl rounded-[32px] overflow-hidden flex flex-col relative z-10 max-h-full">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
          <h3 className="font-bold text-lg truncate pr-4">{result.videoTitle}</h3>
          <button onClick={onClose} className="p-2 bg-secondary rounded-full hover:bg-secondary/80 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {/* Player: real HLS stream when available, facade for seeded demos */}
          <div className="w-full bg-black aspect-video relative group">
             {result.videoUrl ? (
               <VideoPlayer
                 src={result.videoUrl}
                 startAt={result.timestampSeconds}
                 poster={result.thumbnailUrl || undefined}
               />
             ) : (
               <>
                 <div className="absolute inset-0 bg-black">
                   {result.thumbnailUrl && (
                     <img src={result.thumbnailUrl} className="w-full h-full object-cover opacity-80" alt="Video" />
                   )}
                 </div>
                 <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                   <div className="w-20 h-20 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center cursor-pointer hover:bg-white/30 hover:scale-105 transition-all">
                     <Play className="w-8 h-8 text-white fill-white ml-1" />
                   </div>
                 </div>

                 {/* Player Controls overlay */}
                 <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent pt-12 pb-6 px-8 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    <div className="flex items-center justify-between text-white font-mono text-xs font-bold mb-3">
                      <span>{Math.floor(result.timestampSeconds / 60)}:{(result.timestampSeconds % 60).toString().padStart(2, '0')}</span>
                      <span>{Math.floor(result.durationSeconds / 60)}:{(result.durationSeconds % 60).toString().padStart(2, '0')}</span>
                    </div>

                    {/* Timeline Scrubber */}
                    <div className="w-full h-2 bg-white/30 rounded-full relative cursor-pointer group/scrubber">
                      {/* Progress fill */}
                      <div className="absolute top-0 left-0 h-full bg-white rounded-l-full" style={{ width: `${matchPercent}%` }} />

                      {/* Highlighted match segment */}
                      <div className="absolute top-1/2 -translate-y-1/2 h-4 w-1 bg-accent rounded-full shadow-[0_0_8px_rgba(28,138,62,1)]" style={{ left: `${matchPercent}%` }} />
                      <div className="absolute top-1/2 -translate-y-1/2 h-1 bg-accent/40 rounded-full" style={{ left: `${Math.max(0, matchPercent - 2)}%`, width: '4%' }} />
                    </div>
                 </div>
               </>
             )}
          </div>
          
          {/* Metadata Section */}
          <div className="p-8 md:p-12">
            <div className="flex items-center gap-2 mb-6">
              <span className="bg-accent text-accent-foreground px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
                <SearchIcon className="w-3 h-3" /> Exact match found
              </span>
              <span className="text-sm font-mono font-bold text-muted-foreground px-3 py-1 bg-secondary rounded-full">
                @ {Math.floor(result.timestampSeconds / 60)}:{(result.timestampSeconds % 60).toString().padStart(2, '0')}
              </span>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
              <div className="md:col-span-2 space-y-6">
                <div>
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
                    <Quote className="w-3.5 h-3.5" /> Transcript excerpt
                  </h4>
                  <div className="text-lg font-serif italic text-primary/90 leading-relaxed p-6 bg-secondary/30 rounded-[20px] border border-border">
                    "… {result.snippet} …"
                  </div>
                </div>
                
                {videoDetail?.tags && videoDetail.tags.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Topics</h4>
                    <div className="flex flex-wrap gap-2">
                      {videoDetail.tags.map((tag: string) => (
                        <span key={tag} className="px-3 py-1.5 bg-card border border-border rounded-lg text-sm font-semibold shadow-sm">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              
              <div className="space-y-8">
                <div>
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
                    <Calendar className="w-3.5 h-3.5" /> Date & Location
                  </h4>
                  <div className="space-y-2 text-sm font-medium">
                    <div className="flex items-center justify-between py-2 border-b border-border/50">
                      <span className="text-muted-foreground">Recorded</span>
                      <span className="font-bold">{result.recordedAt ? new Date(result.recordedAt).toLocaleDateString() : 'Unknown'}</span>
                    </div>
                    <div className="flex items-center justify-between py-2 border-b border-border/50">
                      <span className="text-muted-foreground">Location</span>
                      <span className="font-bold">{result.location || 'Unknown'}</span>
                    </div>
                  </div>
                </div>
                
                {(result.people && result.people.length > 0) ? (
                  <div>
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
                      <Users className="w-3.5 h-3.5" /> People in scene
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {result.people.map((person: string) => (
                        <span key={person} className="px-3 py-1.5 bg-card border border-border rounded-lg text-sm font-semibold flex items-center gap-2 shadow-sm">
                          <div className="w-4 h-4 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-[8px]">{person[0]}</div>
                          {person}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
