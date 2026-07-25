import { useState } from "react";
import { useLocation } from "wouter";
import { Navbar } from "@/components/layout/Navbar";
import { Search, Upload, Clock, MapPin, Tag, Edit2, Play, Check, X, AlertCircle } from "lucide-react";
import { 
  useListVideos, 
  useCreateVideo, 
  useListReviewItems, 
  useResolveReviewItem, 
  useGetStats,
  getListVideosQueryKey,
  getListReviewItemsQueryKey,
  getGetStatsQueryKey
} from "@workspace/api-client-react";
import { Button, Card } from "@/components/ui";
import { useQueryClient } from "@tanstack/react-query";

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"library" | "review">("library");
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const { data: videos = [], isLoading: isLoadingVideos } = useListVideos();
  const { data: reviewItems = [], isLoading: isLoadingReview } = useListReviewItems();
  const { data: stats } = useGetStats();
  
  const createVideo = useCreateVideo();
  const resolveReview = useResolveReviewItem();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setLocation(`/search?q=${encodeURIComponent(searchQuery)}`);
    }
  };

  const simulateUpload = () => {
    setUploadProgress(10);
    const interval = setInterval(() => {
      setUploadProgress(p => {
        if (p >= 100) {
          clearInterval(interval);
          createVideo.mutate({
            data: {
              title: "New memory",
              durationSeconds: 120,
              source: "gallery",
              tags: ["recently-uploaded"],
            }
          }, {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
              setIsUploadOpen(false);
              setUploadProgress(0);
            }
          });
          return 100;
        }
        return p + 20;
      });
    }, 500);
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background relative pb-20">
      <Navbar variant="app" />
      
      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 md:px-10 pt-32 relative z-10">
        {/* Search Hero */}
        <div className="max-w-3xl mx-auto text-center mb-16">
          <form onSubmit={handleSearch} className="relative group">
            <div className="absolute inset-y-0 left-6 flex items-center pointer-events-none">
              <Search className="w-6 h-6 text-muted-foreground group-focus-within:text-primary transition-colors" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Ask anything about your memories..."
              className="w-full h-20 pl-16 pr-8 rounded-full bg-card border border-border shadow-[0_8px_30px_-10px_rgba(0,0,0,0.08)] text-xl font-medium focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all placeholder:text-muted-foreground/60"
            />
            <Button 
              type="submit" 
              className="absolute right-3 top-3 bottom-3 rounded-full px-8 text-base font-bold shadow-md"
              disabled={!searchQuery.trim()}
            >
              Search
            </Button>
          </form>
          
          {stats && (
            <div className="mt-8 flex items-center justify-center gap-6 text-sm font-semibold text-muted-foreground">
              <span className="flex items-center gap-1.5"><Play className="w-4 h-4" /> {stats.totalVideos} videos</span>
              <span className="w-1 h-1 rounded-full bg-border" />
              <span className="flex items-center gap-1.5"><Clock className="w-4 h-4" /> {Math.round(stats.totalHoursIndexed)} hours indexed</span>
              <span className="w-1 h-1 rounded-full bg-border" />
              <span className="flex items-center gap-1.5"><Tag className="w-4 h-4" /> {stats.totalScenes} scenes</span>
            </div>
          )}
        </div>

        {/* Tabs & Actions */}
        <div className="flex items-center justify-between mb-8 border-b border-border pb-4">
          <div className="flex items-center gap-8">
            <button 
              onClick={() => setActiveTab("library")}
              className={`text-lg font-bold pb-4 -mb-[17px] border-b-2 transition-colors ${activeTab === "library" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-primary"}`}
            >
              Library
            </button>
            <button 
              onClick={() => setActiveTab("review")}
              className={`text-lg font-bold pb-4 -mb-[17px] border-b-2 transition-colors flex items-center gap-2 ${activeTab === "review" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-primary"}`}
            >
              Needs Review
              {reviewItems.length > 0 && (
                <span className="bg-accent text-accent-foreground text-[10px] px-2 py-0.5 rounded-full">{reviewItems.length}</span>
              )}
            </button>
          </div>
          
          <Button onClick={() => setIsUploadOpen(true)} className="rounded-full shadow-md font-bold px-6">
            <Upload className="w-4 h-4 mr-2" /> Upload
          </Button>
        </div>

        {/* Content */}
        {activeTab === "library" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {isLoadingVideos ? (
              [...Array(8)].map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="aspect-video bg-secondary rounded-2xl mb-3" />
                  <div className="h-5 bg-secondary rounded w-3/4 mb-2" />
                  <div className="h-4 bg-secondary rounded w-1/2" />
                </div>
              ))
            ) : videos.length === 0 ? (
              <div className="col-span-full py-20 text-center text-muted-foreground font-medium">
                No videos yet. Upload your first memory to get started.
              </div>
            ) : (
              videos.map((video) => (
                <div key={video.id} className="group cursor-pointer">
                  <div className="aspect-video bg-secondary rounded-2xl mb-4 overflow-hidden relative border border-border shadow-sm group-hover:shadow-md transition-all group-hover:-translate-y-1">
                    <img src={video.thumbnailUrl || "/images/trekking.jpg"} alt={video.title} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <div className="w-12 h-12 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center">
                        <Play className="w-5 h-5 text-white fill-white" />
                      </div>
                    </div>
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="w-8 h-8 bg-black/50 backdrop-blur-md rounded-full flex items-center justify-center text-white hover:bg-black/70">
                        <Edit2 className="w-4 h-4" />
                      </div>
                    </div>
                    <div className="absolute bottom-3 right-3 px-2 py-1 bg-black/60 backdrop-blur-md rounded-md text-[10px] font-mono font-bold text-white">
                      {Math.floor(video.durationSeconds / 60)}:{(video.durationSeconds % 60).toString().padStart(2, '0')}
                    </div>
                  </div>
                  <h3 className="font-bold text-base mb-1 truncate group-hover:text-accent transition-colors">{video.title}</h3>
                  <div className="flex items-center gap-3 text-xs font-semibold text-muted-foreground">
                    <span>{new Date(video.uploadedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>
                    {video.location && (
                      <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {video.location}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === "review" && (
          <div className="bg-secondary/30 rounded-[24px] border border-border p-8 min-h-[400px]">
            {isLoadingReview ? (
              <div className="text-center py-20 text-muted-foreground font-medium">Loading review items...</div>
            ) : reviewItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 bg-card rounded-full flex items-center justify-center mb-4 shadow-sm border border-border">
                  <Check className="w-8 h-8 text-accent" />
                </div>
                <h3 className="text-xl font-bold mb-2">All caught up</h3>
                <p className="text-muted-foreground font-medium">No items need your review right now.</p>
              </div>
            ) : (
              <div className="space-y-4 max-w-4xl mx-auto">
                {reviewItems.map((item) => (
                  <div key={item.id} className="bg-card rounded-2xl p-4 flex flex-col sm:flex-row gap-6 border border-border shadow-sm items-center">
                    <div className="w-40 aspect-video rounded-xl overflow-hidden bg-secondary shrink-0 relative">
                      <img src={item.thumbnailUrl} className="w-full h-full object-cover" alt="" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-orange-100 text-orange-800 text-[10px] font-bold uppercase tracking-wider mb-2">
                        <AlertCircle className="w-3 h-3" /> Flagged
                      </div>
                      <h4 className="font-bold text-base mb-1">{item.videoTitle}</h4>
                      <p className="text-sm font-medium text-muted-foreground">{item.reason}</p>
                    </div>
                    <div className="flex sm:flex-col gap-2 shrink-0 w-full sm:w-auto">
                      <Button 
                        onClick={() => {
                          resolveReview.mutate({ id: item.id, data: { status: "accepted" } }, {
                            onSuccess: () => queryClient.invalidateQueries({ queryKey: getListReviewItemsQueryKey() })
                          });
                        }}
                        className="flex-1 sm:flex-none rounded-xl font-bold h-10 shadow-sm"
                      >
                        Accept
                      </Button>
                      <Button 
                        variant="outline"
                        onClick={() => {
                          resolveReview.mutate({ id: item.id, data: { status: "discarded" } }, {
                            onSuccess: () => queryClient.invalidateQueries({ queryKey: getListReviewItemsQueryKey() })
                          });
                        }}
                        className="flex-1 sm:flex-none rounded-xl font-bold h-10"
                      >
                        Discard
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Upload Overlay */}
      {isUploadOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <div className="absolute inset-0" onClick={() => !uploadProgress && setIsUploadOpen(false)} />
          <Card className="w-full max-w-xl p-8 relative z-10 rounded-[24px] shadow-2xl border-border animate-in fade-in zoom-in duration-200">
            <button 
              onClick={() => !uploadProgress && setIsUploadOpen(false)}
              className="absolute top-6 right-6 text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
              disabled={uploadProgress > 0}
            >
              <X className="w-6 h-6" />
            </button>
            <h2 className="text-2xl font-extrabold mb-2">Upload memories</h2>
            <p className="text-muted-foreground font-medium mb-8">Drag and drop your video files here.</p>
            
            <div className="border-2 border-dashed border-border rounded-2xl p-12 flex flex-col items-center justify-center text-center bg-secondary/30 transition-colors hover:bg-secondary/50 hover:border-primary/30 cursor-pointer">
              <div className="w-16 h-16 bg-card rounded-full shadow-sm flex items-center justify-center mb-6">
                <Upload className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-bold text-lg mb-2">Select a video or drag and drop</h3>
              <p className="text-sm font-medium text-muted-foreground mb-8">MP4, MOV up to 10GB</p>
              
              {uploadProgress > 0 ? (
                <div className="w-full max-w-sm">
                  <div className="flex items-center justify-between text-xs font-bold mb-2">
                    <span>Uploading...</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-accent transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                  </div>
                </div>
              ) : (
                <Button onClick={simulateUpload} className="rounded-xl font-bold px-8 shadow-sm">
                  Select file
                </Button>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
