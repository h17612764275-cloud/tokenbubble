import { ArrowClockwise, ChartLineUp, Eye, EyeSlash, PushPin, PushPinSlash } from "@phosphor-icons/react";
import type { CSSProperties, MouseEventHandler, PointerEventHandler } from "react";
import type { Language } from "../types";
import "./WidgetQuickActions.css";

interface Props {
  language: Language;
  positionLocked: boolean;
  todayTokens: number | null;
  widgetSize: number;
  accentColor: string;
  visible?: boolean;
  busy?: boolean;
  onRefresh: () => void;
  onHide: () => void;
  onTogglePositionLock: () => void;
}

function formatTokenCount(tokens: number | null): string {
  if (tokens === null) return "--";
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return Math.round(tokens).toLocaleString();
}

export function WidgetQuickActions({ language, positionLocked, todayTokens, widgetSize, accentColor, visible = true, busy = false, onRefresh, onHide, onTogglePositionLock }: Props) {
  const zh = language === "zh-CN";
  const stopPointer: MouseEventHandler<HTMLElement> = (event) => event.stopPropagation();
  const stopPointerDown: PointerEventHandler<HTMLElement> = (event) => event.stopPropagation();
  const today = formatTokenCount(todayTokens);
  const visibilityLabel = visible
    ? (zh ? "浮窗当前显示，点击隐藏" : "Widget visible; click to hide")
    : (zh ? "浮窗当前隐藏，点击显示" : "Widget hidden; click to show");
  const style = {
    "--theme-accent": accentColor,
    "--widget-orb-half-size": `${widgetSize / 2}px`,
  } as CSSProperties;

  return (
    <aside
      className="widget-quick-actions"
      style={style}
      role="toolbar"
      aria-label={zh ? "浮窗快捷功能" : "Widget quick actions"}
      onMouseDown={stopPointer}
      onPointerDown={stopPointerDown}
      onClick={stopPointer}
    >
      <button type="button" disabled={busy} onClick={onRefresh} aria-label={zh ? "刷新" : "Refresh"} title={zh ? "刷新" : "Refresh"}>
        <ArrowClockwise weight="bold" />
      </button>
      <button type="button" disabled={busy} onClick={onHide} aria-label={visibilityLabel} title={visibilityLabel} data-visibility={visible ? "visible" : "hidden"}>
        {visible ? <Eye weight="duotone" /> : <EyeSlash weight="duotone" />}
      </button>
      <button
        type="button"
        className={positionLocked ? "is-active" : ""}
        disabled={busy}
        onClick={onTogglePositionLock}
        aria-label={positionLocked ? (zh ? "解锁位置" : "Unlock position") : (zh ? "固定位置" : "Lock position")}
        title={positionLocked ? (zh ? "解锁位置" : "Unlock position") : (zh ? "固定位置" : "Lock position")}
      >
        {positionLocked ? <PushPinSlash weight="duotone" /> : <PushPin weight="duotone" />}
      </button>
      <div className="widget-quick-actions__usage" role="status" aria-label={zh ? `今日 Token 消耗 ${today}` : `Tokens used today ${today}`}>
        <ChartLineUp weight="duotone" />
        <span>{zh ? "今日" : "Today"} {today}</span>
      </div>
    </aside>
  );
}
