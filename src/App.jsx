import React, { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

async function fetchTemplates() {
  const { data, error } = await supabase.from("templates").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function fetchDownloadLogs() {
  const { data, error } = await supabase
    .from("download_logs")
    .select("*")
    .order("downloaded_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

const INK = "#16233A";
const PAPER = "#F7F5EF";
const TEAL = "#0F6E6A";
const TEAL_DARK = "#0B4F4C";
const LINE = "#D8D3C4";

const uid = () => Math.random().toString(36).slice(2, 9);

/* Simple accessibility gate, NOT real authentication: anyone with browser
   devtools access could bypass this. It just hides the editor/history UI
   from casual sales users. Add your email to this list, then in the
   browser set localStorage key "editor" to that email to unlock it. */
const ALLOWED_EDITOR_EMAILS = ["medirudiantoni@gmail.com"];
function isEditorUser() {
  try {
    return ALLOWED_EDITOR_EMAILS.includes(localStorage.getItem("editor"));
  } catch {
    return false;
  }
}

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

function loadScript(src, globalCheck) {
  return new Promise((resolve, reject) => {
    if (globalCheck && globalCheck()) return resolve();
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", reject);
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = reject;
    document.body.appendChild(s);
  });
}

async function pdfFileToImages(file, maxPages = 30) {
  await loadScript(PDFJS_URL, () => window.pdfjsLib);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const count = Math.min(doc.numPages, maxPages);
  const images = [];
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    images.push(canvas.toDataURL("image/png"));
  }
  return images;
}

/* Self-contained PDF writer: embeds one JPEG per page (DCTDecode). No
   external library needed, so it can't fail due to a blocked CDN script. */
function buildMultiPagePdf(pages) {
  // pages: [{ jpegBytes: Uint8Array, width, height }, ...]
  const parts = [];
  const offsets = {};
  let offset = 0;
  const push = (chunk) => {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    parts.push(bytes);
    offset += bytes.length;
  };

  const objMap = pages.map((_, idx) => {
    const base = 3 + idx * 3;
    return { page: base, img: base + 1, content: base + 2 };
  });
  const totalObjs = 2 + pages.length * 3;

  push("%PDF-1.4\n");

  offsets[1] = offset;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  const kids = objMap.map((o) => `${o.page} 0 R`).join(" ");
  offsets[2] = offset;
  push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((p, idx) => {
    const { page, img, content } = objMap[idx];
    offsets[page] = offset;
    push(`${page} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>\nendobj\n`);

    offsets[img] = offset;
    push(`${img} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpegBytes.length} >>\nstream\n`);
    push(p.jpegBytes);
    push("\nendstream\nendobj\n");

    const contentStr = `q ${p.width} 0 0 ${p.height} 0 0 cm /Im0 Do Q`;
    offsets[content] = offset;
    push(`${content} 0 obj\n<< /Length ${contentStr.length} >>\nstream\n${contentStr}\nendstream\nendobj\n`);
  });

  const xrefOffset = offset;
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjs; i++) xref += String(offsets[i] || 0).padStart(10, "0") + " 00000 n \n";
  push(xref);
  push(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function dataUrlToBlob(dataUrl) {
  const mimeMatch = dataUrl.match(/^data:(.*?);base64,/);
  const mime = mimeMatch ? mimeMatch[1] : "image/png";
  return new Blob([dataUrlToBytes(dataUrl)], { type: mime });
}

/* Shrinks a font size (px) until `text` fits within `maxWidthPx`, so preview
   and the exported image always wrap/clip identically instead of overflowing. */
function fitFontSize(ctx, text, maxWidthPx, baseFontPx, weight, minFontPx = 8) {
  if (!text) return baseFontPx;
  ctx.font = `${weight || 600} ${baseFontPx}px 'JetBrains Mono', monospace`;
  if (ctx.measureText(text).width <= maxWidthPx) return baseFontPx;
  let size = baseFontPx;
  while (size > minFontPx) {
    size -= 1;
    ctx.font = `${weight || 600} ${size}px 'JetBrains Mono', monospace`;
    if (ctx.measureText(text).width <= maxWidthPx) break;
  }
  return size;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TemplateEditorAppInner />
    </QueryClientProvider>
  );
}

function TemplateEditorAppInner() {
  const isEditor = useState(() => isEditorUser())[0];
  const [mode, setMode] = useState(() => (isEditorUser() ? "editor" : "fill")); // 'editor' | 'fill' | 'history'
  const activeMode = isEditor ? mode : "fill";

  return (
    <div style={{ background: PAPER, minHeight: 640, fontFamily: "'Space Grotesk', system-ui, sans-serif", color: INK }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
        .mono { font-family: 'JetBrains Mono', monospace; }
        .blueprint-bg {
          background-image: repeating-linear-gradient(0deg, rgba(15,110,106,0.06) 0 1px, transparent 1px 24px),
                             repeating-linear-gradient(90deg, rgba(15,110,106,0.06) 0 1px, transparent 1px 24px);
        }
        .tag-btn { transition: all .15s ease; }
        .field-box { transition: box-shadow .1s ease; }
        input[type=text], input[type=number], input[type=color] { outline: none; }
        input[type=text]:focus, input[type=number]:focus { box-shadow: 0 0 0 2px ${TEAL}55; }
      `}</style>

      {/* Top bar */}
      <div style={{ borderBottom: `1px solid ${LINE}` }} className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-2">
          <div style={{ width: 10, height: 10, background: TEAL, transform: "rotate(45deg)" }} />
          <span className="mono" style={{ fontSize: 13, letterSpacing: 1, fontWeight: 700, textTransform: "uppercase" }}>
            Titik&nbsp;Edit
          </span>
        </div>
        <div className="flex gap-1" style={{ background: "#EFEBDF", padding: 4, borderRadius: 8 }}>
          {isEditor && (
            <button
              className="tag-btn mono"
              onClick={() => setMode("editor")}
              style={{
                padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
                background: activeMode === "editor" ? INK : "transparent",
                color: activeMode === "editor" ? PAPER : INK,
              }}
            >
              01 · SUSUN TEMPLATE
            </button>
          )}
          <button
            className="tag-btn mono"
            onClick={() => setMode("fill")}
            style={{
              padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
              background: activeMode === "fill" ? INK : "transparent",
              color: activeMode === "fill" ? PAPER : INK,
            }}
          >
            {isEditor ? "02 · ISI DATA" : "ISI DATA"}
          </button>
          {isEditor && (
            <button
              className="tag-btn mono"
              onClick={() => setMode("history")}
              style={{
                padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
                background: activeMode === "history" ? INK : "transparent",
                color: activeMode === "history" ? PAPER : INK,
              }}
            >
              03 · RIWAYAT
            </button>
          )}
        </div>
      </div>

      {activeMode === "editor" ? <EditorPage /> : activeMode === "fill" ? <FillPage isEditor={isEditor} /> : <HistoryPage />}
    </div>
  );
}

/* ============================== EDITOR ============================== */

function EditorPage() {
  const [image, setImage] = useState(null);
  const [fields, setFields] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [templateName, setTemplateName] = useState("");
  const [saveStatus, setSaveStatus] = useState(""); // '', 'saving', 'saved', 'error'
  const [drawing, setDrawing] = useState(null);
  const [uploadStatus, setUploadStatus] = useState(""); // '', 'loading', 'error'
  const [pdfPages, setPdfPages] = useState([]); // dataURLs for each page, when source is a multi-page PDF
  const [pdfPageIndex, setPdfPageIndex] = useState(0);
  const overlayRef = useRef(null);
  const queryClient = useQueryClient();

  const selected = fields.find((f) => f.id === selectedId) || null;

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadStatus("loading");
    try {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        const pages = await pdfFileToImages(file);
        setPdfPages(pages);
        setPdfPageIndex(0);
        setImage(pages[0]);
      } else {
        setPdfPages([]);
        setPdfPageIndex(0);
        setImage(await fileToDataURL(file));
      }
      setFields([]);
      setSelectedId(null);
      setUploadStatus("");
    } catch (err) {
      setUploadStatus("error");
    }
  };

  const selectPdfPage = (idx) => {
    setPdfPageIndex(idx);
    setImage(pdfPages[idx]);
    setSelectedId(null);
  };

  const pctFromEvent = (e) => {
    const rect = overlayRef.current.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
    return { x, y };
  };

  const onOverlayMouseDown = (e) => {
    const { x, y } = pctFromEvent(e);
    const fieldEl = e.target.closest ? e.target.closest("[data-field-id]") : null;
    const clickedFieldId = fieldEl ? fieldEl.getAttribute("data-field-id") : null;
    setDrawing({ x0: x, y0: y, x1: x, y1: y, clickedFieldId });
  };
  const onOverlayMouseMove = (e) => {
    if (!drawing) return;
    const { x, y } = pctFromEvent(e);
    setDrawing((d) => ({ ...d, x1: x, y1: y }));
  };
  const onOverlayMouseUp = () => {
    if (!drawing) return;
    let x = Math.min(drawing.x0, drawing.x1);
    let y = Math.min(drawing.y0, drawing.y1);
    let w = Math.abs(drawing.x1 - drawing.x0);
    let h = Math.abs(drawing.y1 - drawing.y0);
    const clickedFieldId = drawing.clickedFieldId;
    setDrawing(null);
    if (w < 2 || h < 2) {
      if (clickedFieldId) {
        // Plain click (no real drag) on an existing field: just select it.
        setSelectedId(clickedFieldId);
        return;
      }
      // Plain click on empty area: create a default-size box centered on the click.
      w = 20;
      h = 8;
      x = Math.min(Math.max(drawing.x1 - w / 2, 0), 100 - w);
      y = Math.min(Math.max(drawing.y1 - h / 2, 0), 100 - h);
    }
    // A real drag always creates a new field, even if it started on top of
    // an existing one — so overlapping/nearby fields can still be drawn.
    const newField = {
      id: uid(),
      label: `field_${fields.length + 1}`,
      x, y, w, h,
      fontSizePct: 3,
      color: "#16233A",
      align: "left",
      fontWeight: 600,
      bgColor: null,
      page: pdfPageIndex,
    };
    setFields((f) => [...f, newField]);
    setSelectedId(newField.id);
  };

  const updateField = (id, patch) => setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const deleteField = (id) => {
    setFields((fs) => fs.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const currentPageFields = fields.filter((f) => (f.page || 0) === pdfPageIndex);

  const canSave = image && fields.length > 0 && templateName.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaveStatus("saving");
    try {
      const pagesToSave = pdfPages.length ? pdfPages : [image];
      const templateId = `${Date.now()}_${uid()}`;
      const uploadedUrls = await Promise.all(
        pagesToSave.map(async (dataUrl, i) => {
          const blob = dataUrlToBlob(dataUrl);
          const ext = blob.type === "image/jpeg" ? "jpg" : "png";
          const path = `${templateId}/page-${i + 1}.${ext}`;
          const { error: upErr } = await supabase.storage
            .from("template-images")
            .upload(path, blob, { contentType: blob.type, upsert: true });
          if (upErr) throw upErr;
          const { data: pub } = supabase.storage.from("template-images").getPublicUrl(path);
          return pub.publicUrl;
        })
      );
      const { error } = await supabase
        .from("templates")
        .insert({ name: templateName.trim(), image: uploadedUrls[0], fields, pages: uploadedUrls });
      if (error) throw error;
      setSaveStatus("saved");
      queryClient.invalidateQueries({ queryKey: ["templates"] });
    } catch (err) {
      setSaveStatus("error");
    }
    setTimeout(() => setSaveStatus(""), 2500);
  };

  return (
    <div className="flex" style={{ minHeight: 580 }}>
      {/* Left panel */}
      <div style={{ width: 300, borderRight: `1px solid ${LINE}`, background: "#FCFBF7" }} className="p-4 flex flex-col gap-4">
        <div>
          <div className="mono" style={{ fontSize: 11, letterSpacing: 1, color: "#6B7280", marginBottom: 6 }}>
            SUMBER GAMBAR
          </div>
          <label
            className="tag-btn"
            style={{
              display: "block", textAlign: "center", padding: "10px 12px", borderRadius: 6,
              border: `1.5px dashed ${TEAL}`, cursor: "pointer", fontSize: 13, color: TEAL_DARK, fontWeight: 600,
            }}
          >
            {uploadStatus === "loading" ? "Memproses…" : image ? "Ganti Gambar" : "Upload Desain (PNG/JPG/PDF)"}
            <input type="file" accept="image/*,application/pdf" onChange={handleUpload} style={{ display: "none" }} />
          </label>
          {uploadStatus === "error" && (
            <p style={{ fontSize: 12, color: "#B0432E", marginTop: 6 }}>Gagal memproses file. Coba file lain.</p>
          )}
          {!image && uploadStatus !== "error" && (
            <p style={{ fontSize: 12, color: "#8A8577", marginTop: 8, lineHeight: 1.5 }}>
              Upload hasil export desain (flyer, banner) — PNG, JPG, atau PDF (semua halaman bisa dipilih). Setelah itu tandai area yang boleh diubah sales dengan klik-drag di atas gambar.
            </p>
          )}
          {pdfPages.length > 1 && (
            <div style={{ marginTop: 10 }}>
              <div className="mono" style={{ fontSize: 10, letterSpacing: 0.5, color: "#8A8577", marginBottom: 6 }}>
                PILIH HALAMAN ({pdfPages.length})
              </div>
              <div className="flex gap-2" style={{ overflowX: "auto", paddingBottom: 4 }}>
                {pdfPages.map((p, idx) => (
                  <button
                    key={idx}
                    onClick={() => selectPdfPage(idx)}
                    style={{
                      flexShrink: 0, width: 52, padding: 0, borderRadius: 4, overflow: "hidden",
                      border: `2px solid ${idx === pdfPageIndex ? TEAL : LINE}`,
                    }}
                  >
                    <img src={p} alt={`Halaman ${idx + 1}`} style={{ width: "100%", display: "block" }} />
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 11, color: "#8A8577", marginTop: 6, lineHeight: 1.4 }}>
                Field tersimpan per halaman — pindah halaman aman, field di halaman lain tidak hilang.
              </p>
            </div>
          )}
        </div>

        {image && (
          <>
            <div>
              <div className="mono" style={{ fontSize: 11, letterSpacing: 1, color: "#6B7280", marginBottom: 6 }}>
                DAFTAR FIELD ({currentPageFields.length}){pdfPages.length > 1 && (
                  <span style={{ color: "#B5AF9C" }}> · total template: {fields.length}</span>
                )}
              </div>
              <div className="flex flex-col gap-1" style={{ maxHeight: 180, overflowY: "auto" }}>
                {currentPageFields.length === 0 && (
                  <p style={{ fontSize: 12, color: "#8A8577" }}>Belum ada field di halaman ini. Drag di atas gambar untuk membuat satu.</p>
                )}
                {currentPageFields.map((f, i) => (
                  <button
                    key={f.id}
                    onClick={() => setSelectedId(f.id)}
                    className="mono"
                    style={{
                      textAlign: "left", padding: "6px 8px", borderRadius: 4, fontSize: 12,
                      background: selectedId === f.id ? TEAL : "transparent",
                      color: selectedId === f.id ? PAPER : INK,
                      border: `1px solid ${selectedId === f.id ? TEAL : LINE}`,
                    }}
                  >
                    {String(i + 1).padStart(2, "0")} · {f.label}
                  </button>
                ))}
              </div>
            </div>

            {selected && (
              <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 12 }} className="flex flex-col gap-3">
                <div className="mono" style={{ fontSize: 11, letterSpacing: 1, color: "#6B7280" }}>
                  PROPERTI FIELD
                </div>
                <LabeledInput label="Nama field">
                  <input
                    type="text"
                    value={selected.label}
                    onChange={(e) => updateField(selected.id, { label: e.target.value })}
                    style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                  />
                </LabeledInput>
                <div className="flex gap-2">
                  <LabeledInput label="Posisi X (%)">
                    <input
                      type="number" min={0} max={100} step={0.5}
                      value={Math.round(selected.x * 10) / 10}
                      onChange={(e) => updateField(selected.id, { x: parseFloat(e.target.value) || 0 })}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                    />
                  </LabeledInput>
                  <LabeledInput label="Posisi Y (%)">
                    <input
                      type="number" min={0} max={100} step={0.5}
                      value={Math.round(selected.y * 10) / 10}
                      onChange={(e) => updateField(selected.id, { y: parseFloat(e.target.value) || 0 })}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                    />
                  </LabeledInput>
                </div>
                <div className="flex gap-2">
                  <LabeledInput label="Lebar (%)">
                    <input
                      type="number" min={1} max={100} step={0.5}
                      value={Math.round(selected.w * 10) / 10}
                      onChange={(e) => updateField(selected.id, { w: parseFloat(e.target.value) || 1 })}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                    />
                  </LabeledInput>
                  <LabeledInput label="Tinggi (%)">
                    <input
                      type="number" min={1} max={100} step={0.5}
                      value={Math.round(selected.h * 10) / 10}
                      onChange={(e) => updateField(selected.id, { h: parseFloat(e.target.value) || 1 })}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                    />
                  </LabeledInput>
                </div>
                <div className="flex gap-2">
                  <LabeledInput label="Ukuran teks (% tinggi)">
                    <input
                      type="number" min={1} max={20} step={0.5}
                      value={selected.fontSizePct}
                      onChange={(e) => updateField(selected.id, { fontSizePct: parseFloat(e.target.value) || 1 })}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                    />
                  </LabeledInput>
                  <LabeledInput label="Warna">
                    <input
                      type="color"
                      value={selected.color}
                      onChange={(e) => updateField(selected.id, { color: e.target.value })}
                      style={{ width: "100%", height: 30, borderRadius: 4, border: `1px solid ${LINE}` }}
                    />
                  </LabeledInput>
                </div>
                <LabeledInput label="Perataan">
                  <div className="flex gap-1">
                    {["left", "center", "right"].map((a) => (
                      <button
                        key={a}
                        onClick={() => updateField(selected.id, { align: a })}
                        className="mono"
                        style={{
                          flex: 1, padding: "5px 0", fontSize: 11, borderRadius: 4,
                          border: `1px solid ${selected.align === a ? TEAL : LINE}`,
                          background: selected.align === a ? TEAL : "transparent",
                          color: selected.align === a ? PAPER : INK,
                        }}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                </LabeledInput>
                <LabeledInput label="Warna latar (opsional)">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateField(selected.id, { bgColor: selected.bgColor ? null : "#FFFFFF" })}
                      className="mono"
                      style={{
                        padding: "5px 10px", fontSize: 11, borderRadius: 4,
                        border: `1px solid ${selected.bgColor ? TEAL : LINE}`,
                        background: selected.bgColor ? TEAL : "transparent",
                        color: selected.bgColor ? PAPER : INK,
                      }}
                    >
                      {selected.bgColor ? "Aktif" : "Tidak ada"}
                    </button>
                    {selected.bgColor && (
                      <input
                        type="color"
                        value={selected.bgColor}
                        onChange={(e) => updateField(selected.id, { bgColor: e.target.value })}
                        style={{ flex: 1, height: 28, borderRadius: 4, border: `1px solid ${LINE}` }}
                      />
                    )}
                  </div>
                </LabeledInput>
                <button
                  onClick={() => deleteField(selected.id)}
                  style={{ fontSize: 12, color: "#B0432E", textAlign: "left", padding: "4px 0" }}
                >
                  Hapus field ini
                </button>
              </div>
            )}

            <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 12, marginTop: "auto" }} className="flex flex-col gap-2">
              <LabeledInput label="Nama template">
                <input
                  type="text"
                  placeholder="mis. Flyer Promo MPS ADT"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  style={{ width: "100%", padding: "7px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                />
              </LabeledInput>
              <button
                disabled={!canSave || saveStatus === "saving"}
                onClick={handleSave}
                style={{
                  padding: "9px 0", borderRadius: 6, fontWeight: 700, fontSize: 13, letterSpacing: 0.3,
                  background: canSave ? TEAL : "#D8D3C4", color: PAPER, cursor: canSave ? "pointer" : "not-allowed",
                }}
              >
                {saveStatus === "saving" ? "Menyimpan…" : saveStatus === "saved" ? "Tersimpan ✓" : saveStatus === "error" ? "Gagal, coba lagi" : "Simpan & Bagikan Template"}
              </button>
              <p style={{ fontSize: 11, color: "#8A8577" }}>
                Setelah disimpan, sales tinggal buka tab "02 · Isi Data" untuk mengisi teks mereka sendiri.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Canvas area */}
      <div className="blueprint-bg flex-1 flex p-8" style={{ overflow: "auto" }}>
        {!image ? (
          <div className="mono" style={{ color: "#9A9587", fontSize: 13, textAlign: "center", margin: "auto" }}>
            [ belum ada gambar — upload desain di panel kiri ]
          </div>
        ) : (
          <div
            style={{ position: "relative", maxWidth: "100%", margin: "auto", boxShadow: "0 4px 20px rgba(22,35,58,0.15)" }}
          >
            <img src={image} alt="template" style={{ display: "block", width: "100%", maxWidth: 640, userSelect: "none" }} draggable={false} />
            <div
              ref={overlayRef}
              onMouseDown={onOverlayMouseDown}
              onMouseMove={onOverlayMouseMove}
              onMouseUp={onOverlayMouseUp}
              onMouseLeave={() => setDrawing(null)}
              style={{ position: "absolute", inset: 0, cursor: "crosshair" }}
            >
              {currentPageFields.map((f) => (
                <div
                  key={f.id}
                  className="field-box"
                  data-field-id={f.id}
                  style={{
                    position: "absolute",
                    left: `${f.x}%`, top: `${f.y}%`, width: `${f.w}%`, height: `${f.h}%`,
                    border: `1.5px dashed ${selectedId === f.id ? TEAL_DARK : TEAL}`,
                    background: f.bgColor
                      ? f.bgColor
                      : selectedId === f.id ? "rgba(15,110,106,0.14)" : "rgba(15,110,106,0.06)",
                    cursor: "pointer",
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      position: "absolute", top: -18, left: 0, fontSize: 10, background: TEAL_DARK, color: PAPER,
                      padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap", pointerEvents: "none",
                    }}
                  >
                    {f.label}
                  </span>
                </div>
              ))}
              {drawing && (
                <div
                  style={{
                    position: "absolute",
                    left: `${Math.min(drawing.x0, drawing.x1)}%`,
                    top: `${Math.min(drawing.y0, drawing.y1)}%`,
                    width: `${Math.abs(drawing.x1 - drawing.x0)}%`,
                    height: `${Math.abs(drawing.y1 - drawing.y0)}%`,
                    border: `1.5px solid ${TEAL_DARK}`,
                    background: "rgba(15,110,106,0.18)",
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LabeledInput({ label, children }) {
  return (
    <label style={{ display: "block" }}>
      <div className="mono" style={{ fontSize: 10, color: "#8A8577", marginBottom: 3, letterSpacing: 0.3 }}>{label}</div>
      {children}
    </label>
  );
}

/* ============================== FILL (SALES) ============================== */

function getTemplatePages(t) {
  return t.pages && t.pages.length ? t.pages : [t.image];
}

function renderPageCanvas(imgSrc, pageFields, values) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      pageFields.forEach((f) => {
        const boxX = (f.x / 100) * canvas.width;
        const boxY = (f.y / 100) * canvas.height;
        const boxW = (f.w / 100) * canvas.width;
        const boxH = (f.h / 100) * canvas.height;
        const text = values[f.id] || "";
        const baseFontPx = (f.fontSizePct / 100) * canvas.height;
        const safeWidth = boxW * 0.92;
        const fontPx = fitFontSize(ctx, text, safeWidth, baseFontPx, f.fontWeight);

        ctx.save();
        ctx.beginPath();
        ctx.rect(boxX, boxY, boxW, boxH);
        ctx.clip();

        if (f.bgColor) {
          ctx.fillStyle = f.bgColor;
          ctx.fillRect(boxX, boxY, boxW, boxH);
        }

        ctx.font = `${f.fontWeight || 600} ${fontPx}px 'JetBrains Mono', monospace`;
        ctx.fillStyle = f.color || "#16233A";
        ctx.textBaseline = "middle";
        ctx.textAlign = f.align || "left";
        let drawX = boxX + boxW * 0.04;
        if (f.align === "center") drawX = boxX + boxW / 2;
        else if (f.align === "right") drawX = boxX + boxW * 0.96;
        ctx.fillText(text, drawX, boxY + boxH / 2);
        ctx.restore();
      });
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = imgSrc;
  });
}

function PagePreview({ pageSrc, pageFields, values }) {
  const imgRef = useRef(null);
  const measureCanvasRef = useRef(null);
  const [dispSize, setDispSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!imgRef.current) return;
    const el = imgRef.current;
    const update = () => setDispSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageSrc]);

  const getFontPx = (f, text) => {
    if (!dispSize.h) return f.fontSizePct * 6.4;
    if (!measureCanvasRef.current) measureCanvasRef.current = document.createElement("canvas");
    const ctx = measureCanvasRef.current.getContext("2d");
    const baseFontPx = dispSize.h * (f.fontSizePct / 100);
    const safeWidth = dispSize.w * (f.w / 100) * 0.92;
    return fitFontSize(ctx, text || "", safeWidth, baseFontPx, f.fontWeight);
  };

  return (
    <div style={{ position: "relative", boxShadow: "0 4px 20px rgba(22,35,58,0.15)" }}>
      <img ref={imgRef} src={pageSrc} style={{ display: "block", width: "100%" }} draggable={false} />
      {pageFields.map((f) => (
        <div
          key={f.id}
          style={{
            position: "absolute",
            left: `${f.x}%`, top: `${f.y}%`, width: `${f.w}%`, height: `${f.h}%`,
            display: "flex", alignItems: "center",
            justifyContent: f.align === "center" ? "center" : f.align === "right" ? "flex-end" : "flex-start",
            fontSize: `${getFontPx(f, values[f.id] || f.label)}px`,
            color: f.color, fontWeight: f.fontWeight || 600,
            fontFamily: "'JetBrains Mono', monospace",
            background: f.bgColor || "transparent",
            overflow: "hidden", whiteSpace: "nowrap", pointerEvents: "none",
          }}
        >
          <span style={{ opacity: values[f.id] ? 1 : 0.35 }}>
            {values[f.id] || f.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function FillPage({ isEditor }) {
  const queryClient = useQueryClient();
  const { data: templates = [], isLoading: loading, isError: loadError, refetch: loadTemplates } = useQuery({
    queryKey: ["templates"],
    queryFn: fetchTemplates,
  });
  const [selected, setSelected] = useState(null);
  const [values, setValues] = useState({});
  const [downloadFormat, setDownloadFormat] = useState("png");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [previewFilter, setPreviewFilter] = useState("withFields"); // 'withFields' | 'all'

  useEffect(() => {
    if (selected) {
      const init = {};
      selected.fields.forEach((f) => { init[f.id] = ""; });
      setValues(init);
      setPreviewFilter("withFields");
    }
  }, [selected]);

  const deleteMutation = useMutation({
    mutationFn: async (t) => {
      const marker = "/object/public/template-images/";
      const paths = getTemplatePages(t)
        .map((url) => {
          const idx = url.indexOf(marker);
          return idx >= 0 ? url.slice(idx + marker.length) : null;
        })
        .filter(Boolean);
      if (paths.length) await supabase.storage.from("template-images").remove(paths);
      const { error } = await supabase.from("templates").delete().eq("id", t.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["templates"] }),
  });

  const deleteTemplate = (t, e) => {
    e.stopPropagation();
    deleteMutation.mutate(t);
  };

  const handleDownload = async () => {
    if (!selected || downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const pages = getTemplatePages(selected);
      const isMultiPage = pages.length > 1;
      const fileBase = (selected.name || "hasil").replace(/\s+/g, "_");
      const canvases = await Promise.all(
        pages.map((src, idx) =>
          renderPageCanvas(src, selected.fields.filter((f) => (f.page || 0) === idx), values)
        )
      );

      if (!isMultiPage && downloadFormat === "png") {
        const canvas = canvases[0];
        await new Promise((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (!blob) return reject(new Error("Gagal membuat PNG"));
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${fileBase}_hasil.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            resolve();
          }, "image/png");
        });
      } else {
        const pageData = canvases.map((canvas) => ({
          jpegBytes: dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92)),
          width: canvas.width,
          height: canvas.height,
        }));
        const pdfBytes = buildMultiPagePdf(pageData);
        const blob = new Blob([pdfBytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${fileBase}_hasil.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }

      const fieldValuesByLabel = {};
      selected.fields.forEach((f) => { fieldValuesByLabel[f.label] = values[f.id] || ""; });
      supabase.from("download_logs").insert({
        template_id: selected.id,
        template_name: selected.name,
        field_values: fieldValuesByLabel,
        format: isMultiPage ? "pdf" : downloadFormat,
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: ["download_logs"] });
      }); // best-effort, don't block/fail the download on log errors
    } catch (err) {
      setDownloadError("Gagal mengunduh: " + (err?.message || "terjadi kesalahan"));
    }
    setDownloading(false);
  };

  if (loading) {
    return <div className="p-8 mono" style={{ fontSize: 13, color: "#8A8577" }}>Memuat template…</div>;
  }

  if (loadError) {
    return (
      <div className="p-8">
        <p style={{ fontSize: 13, color: "#B0432E", marginBottom: 8 }}>Gagal memuat daftar template.</p>
        <button onClick={loadTemplates} className="mono" style={{ fontSize: 12, padding: "6px 12px", borderRadius: 6, background: TEAL, color: PAPER }}>
          Coba lagi
        </button>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="p-6">
        <div className="mono" style={{ fontSize: 11, letterSpacing: 1, color: "#6B7280", marginBottom: 12 }}>
          PILIH TEMPLATE ({templates.length})
        </div>
        {templates.length === 0 ? (
          <p style={{ fontSize: 13, color: "#8A8577" }}>
            Belum ada template. Minta admin membuat & menyimpan template di tab "01 · Susun Template".
          </p>
        ) : (
          <div className="flex flex-wrap gap-4">
            {templates.map((t) => {
              const pageCount = getTemplatePages(t).length;
              return (
                <div
                  key={t.id}
                  onClick={() => setSelected(t)}
                  style={{
                    width: 200, cursor: "pointer", border: `1px solid ${LINE}`, borderRadius: 8, overflow: "hidden",
                    background: "#FCFBF7",
                  }}
                >
                  <img src={t.image} alt={t.name} style={{ width: "100%", height: 130, objectFit: "cover", display: "block" }} />
                  <div className="p-2 flex items-center justify-between">
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</div>
                      <div className="mono" style={{ fontSize: 10, color: "#8A8577" }}>
                        {pageCount > 1 ? `${pageCount} halaman · ` : ""}{t.fields.length} field
                      </div>
                    </div>
                    {isEditor && (
                      <button
                        onClick={(e) => deleteTemplate(t, e)}
                        style={{ fontSize: 11, color: "#B0432E" }}
                        title="Hapus template"
                      >
                        Hapus
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const pages = getTemplatePages(selected);
  const isMultiPage = pages.length > 1;
  const pagesWithFields = new Set(selected.fields.map((f) => f.page || 0));
  const visiblePageIndexes =
    previewFilter === "all" || pagesWithFields.size === 0
      ? pages.map((_, i) => i)
      : pages.map((_, i) => i).filter((i) => pagesWithFields.has(i));

  return (
    <div className="flex flex-col md:flex-row" style={{ minHeight: 580 }}>
      <div className={`md:w-70 md:border-r border-r-[${LINE}] bg-[#FCFBF7] p-4 flex flex-col gap-3 md:max-h-screen md:pb-20 md:sticky top-0`} >
        <button onClick={() => setSelected(null)} className="mono" style={{ fontSize: 11, color: TEAL_DARK, textAlign: "left" }}>
          ← Pilih template lain
        </button>

        <div className="flex-1 overflow-y-auto">

          <div style={{ fontSize: 15, fontWeight: 700 }}>{selected.name}</div>

          {isMultiPage && (
            <div className="flex gap-1" style={{ background: "#EFEBDF", padding: 3, borderRadius: 6 }}>
              <button
                onClick={() => setPreviewFilter("withFields")}
                className="mono"
                style={{
                  flex: 1, padding: "5px 0", fontSize: 10, fontWeight: 700, borderRadius: 4,
                  background: previewFilter === "withFields" ? INK : "transparent",
                  color: previewFilter === "withFields" ? PAPER : INK,
                }}
              >
                HAL. BERISI FIELD
              </button>
              <button
                onClick={() => setPreviewFilter("all")}
                className="mono"
                style={{
                  flex: 1, padding: "5px 0", fontSize: 10, fontWeight: 700, borderRadius: 4,
                  background: previewFilter === "all" ? INK : "transparent",
                  color: previewFilter === "all" ? PAPER : INK,
                }}
              >
                SEMUA HALAMAN
              </button>
            </div>
          )}

          <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 10, overflowY: "auto" }} className="flex flex-col gap-3">
            {Array.from(pagesWithFields).sort((a, b) => a - b).map((pageIdx) => (
              <div key={pageIdx} className="flex flex-col gap-3">
                {isMultiPage && (
                  <div className="mono" style={{ fontSize: 10, letterSpacing: 0.5, color: "#8A8577" }}>
                    HALAMAN {pageIdx + 1}
                  </div>
                )}
                {selected.fields.filter((f) => (f.page || 0) === pageIdx).map((f) => (
                  <LabeledInput key={f.id} label={f.label}>
                    <input
                      type="text"
                      value={values[f.id] || ""}
                      onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                      placeholder={`isi ${f.label}...`}
                      style={{ width: "100%", padding: "7px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                    />
                  </LabeledInput>
                ))}
              </div>
            ))}
          </div>
        </div>


        <div style={{ marginTop: "auto" }} className="flex flex-col gap-2">
          {isMultiPage ? (
            <p className="mono" style={{ fontSize: 10, color: "#8A8577", textAlign: "center" }}>
              Format unduhan: PDF ({pages.length} halaman)
            </p>
          ) : (
            <div className="flex gap-1" style={{ background: "#EFEBDF", padding: 3, borderRadius: 6 }}>
              {["png", "pdf"].map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => setDownloadFormat(fmt)}
                  className="mono"
                  style={{
                    flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 700, borderRadius: 4,
                    background: downloadFormat === fmt ? INK : "transparent",
                    color: downloadFormat === fmt ? PAPER : INK,
                  }}
                >
                  {fmt.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={handleDownload}
            disabled={downloading}
            style={{ padding: "10px 0", borderRadius: 6, fontWeight: 700, fontSize: 13, background: TEAL, color: PAPER, opacity: downloading ? 0.7 : 1 }}
          >
            {downloading ? "Memproses…" : `Unduh Hasil (${isMultiPage ? "PDF" : downloadFormat.toUpperCase()})`}
          </button>
          {downloadError && (
            <p style={{ fontSize: 11, color: "#B0432E" }}>{downloadError}</p>
          )}
        </div>
      </div>

      <div className="blueprint-bg flex-1 flex p-8" style={{ overflow: "auto" }}>
        <div className="flex flex-col gap-6" style={{ width: "100%", maxWidth: 640, margin: "auto" }}>
          {visiblePageIndexes.map((idx) => (
            <div key={idx}>
              {isMultiPage && (
                <div className="mono" style={{ fontSize: 10, color: "#8A8577", marginBottom: 6 }}>
                  HALAMAN {idx + 1}{!pagesWithFields.has(idx) && " · tanpa field"}
                </div>
              )}
              <PagePreview
                pageSrc={pages[idx]}
                pageFields={selected.fields.filter((f) => (f.page || 0) === idx)}
                values={values}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================== HISTORY (RIWAYAT) ============================== */

function HistoryPage() {
  const { data: logs = [], isLoading: loading, isError: loadError, refetch: loadLogs } = useQuery({
    queryKey: ["download_logs"],
    queryFn: fetchDownloadLogs,
  });

  const formatTime = (iso) => {
    try {
      return new Date(iso).toLocaleString("id-ID", {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  if (loading) {
    return <div className="p-8 mono" style={{ fontSize: 13, color: "#8A8577" }}>Memuat riwayat…</div>;
  }

  if (loadError) {
    return (
      <div className="p-8">
        <p style={{ fontSize: 13, color: "#B0432E", marginBottom: 8 }}>Gagal memuat riwayat download.</p>
        <button onClick={loadLogs} className="mono" style={{ fontSize: 12, padding: "6px 12px", borderRadius: 6, background: TEAL, color: PAPER }}>
          Coba lagi
        </button>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="mono" style={{ fontSize: 11, letterSpacing: 1, color: "#6B7280" }}>
          RIWAYAT DOWNLOAD ({logs.length})
        </div>
        <button onClick={loadLogs} className="mono" style={{ fontSize: 11, color: TEAL_DARK }}>
          ↻ Refresh
        </button>
      </div>

      {logs.length === 0 ? (
        <p style={{ fontSize: 13, color: "#8A8577" }}>Belum ada yang download hasil apa pun.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {logs.map((log) => (
            <div
              key={log.id}
              style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: 12, background: "#FCFBF7" }}
            >
              <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{log.template_name}</div>
                <div className="flex items-center gap-2">
                  <span
                    className="mono"
                    style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                      background: TEAL, color: PAPER,
                    }}
                  >
                    {(log.format || "").toUpperCase()}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: "#8A8577" }}>
                    {formatTime(log.downloaded_at)}
                  </span>
                </div>
              </div>
              {log.field_values && Object.keys(log.field_values).length > 0 && (
                <div className="flex flex-col gap-1" style={{ marginTop: 8, borderTop: `1px solid ${LINE}`, paddingTop: 8 }}>
                  {Object.entries(log.field_values).map(([label, value]) => (
                    <div key={label} className="flex" style={{ fontSize: 12, gap: 6 }}>
                      <span className="mono" style={{ color: "#8A8577", minWidth: 90 }}>{label}</span>
                      <span style={{ color: INK }}>{value || <em style={{ color: "#B5AF9C" }}>(kosong)</em>}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}