import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { rulesReaderMessages as labels } from "../../i18n/messages/rules-reader.js";
import type { RulesChapter, RulesSketchbookProps } from "./rules-types.js";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import { clubArt, nightArt } from "./rules-book-assets.js";
import "./rules-sketchbook.css";

type Position = { chapter: number; side: "art" | "text" };
type Turn = {
  from: Position;
  to: Position;
  direction: number;
  progress: number;
  pageWidth: number;
  single: boolean;
  duration: number;
};
type Drag = {
  id: number;
  x: number;
  y: number;
  direction: number;
  moved: boolean;
  progress: number;
};
const stripCount = 20;

const pad = (n: number) => String(n).padStart(2, "0");
const dimensions = () => {
  const single = window.innerWidth < 780;
  const inset = single ? 24 : 64;
  return {
    single,
    width: Math.max(120, Math.min(single ? 500 : 1000, window.innerWidth - inset * 2)),
    height: Math.max(
      120,
      Math.min(780, window.innerHeight - (window.innerHeight < 650 ? 128 : 160)),
    ),
  };
};

/** The original illustrated plates, expressed as native SVG rather than markup strings. */
function Illustration({
  art,
  locale,
}: {
  art: RulesChapter["art"];
  locale: RulesSketchbookProps["locale"];
}) {
  if (art === "club" || art === "night")
    return <img src={art === "club" ? clubArt : nightArt} alt="" draggable={false} />;
  if (art === "table")
    return (
      <svg viewBox="0 0 470 470" aria-hidden="true">
        <ellipse cx="239" cy="237" rx="128" ry="125" fill="#a38a5f13" stroke="none" />
        <g stroke="#8a7c65" strokeWidth="1.2">
          {Array.from({ length: 10 }, (_, i) => {
            const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
            const x = 235 + Math.cos(angle) * 167,
              y = 220 + Math.sin(angle) * 150;
            return (
              <g key={i}>
                <g transform={`translate(${x} ${y}) rotate(${(angle * 180) / Math.PI + 90})`}>
                  <path d="M-17-17Q0-26 17-17L19 15Q0 22-19 15Z" fill="#c2ae8740" />
                  <path d="M-13-12Q0-18 13-12M-17 13l-2 15m35-15 2 15" />
                  <path d="M-12-8v15m8-17v19m8-19v19m8-17v15" strokeOpacity=".25" />
                </g>
                <text
                  x={x}
                  y={y + 5}
                  textAnchor="middle"
                  fill="#847356"
                  stroke="none"
                  fontSize="17"
                >
                  {i + 1}
                </text>
              </g>
            );
          })}
          <ellipse cx="235" cy="220" rx="126" ry="111" fill="#bbbc9c3a" />
          <ellipse cx="235" cy="220" rx="117" ry="103" stroke="#8a7c6555" />
          <path
            d="M141 170q90-55 186 0M129 220q100-50 212 0M145 272q90-40 177 0"
            stroke="#8a7c6518"
          />
          <rect
            x="211"
            y="192"
            width="27"
            height="39"
            rx="2"
            transform="rotate(-13 225 211)"
            fill="#f1e6ce"
          />
          <rect
            x="233"
            y="195"
            width="27"
            height="39"
            rx="2"
            transform="rotate(12 246 212)"
            fill="#8c554542"
          />
          <circle cx="188" cy="230" r="14" fill="#cbb88722" />
          <circle cx="188" cy="230" r="9" stroke="#8a7c6555" />
          <path d="M205 337q40 14 76-1m-62 14q20 6 39 0" stroke="#8a7c6544" />
        </g>
        <text
          x="235"
          y="426"
          textAnchor="middle"
          fill="#9a8769"
          stroke="none"
          fontSize="24"
          fontStyle="italic"
        >
          {labels[locale].tableCaption}
        </text>
      </svg>
    );
  return (
    <svg viewBox="0 0 470 470" aria-hidden="true">
      <ellipse cx="248" cy="320" rx="162" ry="24" fill="#b49b6915" stroke="none" />
      {[-17, 0, 17].map((angle, i) => (
        <g
          key={i}
          transform={`translate(${138 + i * 63} ${115 + Math.abs(i - 1) * 17}) rotate(${angle} 65 105)`}
        >
          <rect x="3" y="7" width="130" height="203" rx="8" fill="#71634d16" stroke="none" />
          <rect width="130" height="203" rx="7" fill="#eee4cf" stroke="#8b7959" />
          <rect
            x="9"
            y="9"
            width="112"
            height="185"
            rx="4"
            fill={i === 1 ? "#505345" : "#8e5143"}
            opacity=".83"
          />
          <rect x="17" y="17" width="96" height="169" rx="2" stroke="#dfcfac" />
          <path
            d="M24 30q40 25 82 0M24 174q40-25 82 0M28 40v122m74-122V40"
            stroke="#e6d4a5"
            strokeOpacity=".6"
          />
          <path d="M65 57 91 101 65 145 39 101Z" stroke="#ecdfc2" />
          <circle cx="65" cy="101" r="25" stroke="#ecdfc2" />
          <path
            d="M65 77v48M41 101h48m-41-17 34 34m0-34-34 34"
            stroke="#ecdfc2"
            strokeOpacity=".5"
          />
          <circle cx="65" cy="101" r="10" fill="#e4cf9a" stroke="none" />
        </g>
      ))}
      <path d="M83 370q85 10 105-30M346 345q26 32 66 20" stroke="#93815a66" />
      <text
        x="235"
        y="421"
        textAnchor="middle"
        fontStyle="italic"
        fontSize="24"
        fill="#9a8769"
        stroke="none"
      >
        {labels[locale].cardsCaption}
      </text>
    </svg>
  );
}

