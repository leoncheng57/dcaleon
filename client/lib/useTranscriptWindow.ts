import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DisplayItem } from "./derive.js";
import type { TranscriptFollowState } from "./useTranscriptFollow.js";

const PAGE_SIZE = 50;

/** Window only the presentation; callers retain the complete transcript for tools. */
export function useTranscriptWindow(all: DisplayItem[], scope: string, follow: TranscriptFollowState) {
  const [window, setWindow] = useState<{ scope: string; first: string | null }>({ scope, first: null });
  const first = window.scope === scope ? window.first : null;
  const pinnedIndex = first === null ? -1 : all.findIndex((item) => item.id === first);
  const start = pinnedIndex < 0 ? Math.max(0, all.length - PAGE_SIZE) : pinnedIndex;
  const items = useMemo(() => all.slice(start), [all, start]);
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const jumping = useRef(false);

  useLayoutEffect(() => {
    const scroller = follow.scrollerRef.current;
    const saved = anchor.current;
    anchor.current = null;
    if (scroller && saved?.element.isConnected) {
      scroller.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
      follow.onScroll();
    }
    if (jumping.current && scroller) {
      jumping.current = false;
      scroller.scrollTop = scroller.scrollHeight;
      follow.onScroll();
    }
  }, [items, follow.scrollerRef, follow.onScroll]);

  const expand = (nextStart: number) => {
    const scroller = follow.scrollerRef.current;
    if (scroller) {
      const top = scroller.getBoundingClientRect().top;
      const element = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-item]"))
        .find((row) => row.getBoundingClientRect().bottom > top);
      if (element) anchor.current = { element, top: element.getBoundingClientRect().top };
    }
    setWindow({ scope, first: all[nextStart]?.id ?? null });
  };

  return {
    items,
    hiddenCount: start,
    loadEarlier: () => expand(Math.max(0, start - PAGE_SIZE)),
    showAll: () => expand(0),
    onScroll: () => {
      follow.onScroll();
      const scroller = follow.scrollerRef.current;
      // Pin the first visible item when reading history so incoming activity
      // cannot slide that history out from under the reader.
      if (first === null && scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 96) {
        setWindow({ scope, first: items[0]?.id ?? null });
      }
    },
    jumpToLatest: () => {
      jumping.current = start !== Math.max(0, all.length - PAGE_SIZE);
      setWindow({ scope, first: null });
      follow.jumpToLatest();
    },
  };
}
