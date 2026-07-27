import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import Hls from "hls.js";
import { motion, useInView } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Navbar } from "@/components/layout/Navbar";
import { GlossyButton } from "@/components/ui/glossy-button";
import { StitchedCard } from "@/components/ui/stitched-card";
import { Play, Search, CheckCircle, ArrowRight, Volume2, VolumeX, FileVideo, Mic2, Shield, Search as SearchIconLucide, Brain, Sparkles } from "lucide-react";
import {
  useGetStats,
  useListVideos,
  getGetStatsQueryKey,
  getListVideosQueryKey,
  type Video,
} from "@workspace/api-client-react";
import { useCurrentUser } from "@/lib/auth";
import { Users, Eye } from "lucide-react";

// Demo assets shown on the landing page before the user uploads anything.
const DEMO = {
  audio: "/audio/landing-vlog.mp3",
  videos: [
    { src: "/videos/landing-stuck-in-traffic.mp4", title: "Stuck in traffic", tag: "vlog", scene: "car interior, traffic, driver" },
    { src: "/videos/landing-friends-enjoying.mp4", title: "Friends enjoying", tag: "friends", scene: "people laughing, cafe, group" },
    { src: "/videos/landing-juggling-football.mp4", title: "Juggling football", tag: "sport", scene: "football, park, juggling" },
  ],
  hackathon: {
    src: "/videos/landing-hackathon-demo.mp4",
    title: "Recall demo",
    tag: "demo",
    scene: "search interface, video results, transcript",
  },
} as const;

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
  bottom,
  left,
  right,
  lineWidth,
  lineTop,
  lineBottom,
  lineLeft,
  lineRight,
  rotate,
  color = "#1c8a3e",
}: {
  label: string;
  top?: number | string;
  bottom?: number | string;
  left?: number | string;
  right?: number | string;
  lineWidth: number;
  lineTop?: number | string;
  lineBottom?: number | string;
  lineLeft?: number | string;
  lineRight?: number | string;
  rotate: number;
  color?: string;
}) {
  return (
    <>
      <div
        className="absolute z-20 hidden xl:flex items-center gap-1.5 bg-white/90 backdrop-blur-sm border border-[rgba(20,20,15,0.10)] rounded-full px-3 py-1.5 text-[10.5px] font-bold text-[#55554d] whitespace-nowrap"
        style={{ top, bottom, left, right, boxShadow: "0 8px 18px -8px rgba(0,0,0,0.18)" }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
        {label}
      </div>
      <div
        className="absolute z-10 hidden xl:block border-t border-dashed border-[rgba(20,20,15,0.35)]"
        style={{
          top: lineTop,
          bottom: lineBottom,
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

/** Floating audio card that plays the demo vlog MP3. */
function FloatingAudioCard({ audioSrc, transcriptExcerpt }: { audioSrc: string; transcriptExcerpt?: string | null }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => setPlaying(false);
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("play", onPlay);
    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("play", onPlay);
    };
  }, []);

  return (
    <div
      className="hidden lg:block absolute top-[260px] right-6 xl:right-10 z-20 w-[180px] xl:w-[220px] float-anim d1"
      style={{ ["--rot" as string]: "4deg", transform: "rotate(4deg)" }}
    >
      <div
        className="rounded-[15px] p-4 text-white border border-white/10"
        style={{ background: "#14140f", boxShadow: "0 22px 44px -14px rgba(0,0,0,0.45)" }}
      >
        <div className="flex items-center justify-between mb-2">
          <p className="font-mono text-[9.5px] text-[#8f8f86]">VLOG AUDIO</p>
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
          {transcriptExcerpt ? `"${transcriptExcerpt.slice(0, 45)}${transcriptExcerpt.length > 45 ? "…" : ""}"` : '"…and that\'s why the fridge was on the roof."'}
        </p>
      </div>
      <audio ref={audioRef} src={audioSrc} loop className="hidden" />
    </div>
  );
}

type HeroVideo = Video & { transcriptExcerpt?: string | null };

async function fetchHeroVideos(): Promise<{ teacher: HeroVideo | null; podcast: HeroVideo | null }> {
  const res = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/videos/hero`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load hero videos");
  return (await res.json()) as { teacher: HeroVideo | null; podcast: HeroVideo | null };
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
  const { data: hero } = useQuery({
    queryKey: ["hero-videos"],
    queryFn: fetchHeroVideos,
    enabled: authed,
  });

  const teacherVideo = hero?.teacher;
  const podcastVideo = hero?.podcast;

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
          {/* Left floating video stack — 3 scene-extracted demo cards */}
          <div className="absolute top-[150px] left-7 xl:left-9 z-10">
            {/* Card 1 — stuck in traffic */}
            <div className="float-anim" style={{ ["--rot" as string]: "-8deg", transform: "rotate(-8deg)" }}>
              <StitchedCard
                className="w-[140px] h-[176px] xl:w-[150px] xl:h-[190px] bg-white rounded-[16px] p-2 shadow-[0_18px_34px_-14px_rgba(0,0,0,0.28)]"
                inset={5}
                radius={9}
              >
                <div className="w-full h-full rounded-[8px] overflow-hidden bg-[#14140f]">
                  <video src={DEMO.videos[0].src} muted loop playsInline autoPlay className="w-full h-full object-cover" />
                </div>
              </StitchedCard>
            </div>
            {/* Card 2 — friends enjoying */}
            <div className="float-anim d1 absolute top-[150px] left-20 xl:left-24 z-20" style={{ ["--rot" as string]: "7deg", transform: "rotate(7deg)" }}>
              <StitchedCard
                className="w-[135px] h-[170px] xl:w-[145px] xl:h-[184px] bg-white rounded-[16px] p-2 shadow-[0_18px_34px_-14px_rgba(0,0,0,0.28)]"
                inset={5}
                radius={9}
              >
                <div className="w-full h-full rounded-[8px] overflow-hidden bg-[#14140f]">
                  <video src={DEMO.videos[1].src} muted loop playsInline autoPlay className="w-full h-full object-cover" />
                </div>
              </StitchedCard>
            </div>
            {/* Card 3 — juggling football */}
            <div className="float-anim d2 absolute top-[300px] left-2 xl:left-4 z-30" style={{ ["--rot" as string]: "-4deg", transform: "rotate(-4deg)" }}>
              <StitchedCard
                className="w-[140px] h-[176px] xl:w-[150px] xl:h-[190px] bg-white rounded-[16px] p-2 shadow-[0_18px_34px_-14px_rgba(0,0,0,0.28)]"
                inset={5}
                radius={9}
              >
                <div className="w-full h-full rounded-[8px] overflow-hidden bg-[#14140f]">
                  <video src={DEMO.videos[2].src} muted loop playsInline autoPlay className="w-full h-full object-cover" />
                </div>
              </StitchedCard>
            </div>
          </div>

          <Annotation
            label={`Scene extracted · "${DEMO.videos[0].scene}"`}
            top={150}
            left={210}
            lineTop={170}
            lineLeft={150}
            lineWidth={60}
            rotate={18}
          />
          <Annotation
            label={`Scene extracted · "${DEMO.videos[1].scene}"`}
            top={330}
            left={240}
            lineTop={335}
            lineLeft={165}
            lineWidth={75}
            rotate={-8}
            color="#3b82f6"
          />
          <Annotation
            label={`Scene extracted · "${DEMO.videos[2].scene}"`}
            top={480}
            left={215}
            lineTop={470}
            lineLeft={150}
            lineWidth={65}
            rotate={-18}
            color="#a855f7"
          />

          {/* Right moment card — podcast / gold moment */}
          <div className="absolute top-[130px] right-9 z-10 w-[220px] float-anim d2" style={{ ["--rot" as string]: "2deg", transform: "rotate(2deg)" }}>
            <div className="rounded-[15px] p-4 text-white" style={{ background: "#14140f", boxShadow: "0 22px 44px -14px rgba(0,0,0,0.45)" }}>
              <p className="font-mono text-[9.5px] text-[#8f8f86] mb-1.5">GOLD MOMENT</p>
              <p className="text-sm font-bold leading-snug mb-2">
                {podcastVideo?.transcriptExcerpt
                  ? `"${podcastVideo.transcriptExcerpt.slice(0, 60)}${podcastVideo.transcriptExcerpt.length > 60 ? "…" : ""}"`
                  : '"Wait, did I just say that out loud? ... yeah, we\'re keeping it in."'}
              </p>
              <div className="flex gap-[2px] items-end h-3.5 mt-2">
                {[5, 10, 14, 8, 12, 6, 11, 14, 7].map((h, i) => (
                  <span key={i} className="w-0.5 rounded-sm" style={{ height: `${h}px`, background: "#a855f7" }} />
                ))}
              </div>
            </div>
          </div>

          <Annotation
            label="Podcast transcript indexed"
            top={100}
            right={78}
            lineTop={112}
            lineRight={110}
            lineWidth={30}
            rotate={-25}
            color="#a855f7"
          />

          {/* Bottom right — hackathon demo video card with scene extraction */}
          <div className="absolute bottom-16 right-10 z-10 float-anim d1" style={{ ["--rot" as string]: "-3deg", transform: "rotate(-3deg)" }}>
            <StitchedCard
              className="w-[165px] xl:w-[190px] bg-white rounded-[16px] p-2 shadow-[0_18px_34px_-14px_rgba(0,0,0,0.28)]"
              inset={5}
              radius={9}
            >
              <div className="w-full h-[135px] xl:h-[150px] rounded-[8px] overflow-hidden bg-[#14140f]">
                <video src={DEMO.hackathon.src} muted loop playsInline autoPlay className="w-full h-full object-cover" />
              </div>
            </StitchedCard>
          </div>

          <Annotation
            label={`Scene extracted · "${DEMO.hackathon.scene}"`}
            bottom={160}
            right={230}
            lineBottom={120}
            lineRight={220}
            lineWidth={30}
            rotate={-20}
            color="#ec4899"
          />
        </div>

        {/* Floating audio card — demo vlog MP3, desktop only */}
        <FloatingAudioCard audioSrc={DEMO.audio} transcriptExcerpt={podcastVideo?.transcriptExcerpt} />

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
                <span className="hidden sm:inline-flex text-[11.5px] font-bold px-3 py-1.5 rounded-full text-[#9a9a90]">People {authed && stats?.totalPeople !== undefined ? stats.totalPeople : ""}</span>
                <span className="sm:hidden w-8 h-8 rounded-full flex items-center justify-center text-[#9a9a90]" title="People">
                  <Users className="w-4 h-4" />
                </span>
                <span className="hidden sm:inline-flex text-[11.5px] font-bold px-3 py-1.5 rounded-full text-[#9a9a90]">Review {authed && stats?.pendingReviewCount ? stats.pendingReviewCount : ""}</span>
                <span className="sm:hidden w-8 h-8 rounded-full flex items-center justify-center text-[#9a9a90]" title="Review">
                  <Eye className="w-4 h-4" />
                </span>
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

            {/* Preview grid — demo videos always first, then user videos */}
            {isLoadingVideos && authed ? (
              <div className="flex gap-3 overflow-hidden">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="w-[140px] sm:w-[160px] md:flex-1 md:min-w-0 shrink-0 animate-pulse">
                    <div className="aspect-[4/3] bg-white/5 rounded-[10px]" />
                    <div className="h-3.5 bg-white/5 rounded w-3/4 mt-1.5" />
                    <div className="h-3 bg-white/5 rounded w-1/2 mt-1" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {DEMO.videos.map((demo, i) => (
                  <Link key={`demo-${i}`} href={authed ? "/dashboard" : "/login"} className="w-[140px] sm:w-[160px] md:flex-1 md:min-w-0 shrink-0 group snap-start block">
                    <div className="aspect-[4/3] rounded-[10px] overflow-hidden border border-[#2a2a24] bg-gradient-to-br from-[#2a2a24] to-[#0c0c08] relative">
                      <video src={demo.src} muted loop playsInline autoPlay className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity group-hover:scale-105 duration-500" />
                      <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[8px] font-bold uppercase">Demo</div>
                    </div>
                    <p className="text-[11px] font-bold text-[#eee] mt-1.5 truncate group-hover:text-[#1c8a3e] transition-colors">{demo.title}</p>
                    <p className="text-[9.5px] text-[#8f8f86] truncate">{demo.tag} · demo</p>
                  </Link>
                ))}
                {authed && (videos ?? []).slice(0, 4).map((video) => (
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

        /* ── Process section (How It Works) ─────────────────────── */
        .process { display:flex; flex-direction:column; gap:110px; max-width:1080px; margin:0 auto; }
        .p-row { display:flex; align-items:center; gap:70px; position:relative; }
        .p-row.rev { flex-direction:row-reverse; }
        .p-text { flex:0 0 380px; position:relative; z-index:2; }
        .p-visual { flex:1; position:relative; min-height:260px; display:flex; align-items:center; justify-content:center; }
        .p-icon {
          width:46px; height:46px; border-radius:13px; margin-bottom:20px;
          display:flex; align-items:center; justify-content:center;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), 0 12px 22px -10px rgba(0,0,0,0.35);
        }
        .p-icon svg { width:22px; height:22px; }
        .p-text h3 { font-size:23px; font-weight:800; letter-spacing:-0.015em; margin-bottom:11px; line-height:1.25; color:#14140f; }
        .p-text p { font-size:14.5px; color:#55554d; line-height:1.65; }
        .p-tech {
          display:inline-flex; align-items:center; gap:6px; margin-top:16px;
          font-family:'JetBrains Mono', monospace; font-size:10.5px; font-weight:600; color:#1c8a3e;
          background:rgba(28,138,62,0.08); border:1px solid rgba(28,138,62,0.18);
          padding:5px 12px; border-radius:999px;
        }
        .p-ghost {
          position:absolute; z-index:0; font-family:'JetBrains Mono', monospace; font-weight:700;
          font-size:150px; color:#14140f; opacity:0.045; line-height:1; user-select:none; pointer-events:none;
          top:50%; left:50%; transform:translate(-50%,-50%);
        }
        .p-blob { position:absolute; z-index:0; border-radius:50%; filter:blur(36px); opacity:0.5; pointer-events:none; }
        .mock {
          position:relative; z-index:1; width:280px; background:#fff; border-radius:16px;
          border:1px solid rgba(20,20,15,0.10); box-shadow:0 30px 60px -22px rgba(0,0,0,0.28);
          padding:18px;
        }
        .mock .mhead { display:flex; align-items:center; gap:6px; margin-bottom:14px; }
        .mock .mdot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
        .mock .mtitle { font-size:10.5px; font-weight:700; color:#9a9a90; margin-left:4px; }
        .mock-drop { border:1.5px dashed rgba(20,20,15,0.25); border-radius:11px; padding:18px 10px; text-align:center; }
        .mock-drop .mu-icon { width:30px; height:30px; border-radius:9px; background:linear-gradient(135deg,#1c8a3e,#0e5024); margin:0 auto 8px; display:flex; align-items:center; justify-content:center; }
        .mock-drop .mu-icon svg { width:15px; height:15px; }
        .mock-drop span { font-size:11px; font-weight:700; color:#55554d; display:block; }
        .mock-drop .fname { margin-top:10px; background:#f4f4f2; border-radius:8px; padding:6px 8px; font-size:9.5px; text-align:left; color:#55554d; font-family:'JetBrains Mono',monospace; }
        .mock-flag { background:#f4f4f2; border-radius:11px; padding:12px; display:flex; gap:10px; align-items:center; }
        .mock-flag .fthumb { width:38px; height:38px; border-radius:8px; background:linear-gradient(135deg,#2a2a24,#0c0c08); flex-shrink:0; }
        .mock-flag .fbody { flex:1; min-width:0; }
        .mock-flag .flabel { font-size:9px; font-weight:700; color:#c26a1a; background:#fdf0e2; display:inline-block; padding:2px 7px; border-radius:5px; margin-bottom:4px; }
        .mock-flag .freason { font-size:9.5px; color:#55554d; }
        .mock-actions { display:flex; gap:6px; margin-top:12px; }
        .mock-actions .ma { flex:1; text-align:center; font-size:9.5px; font-weight:700; padding:7px 0; border-radius:8px; cursor:default; }
        .mock-actions .ma.accept { background:linear-gradient(180deg,#414141,#030303); color:#fff; }
        .mock-actions .ma.discard { background:#eee; color:#555; }
        .mock-dual { display:flex; gap:8px; }
        .mock-dual .col { flex:1; background:#f4f4f2; border-radius:10px; padding:10px; }
        .mock-dual .col-label { font-size:8.5px; font-weight:700; color:#9a9a90; margin-bottom:8px; }
        .mock-wave { display:flex; align-items:flex-end; gap:2px; height:26px; }
        .mock-wave span { width:3px; background:#1c8a3e; border-radius:2px; }
        .mock-scene-txt { font-size:9px; color:#55554d; line-height:1.5; font-style:italic; }
        .mock-face { display:flex; align-items:center; gap:10px; }
        .mock-avatar { width:40px; height:40px; border-radius:50%; background:linear-gradient(135deg,#d8503f,#8f2a1f); flex-shrink:0; border:2px solid #fff; box-shadow:0 0 0 1px rgba(20,20,15,0.10); }
        .mock-tl { flex:1; }
        .mock-tl .mtl-label { font-size:9px; font-weight:700; color:#55554d; margin-bottom:6px; }
        .mock-tl-bar { height:8px; border-radius:5px; background:#eee; position:relative; overflow:hidden; }
        .mock-tl-bar span { position:absolute; top:0; bottom:0; background:#1c8a3e; border-radius:5px; }
        .mock-chat { display:flex; flex-direction:column; gap:8px; }
        .mock-bubble { font-size:10px; padding:8px 11px; border-radius:12px; max-width:88%; line-height:1.4; }
        .mock-bubble.user { align-self:flex-end; background:linear-gradient(180deg,#414141,#030303); color:#fff; border-bottom-right-radius:3px; }
        .mock-bubble.ai { align-self:flex-start; background:#f4f4f2; color:#55554d; border-bottom-left-radius:3px; }
        .mock-chips { display:flex; gap:5px; flex-wrap:wrap; margin-top:2px; }
        .mock-chip { font-size:8.5px; font-weight:700; padding:4px 9px; border-radius:999px; background:#eee; color:#999; }
        .mock-chip.active { background:rgba(28,138,62,0.12); color:#1c8a3e; border:1px solid rgba(28,138,62,0.3); }
        .mock-trim .mtrim-track { height:6px; border-radius:4px; background:#eee; position:relative; margin:16px 0 10px; }
        .mock-trim .mtrim-sel { position:absolute; top:0; bottom:0; background:#14140f; border-radius:4px; }
        .mock-trim .mtrim-handle { position:absolute; top:50%; width:12px; height:12px; border-radius:50%; background:#fff; border:2px solid #14140f; transform:translate(-50%,-50%); }
        .mock-trim .mtrim-btn { text-align:center; font-size:10px; font-weight:700; background:linear-gradient(180deg,#414141,#030303); color:#fff; padding:8px 0; border-radius:9px; }

        /* ── Why Recall cards ───────────────────────────────────── */
        .why-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; }
        .why-card { background:#fff; border-radius:16px; padding:24px; border:1px solid rgba(20,20,15,0.10); box-shadow:0 10px 26px -14px rgba(0,0,0,0.10); }
        .why-card .ic { width:38px; height:38px; border-radius:10px; margin-bottom:14px; display:flex; align-items:center; justify-content:center; box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), 0 8px 16px -8px rgba(0,0,0,0.3); }
        .why-card .ic svg { width:18px; height:18px; }
        .why-card h3 { font-size:16px; font-weight:800; margin-bottom:8px; color:#14140f; }
        .why-card p { font-size:13.5px; color:#55554d; line-height:1.55; }

        @media (max-width: 900px) {
          .p-row, .p-row.rev { flex-direction:column; gap:34px; }
          .p-text { flex:none; text-align:center; }
          .p-tech { margin-left:auto; margin-right:auto; }
          .p-ghost { font-size:100px; }
          .why-grid { grid-template-columns:1fr 1fr; }
        }
        @media (max-width: 560px) {
          .why-grid { grid-template-columns:1fr; }
        }
      `}</style>
    </div>
  );
}

