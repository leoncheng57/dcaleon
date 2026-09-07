import { memo, useCallback, useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Transcript } from "./transcript.js";

/** Measured rows keep Markdown/tool DOM proportional to the viewport. */
export const VirtualTranscript = memo(function VirtualTranscript({ scrollerRef, ...props }: ComponentProps<typeof Transcript> & { scrollerRef: RefObject<HTMLDivElement | null> }) {
  const list = useRef<HTMLDivElement>(null);
  const commits = useRef(0);
  useLayoutEffect(() => { if (list.current) list.current.dataset.renderCommits = String(++commits.current); });
  const [margin, setMargin] = useState(0);
  const getItemKey = useCallback((index: number) => props.items[index].id, [props.items]);
  const virtual = useVirtualizer({
    count: props.items.length,
    getScrollElement: () => scrollerRef.current,
    getItemKey,
    estimateSize: () => 160,
    overscan: 4,
    scrollMargin: margin,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 96,
  });
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !list.current) return;
    setMargin(list.current.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
  }, [scrollerRef, props.items]);
  useLayoutEffect(() => { virtual.scrollToEnd(); }, []);
  const rows = virtual.getVirtualItems();
  return (
    <div ref={list} data-testid="claude-virtual-transcript" data-rendered-rows={rows.length}
      style={{ height: virtual.getTotalSize(), position: "relative", overflowAnchor: "none" }}>
      {rows.map((row) => (
        <div key={row.key} data-index={row.index} ref={virtual.measureElement}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", paddingTop: 24, transform: `translateY(${row.start - margin}px)` }}>
          <Transcript {...props} items={[props.items[row.index]]} />
        </div>
      ))}
    </div>
  );
});
