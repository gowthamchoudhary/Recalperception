import { useEffect, useRef, useState, useMemo } from "react";
import { Link } from "wouter";
import Hls from "hls.js";
import { motion, useInView } from "framer-motion";
import { Navbar } from "@/components/layout/Navbar";
import { GlossyButton } from "@/components/ui/glossy-button";
import { StitchedCard } from "@/components/ui/stitched-card";
import { Play, Search, CheckCircle, ArrowRight, Volume2, VolumeX, FileVideo, Mic2, Shield, Search as SearchIconLucide, Brain, Sparkles } from "lucide-react";
import {
  useGetStats,
  useListVideos,
  useGetVideo,
  getGetStatsQueryKey,
  getListVideosQueryKey,
  getGetVideoQueryKey,
  type Video,
  type VideoDetail,
} from "@workspace/api-client-react";
import { useCurrentUser } from "@/lib/auth";

/** Muted, looping HLS preview used in the floating hero cards. */
function HlsLoop({ src, startAt = 0, className, muted = true, onElement }: { src: string; startAt?: number; className?: string; muted?: boolean; onElement?: (el: HTMLVideoElement) => void }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    onElement?.(video);
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
  }, [src, startAt, onElement]);

  return (
    <video
      ref={ref}
      muted={muted}
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

const BrandMark = () => (
  <div
    className="w-5 h-5 rounded-md flex items-center justify-center"
    style={{
      background: "linear-gradient(135deg, #1c8a3e, #0e5024)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3)",
    }}
  />
);

const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8f8f86" strokeWidth="2">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

/** Animated waveform bars for the audio card. */
function AudioWaveform({ isPlaying }: { isPlaying: boolean }) {
  const bars = [12, 22, 16, 30, 20, 26, 14, 24, 18, 28, 16, 20, 24, 12, 18];
  return (
    <div className="flex items-center gap-[3px] h-8">
      {bars.map((h, i) => (
        <motion.span
          key={i}
          className="w-1 rounded-full bg-[#1c8a3e]"
          animate={{
            height: isPlaying ? [h * 0.4, h, h * 0.6, h * 1.1, h * 0.5] : h,
          }}
          transition={{
            duration: 0.9 + Math.random() * 0.4,
            repeat: Infinity,
            repeatType: "reverse",
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}

/** Annotation pill with a dashed connector line. */
function Annotation({
  label,
  top,
  left,
  right,
  lineWidth,
  lineTop,
  lineLeft,
  lineRight,
  rotate,
  color = "#1c8a3e",
}: {
  label: string;
  top?: number | string;
  left?: number | string;
  right?: number | string;
  lineWidth: number;
  lineTop: number | string;
  lineLeft?: number | string;
  lineRight?: number | string;
  rotate: number;
  color?: string;
}) {
  return (
    <>
      <div
        className="absolute z-20 hidden xl:flex items-center gap-1.5 bg-white/90 backdrop-blur-sm border border-[rgba(20,20,15,0.10)] rounded-full px-3 py-1.5 text-[10.5px] font-bold text-[#55554d] whitespace-nowrap"
        style={{ top, left, right, boxShadow: "0 8px 18px -8px rgba(0,0,0,0.18)" }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
        {label}
      </div>
      <div
        className="absolute z-10 hidden xl:block border-t border-dashed border-[rgba(20,20,15,0.35)]"
        style={{
          top: lineTop,
          left: lineLeft,
          right: lineRight,
          width: lineWidth,
          transform: `rotate(${rotate}deg)`,
          transformOrigin: lineLeft !== undefined ? "left center" : "right center",
        }}
      />
    </>
  );
}

/** Floating video card that plays a real user video. */
function FloatingVideoCard({ video }: { video: Video }) {
  return (
    <div
      className="absolute bottom-[100px] left-6 xl:left-10 z-20 w-[150px] xl:w-[190px] float-anim d2"
      style={{ ["--rot" as string]: "-6deg", transform: "rotate(-6deg)" }}
    >
      <StitchedCard
        className="bg-white rounded-[14px] p-2 shadow-[0_18px_34px_-14px_rgba(0,0,0,0.28)] overflow-hidden"
        inset={5}
        radius={9}
      >
        <div className="aspect-[4/3] rounded-[7px] overflow-hidden bg-[#14140f] relative">
          {video.videoUrl ? (
            <HlsLoop src={video.videoUrl} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white/30">
              <Play className="w-8 h-8" />
            </div>
          )}
          <div className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-bold">
            {mmss(video.durationSeconds)}
          </div>
        </div>
        <p className="text-[10px] font-bold text-[#14140f] mt-1.5 truncate px-0.5">{video.title}</p>
        <p className="text-[9px] text-[#55554d] px-0.5">{video.source}</p>
      </StitchedCard>
    </div>
  );
}

/** Floating audio card that can play the audio from a video. */
function FloatingAudioCard({ video, transcriptExcerpt }: { video: Video; transcriptExcerpt?: string | null }) {
  const [playing, setPlaying] = useState(false);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

  const toggle = () => {
    if (!videoEl) return;
    if (playing) {
      videoEl.muted = true;
      videoEl.pause();
      setPlaying(false);
    } else {
      videoEl.muted = false;
      void videoEl.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  useEffect(() => {
    return () => {
      if (videoEl) {
        videoEl.pause();
        videoEl.muted = true;
      }
    };
  }, [videoEl]);

  return (
    <div
      className="absolute top-[260px] right-6 xl:right-10 z-20 w-[180px] xl:w-[220px] float-anim d1"
      style={{ ["--rot" as string]: "4deg", transform: "rotate(4deg)" }}
    >
      <div
        className="rounded-[15px] p-4 text-white border border-white/10"
        style={{ background: "#14140f", boxShadow: "0 22px 44px -14px rgba(0,0,0,0.45)" }}
      >
        <div className="flex items-center justify-between mb-2">
          <p className="font-mono text-[9.5px] text-[#8f8f86]">AUDIO INDEX</p>
          <button
            onClick={toggle}
            className="w-6 h-6 rounded-full bg-[#1c8a3e] flex items-center justify-center hover:bg-[#168033] transition-colors"
            aria-label={playing ? "Pause audio" : "Play audio"}
          >
            {playing ? <Volume2 className="w-3 h-3 text-white" /> : <VolumeX className="w-3 h-3 text-white" />}
          </button>
        </div>
        <AudioWaveform isPlaying={playing} />
        <p className="text-[10px] text-[#9a9a90] mt-2 font-medium truncate">
          {transcriptExcerpt ? `"${transcriptExcerpt.slice(0, 45)}${transcriptExcerpt.length > 45 ? "…" : ""}"` : "Audio transcript indexed"}
        </p>
      </div>
      {video.videoUrl && (
        <HlsLoop src={video.videoUrl} muted={!playing} className="hidden" onElement={setVideoEl} />
      )}
    </div>
  );
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

  const playable = useMemo(
    () => (videos ?? []).filter((v) => v.videoUrl && v.status === "indexed"),
    [videos],
  );
  const featuredVideo = playable[0];
  const { data: featuredDetail } = useGetVideo(featuredVideo?.id ?? 0, {
    query: { enabled: !!featuredVideo, queryKey: getGetVideoQueryKey(featuredVideo?.id ?? 0) },
  });

  return (
    <div className="min-h-screen flex flex-col relative bg-[#f4f4f2]">
      <Navbar variant="public" />

      {/* ── HERO ─────────────────────────────────────────────────────── */}
      <section className="relative flex flex-col items-center justify-center min-h-[auto] md:min-h-[100vh] px-5 sm:px-6 pt-24 md:pt-28 pb-10 md:pb-7 overflow-hidden">
        {/* Soft radial glow */}
        <div
          className="absolute pointer-events-none z-0"
          style={{
            top: "38%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: 900,
            height: 700,
            borderRadius: "50%",
            background: "radial-gradient(circle, #ffffff 0%, rgba(255,255,255,0) 65%)",
          }}
        />

        {/* Floating decorative cards */}
        <div className="hidden xl:block pointer-events-none">
          {/* Left photo stack */}
          <div className="absolute top-[150px] left-9 z-10">
            <div className="float-anim" style={{ ["--rot" as string]: "-8deg", transform: "rotate(-8deg)" }}>
              <StitchedCard
                className="w-[118px] h-[150px] bg-white rounded-[14px] p-2 shadow-[0_18px_34px_-14px_rgba(0,0,0,0.28)]"
                inset={5}
                radius={9}
              >
                <div className="w-full h-full rounded-[7px]" style={{ background: "linear-gradient(160deg, #173f22, #0c1f12)" }} />
              </StitchedCard>
            </div>
            <div className="float-anim d1 absolute top-[120px] left-16 z-20" style={{ ["--rot" as string]: "7deg", transform: "rotate(7deg)" }}>
              <StitchedCard
                className="w-[100px] h-[126px] bg-white rounded-[14px] p-2 shadow-[0_18px_34px_-14px_rgba(0,0,0,0.28)]"
                inset={5}
                radius={9}
              >
                <div className="w-full h-full rounded-[7px]" style={{ background: "linear-gradient(160deg, #2a2a24, #050503)" }} />
              </StitchedCard>
            </div>
          </div>

          <Annotation
            label='Scene extracted · "trekking, mountains"'
            top={140}
            left={172}
            lineTop={150}
            lineLeft={150}
            lineWidth={34}
            rotate={18}
          />
          <Annotation
            label="People detected · 3 faces"
            top={300}
            left={20}
            lineTop={300}
            lineLeft={78}
            lineWidth={30}
            rotate={-10}
            color="#f59e0b"
          />

          {/* Right moment card */}
          <div className="absolute top-[130px] right-9 z-10 w-[220px] float-anim d2" style={{ ["--rot" as string]: "2deg", transform: "rotate(2deg)" }}>
            <div className="rounded-[15px] p-4 text-white" style={{ background: "#14140f", boxShadow: "0 22px 44px -14px rgba(0,0,0,0.45)" }}>
              <p className="font-mono text-[9.5px] text-[#8f8f86] mb-1.5">MOMENT FOUND</p>
              <p className="text-sm font-bold leading-snug mb-2">
                {featuredDetail?.transcriptExcerpt
                  ? `"${featuredDetail.transcriptExcerpt.slice(0, 60)}${featuredDetail.transcriptExcerpt.length > 60 ? "…" : ""}"`
                  : '"We finally made it to the top..."'}
              </p>
              <div className="flex gap-[2px] items-end h-3.5 mt-2">
                {[5, 10, 14, 8, 12, 6, 11, 14, 7].map((h, i) => (
                  <span key={i} className="w-0.5 rounded-sm" style={{ height: `${h}px`, background: "#1c8a3e" }} />
                ))}
              </div>
            </div>
          </div>

          <Annotation
            label="Audio transcript indexed"
            top={100}
            right={78}
            lineTop={112}
            lineRight={110}
            lineWidth={30}
            rotate={-25}
            color="#3b82f6"
          />

          {/* Bottom right clip card */}
          <div className="absolute bottom-16 right-10 z-10 float-anim d1" style={{ ["--rot" as string]: "-3deg", transform: "rotate(-3deg)" }}>
            <div className="w-[170px] bg-white rounded-xl p-2.5 flex gap-2.5 items-center border border-[rgba(20,20,15,0.10)] shadow-[0_16px_32px_-14px_rgba(0,0,0,0.2)]">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "linear-gradient(135deg, #2a2a24, #050503)" }}>
                <Play className="w-3 h-3 text-white fill-white" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-bold truncate leading-tight">{featuredVideo?.title ?? "Sarah's 30th"}</p>
                <p className="text-[9.5px] text-[#55554d] font-medium">{featuredVideo ? `Indexed · ${mmss(featuredVideo.durationSeconds)}` : "Indexed · 3 people"}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Real-user floating video + audio cards — shown when logged in */}
        {featuredVideo && (
          <>
            <FloatingVideoCard video={featuredVideo} />
            <FloatingAudioCard video={featuredVideo} transcriptExcerpt={featuredDetail?.transcriptExcerpt} />
          </>
        )}

        {/* Hero text + CTA */}
        <div className="relative z-30 text-center max-w-[820px]">
          <span
            className="inline-flex items-center gap-2 mb-4 text-[13.5px] font-bold text-[#14140f]"
            style={{
              padding: "8px 18px",
              borderRadius: 999,
              background: "linear-gradient(180deg, #ffffff, #f1f1ee)",
              border: "1px solid #e2e2dd",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9), 0 6px 16px -6px rgba(0,0,0,0.12)",
            }}
          >
            <CheckCircle className="w-3.5 h-3.5 text-[#1c8a3e]" />
            For your gallery, Google Photos, or YouTube
          </span>

          <h1 className="text-[32px] sm:text-[38px] md:text-[52px] font-extrabold tracking-[-0.03em] leading-[1.08] text-[#14140f]">
            Everything you've <span className="text-[#1c8a3e]">filmed.</span>
            <br className="hidden md:block" />
            <span
              className="font-mono font-semibold text-white px-3 py-1 md:px-3.5 rounded-lg inline-block mx-1"
              style={{ background: "#14140f", transform: "rotate(-1.5deg)", boxShadow: "0 6px 14px -6px rgba(0,0,0,0.4)" }}
            >
              Found.
            </span>
          </h1>

          <p className="mt-4 md:mt-5 text-[15.5px] text-[#55554d] font-medium leading-relaxed max-w-xl mx-auto">
            Search a lifetime of video like it's one searchable memory — by what was said, what happened, and who was there.
          </p>

          <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-5">
            <GlossyButton variant="dark" href={authed ? "/dashboard" : "/login"} icon={<ArrowRight className="w-4 h-4" />} className="px-6 py-3.5 text-[15px]">
              {authed ? "Open your library" : "Start searching"}
            </GlossyButton>
            <a href="#how" className="text-[15px] font-semibold text-[#55554d] hover:text-[#14140f] border-b border-transparent hover:border-[#14140f] transition-colors pb-0.5">
              See how indexing works
            </a>
          </div>
        </div>

        {/* ── App Preview Panel ────────────────────────────────────── */}
        <div className="relative z-20 w-full max-w-[800px] mt-7 md:mt-8">
          {/* Peak-creativity gradient behind the search bar */}
          <div
            className="absolute -inset-1 rounded-[28px] blur-lg opacity-80 -z-10"
            style={{
              background:
                "conic-gradient(from 180deg at 50% 50%, #1c8a3e 0deg, #3b82f6 60deg, #a855f7 120deg, #ec4899 180deg, #f59e0b 240deg, #1c8a3e 360deg)",
            }}
          />
          <div
            className="rounded-[24px] md:rounded-[28px] p-5 md:p-7 border border-[rgba(255,255,255,0.08)]"
            style={{
              background: "linear-gradient(180deg, #1b1b16, #0d0d0a)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 40px 70px -20px rgba(0,0,0,0.55)",
            }}
          >
            {/* Top bar */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2 text-white font-extrabold text-[14.5px]">
                <BrandMark />
                recall
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className="text-[11.5px] font-bold px-3 py-1.5 rounded-full"
                  style={{ background: "linear-gradient(180deg, #ffffff, #e8e8e8)", color: "#111", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 10px -4px rgba(0,0,0,0.3)" }}
                >
                  Library {authed && stats?.totalVideos !== undefined ? stats.totalVideos : ""}
                </span>
                <span className="text-[11.5px] font-bold px-3 py-1.5 rounded-full text-[#9a9a90]">People {authed && stats?.totalPeople !== undefined ? stats.totalPeople : ""}</span>
                <span className="text-[11.5px] font-bold px-3 py-1.5 rounded-full text-[#9a9a90]">Review {authed && stats?.pendingReviewCount ? stats.pendingReviewCount : ""}</span>
              </div>
            </div>

            {/* Gradient search glass — expanded and taller */}
            <Link href={authed ? "/dashboard" : "/login"} className="block relative group mb-5 cursor-text">
              <div className="absolute inset-0 rounded-full -z-10 opacity-70 group-hover:opacity-100 transition-opacity duration-500" style={{ background: "linear-gradient(90deg, #1c8a3e, #3b82f6, #a855f7, #ec4899, #f59e0b)", filter: "blur(12px)" }} />
              <div
                className="flex items-center gap-3 rounded-full px-5 py-4 md:py-5"
                style={{
                  background: "linear-gradient(180deg, #222219, #17170f)",
                  border: "1px solid #33332a",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -1px 6px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.2)",
                }}
              >
                <SearchIcon />
                <span className="text-[14px] md:text-[15px] font-medium text-[#8f8f86]">Ask anything about your memories...</span>
              </div>
            </Link>

            {/* Preview grid */}
            {!authed ? (
              <div className="py-6 flex flex-col items-center text-center">
                <p className="text-[#8f8f86] font-medium mb-4 max-w-md text-sm">Log in to see your library here — every upload is transcribed, indexed, and privacy-scanned automatically.</p>
                <GlossyButton variant="light" href="/login" className="px-5 py-2.5 text-[13.5px]">
                  Sign in to your archive
                </GlossyButton>
              </div>
            ) : isLoadingVideos ? (
              <div className="flex gap-3 overflow-hidden">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="w-[140px] sm:w-[160px] md:flex-1 md:min-w-0 shrink-0 animate-pulse">
                    <div className="aspect-[4/3] bg-white/5 rounded-[10px]" />
                    <div className="h-3.5 bg-white/5 rounded w-3/4 mt-1.5" />
                    <div className="h-3 bg-white/5 rounded w-1/2 mt-1" />
                  </div>
                ))}
              </div>
            ) : (videos?.length ?? 0) === 0 ? (
              <div className="py-6 flex flex-col items-center text-center">
                <p className="text-[#8f8f86] font-medium mb-4 max-w-md text-sm">Your library is empty. Upload your first video and it will show up here, fully searchable.</p>
                <GlossyButton variant="light" href="/dashboard" className="px-5 py-2.5 text-[13.5px]">
                  Upload a video
                </GlossyButton>
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {videos!.slice(0, 4).map((video) => (
                  <Link key={video.id} href="/dashboard" className="w-[140px] sm:w-[160px] md:flex-1 md:min-w-0 shrink-0 group snap-start block">
                    <div className="aspect-[4/3] rounded-[10px] overflow-hidden border border-[#2a2a24] bg-gradient-to-br from-[#2a2a24] to-[#0c0c08]">
                      {video.thumbnailUrl ? (
                        <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity group-hover:scale-105 duration-500" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-white/20">
                          <Play className="w-7 h-7" />
                        </div>
                      )}
                    </div>
                    <p className="text-[11px] font-bold text-[#eee] mt-1.5 truncate group-hover:text-[#1c8a3e] transition-colors">{video.title}</p>
                    <p className="text-[9.5px] text-[#8f8f86] truncate">
                      {video.location && <span>{video.location} · </span>}
                      {mmss(video.durationSeconds)} · {video.recordedAt ? new Date(video.recordedAt).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : monthYear(video.uploadedAt)}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────────── */}
      <HowItWorks />

      {/* ── WHY RECALL ───────────────────────────────────────────────── */}
      <WhyRecall />

      <style>{`
        @keyframes bob {
          0%, 100% { transform: translateY(0) rotate(var(--rot, 0deg)); }
          50% { transform: translateY(-8px) rotate(var(--rot, 0deg)); }
        }
        .float-anim { animation: bob 6s ease-in-out infinite; }
        .float-anim.d1 { animation-delay: 0.8s; }
        .float-anim.d2 { animation-delay: 1.6s; }
      `}</style>
    </div>
  );
}

/** Advanced "How It Works" section with scroll-triggered animations. */
function HowItWorks() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-100px" });

  const steps = [
    {
      num: "01",
      title: "Bring your videos",
      body: "Drag in a folder, connect Google Photos, or pull from your YouTube channel — all in one batch.",
      icon: FileVideo,
      color: "#1c8a3e",
    },
    {
      num: "02",
      title: "We index everything",
      body: "Every video is understood two ways at once — what was said, and what was visually happening.",
      icon: Brain,
      color: "#3b82f6",
    },
    {
      num: "03",
      title: "You stay in control",
      body: "Anything sensitive is quietly set aside for your review — nothing searchable without your say-so.",
      icon: Shield,
      color: "#a855f7",
    },
    {
      num: "04",
      title: "Just ask",
      body: "Type what you remember, in plain language, and get back the exact clip and moment.",
      icon: SearchIconLucide,
      color: "#ec4899",
    },
  ];

  return (
    <section id="how" className="px-6 py-24 md:py-32 max-w-[1200px] mx-auto overflow-hidden">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="text-center mb-16 md:mb-20"
        ref={ref}
      >
        <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-[12px] font-bold text-[#1c8a3e] bg-white border border-[rgba(20,20,15,0.08)] shadow-sm mb-4">
          <Sparkles className="w-3.5 h-3.5" />
          HOW IT WORKS
        </span>
        <h2 className="text-[30px] md:text-[44px] font-extrabold tracking-[-0.02em] text-[#14140f] max-w-[680px] mx-auto leading-tight">
          From a folder of unsearchable footage to one search bar.
        </h2>
      </motion.div>

      <div className="relative">
        {/* Connecting gradient line */}
        <div className="hidden lg:block absolute top-[88px] left-[12.5%] right-[12.5%] h-0.5 bg-gradient-to-r from-[#1c8a3e] via-[#3b82f6] to-[#ec4899] opacity-20 rounded-full" />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {steps.map((step, i) => (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, y: 40 }}
              animate={inView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.1 + i * 0.12, ease: "easeOut" }}
            >
              <div className="group relative h-full bg-white rounded-[22px] p-6 border border-[rgba(20,20,15,0.08)] hover:shadow-[0_20px_50px_-20px_rgba(0,0,0,0.15)] hover:-translate-y-1.5 transition-all duration-300">
                <div
                  className="w-12 h-12 rounded-[14px] flex items-center justify-center mb-5 text-white shadow-lg"
                  style={{ background: `linear-gradient(135deg, ${step.color}, ${step.color}dd)` }}
                >
                  <step.icon className="w-5 h-5" />
                </div>
                <p className="font-mono text-[12px] font-bold mb-2" style={{ color: step.color }}>
                  {step.num}
                </p>
                <h3 className="text-[18px] md:text-[20px] font-extrabold text-[#14140f] mb-3">{step.title}</h3>
                <p className="text-[14px] text-[#55554d] leading-relaxed">{step.body}</p>

                {/* Glow on hover */}
                <div
                  className="absolute inset-0 rounded-[22px] opacity-0 group-hover:opacity-100 transition-opacity duration-500 -z-10"
                  style={{ background: `radial-gradient(circle at 50% 0%, ${step.color}15, transparent 70%)` }}
                />
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Advanced "Why Recall" section with bright, light SaaS cards. */
function WhyRecall() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-100px" });

  const cards = [
    {
      title: "Video is unsearchable by default",
      body: "Notes and docs are trivial to search. A thousand personal videos are not — until now.",
      icon: FileVideo,
      gradient: "linear-gradient(135deg, #1c8a3e, #0e5024)",
      bg: "radial-gradient(circle at 50% 0%, rgba(28,138,62,0.12), transparent 60%)",
    },
    {
      title: "Understands what happened, not just what was said",
      body: "Even silent clips and screen recordings are searchable by what's visually in them.",
      icon: Brain,
      gradient: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
      bg: "radial-gradient(circle at 50% 0%, rgba(59,130,246,0.12), transparent 60%)",
    },
    {
      title: "Private by design",
      body: "Sensitive moments are flagged before they're ever searchable — you decide what stays.",
      icon: Shield,
      gradient: "linear-gradient(135deg, #a855f7, #7e22ce)",
      bg: "radial-gradient(circle at 50% 0%, rgba(168,85,247,0.12), transparent 60%)",
    },
  ];

  return (
    <section className="px-6 py-24 md:py-32 max-w-[1200px] mx-auto overflow-hidden">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="text-center mb-16 md:mb-20"
        ref={ref}
      >
        <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-[12px] font-bold text-[#3b82f6] bg-white border border-[rgba(20,20,15,0.08)] shadow-sm mb-4">
          <Mic2 className="w-3.5 h-3.5" />
          WHY RECALL
        </span>
        <h2 className="text-[30px] md:text-[44px] font-extrabold tracking-[-0.02em] text-[#14140f] max-w-[720px] mx-auto leading-tight">
          Text got a second brain years ago. <span className="text-[#3b82f6]">Video never did.</span>
        </h2>
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {cards.map((card, i) => (
          <motion.div
            key={card.title}
            initial={{ opacity: 0, y: 40, scale: 0.96 }}
            animate={inView ? { opacity: 1, y: 0, scale: 1 } : {}}
            transition={{ duration: 0.55, delay: 0.15 + i * 0.12, ease: "easeOut" }}
          >
            <div
              className="group relative h-full rounded-[24px] p-7 border border-[rgba(20,20,15,0.08)] hover:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.18)] hover:-translate-y-2 transition-all duration-300 overflow-hidden"
              style={{ background: "#fff" }}
            >
              {/* Soft gradient glow behind the card */}
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 -z-10" style={{ background: card.bg }} />

              <div
                className="w-14 h-14 rounded-[16px] flex items-center justify-center mb-5 text-white shadow-lg"
                style={{ background: card.gradient }}
              >
                <card.icon className="w-6 h-6" />
              </div>
              <h3 className="text-[19px] md:text-[21px] font-extrabold text-[#14140f] mb-3 leading-snug">{card.title}</h3>
              <p className="text-[14.5px] text-[#55554d] leading-relaxed">{card.body}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
