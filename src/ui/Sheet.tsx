/**
 * The command sheet — the one surface that says what the game wants next.
 *
 * It replaces the old tab bar. A tab bar is the right pattern for peer destinations you
 * choose between; this app is a wizard followed by a turn loop, where at any moment there is
 * exactly one thing to do, and the old shell's cost for that mismatch was concrete: arming a
 * placement on the Play tab and then having to go and find the Board tab yourself.
 *
 * Three detents, and the reason there are three:
 *   rest — exactly the current prompt and its primary action, measured, never taller than
 *          it needs to be. The board owns everything above it.
 *   half — the full option list for the current step, with the board still readable.
 *   full — long content: a datacard, the rule text behind a decision, the log.
 *
 * The board pane is inset by the REST height only, so expanding the sheet never reflows the
 * board and the viewport aspect stays put. Dragging is initiated from the grab handle alone,
 * which sidesteps scroll chaining entirely: a finger inside the body always scrolls the body.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export type Detent = 'rest' | 'half' | 'full';

export interface SheetProps {
  /** Which detent to show. The parent drives this from game state; the user may override. */
  detent: Detent;
  onDetent: (d: Detent) => void;
  /**
   * A pending decision owns the screen: the board dims and the sheet cannot be collapsed
   * below `half`, because there is nothing else the player may do.
   */
  modal?: boolean;
  /** Measured height of the resting sheet, so the board pane can inset by exactly that. */
  onRestHeight?: (px: number) => void;
  /**
   * Docked to the side instead of the bottom. A phone in landscape has ~390px of height; a
   * bottom sheet takes half of it and leaves the killzone a strip. Sideways, the same content
   * is a column and the board keeps the rest.
   */
  side?: boolean;
  /** Always visible: the prompt and its primary action. */
  peek: preact.ComponentChildren;
  /** Revealed at `half` and `full`. Scrolls. */
  children?: preact.ComponentChildren;
  label?: string;
}

/** Fractions of the stage the expanded detents occupy. */
const HALF = 0.52;
const FULL = 0.92;
/** A drag shorter than this is a tap on the handle, which cycles detents instead. */
const DRAG_SLOP_PX = 6;

export function Sheet({ detent, onDetent, modal = false, onRestHeight, peek, children, label, side = false }: SheetProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const peekRef = useRef<HTMLDivElement | null>(null);
  const [restPx, setRestPx] = useState(140);
  const [stagePx, setStagePx] = useState(600);
  /** Live height while a finger is on the handle; null when the detents are in charge. */
  const [dragPx, setDragPx] = useState<number | null>(null);

  // --- measure -----------------------------------------------------------
  useLayoutEffect(() => {
    const el = peekRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const read = () => {
      const stage = root.parentElement?.getBoundingClientRect().height ?? 0;
      // Same 1px slop as the rest height: a raw sub-pixel rect re-renders on every frame of a
      // resize, and this effect rebuilds the observer each render.
      if (stage > 0) setStagePx((cur) => (Math.abs(cur - stage) < 1 ? cur : stage));
      // grab handle + peek row. Measured, so the resting sheet is exactly as tall as the
      // current prompt needs and never a pixel more of the board than it has to take.
      const grab = root.querySelector('.sheet-grab')?.getBoundingClientRect().height ?? 20;
      const h = Math.ceil(el.getBoundingClientRect().height + grab);
      // Never taller than the `half` detent, or expanding the sheet would make it SMALLER.
      const next = Math.max(96, Math.min(h, stage > 0 ? stage * HALF : h));
      setRestPx((cur) => (Math.abs(cur - next) < 1 ? cur : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (root.parentElement) ro.observe(root.parentElement);
    return () => ro.disconnect();
    // `side` only: with no dependency array this tore down and rebuilt the observer on every
    // render. The observer itself is what keeps the measurement current.
  }, [side]);

  useEffect(() => {
    // A side sheet insets the board horizontally, never vertically.
    onRestHeight?.(side ? 0 : restPx);
  }, [restPx, onRestHeight, side]);

  const heightFor = useCallback(
    (d: Detent): number => (d === 'rest' ? restPx : d === 'half' ? stagePx * HALF : stagePx * FULL),
    [restPx, stagePx],
  );

  /**
   * Modal sheets never rest: there is a question on screen that must be answered. A SIDE
   * sheet has no detents at all — it is a fixed column, always fully open — so the drag
   * handle and the height maths are simply not in play.
   */
  const effective: Detent = side ? 'full' : modal && detent === 'rest' ? 'half' : detent;
  const height = dragPx ?? heightFor(effective);

  // --- drag the handle ---------------------------------------------------
  const gesture = useRef<{ id: number; startY: number; startH: number; moved: boolean } | null>(null);

  const onPointerDown = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    gesture.current = { id: e.pointerId, startY: e.clientY, startH: heightFor(effective), moved: false };
  };

  const onPointerMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dy = g.startY - e.clientY; // up is taller
    if (!g.moved && Math.abs(dy) < DRAG_SLOP_PX) return;
    g.moved = true;
    const min = modal ? heightFor('half') : restPx;
    setDragPx(Math.max(min, Math.min(stagePx * FULL, g.startH + dy)));
  };

  const settle = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    const landed = dragPx;
    setDragPx(null);
    if (!g.moved) {
      // A tap on the handle cycles — the affordance people try first, and the only way to
      // reach `full` without a drag.
      const order: Detent[] = modal ? ['half', 'full'] : ['rest', 'half', 'full'];
      const i = order.indexOf(effective);
      onDetent(order[(i + 1) % order.length]!);
      return;
    }
    if (landed === null) return;
    const options: Detent[] = modal ? ['half', 'full'] : ['rest', 'half', 'full'];
    let best = options[0]!;
    let bestGap = Infinity;
    for (const d of options) {
      const gap = Math.abs(heightFor(d) - landed);
      if (gap < bestGap) {
        bestGap = gap;
        best = d;
      }
    }
    onDetent(best);
  };

  return (
    <>
      {modal && <div class="sheet-scrim" aria-hidden="true" />}
      <section
        ref={rootRef}
        class={`sheet${side ? ' is-side' : ''}${dragPx !== null ? ' is-dragging' : ''} detent-${effective}`}
        style={side ? undefined : { height: `${Math.round(height)}px` }}
        aria-label={label ?? 'Command'}
        data-detent={side ? 'side' : effective}
      >
        {!side && (
        <div
          class="sheet-grab"
          role="button"
          tabIndex={0}
          aria-label={effective === 'full' ? 'Collapse the panel' : 'Expand the panel'}
          aria-expanded={effective !== 'rest'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={settle}
          onPointerCancel={settle}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'ArrowUp') onDetent(effective === 'rest' ? 'half' : 'full');
            if (e.key === 'ArrowDown') onDetent(effective === 'full' ? 'half' : modal ? 'half' : 'rest');
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              const order: Detent[] = modal ? ['half', 'full'] : ['rest', 'half', 'full'];
              onDetent(order[(order.indexOf(effective) + 1) % order.length]!);
            }
          }}
        />
        )}
        {/* The peek is its OWN grid row, not the first thing in the scroller: at `rest` the
            scroller is then exactly zero tall, so the body is hidden cleanly instead of
            showing a half-clipped line of text under the primary button. */}
        <div class="sheet-peek" ref={peekRef}>
          {peek}
        </div>
        <div class="sheet-body">{children}</div>
      </section>
    </>
  );
}
