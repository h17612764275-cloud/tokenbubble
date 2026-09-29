import {
  ArrowCounterClockwise,
  ArrowUpRight,
  Check,
  Circle,
  DownloadSimple,
  GridFour,
  PencilSimple,
  PushPin,
  Rectangle,
  TextT,
  X,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { join } from "@tauri-apps/api/path";
import annotationMoveCursor from "../assets/annotation-move-cursor.svg";
import {
  activateScreenshot,
  cancelScreenshot,
  chooseScreenshotFile,
  finishScreenshot,
  getPreferences,
  getScreenshotCapture,
  heartbeatScreenshot,
  revealScreenshot,
  setScreenshotDialogMode,
  type ScreenshotCapturePayload,
} from "../lib/bridge";
import {
  clampSelection,
  findWindowTargetAtPoint,
  moveSelection,
  normalizeSelection,
  projectCaptureRect,
  resizeSelection,
  snapPointToWindowEdges,
  toolbarTop,
  type Point,
  type ResizeHandle,
  type ScreenshotRect,
} from "../lib/screenshot";
import {
  findDrawingActionAtPoint,
  translateDrawingAction,
  type DrawingAction,
  type DrawingTool,
} from "../lib/screenshotAnnotations";

interface Interaction {
  mode: "pending-select" | "select" | "move" | "resize" | "draw" | "move-action";
  origin: Point;
  initial: ScreenshotRect | null;
  handle?: ResizeHandle;
  tool?: DrawingTool;
  actionIndex?: number;
  initialAction?: DrawingAction;
  didMove?: boolean;
}

const HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const WINDOW_CLICK_DRAG_THRESHOLD = 4;
const WINDOW_EDGE_SNAP_THRESHOLD = 10;
const ANNOTATION_MOVE_CURSOR = `url("${annotationMoveCursor}") 16 16, move`;
const TOOL_BUTTONS: Array<{ tool: DrawingTool; label: string; icon: typeof Rectangle }> = [
  { tool: "rectangle", label: "矩形", icon: Rectangle },
  { tool: "ellipse", label: "圆形", icon: Circle },
  { tool: "arrow", label: "箭头", icon: ArrowUpRight },
  { tool: "pen", label: "画笔", icon: PencilSimple },
  { tool: "mosaic", label: "马赛克", icon: GridFour },
  { tool: "text", label: "文字", icon: TextT },
];

const point = (event: ReactPointerEvent): Point => ({ x: event.clientX, y: event.clientY });

const textActionFromDraft = (position: Point | null, value: string): DrawingAction | null => (
  position && value.trim()
    ? { tool: "text", start: position, end: position, text: value }
    : null
);

function drawAction(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  action: DrawingAction,
  selection: ScreenshotRect,
  destinationScaleX: number,
  destinationScaleY: number,
  sourceScaleX: number,
  sourceScaleY: number,
) {
  const project = (value: Point) => ({
    x: (value.x - selection.x) * destinationScaleX,
    y: (value.y - selection.y) * destinationScaleY,
  });
  const start = project(action.start);
  const end = project(action.end);
  const lineScale = Math.max(1, (destinationScaleX + destinationScaleY) / 2);
  context.save();
  context.strokeStyle = "#ff4f8b";
  context.fillStyle = "#ff4f8b";
  context.lineWidth = 3 * lineScale;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = "rgba(255,79,139,.38)";
  context.shadowBlur = 2.5 * lineScale;

  if (action.tool === "rectangle") {
    context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
  } else if (action.tool === "ellipse") {
    context.beginPath();
    context.ellipse((start.x + end.x) / 2, (start.y + end.y) / 2, Math.abs(end.x - start.x) / 2, Math.abs(end.y - start.y) / 2, 0, 0, Math.PI * 2);
    context.stroke();
  } else if (action.tool === "arrow") {
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const head = 11 * lineScale;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
    context.stroke();
  } else if (action.tool === "pen") {
    const points = action.points ?? [action.start, action.end];
    if (points.length > 1) {
      context.beginPath();
      const first = project(points[0]);
      context.moveTo(first.x, first.y);
      for (const value of points.slice(1)) {
        const next = project(value);
        context.lineTo(next.x, next.y);
      }
      context.stroke();
    }
  } else if (action.tool === "mosaic") {
    const block = 14;
    context.imageSmoothingEnabled = false;
    for (const value of action.points ?? []) {
      const next = project(value);
      context.drawImage(
        image,
        Math.max(0, value.x * sourceScaleX),
        Math.max(0, value.y * sourceScaleY),
        1,
        1,
        next.x - block * destinationScaleX / 2,
        next.y - block * destinationScaleY / 2,
        block * destinationScaleX,
        block * destinationScaleY,
      );
    }
  } else if (action.tool === "text" && action.text) {
    context.font = `700 ${18 * lineScale}px "Microsoft YaHei UI", sans-serif`;
    context.textBaseline = "top";
    context.fillText(action.text, start.x, start.y);
  }
  context.restore();
}

export function ScreenshotOverlay() {
  const [capture, setCapture] = useState<ScreenshotCapturePayload | null>(null);
  const [selection, setSelection] = useState<ScreenshotRect | null>(null);
  const [suggestedSelection, setSuggestedSelection] = useState<ScreenshotRect | null>(null);
  const [activeTool, setActiveTool] = useState<DrawingTool | null>(null);
  const [actions, setActions] = useState<DrawingAction[]>([]);
  const [preview, setPreview] = useState<DrawingAction | null>(null);
  const [hoveredActionIndex, setHoveredActionIndex] = useState<number | null>(null);
  const [draggingActionIndex, setDraggingActionIndex] = useState<number | null>(null);
  const [textEditor, setTextEditor] = useState<Point | null>(null);
  const [textValue, setTextValue] = useState("");
  const [imageRevision, setImageRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const annotationRef = useRef<HTMLCanvasElement>(null);
  const actionsRef = useRef<DrawingAction[]>([]);
  const interaction = useRef<Interaction | null>(null);
  const previewRef = useRef<DrawingAction | null>(null);
  const actionHistory = useRef<DrawingAction[][]>([]);
  const composingText = useRef(false);
  const textDraftRef = useRef<{ id: number; position: Point; value: string } | null>(null);
  const textDraftSequence = useRef(0);
  const suppressSelectionClick = useRef(false);
  const currentSessionId = useRef<number | null>(null);
  const activatedSessionId = useRef<number | null>(null);
  const cancelPendingReveal = useRef<() => void>(() => undefined);
  const mounted = useRef(true);

  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let requestRevision = 0;
    let latestSessionId = 0;
    let unlisten: () => void = () => undefined;
    const requestCapture = (showError: boolean, expectedSessionId?: number) => {
      const revision = ++requestRevision;
      void getScreenshotCapture(expectedSessionId)
        .then((value) => {
          if (disposed || revision !== requestRevision) return;
          if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) return;
          if (value.sessionId < latestSessionId) return;
          latestSessionId = value.sessionId;
          currentSessionId.current = value.sessionId;
          activatedSessionId.current = null;
          setCapture(value);
        })
        .catch((value) => {
          if (!disposed && revision === requestRevision && showError) setError(String(value));
        });
    };
    const loadCapture = (sessionId: number, showError = true) => {
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return;
      if (sessionId <= latestSessionId) return;
      latestSessionId = sessionId;
      cancelPendingReveal.current();
      currentSessionId.current = sessionId;
      activatedSessionId.current = null;
      setCapture(null);
      setSelection(null);
      setSuggestedSelection(null);
      setActiveTool(null);
      setActions([]);
      actionsRef.current = [];
      actionHistory.current = [];
      setPreview(null);
      setHoveredActionIndex(null);
      setDraggingActionIndex(null);
      interaction.current = null;
      previewRef.current = null;
      suppressSelectionClick.current = false;
      composingText.current = false;
      textDraftRef.current = null;
      setTextEditor(null);
      setTextValue("");
      setBusy(false);
      setError("");
      requestCapture(showError, sessionId);
    };
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<number>("screenshot-capture-ready", (event) => loadCapture(event.payload)))
      .then((cleanup) => {
        if (disposed) cleanup();
        else {
          unlisten = cleanup;
          if (latestSessionId === 0) requestCapture(false);
        }
      })
      .catch(() => { if (!disposed && latestSessionId === 0) requestCapture(false); });
    return () => {
      disposed = true;
      mounted.current = false;
      currentSessionId.current = null;
      cancelPendingReveal.current();
      unlisten();
    };
  }, []);

  const bounds = { width: window.innerWidth, height: window.innerHeight };
  const windowTargets = capture
    ? (capture.windowTargets ?? []).map((target) => projectCaptureRect(target, capture, bounds))
    : [];

  const undoLastAction = () => {
    if (textDraftRef.current) {
      composingText.current = false;
      textDraftRef.current = null;
      setTextEditor(null);
      setTextValue("");
      return;
    }
    const current = interaction.current;
    if (current?.mode === "move-action" || current?.mode === "draw") interaction.current = null;
    suppressSelectionClick.current = false;
    setDraggingActionIndex(null);
    setHoveredActionIndex(null);
    if (current?.mode === "move-action" || current?.mode === "draw") {
      const previous = actionHistory.current.pop();
      if (previous) setActions(previous);
      previewRef.current = null;
      setPreview(null);
      return;
    }
    const previous = actionHistory.current.pop();
    setActions((value) => previous ?? value.slice(0, -1));
  };

  useEffect(() => {
    const canvas = annotationRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !selection || !capture) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(selection.width * ratio));
    canvas.height = Math.max(1, Math.round(selection.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const sourceScaleX = capture.width / window.innerWidth;
    const sourceScaleY = capture.height / window.innerHeight;
    const renderedActions = preview ? [...actions, preview] : [...actions];
    const draftAction = textEditor ? textActionFromDraft(textEditor, textValue) : null;
    if (draftAction) renderedActions.push(draftAction);
    for (const action of renderedActions) {
      drawAction(context, image, action, selection, ratio, ratio, sourceScaleX, sourceScaleY);
    }
  }, [actions, capture, imageRevision, preview, selection, textEditor, textValue]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (textEditor) {
          composingText.current = false;
          textDraftRef.current = null;
          setTextEditor(null);
          setTextValue("");
        } else {
          cancelCurrentScreenshot();
        }
      } else if (event.key === "Enter" && selection && !textEditor && !busy) {
        event.preventDefault();
        void complete("confirm");
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoLastAction();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const revealCapture = (sessionId: number) => {
    if (currentSessionId.current !== sessionId) return;
    setImageRevision((value) => value + 1);
    if (activatedSessionId.current === sessionId) return;
    activatedSessionId.current = sessionId;
    const isCurrentSession = () => mounted.current && currentSessionId.current === sessionId && activatedSessionId.current === sessionId;
    // The image is decoded at onLoad. An offscreen macOS WebView may pause animation
    // frames, so move the native window first and bound only the paint wait.
    void activateScreenshot(sessionId)
      .then((activeSessionId) => {
        if (!isCurrentSession()) return;
        let finished = false;
        let firstFrame: number | undefined;
        let secondFrame: number | undefined;
        let fallbackTimer: number | undefined;
        const cancel = () => {
          finished = true;
          if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
          if (typeof window.cancelAnimationFrame === "function") {
            if (firstFrame !== undefined) window.cancelAnimationFrame(firstFrame);
            if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
          }
        };
        cancelPendingReveal.current = cancel;
        const reveal = () => {
          if (finished) return;
          cancel();
          if (!isCurrentSession()) return;
          void revealScreenshot(activeSessionId).catch((value) => {
            if (isCurrentSession()) setError(String(value));
          });
        };
        fallbackTimer = window.setTimeout(reveal, 120);
        firstFrame = window.requestAnimationFrame(() => {
          secondFrame = window.requestAnimationFrame(reveal);
        });
      })
      .catch((value) => {
        if (isCurrentSession()) setError(String(value));
      });
  };

  const cancelCurrentScreenshot = () => {
    const sessionId = currentSessionId.current;
    if (sessionId === null) return;
    currentSessionId.current = null;
    cancelPendingReveal.current();
    void cancelScreenshot(sessionId).catch((value) => {
      if (mounted.current && currentSessionId.current === null) setError(String(value));
    });
  };

  useEffect(() => {
    if (!capture) return;
    let disposed = false;
    const heartbeat = () => {
      void heartbeatScreenshot(capture.sessionId)
        .then((alive) => {
          if (!alive && !disposed) {
            currentSessionId.current = null;
            cancelPendingReveal.current();
            setCapture(null);
          }
        })
        .catch(() => undefined);
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 1_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [capture]);

  const startSelection = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || busy) return;
    const target = event.target as HTMLElement;
    if (target.closest(".screenshot-toolbar") || target.closest(".screenshot-selection")) return;
    const origin = point(event);
    const suggested = findWindowTargetAtPoint(windowTargets, origin);
    interaction.current = suggested
      ? { mode: "pending-select", origin, initial: suggested }
      : { mode: "select", origin, initial: null };
    setSuggestedSelection(suggested);
    setSelection(suggested ? null : { x: origin.x, y: origin.y, width: 0, height: 0 });
    setActions([]);
    actionsRef.current = [];
    actionHistory.current = [];
    setPreview(null);
    setHoveredActionIndex(null);
    setDraggingActionIndex(null);
    previewRef.current = null;
    suppressSelectionClick.current = false;
    composingText.current = false;
    textDraftRef.current = null;
    setTextEditor(null);
    setTextValue("");
    rootRef.current?.setPointerCapture(event.pointerId);
  };

  const openTextDraft = (position: Point) => {
    composingText.current = false;
    textDraftRef.current = { id: ++textDraftSequence.current, position, value: "" };
    setTextEditor(position);
    setTextValue("");
  };

  const commitText = (expectedDraftId?: number): DrawingAction[] => {
    const draft = textDraftRef.current;
    if (!draft || (expectedDraftId !== undefined && draft.id !== expectedDraftId)) return actionsRef.current;
    composingText.current = false;
    textDraftRef.current = null;
    let nextActions = actionsRef.current;
    const action = textActionFromDraft(draft.position, draft.value);
    if (action) {
      actionHistory.current.push(nextActions);
      nextActions = [...nextActions, action];
      actionsRef.current = nextActions;
      setActions(nextActions);
    }
    setTextEditor(null);
    setTextValue("");
    return nextActions;
  };

  const startInside = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !selection || busy) return;
    event.stopPropagation();
    const origin = point(event);
    const currentActions = commitText();
    const actionIndex = findDrawingActionAtPoint(currentActions, origin);
    if (actionIndex !== null) {
      event.preventDefault();
      suppressSelectionClick.current = true;
      actionHistory.current.push(currentActions);
      interaction.current = {
        mode: "move-action",
        origin,
        initial: selection,
        actionIndex,
        initialAction: currentActions[actionIndex],
        didMove: false,
      };
      setHoveredActionIndex(actionIndex);
      setDraggingActionIndex(actionIndex);
      rootRef.current?.setPointerCapture(event.pointerId);
      return;
    }
    suppressSelectionClick.current = false;
    setHoveredActionIndex(null);
    if (activeTool === "text") {
      openTextDraft(origin);
      return;
    }
    if (activeTool) {
      const action: DrawingAction = { tool: activeTool, start: origin, end: origin, points: [origin] };
      actionHistory.current.push(currentActions);
      interaction.current = { mode: "draw", origin, initial: selection, tool: activeTool };
      previewRef.current = action;
      setPreview(action);
    } else {
      interaction.current = { mode: "move", origin, initial: selection };
    }
    rootRef.current?.setPointerCapture(event.pointerId);
  };

  const openTextEditor = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressSelectionClick.current) {
      suppressSelectionClick.current = false;
      event.stopPropagation();
      return;
    }
    if (activeTool !== "text" || busy || (event.target as HTMLElement).closest(".screenshot-text-editor")) return;
    event.stopPropagation();
    openTextDraft({ x: event.clientX, y: event.clientY });
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>, handle: ResizeHandle) => {
    if (event.button !== 0 || !selection || busy) return;
    event.preventDefault();
    event.stopPropagation();
    commitText();
    setHoveredActionIndex(null);
    interaction.current = { mode: "resize", origin: point(event), initial: selection, handle };
    rootRef.current?.setPointerCapture(event.pointerId);
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = interaction.current;
    const next = point(event);
    if (!current) {
      if (!selection && !busy && !textEditor) {
        setSuggestedSelection(findWindowTargetAtPoint(windowTargets, next));
        return;
      }
      setHoveredActionIndex(selection && !busy && !textEditor
        ? findDrawingActionAtPoint(actions, next)
        : null);
      return;
    }
    const snap = (value: Point) => event.altKey
      ? value
      : snapPointToWindowEdges(value, windowTargets, WINDOW_EDGE_SNAP_THRESHOLD);
    if (current.mode === "pending-select") {
      if (Math.hypot(next.x - current.origin.x, next.y - current.origin.y) <= WINDOW_CLICK_DRAG_THRESHOLD) return;
      interaction.current = { ...current, mode: "select", initial: null };
      setSuggestedSelection(null);
      setSelection(clampSelection(normalizeSelection(snap(current.origin), snap(next)), bounds));
    } else if (current.mode === "select") {
      setSelection(clampSelection(normalizeSelection(snap(current.origin), snap(next)), bounds));
    } else if (current.mode === "move" && current.initial) {
      setSelection(moveSelection(current.initial, { x: next.x - current.origin.x, y: next.y - current.origin.y }, bounds));
    } else if (current.mode === "resize" && current.initial && current.handle) {
      setSelection(resizeSelection(current.initial, current.handle, snap(next), bounds));
    } else if (current.mode === "move-action" && current.actionIndex !== undefined && current.initialAction) {
      const delta = { x: next.x - current.origin.x, y: next.y - current.origin.y };
      if (delta.x !== 0 || delta.y !== 0) current.didMove = true;
      const moved = translateDrawingAction(current.initialAction, delta);
      setActions((value) => value.map((action, index) => index === current.actionIndex ? moved : action));
    } else if (current.mode === "draw" && current.tool) {
      setPreview((value) => {
        const updated = value ? {
          ...value,
          end: next,
          points: current.tool === "pen" || current.tool === "mosaic" ? [...(value.points ?? []), next] : value.points,
        } : null;
        previewRef.current = updated;
        return updated;
      });
    }
  };

  const end = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const current = interaction.current;
    interaction.current = null;
    if (rootRef.current?.hasPointerCapture(event.pointerId)) rootRef.current.releasePointerCapture(event.pointerId);
    if (current?.mode === "pending-select") {
      setSuggestedSelection(null);
      setSelection(cancelled ? null : current.initial);
    }
    if (current?.mode === "move-action") {
      if (cancelled || !current.didMove) {
        const previous = actionHistory.current.pop();
        if (previous) setActions(previous);
      }
      setDraggingActionIndex(null);
      setHoveredActionIndex(cancelled ? null : current.actionIndex ?? null);
      if (cancelled) {
        suppressSelectionClick.current = false;
      } else {
        window.setTimeout(() => { suppressSelectionClick.current = false; }, 0);
      }
    }
    const committed = previewRef.current;
    if (current?.mode === "draw") {
      if (cancelled || !committed) {
        actionHistory.current.pop();
      } else {
        setActions((value) => [...value, committed]);
      }
    }
    previewRef.current = null;
    setPreview(null);
  };

  const renderResult = (renderActions: DrawingAction[]): string => {
    if (!selection || !capture || !imageRef.current) throw new Error("请先框选截图区域");
    const sourceScaleX = capture.width / window.innerWidth;
    const sourceScaleY = capture.height / window.innerHeight;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(selection.width * sourceScaleX));
    canvas.height = Math.max(1, Math.round(selection.height * sourceScaleY));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法生成截图");
    context.drawImage(
      imageRef.current,
      selection.x * sourceScaleX,
      selection.y * sourceScaleY,
      selection.width * sourceScaleX,
      selection.height * sourceScaleY,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    for (const action of renderActions) {
      drawAction(context, imageRef.current, action, selection, sourceScaleX, sourceScaleY, sourceScaleX, sourceScaleY);
    }
    return canvas.toDataURL("image/png");
  };

  const complete = async (mode: "confirm" | "save-as" | "pin") => {
    if (!selection || !capture || busy || currentSessionId.current !== capture.sessionId) return;
    const sessionId = capture.sessionId;
    const isCurrentSession = () => currentSessionId.current === sessionId;
    setBusy(true);
    setError("");
    try {
      const dataUrl = renderResult(commitText());
      let targetPath: string | null = null;
      if (mode === "save-as") {
        const preferences = await getPreferences();
        if (!isCurrentSession()) return;
        const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        const defaultPath = await join(preferences.screenshotFolder, `Token-Bubble_${stamp}.png`);
        if (!isCurrentSession()) return;
        let dialogOpened = false;
        try {
          await setScreenshotDialogMode(sessionId, true);
          dialogOpened = true;
          if (!isCurrentSession()) return;
          targetPath = await chooseScreenshotFile(defaultPath);
        } finally {
          if (dialogOpened) {
            try {
              await setScreenshotDialogMode(sessionId, false);
            } catch (value) {
              if (isCurrentSession()) throw value;
            }
          }
        }
        if (!isCurrentSession() || !targetPath) return;
      }
      await finishScreenshot(sessionId, dataUrl, targetPath, mode === "pin");
    } catch (value) {
      if (isCurrentSession()) setError(String(value));
    } finally {
      if (isCurrentSession()) setBusy(false);
    }
  };

  const toolbarHalf = Math.min(250, Math.max(0, (window.innerWidth - 24) / 2));
  const toolbar = selection ? {
    top: toolbarTop(selection, 54, window.innerHeight),
    left: Math.min(window.innerWidth - 12 - toolbarHalf, Math.max(12 + toolbarHalf, selection.x + selection.width / 2)),
  } : null;
  const maskSelection = selection ?? suggestedSelection;
  const activeTextDraftId = textDraftRef.current?.id;

  const selectTool = (tool: DrawingTool) => {
    commitText();
    setActiveTool((value) => value === tool ? null : tool);
  };

  return (
    <main ref={rootRef} className="screenshot-overlay" onPointerDown={startSelection} onPointerMove={move} onPointerUp={end} onPointerCancel={(event) => end(event, true)}>
      {capture ? <img ref={imageRef} className="screenshot-capture" src={capture.dataUrl} draggable={false} alt="" onLoad={() => revealCapture(capture.sessionId)} /> : null}
      {suggestedSelection ? (
        <div
          className="screenshot-window-suggestion"
          style={{
            left: suggestedSelection.x,
            top: suggestedSelection.y,
            width: suggestedSelection.width,
            height: suggestedSelection.height,
          }}
          aria-hidden="true"
        >
          <output>{Math.round(suggestedSelection.width * (capture?.width ?? window.innerWidth) / window.innerWidth)} × {Math.round(suggestedSelection.height * (capture?.height ?? window.innerHeight) / window.innerHeight)}</output>
        </div>
      ) : null}
      {maskSelection ? (
        <>
          <div className="screenshot-mask screenshot-mask--top" style={{ height: maskSelection.y }} />
          <div className="screenshot-mask screenshot-mask--left" style={{ top: maskSelection.y, width: maskSelection.x, height: maskSelection.height }} />
          <div className="screenshot-mask screenshot-mask--right" style={{ top: maskSelection.y, left: maskSelection.x + maskSelection.width, height: maskSelection.height }} />
          <div className="screenshot-mask screenshot-mask--bottom" style={{ top: maskSelection.y + maskSelection.height }} />
          {selection ? (
            <>
              <div
                className={`screenshot-selection${activeTool ? " is-drawing" : ""}${hoveredActionIndex !== null ? " is-annotation-hovered" : ""}${draggingActionIndex !== null ? " is-moving-annotation" : ""}`}
                style={{
                  left: selection.x,
                  top: selection.y,
                  width: selection.width,
                  height: selection.height,
                  cursor: draggingActionIndex !== null || hoveredActionIndex !== null ? ANNOTATION_MOVE_CURSOR : undefined,
                }}
                onPointerDown={startInside}
                onClick={openTextEditor}
              >
                <canvas ref={annotationRef} />
                {HANDLES.map((handle) => <button key={handle} type="button" className={`screenshot-handle screenshot-handle--${handle}`} onPointerDown={(event) => startResize(event, handle)} aria-label={`调整 ${handle}`} />)}
                <output className="screenshot-size">{Math.round(selection.width * (capture?.width ?? window.innerWidth) / window.innerWidth)} × {Math.round(selection.height * (capture?.height ?? window.innerHeight) / window.innerHeight)}</output>
                {textEditor ? (
                  <input
                    type="text"
                    className="screenshot-text-editor"
                    style={{
                      left: textEditor.x - selection.x,
                      top: textEditor.y - selection.y,
                      width: Math.max(1, selection.width - (textEditor.x - selection.x)),
                      background: "transparent",
                      borderStyle: "none",
                      borderWidth: 0,
                      boxShadow: "none",
                      color: "transparent",
                      textShadow: "none",
                    }}
                    aria-label="输入截图文字"
                    value={textValue}
                    onPointerDown={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const draft = textDraftRef.current;
                      if (draft) textDraftRef.current = { ...draft, value: event.target.value };
                      setTextValue(event.target.value);
                    }}
                    onBlur={() => commitText(activeTextDraftId)}
                    onCompositionStart={() => { composingText.current = true; }}
                    onCompositionEnd={() => { composingText.current = false; }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter" && !composingText.current && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        commitText(activeTextDraftId);
                      }
                      if (event.key === "Escape" && !composingText.current) {
                        event.preventDefault();
                        composingText.current = false;
                        if (textDraftRef.current?.id === activeTextDraftId) textDraftRef.current = null;
                        setTextEditor(null);
                        setTextValue("");
                      }
                    }}
                    spellCheck={false}
                    autoFocus
                  />
                ) : null}
              </div>
              {toolbar ? (
                <nav className="screenshot-toolbar" style={{ left: toolbar.left, top: toolbar.top }} aria-label="截图工具栏">
                  {TOOL_BUTTONS.map(({ tool, label, icon: Icon }) => (
                    <button key={tool} type="button" className={activeTool === tool ? "is-active" : ""} onClick={() => selectTool(tool)} title={label} aria-label={label}><Icon /></button>
                  ))}
                  <i aria-hidden="true" />
                  <button type="button" onClick={undoLastAction} disabled={actions.length === 0 && !textEditor} title="撤销" aria-label="撤销"><ArrowCounterClockwise /></button>
                  <button type="button" className="is-save" onClick={() => void complete("save-as")} disabled={busy} title="另存为" aria-label="另存为"><DownloadSimple /></button>
                  <button type="button" className="is-pin" onClick={() => void complete("pin")} disabled={busy} title="贴图置顶" aria-label="贴图置顶"><PushPin /></button>
                  <button type="button" className="is-cancel" onClick={cancelCurrentScreenshot} title="取消" aria-label="取消"><X /></button>
                  <button type="button" className="is-confirm" onClick={() => void complete("confirm")} disabled={busy} title="完成" aria-label="完成"><Check /></button>
                </nav>
              ) : null}
            </>
          ) : null}
        </>
      ) : <div className="screenshot-mask screenshot-mask--full" />}
      {error ? <div className="screenshot-error" role="alert">{error}<button type="button" onClick={cancelCurrentScreenshot}>关闭</button></div> : null}
    </main>
  );
}
