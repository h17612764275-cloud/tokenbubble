import { Camera, FolderSimple, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import {
  beginScreenshot,
  chooseScreenshotFolder,
  getDefaultScreenshotFolder,
  isGlobalShortcutRegistered,
  openScreenshotFolder,
} from "../lib/bridge";
import { formatShortcut } from "../lib/screenshot";
import type { WidgetPreferences } from "../types";

interface Props {
  preferences: WidgetPreferences;
  zh: boolean;
  onClose: () => void;
  onSave: (shortcut: string, folder: string) => void;
}

export function ScreenshotSettingsDialog({ preferences, zh, onClose, onSave }: Props) {
  const [defaultFolder, setDefaultFolder] = useState(preferences.screenshotFolder);
  const [draftShortcut, setDraftShortcut] = useState(preferences.screenshotShortcut);
  const [draftFolder, setDraftFolder] = useState(preferences.screenshotFolder);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");

  useEffect(() => {
    void getDefaultScreenshotFolder().then((folder) => {
      setDefaultFolder(folder);
      setDraftFolder((current) => current || folder);
    });
  }, []);

  useEffect(() => {
    if (!capturing) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(false);
        setError("");
        return;
      }
      const shortcut = formatShortcut(event);
      if (!shortcut) {
        setError(zh ? "请按下包含 Ctrl、Alt 或 Shift 的组合键" : "Use Ctrl, Alt, or Shift in the shortcut");
        return;
      }
      void isGlobalShortcutRegistered(shortcut).then((registered) => {
        if (registered && shortcut !== preferences.screenshotShortcut) {
          setError(zh ? "该快捷键已被占用" : "This shortcut is already in use");
          return;
        }
        setDraftShortcut(shortcut);
        setCapturing(false);
        setError("");
      });
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [capturing, preferences.screenshotShortcut, zh]);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !capturing) onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [capturing, onClose]);

  const folderLabel = useMemo(
    () => draftFolder === defaultFolder ? `Token Bubble / ${zh ? "截图" : "Screenshots"}` : draftFolder,
    [defaultFolder, draftFolder, zh],
  );

  const reset = () => {
    setDraftShortcut("Ctrl+P");
    setDraftFolder(defaultFolder);
    setCapturing(false);
    setError("");
  };

  const startScreenshot = () => {
    if (starting) return;
    setStarting(true);
    setStartError("");
    void beginScreenshot()
      .then(onClose)
      .catch((value) => setStartError(String(value)))
      .finally(() => setStarting(false));
  };

  return (
    <div className="settings-dialog-backdrop screenshot-settings-backdrop" onMouseDown={onClose}>
      <section className="settings-dialog screenshot-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="screenshot-settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <strong id="screenshot-settings-title">{zh ? "截图设置" : "Screenshot settings"}</strong>
            <span>{zh ? "快捷键与默认保存位置" : "Shortcut and default save location"}</span>
          </div>
          <button type="button" onClick={onClose} aria-label={zh ? "关闭" : "Close"}><X /></button>
        </header>

        <div className="screenshot-settings__group">
          <div className="settings-dialog-current screenshot-settings__current">
            <span>{zh ? "当前快捷键" : "Current shortcut"}</span>
            <kbd>{draftShortcut}</kbd>
          </div>
          <button type="button" className={`settings-dialog-capture${capturing ? " is-capturing" : ""}`} onClick={() => { setCapturing(true); setError(""); }}>
            {capturing ? (zh ? "现在按下新的组合键…" : "Press the new shortcut…") : (zh ? "更改快捷键" : "Change shortcut")}
          </button>
          {error ? <p className="screenshot-settings__error" role="alert">{error}</p> : null}
          <button type="button" className="settings-dialog-capture screenshot-settings__start" disabled={starting} onClick={startScreenshot}>
            <Camera weight="duotone" />
            {starting ? (zh ? "正在启动截图…" : "Starting capture…") : (zh ? "开始截图" : "Start capture")}
          </button>
          {startError ? <p className="screenshot-settings__error" role="alert">{startError}</p> : null}
        </div>

        <div className="screenshot-settings__group screenshot-settings__folder">
          <span className="screenshot-settings__label">{zh ? "默认保存文件夹" : "Default save folder"}</span>
          <button type="button" className="screenshot-settings__path" title={draftFolder} onClick={() => void openScreenshotFolder(draftFolder)}>
            <span>{folderLabel}</span><FolderSimple weight="duotone" />
          </button>
          <div className="screenshot-settings__folder-actions">
            <button type="button" onClick={() => void chooseScreenshotFolder().then((folder) => { if (folder) setDraftFolder(folder); })}>{zh ? "更改位置" : "Change"}</button>
            <button type="button" onClick={() => void openScreenshotFolder(draftFolder)}>{zh ? "打开文件夹" : "Open folder"}</button>
          </div>
          <p>{zh ? "截图完成后自动保存到此文件夹；确认截图时同时复制到剪贴板。" : "Screenshots save here automatically and are copied to the clipboard."}</p>
        </div>

        <footer>
          <button type="button" onClick={reset}>{zh ? "恢复默认" : "Reset"}</button>
          <button type="button" className="is-primary" disabled={!draftFolder || !!error} onClick={() => { onSave(draftShortcut, draftFolder); onClose(); }}>{zh ? "完成" : "Done"}</button>
        </footer>
      </section>
    </div>
  );
}