/** How It Works — six alternating rows, each with icon badge, ghost numeral, color blob, and mini mockup. */
function HowItWorks() {
  return (
    <section id="how" style={{ padding: "90px 24px", maxWidth: 1100, margin: "0 auto" }}>
      <p className="font-mono text-[12px] font-bold text-center text-[#1c8a3e] tracking-[0.04em] mb-2.5">THE MECHANISM</p>
      <h2 style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-0.02em", textAlign: "center", maxWidth: 640, margin: "0 auto 50px", lineHeight: 1.2, color: "#14140f" }}>
        Not a search bar bolted onto a video player. A real pipeline.
      </h2>

      <div className="process">

        {/* 01 — Ingest */}
        <div className="p-row">
          <div className="p-text">
            <div className="p-icon" style={{ background: "linear-gradient(135deg,#1c8a3e,#0e5024)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M12 15V3m0 0 4 4m-4-4L8 7"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
            </div>
            <h3>Ingest, in one batch</h3>
            <p>Drag in a folder, connect Google Photos, or pull from your YouTube channel. Every video processes independently — one flagged or failed file never blocks the rest.</p>
            <span className="p-tech">Batch upload · async pipeline</span>
          </div>
          <div className="p-visual">
            <div className="p-ghost">01</div>
            <div className="p-blob" style={{ width: 260, height: 260, background: "#1c8a3e", top: "50%", left: "60%", transform: "translate(-50%,-50%)" }} />
            <div className="mock" style={{ transform: "rotate(-2deg)" }}>
              <div className="mhead">
                <div className="mdot" style={{ background: "#ff5f57" }} />
                <div className="mdot" style={{ background: "#febc2e" }} />
                <div className="mdot" style={{ background: "#28c840" }} />
              </div>
              <div className="mock-drop">
                <div className="mu-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2"><path d="M12 16V4m0 0 4 4m-4-4-4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
                </div>
                <span>Drop videos or select a folder</span>
                <div className="fname">✓ 43 files queued</div>
              </div>
            </div>
          </div>
        </div>

        {/* 02 — Privacy scan */}
        <div className="p-row rev">
          <div className="p-text">
            <div className="p-icon" style={{ background: "linear-gradient(135deg,#5b4bda,#332a8a)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M12 2 4 5v6c0 5 3.4 8.4 8 11 4.6-2.6 8-6 8-11V5l-8-3Z"/></svg>
            </div>
            <h3>Privacy scan, before anything's searchable</h3>
            <p>Every video is checked against baseline sensitive categories, plus anything you personally rule out. Flagged content waits quietly for your review.</p>
            <span className="p-tech">Scene-index sensitivity pass</span>
          </div>
          <div className="p-visual">
            <div className="p-ghost">02</div>
            <div className="p-blob" style={{ width: 240, height: 240, background: "#5b4bda", top: "50%", left: "40%", transform: "translate(-50%,-50%)" }} />
            <div className="mock" style={{ transform: "rotate(2deg)" }}>
              <div className="mhead"><span className="mtitle">NEEDS REVIEW</span></div>
              <div className="mock-flag">
                <div className="fthumb" />
                <div className="fbody">
                  <div className="flabel">FLAGGED</div>
                  <div className="freason">Visible screen content detected</div>
                </div>
              </div>
              <div className="mock-actions">
                <div className="ma accept">Accept</div>
                <div className="ma discard">Discard</div>
              </div>
            </div>
          </div>
        </div>

        {/* 03 — Dual index */}
        <div className="p-row">
          <div className="p-text">
            <div className="p-icon" style={{ background: "linear-gradient(135deg,#d8503f,#8f2a1f)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="18" rx="1.5"/></svg>
            </div>
            <h3>Understood two ways at once</h3>
            <p>VideoDB indexes what was <em>said</em> — full transcript, 97 languages — and what was <em>visually happening</em>, separately. A silent screen recording stays fully searchable.</p>
            <span className="p-tech">VideoDB spoken-word + scene indexing</span>
          </div>
          <div className="p-visual">
            <div className="p-ghost">03</div>
            <div className="p-blob" style={{ width: 250, height: 250, background: "#d8503f", top: "50%", left: "55%", transform: "translate(-50%,-50%)" }} />
            <div className="mock" style={{ transform: "rotate(-1.5deg)", width: 300 }}>
              <div className="mhead"><span className="mtitle">DUAL INDEX</span></div>
              <div className="mock-dual">
                <div className="col">
                  <div className="col-label">SPOKEN</div>
                  <div className="mock-wave">
                    <span style={{ height: 6 }} /><span style={{ height: 14 }} /><span style={{ height: 9 }} />
                    <span style={{ height: 18 }} /><span style={{ height: 7 }} /><span style={{ height: 12 }} />
                    <span style={{ height: 16 }} /><span style={{ height: 5 }} />
                  </div>
                </div>
                <div className="col">
                  <div className="col-label">VISUAL</div>
                  <div className="mock-scene-txt">"…two people laughing near a kitchen counter…"</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 04 — Face timelines */}
        <div className="p-row rev">
          <div className="p-text">
            <div className="p-icon" style={{ background: "linear-gradient(135deg,#e0b13f,#a3760f)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            </div>
            <h3>Faces become timelines, not tags</h3>
            <p>Enroll a person once. Every video is sampled frame-by-frame and checked against them — confirmed appearances merge into real timestamp ranges.</p>
            <span className="p-tech">AWS Rekognition + VideoDB frame extraction</span>
          </div>
          <div className="p-visual">
            <div className="p-ghost">04</div>
            <div className="p-blob" style={{ width: 240, height: 240, background: "#e0b13f", top: "50%", left: "40%", transform: "translate(-50%,-50%)" }} />
            <div className="mock" style={{ transform: "rotate(1.5deg)" }}>
              <div className="mhead"><span className="mtitle">PERSON MATCH</span></div>
              <div className="mock-face">
                <div className="mock-avatar" />
                <div className="mock-tl">
                  <div className="mtl-label">arjun · 3 appearances</div>
                  <div className="mock-tl-bar">
                    <span style={{ left: "8%", width: "14%" }} />
                    <span style={{ left: "40%", width: "20%" }} />
                    <span style={{ left: "75%", width: "12%" }} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 05 — Intent routing */}
        <div className="p-row">
          <div className="p-text">
            <div className="p-icon" style={{ background: "linear-gradient(135deg,#2a9fd8,#1a5f8a)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M12 2a5 5 0 0 0-5 5c0 2 1 3 1 5v2h8v-2c0-2 1-3 1-5a5 5 0 0 0-5-5Z"/><path d="M9 19h6M10 22h4"/></svg>
            </div>
            <h3>It figures out what you're actually asking</h3>
            <p>Before retrieving anything, an LLM classifies your question — find a clip, count something, ask when something last happened, or list every match.</p>
            <span className="p-tech">Groq intent classification</span>
          </div>
          <div className="p-visual">
            <div className="p-ghost">05</div>
            <div className="p-blob" style={{ width: 250, height: 250, background: "#2a9fd8", top: "50%", left: "55%", transform: "translate(-50%,-50%)" }} />
            <div className="mock" style={{ transform: "rotate(-2deg)", width: 290 }}>
              <div className="mhead"><span className="mtitle">CHAT</span></div>
              <div className="mock-chat">
                <div className="mock-bubble user">how many times did I mention HydraDB?</div>
                <div className="mock-bubble ai">Classifying intent…</div>
                <div className="mock-chips">
                  <div className="mock-chip">search</div>
                  <div className="mock-chip active">count</div>
                  <div className="mock-chip">recency</div>
                  <div className="mock-chip">group</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 06 — Rerank & export */}
        <div className="p-row rev">
          <div className="p-text">
            <div className="p-icon" style={{ background: "linear-gradient(135deg,#1c1c1c,#000)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="m20 4-9.5 9.5M20 20 6 8.5"/></svg>
            </div>
            <h3>Reranked, grounded, and exportable</h3>
            <p>Results from both indexes are reranked for true relevance and answered in real language — not a template. Trim the exact moment and export the clip.</p>
            <span className="p-tech">LLM rerank · trim &amp; export</span>
          </div>
          <div className="p-visual">
            <div className="p-ghost">06</div>
            <div className="p-blob" style={{ width: 240, height: 240, background: "#1c1c1c", opacity: 0.3, top: "50%", left: "40%", transform: "translate(-50%,-50%)" }} />
            <div className="mock mock-trim" style={{ transform: "rotate(2deg)" }}>
              <div className="mhead"><span className="mtitle">TRIM &amp; EXPORT</span></div>
              <div className="mtrim-track">
                <div className="mtrim-sel" style={{ left: "35%", width: "30%" }} />
                <div className="mtrim-handle" style={{ left: "35%" }} />
                <div className="mtrim-handle" style={{ left: "65%" }} />
              </div>
              <div className="mtrim-btn">Export clip</div>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}

/** Why Recall — three cards with gradient icon badges (green, gold, indigo). */
function WhyRecall() {
  return (
    <section style={{ padding: "90px 24px", maxWidth: 1100, margin: "0 auto" }}>
      <p className="font-mono text-[12px] font-bold text-center text-[#1c8a3e] tracking-[0.04em] mb-2.5">WHY RECALL</p>
      <h2 style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-0.02em", textAlign: "center", maxWidth: 640, margin: "0 auto 50px", lineHeight: 1.2, color: "#14140f" }}>
        Text got a second brain years ago. Video never did.
      </h2>
      <div className="why-grid">

        <div className="why-card">
          <div className="ic" style={{ background: "linear-gradient(135deg,#1c8a3e,#0e5024)" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M15 10l4.55-2.1A1 1 0 0 1 21 8.8V15.2a1 1 0 0 1-1.45.9L15 14"/><rect x="2" y="7" width="13" height="10" rx="2"/></svg>
          </div>
          <h3>Video was never searchable by default</h3>
          <p>A thousand personal videos aren't trivial to search like a folder of notes — until every frame and word is actually indexed, not just filed by name.</p>
        </div>

        <div className="why-card">
          <div className="ic" style={{ background: "linear-gradient(135deg,#e0b13f,#a3760f)" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          </div>
          <h3>Confirms who's actually there</h3>
          <p>Not a guess based on a name mentioned nearby — a real, face-confirmed timeline of where a specific person actually appears on screen.</p>
        </div>

        <div className="why-card">
          <div className="ic" style={{ background: "linear-gradient(135deg,#5b4bda,#332a8a)" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M12 2 4 5v6c0 5 3.4 8.4 8 11 4.6-2.6 8-6 8-11V5l-8-3Z"/></svg>
          </div>
          <h3>Trustworthy, not just confident</h3>
          <p>When there's no real match, it says so — rather than forcing a plausible-sounding answer to a question it can't actually answer.</p>
        </div>

      </div>
    </section>
  );
}