interface LeafProps {
  position: Position;
  face: "art" | "text";
  chapters: readonly RulesChapter[];
  locale: RulesSketchbookProps["locale"];
  onChoose?: (chapter: number) => void;
  decorative?: boolean;
  error?: string;
  scrollTop?: number;
  onScroll?: (top: number) => void;
  enhanced?: boolean;
}
function Leaf({
  position,
  face,
  chapters,
  locale,
  onChoose,
  decorative = false,
  error,
  scrollTop = 0,
  onScroll,
  enhanced = true,
}: LeafProps) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = scrollTop;
  }, [position.chapter, locale, scrollTop]);
  const l = labels[locale];
  const c = chapters[position.chapter];
  const t = c?.[locale];
  const contents = position.chapter < 0;
  const folio = contents
    ? face === "art"
      ? "i"
      : "ii"
    : pad(position.chapter * 2 + (face === "art" ? 1 : 2));
  return (
    <article
      className={`rs-leaf ${contents && face === "art" ? "rs-frontispiece" : ""}`}
      data-side={face}
      aria-label={face === "art" ? (t?.plate ?? l.subtitle) : undefined}
    >
      {error ? (
        <div className="rs-body" role={decorative ? undefined : "alert"}>
          <p className="rs-eyebrow">{l.edition}</p>
          <h2>{chapters.length ? l.missing : l.empty}</h2>
          <p>{error}</p>
          <button type="button" onClick={() => onChoose?.(-1)}>
            {l.contents}
          </button>
        </div>
      ) : contents ? (
        face === "art" ? (
          <>
            <div className="rs-frontispiece-heading">
              <h2>{l.title}</h2>
              <p>{l.subtitle}</p>
            </div>
            <div className="rs-plate-art">
              <Illustration art="club" locale={locale} />
            </div>
            <p className="rs-plate-note">{l.story}</p>
          </>
        ) : (
          <div
            ref={body}
            className="rs-body rs-contents-body"
            aria-label={l.contents}
            onScroll={(event) => onScroll?.(event.currentTarget.scrollTop)}
          >
            <p className="rs-eyebrow">{l.edition}</p>
            <h2>{l.contents}</h2>
            <p className="rs-contents-intro">{l.find}</p>
            <nav className="rs-contents-list" aria-label={l.contents}>
              {[false, true].map((references) => (
                <section key={String(references)}>
                  <h3>{references ? l.references : l.guide}</h3>
                  {chapters.map((entry, i) =>
                    Boolean(entry.reference) === references ? (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => onChoose?.(i)}
                        data-chapter-target={entry.id}
                        aria-label={`${entry.reference ?? pad(i + 1)} ${entry[locale].name}`}
                      >
                        <span>{entry.reference ?? pad(i + 1)}</span>
                        <strong>{entry[locale].name}</strong>
                        <span>{pad(i * 2 + 2)}</span>
                      </button>
                    ) : null,
                  )}
                </section>
              ))}
            </nav>
            <p className="rs-contents-note">{enhanced ? l.hint : l.flatHint}</p>
            <p className="rs-source-note">{l.note}</p>
          </div>
        )
      ) : face === "art" ? (
        <>
          <span className="rs-plate-tag">{t?.plate}</span>
          <div className="rs-plate-art">{c && <Illustration art={c.art} locale={locale} />}</div>
          <p className="rs-plate-note">{t?.note}</p>
        </>
      ) : (
        t && (
          <div
            ref={body}
            className={`rs-body ${c.reference ? "rs-reference-body" : ""}`}
            aria-label={t.name}
            data-reading-key={c.id}
            onScroll={(event) => onScroll?.(event.currentTarget.scrollTop)}
          >
            <p className="rs-eyebrow">{t.tag}</p>
            {c.reference && <p className="rs-reference">{c.reference}</p>}
            <h2 className={position.chapter === 0 ? "rs-cover-title" : undefined}>
              {t.title[0]}
              <br />
              <em>{t.title[1]}</em>
            </h2>
            <p className="rs-lede">{t.lede}</p>
            {position.chapter === 0 && (
              <div className="rs-role-row" aria-label={l.roleSummary}>
                {Array.from({ length: 10 }, (_, i) => (
                  <i
                    className={`${i >= 7 ? "rs-dark" : ""} ${i === 6 || i === 9 ? "rs-marked" : ""}`}
                    key={i}
                  />
                ))}
                <span>{l.roleCount}</span>
              </div>
            )}
            {t.intro && <p className="rs-cover-summary">{t.intro}</p>}
            {t.outro && <p className="rs-cover-summary">{t.outro}</p>}
            {t.rules?.map(([title, text], i) => (
              <section className="rs-rule-item" key={`${i}-${title}`}>
                <span className="rs-rule-number" aria-hidden="true">
                  {pad(i + 1)}
                </span>
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </section>
            ))}
            {t.paragraphs?.map((text, i) => (
              <p className="rs-paragraph" key={i}>
                {text}
              </p>
            ))}
            <p className="rs-margin-note">{t.margin}</p>
            {t.signature && <p className="rs-signature">{t.signature}</p>}
            <p className="rs-page-source">
              {l.sourceBasis}
              {c.source}
            </p>
          </div>
        )
      )}
      <div className="rs-folio">
        <span>{l.folio}</span>
        <span>{folio}</span>
      </div>
    </article>
  );
}

