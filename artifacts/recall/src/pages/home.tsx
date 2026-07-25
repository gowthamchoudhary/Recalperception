import { useEffect, useRef } from "react";
import { Link } from "wouter";
import Hls from "hls.js";
import { Navbar } from "@/components/layout/Navbar";
import { Play, Search, CheckCircle, Plus } from "lucide-react";
import {
  useGetStats,
  useListVideos,
  useGetVideo,
  getGetStatsQueryKey,
  getListVideosQueryKey,
  getGetVideoQueryKey,
} from "@workspace/api-client-react";
import { useCurrentUser } from "@/lib/auth";

/** Muted, looping HLS preview used in the floating hero cards. */
function HlsLoop({ src, startAt = 0, className }: { src: string; startAt?: number; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let hls: Hls | null = null;
    const onReady = () => {
      if (startAt > 0) video.currentTime = startAt;
      void video.play().catch(() => {});
    };
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.addEventListener("loadedmetadata", onReady, { once: true });
    } else if (Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, onReady);
    }
    return () => {
      video.removeEventListener("loadedmetadata", onReady);
      if (hls) hls.destroy();
    };
  }, [src, startAt]);

  return (
    <video
      ref={ref}
      muted
      loop
      playsInline
      autoPlay
      className={className ?? "w-full h-full object-cover"}
    />
  );
}

