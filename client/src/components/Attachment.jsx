import React, { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { C, MONO } from "../theme";
import { api } from "../api";

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
  const [blobUrl, setBlobUrl] = useState(null);

  // Images need their bytes up front to show a thumbnail; documents only need
  // them when the user actually clicks, so they are fetched on demand.
  useEffect(() => {
    if (!isImage(att)) return;
    let revoked = false;
    let created = null;
    api.fetchAttachment(att.id)
      .then(url => { if (revoked) { URL.revokeObjectURL(url); return; } created = url; setBlobUrl(url); })
      .catch(() => {});
    return () => { revoked = true; if (created) URL.revokeObjectURL(created); };
  }, [att.id]);

  const open = async (e) => {
    e.preventDefault();
    try {
      const url = blobUrl || await api.fetchAttachment(att.id);
      window.open(url, "_blank", "noopener");
    } catch (err) { /* the parent surfaces upload/list errors */ }
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
      <button onClick={() => onRemove(att.id)}
              style={{ position: "absolute", top: -6, right: -6, background: C.crimson, borderRadius: "50%", width: 16, height: 16, color: "#fff", fontSize: 10, lineHeight: "16px" }}>×</button>
    </div>
  );
}