export default function RulesSketchbook({
  open,
  targetId,
  locale,
  chapters,
  onClose,
  enhancedReady = true,
}: RulesSketchbookProps) {
  const fancy = useFancyFeatures();
  const enhanced = fancy && enhancedReady;
  const [position, setPosition] = useState<Position>({ chapter: 0, side: "text" });
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState(dimensions);
  const [turn, setTurn] = useState<Turn | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const book = useRef<HTMLDivElement>(null);
  const hasOpened = useRef(false);
  const activeTurn = useRef<Turn | null>(null);
  const journey = useRef<{
    remaining: Position[];
    direction: number;
    duration: number;
  } | null>(null);
  const frame = useRef(0);
  const strips = useRef<(HTMLDivElement | null)[]>([]);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const scrollPositions = useRef(new Map<string, number>());
  const cancelRef = useRef<() => void>(() => {});
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;
    cancelRef.current();
    if (targetId !== undefined) {
      const index = chapters.findIndex((c) => c.id === targetId);
      setError(index < 0 ? `“${targetId}”` : undefined);
      if (index >= 0) {
        scrollPositions.current.set(`${locale}:${index}`, 0);
        setPosition({ chapter: index, side: "text" });
      }
    } else setError(chapters.length === 0 ? "—" : undefined);
  }, [open, targetId, chapters]);

  // Keep the native top-layer lifecycle separate from page navigation.
  useEffect(() => {
    if (!open) return;
    const modal = dialog.current;
    if (!modal) return;
    document.body.classList.add("rules-sketchbook-open");
    modal.showModal();
    // Hidden dialog children have no scroll geometry. Restore after showModal,
    // not only in the leaf effect (which runs while they are still hidden).
    const body = modal.querySelector<HTMLElement>(".rs-spread .rs-body");
    if (body)
      body.scrollTop =
        targetId !== undefined
          ? 0
          : (scrollPositions.current.get(`${locale}:${position.chapter}`) ?? 0);
    const resize = () => {
      cancelRef.current();
      setLayout(dimensions());
    };
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motionChanged = () => cancelRef.current();
    media.addEventListener("change", motionChanged);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      media.removeEventListener("change", motionChanged);
      cancelRef.current();
      if (modal.open) modal.close();
      document.body.classList.remove("rules-sketchbook-open");
    };
  }, [open]);

  const releaseCapture = () => {
    const id = drag.current?.id;
    drag.current = null;
    if (id !== undefined && book.current?.hasPointerCapture?.(id))
      book.current.releasePointerCapture(id);
  };
  const cancel = () => {
    // The browser may still synthesize a click after capture is cancelled.
    suppressClick.current = true;
    journey.current = null;
    window.cancelAnimationFrame(frame.current);
    frame.current = 0;
    activeTurn.current = null;
    setTurn(null);
    releaseCapture();
  };
  cancelRef.current = cancel;
  useLayoutEffect(() => {
    cancelRef.current();
    if (!enhanced) setPosition((current) => ({ ...current, side: "text" }));
    // A visited but closed toolbar/penalty reader must not clear another host's
    // active decoration. Only an open enhanced reader owns this body class.
    if (!open || !enhanced) return;
    document.body.classList.add("rules-sketchbook-enhanced");
    return () => document.body.classList.remove("rules-sketchbook-enhanced");
  }, [open, enhanced]);
  const close = () => {
    cancel();
    onCloseRef.current();
  };
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Same twenty-strip curl and curvature as the approved paper prototype.
  // Only transforms are mutated per frame; all content remains native React DOM.
  const draw = (progress: number) => {
    const current = activeTurn.current;
    if (!current) return;
    current.progress = progress;
    let x = current.single ? 0 : current.pageWidth;
    let z = 0;
    const stripWidth = current.pageWidth / stripCount;
    strips.current.forEach((strip, i) => {
      const t = (i + 0.5) / stripCount;
      const theta = Math.PI * progress + Math.sin(Math.PI * progress) * 0.9 * (t - 0.35);
      if (strip) {
        strip.style.transform = `translate3d(${x}px,0,${z}px) rotateY(${-theta}rad)`;
        strip.style.setProperty(
          "--rs-shade",
          String(Math.abs(Math.sin(theta)) * 0.17 + Math.sin(Math.PI * progress) * t * 0.07),
        );
        // WebKit can reverse native backface culling for the clipped strips.
        // Choose the mathematically facing surface explicitly in both engines.
        const front = strip.firstElementChild as HTMLElement | null;
        const back = strip.lastElementChild as HTMLElement | null;
        if (front) front.style.visibility = Math.cos(theta) >= 0 ? "visible" : "hidden";
        if (back) back.style.visibility = Math.cos(theta) < 0 ? "visible" : "hidden";
      }
      x += stripWidth * Math.cos(theta);
      z += stripWidth * Math.sin(theta);
    });
  };
  const animate = (end: 0 | 1) => {
    const current = activeTurn.current;
    if (!current) return;
    window.cancelAnimationFrame(frame.current);
    const start = current.progress;
    const began = performance.now();
    const duration = current.duration * Math.max(0.3, Math.abs(end - start));
    const tick = (now: number) => {
      if (activeTurn.current !== current) return;
      const elapsed = Math.min(1, (now - began) / duration);
      const easing = elapsed < 0.5 ? 4 * elapsed ** 3 : 1 - (-2 * elapsed + 2) ** 3 / 2;
      draw(start + (end - start) * easing);
      if (elapsed < 1) frame.current = window.requestAnimationFrame(tick);
      else {
        if (end === 1) setPosition(current.to);
        activeTurn.current = null;
        frame.current = 0;
        setTurn(null);
      }
    };
    frame.current = window.requestAnimationFrame(tick);
  };
  const begin = (
    to: Position,
    direction: number,
    automatic = true,
    from = position,
    duration = 720,
  ) => {
    if (!open || activeTurn.current) return;
    if (!enhanced || reducedMotion()) {
      if (automatic) setPosition(to);
      return;
    }
    const current: Turn = {
      from,
      to,
      direction,
      progress: 0.002,
      pageWidth: layout.width / (layout.single ? 1 : 2),
      single: layout.single,
      duration,
    };
    activeTurn.current = current;
    setTurn(current);
    if (automatic) animate(1);
  };
  useLayoutEffect(() => {
    if (turn) {
      draw(turn.progress);
      return;
    }
    // Start the next curl only after React has committed the intermediate page;
    // starting inside the prior RAF can batch that page out of the painted book.
    const trip = journey.current;
    const next = trip?.remaining.shift();
    if (trip && next) begin(next, trip.direction, true, position, trip.duration);
    else journey.current = null;
  }, [turn, position]);

  const choose = (chapter: number) => {
    if (activeTurn.current) return;
    setError(undefined);
    const to: Position = { chapter, side: "text" };
    if (chapter === position.chapter || error) setPosition(to);
    else {
      const direction = chapter > position.chapter ? 1 : -1;
      const distance = Math.abs(chapter - position.chapter);
      if (enhanced && chapter >= 0 && distance > 1 && !reducedMotion()) {
        // Traverse real intervening chapters, speeding long trips rather than
        // making the reader wait for a full manual turn on every spread.
        const duration = Math.min(320, 1200 / distance);
        journey.current = {
          direction,
          duration,
          remaining: Array.from({ length: distance - 1 }, (_, i) => ({
            chapter: position.chapter + (i + 2) * direction,
            side: "text",
          })),
        };
        begin(
          { chapter: position.chapter + direction, side: "text" },
          direction,
          true,
          position,
          duration,
        );
      } else begin(to, direction);
    }
  };
  const destination = (direction: number): Position | null => {
    if (error) return null;
    if (enhanced && layout.single) {
      const physical =
        position.chapter < 0 ? -1 : position.chapter * 2 + (position.side === "text" ? 1 : 0);
      const next = physical + direction;
      return next < -1 || next >= chapters.length * 2
        ? null
        : next === -1
          ? { chapter: -1, side: "text" }
          : { chapter: Math.floor(next / 2), side: next % 2 ? "text" : "art" };
    }
    const chapter = position.chapter + direction;
    return chapter < -1 || chapter >= chapters.length ? null : { chapter, side: "text" };
  };
  const go = (direction: number) => {
    const next = destination(direction);
    if (next) begin(next, direction);
  };
  const ignorePointer = (target: EventTarget | null) =>
    target instanceof Element &&
    Boolean(target.closest("button,a,input,textarea,select,[contenteditable=true]"));
  const paperDirection = (x: number) => {
    const rect = book.current?.getBoundingClientRect();
    return rect && x < rect.left + rect.width / 2 ? -1 : 1;
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (
      ignorePointer(event.target) ||
      event.button !== 0 ||
      event.isPrimary === false ||
      activeTurn.current ||
      error
    )
      return;
    suppressClick.current = false;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      direction: paperDirection(event.clientX),
      moved: false,
      progress: 0,
    };
    // Capture on the stable book, never on text/art that a turn will replace.
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.id) return;
    const dx = event.clientX - current.x,
      dy = event.clientY - current.y;
    if (!current.moved && Math.abs(dy) > Math.abs(dx) + 8) {
      suppressClick.current = true;
      cancel();
      return;
    }
    if (!current.moved && Math.abs(dx) < 8) return;
    if (!current.moved) {
      current.moved = true;
      current.direction = dx < 0 ? 1 : -1;
      const next = destination(current.direction);
      if (!next) {
        suppressClick.current = true;
        cancel();
        return;
      }
      begin(next, current.direction, false);
    }
    if (event.pointerType === "mouse") event.preventDefault();
    current.progress = Math.max(
      0.002,
      Math.min(
        0.998,
        (-dx * current.direction) /
          (((book.current?.getBoundingClientRect().width || layout.width) /
            (enhanced && !layout.single ? 2 : 1)) *
            1.65),
      ),
    );
    draw(current.progress);
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.id) return;
    releaseCapture();
    suppressClick.current = true;
    if (current.moved) {
      if (!enhanced || reducedMotion()) {
        if (current.progress > 0.16) go(current.direction);
      } else animate(current.progress > 0.16 ? 1 : 0);
    } else go(current.direction);
  };
  const scrollTop = (p: Position) => scrollPositions.current.get(`${locale}:${p.chapter}`) ?? 0;
  const visiblePosition = (face: "art" | "text") =>
    !turn
      ? position
      : layout.single
        ? turn.to
        : face === (turn.direction > 0 ? "text" : "art")
          ? turn.to
          : turn.from;
  const visibleSide = turn && layout.single ? turn.to.side : position.side;
  const style = {
    "--rs-width": `${enhanced ? layout.width : Math.min(760, layout.width)}px`,
    "--rs-height": `${layout.height}px`,
    "--rs-page": `${enhanced ? layout.width / (layout.single ? 1 : 2) : Math.min(760, layout.width)}px`,
  } as CSSProperties;
  if (open) hasOpened.current = true;
  if (!hasOpened.current) return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="rules-sketchbook"
      data-presentation={enhanced ? "enhanced" : "flat"}
      aria-label={enhanced ? labels[locale].book : labels[locale].flatBook}
      lang={locale}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <div
        className="rs-viewport"
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="rs-dock" style={style}>
          <button
            type="button"
            className="rs-close"
            aria-label={labels[locale].close}
            onClick={close}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
          <button
            type="button"
            className="rs-bookmark"
            aria-label={labels[locale].contents}
            title={labels[locale].contents}
            aria-current={position.chapter < 0 ? "page" : undefined}
            onClick={() => choose(-1)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 6h11M7 12h11M7 18h11M3 6h.01M3 12h.01M3 18h.01" />
            </svg>
            <span>{labels[locale].index}</span>
          </button>
          <div
            ref={book}
            className={`rs-book ${layout.single || !enhanced ? "rs-single" : ""} ${turn ? "rs-turning" : ""}`}
            data-chapter={error ? "unavailable" : (chapters[position.chapter]?.id ?? "contents")}
            data-side={position.side}
            aria-busy={turn ? true : undefined}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={() => {
              suppressClick.current = true;
              cancel();
            }}
            onLostPointerCapture={() => {
              if (drag.current) cancel();
            }}
            onClick={(event) => {
              if (ignorePointer(event.target)) return;
              if (suppressClick.current) {
                suppressClick.current = false;
                if (event.detail !== 0) return;
              }
              go(paperDirection(event.clientX));
            }}
          >
            {enhanced && <div className="rs-binding" aria-hidden="true" />}
            <div
              className="rs-spread"
              aria-hidden={turn ? true : undefined}
              inert={turn ? true : undefined}
            >
              {(["art", "text"] as const).map(
                (face) =>
                  ((!enhanced && face === "text") ||
                    (enhanced && (!layout.single || visibleSide === face))) && (
                    <Leaf
                      key={face}
                      position={visiblePosition(face)}
                      face={face}
                      chapters={chapters}
                      locale={locale}
                      enhanced={enhanced}
                      onChoose={choose}
                      error={face === "text" ? error : undefined}
                      scrollTop={scrollTop(visiblePosition(face))}
                      onScroll={
                        face === "text"
                          ? (top) => {
                              if (!activeTurn.current)
                                scrollPositions.current.set(`${locale}:${position.chapter}`, top);
                            }
                          : undefined
                      }
                    />
                  ),
              )}
            </div>
            {enhanced && <div className="rs-spine" aria-hidden="true" />}
            {enhanced && turn && (
              <div
                className={`rs-curl ${turn.direction < 0 ? "rs-reverse" : ""}`}
                aria-hidden="true"
                inert
              >
                {Array.from({ length: stripCount }, (_, i) => (
                  <div
                    key={i}
                    ref={(node) => {
                      strips.current[i] = node;
                    }}
                    className="rs-curl-strip"
                    style={{ width: turn.pageWidth / stripCount + 0.65 }}
                  >
                    {(["front", "back"] as const).map((surface) => {
                      const front = surface === "front";
                      const p = front ? turn.from : turn.to;
                      const face = layout.single
                        ? p.side
                        : front
                          ? turn.direction > 0
                            ? "text"
                            : "art"
                          : turn.direction > 0
                            ? "art"
                            : "text";
                      const offset = front
                        ? (i * turn.pageWidth) / stripCount
                        : turn.pageWidth - ((i + 1) * turn.pageWidth) / stripCount;
                      return (
                        <div key={surface} className={`rs-curl-face rs-${surface}`}>
                          <div
                            className="rs-curl-content"
                            style={{
                              left: -offset,
                              transform: turn.direction < 0 ? "scaleX(-1)" : undefined,
                            }}
                          >
                            <Leaf
                              position={p}
                              face={face}
                              chapters={chapters}
                              locale={locale}
                              decorative
                              scrollTop={scrollTop(p)}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="rs-edge rs-back"
            aria-label={labels[locale].previous}
            disabled={!destination(-1) || Boolean(turn)}
            onClick={() => go(-1)}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <button
            type="button"
            className="rs-edge rs-next"
            aria-label={labels[locale].next}
            disabled={!destination(1) || Boolean(turn)}
            onClick={() => go(1)}
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>
      </div>
      <p className="rs-sr-only" role="status" aria-live="polite">
        {open
          ? error
            ? labels[locale].missing
            : (chapters[position.chapter]?.[locale].name ?? labels[locale].contents)
          : ""}
      </p>
    </dialog>,
    document.body,
  );
}
