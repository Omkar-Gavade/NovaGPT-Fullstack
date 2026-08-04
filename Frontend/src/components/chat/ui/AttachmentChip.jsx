import { X, FileText, Image as ImageIcon, FileAudio, FileVideo, FileArchive, Table, Hash, File } from "lucide-react";
import { humanSize } from "../../../hooks/useAttachments";

const ICON = {
  image: ImageIcon,
  audio: FileAudio,
  video: FileVideo,
  pdf: FileText,
  doc: FileText,
  csv: Table,
  markdown: Hash,
  archive: FileArchive,
  file: File,
};

/** Preview chip for one attachment: thumbnail/icon, name, size, progress, remove. */
export default function AttachmentChip({ item, onRemove }) {
  const Icon = ICON[item.kind] || File;
  const uploading = item.progress < 100;

  return (
    <div className="group/att relative flex w-56 items-center gap-2.5 rounded-xl bg-raised p-2 pr-8 ring-1 ring-line">
      <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-app text-secondary">
        {item.previewUrl ? (
          <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Icon size={18} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-primary">{item.name}</p>
        <p className="text-[11px] text-tertiary">
          {uploading ? `${Math.round(item.progress)}%` : humanSize(item.size)}
        </p>
        {uploading && (
          <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-app">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${item.progress}%` }}
            />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => onRemove(item.id)}
        aria-label={`Remove ${item.name}`}
        className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-md text-tertiary
          opacity-0 transition-opacity hover:bg-active hover:text-primary
          group-hover/att:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
      >
        <X size={13} />
      </button>
    </div>
  );
}
