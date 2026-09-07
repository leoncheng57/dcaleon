import { useCallback, useLayoutEffect, useEffect, useRef, useState, type RefObject } from "react";

export interface TranscriptFollowState {
  scrollerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  newActivity: boolean;
  jumpToLatest: () => void;
}

export function useTranscriptFollow(
  events: unknown[],
  scopeKey?: string,
): TranscriptFollowState {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const initialized = useRef(false);
  const height = useRef(0);
  const [newActivity, setNewActivity] = useState(false);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (!initialized.current || following.current) {
      scroller.scrollTop = scroller.scrollHeight;
      initialized.current = true;
      setNewActivity(false);
    } else {
      setNewActivity(true);
    }
  }, [events]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === "undefined") return;
    following.current = true;
    initialized.current = false;
    height.current = 0;
    setNewActivity(false);
    let frame = 0;
    const sync = () => {
      frame = 0;
      const grew = scroller.scrollHeight > height.current;
      height.current = scroller.scrollHeight;
      if (following.current) {
        scroller.scrollTop = scroller.scrollHeight;
        setNewActivity(false);
      } else if (grew) {
        setNewActivity(true);
      }
    };
    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sync);
    });
    observer.observe(scroller);
    observer.observe(content);
    sync();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scopeKey]);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 96;
    following.current = nearBottom;
    if (nearBottom) setNewActivity(false);
  }, []);

  const jumpToLatest = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    following.current = true;
    setNewActivity(false);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, []);

  return { scrollerRef, contentRef, onScroll, newActivity, jumpToLatest };
}
