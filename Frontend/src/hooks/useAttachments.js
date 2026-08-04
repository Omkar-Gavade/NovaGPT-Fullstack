import { useCallback, useEffect, useRef, useState } from "react";

/** Map a File to a coarse kind used for icon + preview decisions. */
function kindOf(file) {
  const t = file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("video/")) return "video";
  if (t === "application/pdf" || ext === "pdf") return "pdf";
  if (["doc", "docx"].includes(ext)) return "doc";
  if (["csv", "tsv"].includes(ext)) return "csv";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
  return "file";
}

export const humanSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Composer attachments: add via file picker / drag-drop / paste, show local
 * previews with a progress bar, and remove before sending.
 *
 * NOTE: there is no upload endpoint yet, so the "upload" is a local simulation
 * that completes the progress bar. When the backend upload lands, swap the
 * simulated tick for a real XHR/fetch with `onprogress` — the UI stays the same.
 */
export function useAttachments() {
  const [items, setItems] = useState([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const timers = useRef(new Map());

  useEffect(
    () => () => {
      timers.current.forEach(clearInterval);
      items.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const addFiles = useCallback((fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const next = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: file.size,
      kind: kindOf(file),
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      progress: 0,
    }));
    setItems((prev) => [...prev, ...next]);

    // simulate upload progress until a real endpoint exists
    for (const item of next) {
      const t = setInterval(() => {
        setItems((prev) =>
          prev.map((i) => {
            if (i.id !== item.id) return i;
            const progress = Math.min(100, i.progress + 12 + Math.random() * 18);
            if (progress >= 100) {
              clearInterval(timers.current.get(item.id));
              timers.current.delete(item.id);
            }
            return { ...i, progress };
          })
        );
      }, 90);
      timers.current.set(item.id, t);
    }
  }, []);

  const remove = useCallback((id) => {
    clearInterval(timers.current.get(id));
    timers.current.delete(id);
    setItems((prev) => {
      const gone = prev.find((i) => i.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    timers.current.forEach(clearInterval);
    timers.current.clear();
    setItems((prev) => {
      prev.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
      return [];
    });
  }, []);

  // drag & drop handlers for the composer drop zone
  const dropZoneProps = {
    onDragEnter: (e) => {
      e.preventDefault();
      dragDepth.current += 1;
      if (e.dataTransfer?.types?.includes("Files")) setDragging(true);
    },
    onDragOver: (e) => e.preventDefault(),
    onDragLeave: (e) => {
      e.preventDefault();
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) setDragging(false);
    },
    onDrop: (e) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(e.dataTransfer?.files);
    },
  };

  // paste handler (images + files)
  const onPaste = useCallback(
    (e) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles]
  );

  return { items, dragging, addFiles, remove, clear, dropZoneProps, onPaste };
}
