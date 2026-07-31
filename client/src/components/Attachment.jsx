import React, { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { C, MONO } from "../theme";
import { api } from "../api";
import { getOrFetchBlobUrl, peekBlobUrl, releaseBlobUrl } from "../lib/attachmentBlobCache";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"];

function extensionOf(att) {
  const source = att.filename || "";
  const ext = source.split(".").pop();
  return ext && ext !== source ? ext.toLowerCase() : "";
}

function isImage(att) {
  if (att.mimeType) return att.mimeType.startsWith("image/");
  return IMAGE_EXTENSIONS.includes(extensionOf(att));
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Attachment({ att, onRemove }) {
  // Seed from whatever is already cached (e.g. this same attachment was
  // rendered earlier in the session) so a remount shows the thumbnail
  // immediately instead of flashing the placeholder while it refetches.
  const [blobUrl, setBlobUrl] = useState(() => peekBlobUrl(att.id));

  // Images need their bytes up front to show a thumbnail; documents only
  // need them when the user actually clicks. Either way the fetch goes
  // through the shared cache (attachmentBlobCache), so remounting this
  // component -- or opening the same document twice -- reuses the one blob
  // URL instead of creating and leaking another.
  useEffect(() => {
    if (!isImage(att) || blobUrl) return;
    let cancelled = false;
    getOrFetchBlobUrl(att.id, api.fetchAttachment)
      .then(url => { if (!cancelled) setBlobUrl(url); })
      .catch(() => {});
    // Deliberately no cleanup that revokes the URL here -- the cache, not
    // this component instance, owns the URL's lifetime. `cancelled` only
    // stops a late setState on an unmounted component.
    return () => { cancelled = true; };
  }, [att.id, blobUrl]);

  const open = async (e) => {
    e.preventDefault();
    try {
      const url = blobUrl || await getOrFetchBlobUrl(att.id, api.fetchAttachment);
      if (!blobUrl) setBlobUrl(url);
      window.open(url, "_blank", "noopener");
    } catch (err) { /* the parent surfaces upload/list errors */ }
  };

  const handleRemove = async () => {
    // Wait for the delete to settle before releasing the cache -- releasing
    // first and having the delete fail would just cost an extra refetch
    // next time this attachment is viewed, not a correctness problem, but
    // there is no upside to doing it early.
    await onRemove(att.id);
    releaseBlobUrl(att.id);
  };

  const tileStyle = {
    width: 64, height: 64, borderRadius: 6,
    border: `1px solid ${C.hair}`, background: C.panelHi, padding: 4,
  };

  return (
    <div style={{ position: "relative" }}>
      <a href="#" onClick={open}
         title={`${att.filename}${formatSize(att.sizeBytes) ? ` · ${formatSize(att.sizeBytes)}` : ""}`}>
        {isImage(att) && blobUrl ? (
          <img src={blobUrl} alt={att.filename}
               style={{ ...tileStyle, objectFit: "cover", padding: 0 }} />
        ) : (
          <div className="flex flex-col items-center justify-center" style={tileStyle}>
            <FileText size={20} style={{ color: C.teal }} />
            <div style={{ fontFamily: MONO, fontSize: 9, color: C.gold, marginTop: 2, textTransform: "uppercase" }}>
              {extensionOf(att) || "file"}
            </div>
            <div style={{ fontSize: 8, color: C.ivoryDim, maxWidth: 56, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {att.filename}
            </div>
          </div>
        )}
      </a>
      <button onClick={handleRemove}
              style={{ position: "absolute", top: -6, right: -6, background: C.crimson, borderRadius: "50%", width: 16, height: 16, color: "#fff", fontSize: 10, lineHeight: "16px" }}>×</button>
    </div>
  );
}