function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export default function Home() {
  const { user } = useCurrentUser();
  const authed = !!user;

  const { data: stats } = useGetStats({
    query: { enabled: authed, queryKey: getGetStatsQueryKey() },
  });
  const { data: videos, isLoading: isLoadingVideos } = useListVideos(undefined, {
    query: { enabled: authed, queryKey: getListVideosQueryKey(undefined) },
  });

  // Real, playable uploads drive the hero when logged in.
  const playable = (videos ?? []).filter((v) => v.videoUrl && v.status === "indexed");
  const heroA = authed ? playable[0] : undefined;
  const heroB = authed ? (playable[1] ?? playable[0]) : undefined;

  const { data: heroADetail } = useGetVideo(heroA?.id ?? 0, {
    query: { enabled: !!heroA, queryKey: getGetVideoQueryKey(heroA?.id ?? 0) },
  });
  const heroQuote = heroADetail?.transcriptExcerpt?.trim();

  return (
    <div className="min-h-[100dvh] flex flex-col relative bg-background">
      {/* Soft radial glow */}
      <div className="absolute top-[10%] left-1/2 -translate-x-1/2 w-[1000px] h-[800px] bg-white rounded-full opacity-100 blur-[120px] pointer-events-none" />

      <Navbar variant="public" />

      <main className="flex-1 w-full pt-32 pb-24 relative z-10 px-6 flex flex-col items-center overflow-x-hidden">

        {/* Hero Section Wrapper */}
        <div className="w-full max-w-4xl mx-auto text-center relative z-20 mt-8 mb-20 md:mb-28">

          {/* Floating cards anchored to the text block — scattered, never overlapping each other */}
          <div className="absolute inset-0 pointer-events-none hidden sm:block">

            {/* Memory Card A (Top Left) */}
            <div className="absolute top-[0%] right-[100%] mr-4 md:mr-8 lg:mr-12 xl:mr-20 scale-[0.4] md:scale-[0.55] lg:scale-[0.7] xl:scale-[0.9] origin-right opacity-30 md:opacity-60 lg:opacity-80 xl:opacity-100 transition-all duration-500">
              <div className="animate-float" style={{ '--tw-rotate': '-4deg' } as React.CSSProperties}>
                <div className="bg-card p-2 pb-4 rounded-[16px] shadow-[0_20px_40px_-15px_rgba(0,0,0,0.1)] border border-card-border w-52 text-left">
                  <div className="aspect-[4/3] rounded-xl overflow-hidden mb-3 bg-secondary">
                    {heroA?.videoUrl ? (
                      <HlsLoop src={heroA.videoUrl} />
                    ) : (
                      <img src="/images/trekking.jpg" className="w-full h-full object-cover" alt="" />
                    )}
                  </div>
                  <div className="px-2">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-0.5">
                      {heroA ? heroA.title : "Spoken words indexed"}
                    </p>
                    <p className="text-sm font-semibold">
                      {heroA ? monthYear(heroA.uploadedAt) : "Searchable in minutes"}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Memory Card B (Bottom Left, well below card A) */}
            <div className="absolute top-[58%] right-[100%] mr-2 md:mr-4 lg:mr-6 xl:mr-12 scale-[0.35] md:scale-[0.5] lg:scale-[0.6] xl:scale-[0.75] origin-right opacity-20 md:opacity-40 lg:opacity-60 xl:opacity-80 transition-all duration-500">
              <div className="animate-float-delayed" style={{ '--tw-rotate': '-2deg' } as React.CSSProperties}>
                <div className="bg-card p-2 pb-4 rounded-[16px] shadow-lg border border-card-border w-52 text-left">
                  <div className="aspect-[4/3] rounded-xl overflow-hidden bg-secondary">
                    {heroB?.videoUrl ? (
                      <HlsLoop
                        src={heroB.videoUrl}
                        startAt={heroB.id === heroA?.id ? Math.floor(heroB.durationSeconds / 2) : 0}
                      />
                    ) : (
                      <img src="/images/beach.jpg" className="w-full h-full object-cover" alt="" />
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Dark Card (Top Right) */}
            <div className="absolute top-[15%] left-[100%] ml-4 md:ml-8 lg:ml-12 xl:ml-20 scale-[0.4] md:scale-[0.55] lg:scale-[0.75] xl:scale-[0.95] origin-left opacity-40 md:opacity-70 lg:opacity-90 xl:opacity-100 transition-all duration-500">
              <div className="animate-float" style={{ '--tw-rotate': '4deg' } as React.CSSProperties}>
                <div className="bg-[#14140f] text-white p-6 rounded-[16px] shadow-[0_30px_60px_-15px_rgba(0,0,0,0.3)] border border-white/10 w-72 text-left">
                  <div className="flex items-center gap-2 mb-5">
                    <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center">
                      <Search className="w-3.5 h-3.5 text-accent" />
                    </div>
                    <span className="text-[11px] font-bold tracking-widest uppercase text-white/50">Moment found</span>
                  </div>
                  <p className="text-base font-serif italic mb-6 leading-relaxed text-white/90">
                    {heroQuote
                      ? `"${heroQuote.slice(0, 100)}${heroQuote.length > 100 ? "…" : ""}"`
                      : '"Search a lifetime of footage by what was actually said…"'}
                  </p>
                  <div className="w-full h-10 flex items-end gap-[2px] opacity-70 relative">
                     {[...Array(30)].map((_, i) => {
                       const height = i === 12 ? 100 : i === 11 || i === 13 ? 80 : Math.max(15, ((i * 37) % 23) / 23 * 60);
                       return (
                         <div key={i} className={`flex-1 rounded-full ${i >= 11 && i <= 13 ? 'bg-accent' : 'bg-white/20'}`} style={{ height: `${height}%` }} />
                       );
                     })}
                     <div className="absolute w-[2px] h-12 bg-accent left-[40%] bottom-0 z-10 shadow-[0_0_10px_rgba(28,138,62,0.8)]" />
                     <div className="absolute text-[10px] font-mono font-bold text-accent left-[40%] -bottom-5 -ml-3">
                       {heroA ? mmss(Math.floor(heroA.durationSeconds / 2)) : "02:14"}
                     </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Right Clip Result Card */}
            <div className="absolute bottom-[0%] left-[100%] ml-6 md:ml-10 lg:ml-16 xl:ml-24 scale-[0.4] md:scale-[0.55] lg:scale-[0.7] xl:scale-[0.85] origin-left opacity-40 md:opacity-60 lg:opacity-80 xl:opacity-100 transition-all duration-500">
              <div className="animate-float-delayed" style={{ '--tw-rotate': '3deg' } as React.CSSProperties}>
                <div className="bg-card p-3 rounded-[16px] shadow-[0_20px_40px_-15px_rgba(0,0,0,0.1)] border border-card-border flex items-center gap-4 w-72 text-left">
                  <div className="w-16 h-16 rounded-xl overflow-hidden bg-secondary shrink-0 relative shadow-inner">
                    {heroA?.thumbnailUrl ? (
                      <img src={heroA.thumbnailUrl} className="w-full h-full object-cover" alt="" />
                    ) : (
                      <img src="/images/birthday.jpg" className="w-full h-full object-cover" alt="" />
                    )}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
                      <Play className="w-5 h-5 text-white fill-white shadow-sm" />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-bold mb-1 truncate">{heroA ? heroA.title : "Your first upload"}</h4>
                    <p className="text-[11px] text-muted-foreground font-semibold truncate">
                      {heroA
                        ? `Indexed · ${mmss(heroA.durationSeconds)}`
                        : "Transcribed & privacy-scanned"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white text-primary text-xs font-bold mb-10 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.1)] border border-border relative z-10">
            <CheckCircle className="w-4 h-4 text-accent" />
            <span className="tracking-wide">FOR YOUR GALLERY, GOOGLE PHOTOS, OR YOUTUBE</span>
          </div>

          <h1 className="text-[64px] md:text-[88px] font-extrabold tracking-[-0.04em] leading-[1.05] text-primary mb-8 relative z-10">
            Everything you've <br className="hidden md:block" />
            <span className="text-accent">filmed.</span>{' '}
            <span className="font-mono tracking-tight bg-primary text-primary-foreground px-6 py-2 rounded-2xl rotate-[-3deg] inline-block shadow-2xl relative -top-2">Found.</span>
          </h1>

          <p className="text-xl md:text-2xl text-muted-foreground font-medium max-w-2xl mx-auto leading-relaxed mb-12 relative z-10">
            Search a lifetime of video like it's one searchable memory — by what was said, what happened, and who was there.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-6 relative z-10">
            <Link href={authed ? "/dashboard" : "/login"} className="bg-primary text-primary-foreground h-16 px-10 rounded-full inline-flex items-center justify-center text-lg font-bold hover:bg-primary/90 transition-all hover:scale-105 active:scale-95 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.4)]">
              {authed ? "Open your library →" : "Start searching →"}
            </Link>
            <a href="#" className="text-base font-bold text-muted-foreground hover:text-primary hover:underline underline-offset-4 transition-colors">
              See how indexing works
            </a>
          </div>
        </div>

        {/* Product Preview Panel */}
        <div className="w-full max-w-[1040px] mx-auto z-30 transform-gpu animate-in fade-in slide-in-from-bottom-8 duration-1000 mt-4">
          <div className="bg-[#14140f] text-white rounded-[24px] md:rounded-[32px] border border-white/10 shadow-[0_40px_100px_-20px_rgba(0,0,0,0.5)] overflow-hidden">

            {/* Top Bar */}
            <div className="px-6 py-4 flex items-center justify-between border-b border-white/5 bg-white/[0.02]">
              <div className="flex items-center gap-2 group">
                 <div className="w-6 h-6 bg-white rounded-full flex items-center justify-center">
                    <div className="w-2 h-2 bg-accent rounded-sm" />
                 </div>
                 <span className="font-bold text-lg tracking-tight leading-none mb-0.5">recall</span>
              </div>

              <div className="flex items-center gap-2">
                <div className="hidden sm:flex items-center bg-white/5 rounded-full p-1">
                  <button className="px-4 py-1.5 rounded-full bg-white/10 text-white text-xs font-bold transition-colors">
                    Library {authed && stats?.totalVideos !== undefined ? stats.totalVideos : ''}
                  </button>
                  <button className="px-4 py-1.5 rounded-full text-white/50 hover:text-white/80 text-xs font-bold transition-colors">
                    People {authed && stats?.totalPeople !== undefined ? stats.totalPeople : ''}
                  </button>
                  <button className="px-4 py-1.5 rounded-full text-white/50 hover:text-white/80 text-xs font-bold transition-colors">
                    Review {authed && stats?.pendingReviewCount ? stats.pendingReviewCount : ''}
                  </button>
                </div>
                <button className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/70 transition-colors ml-1">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Panel Body */}
            <div className="p-6 md:p-10 bg-gradient-to-b from-white/[0.02] to-transparent">

              {/* Search Bar */}
              <Link href={authed ? "/dashboard" : "/login"} className="block relative group mb-10 cursor-text">
                <div className="absolute inset-y-0 left-6 flex items-center pointer-events-none">
                  <Search className="w-5 h-5 text-white/40 group-hover:text-white/60 transition-colors" />
                </div>
                <div className="w-full h-16 md:h-20 pl-14 pr-6 rounded-full bg-white/5 border border-white/10 flex items-center text-white/40 group-hover:bg-white/10 group-hover:border-white/20 transition-all text-base md:text-lg font-medium shadow-inner">
                  Ask anything about your memories...
                </div>
              </Link>

              {/* Video Cards Row */}
              {!authed ? (
                <div className="py-10 flex flex-col items-center text-center">
                  <p className="text-white/60 font-medium mb-6 max-w-md">
                    Log in to see your library here — every upload is transcribed, indexed, and privacy-scanned automatically.
                  </p>
                  <Link href="/login" className="bg-white text-black h-12 px-8 rounded-full inline-flex items-center justify-center text-sm font-bold hover:bg-white/90 transition-colors">
                    Sign in to your archive
                  </Link>
                </div>
              ) : isLoadingVideos ? (
                <div className="flex gap-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="w-[260px] md:w-[280px] shrink-0 animate-pulse">
                      <div className="aspect-video bg-white/5 rounded-[16px] mb-4" />
                      <div className="h-4 bg-white/5 rounded w-3/4 mb-2.5" />
                      <div className="h-3 bg-white/5 rounded w-1/2" />
                    </div>
                  ))}
                </div>
              ) : (videos?.length ?? 0) === 0 ? (
                <div className="py-10 flex flex-col items-center text-center">
                  <p className="text-white/60 font-medium mb-6 max-w-md">
                    Your library is empty. Upload your first video and it will show up here, fully searchable.
                  </p>
                  <Link href="/dashboard" className="bg-white text-black h-12 px-8 rounded-full inline-flex items-center justify-center text-sm font-bold hover:bg-white/90 transition-colors">
                    Upload a video
                  </Link>
                </div>
              ) : (
                <div className="flex overflow-x-auto pb-4 -mx-6 px-6 md:mx-0 md:px-0 gap-4 snap-x [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                  {videos!.slice(0, 5).map(video => (
                    <Link key={video.id} href="/dashboard" className="w-[260px] md:w-[280px] shrink-0 group snap-start block">
                      <div className="aspect-video bg-white/5 rounded-[16px] mb-4 overflow-hidden relative border border-white/5 group-hover:border-white/20 transition-all shadow-sm">
                        {video.thumbnailUrl ? (
                          <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity group-hover:scale-105 duration-500" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-white/20">
                            <Play className="w-8 h-8" />
                          </div>
                        )}
                        <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <div className="w-10 h-10 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center">
                            <Play className="w-4 h-4 text-white fill-white ml-0.5" />
                          </div>
                        </div>
                      </div>
                      <h4 className="font-bold text-sm text-white mb-1.5 truncate group-hover:text-accent transition-colors">{video.title}</h4>
                      <p className="text-[11px] text-white/50 font-medium truncate flex items-center gap-1.5">
                         {video.location && <span>{video.location}</span>}
                         {video.location && <span>·</span>}
                         <span>{mmss(video.durationSeconds)}</span>
                         <span>·</span>
                         <span>{video.recordedAt ? new Date(video.recordedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : monthYear(video.uploadedAt)}</span>
                      </p>
                    </Link>
                  ))}
                </div>
              )}

            </div>
          </div>
        </div>

      </main>
    </div>
  )
}
