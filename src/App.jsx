import React, { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";

const INK = "#16233A";
const PAPER = "#F7F5EF";
const TEAL = "#0F6E6A";
const TEAL_DARK = "#0B4F4C";
const LINE = "#D8D3C4";

const uid = () => Math.random().toString(36).slice(2, 9);

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

async function pdfFileToDataURL(file) {
  await loadScript(PDFJS_URL, () => window.pdfjsLib);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toDataURL("image/png");
}

/* Self-contained PDF writer: embeds a JPEG directly (DCTDecode) as a single page.
   No external library needed, so it can't fail due to a blocked CDN script. */
function buildPdfFromJpeg(jpegBytes, width, height) {
  const parts = [];
  const offsets = {};
  let offset = 0;
  const push = (chunk) => {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    parts.push(bytes);
    offset += bytes.length;
  };

  push("%PDF-1.4\n");
  offsets[1] = offset;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets[2] = offset;
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offsets[3] = offset;
  push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  offsets[4] = offset;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  push("\nendstream\nendobj\n");
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
  offsets[5] = offset;
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefOffset = offset;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

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
  const [mode, setMode] = useState("editor"); // 'editor' | 'fill'

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
          <button
            className="tag-btn mono"
            onClick={() => setMode("editor")}
            style={{
              padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
              background: mode === "editor" ? INK : "transparent",
              color: mode === "editor" ? PAPER : INK,
            }}
          >
            01 · SUSUN TEMPLATE
          </button>
          <button
            className="tag-btn mono"
            onClick={() => setMode("fill")}
            style={{
              padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
              background: mode === "fill" ? INK : "transparent",
              color: mode === "fill" ? PAPER : INK,
            }}
          >
            02 · ISI DATA
          </button>
        </div>
      </div>

      {mode === "editor" ? <EditorPage /> : <FillPage />}
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
  const overlayRef = useRef(null);

  const selected = fields.find((f) => f.id === selectedId) || null;

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadStatus("loading");
    try {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const dataUrl = isPdf ? await pdfFileToDataURL(file) : await fileToDataURL(file);
      setImage(dataUrl);
      setFields([]);
      setSelectedId(null);
      setUploadStatus("");
    } catch (err) {
      setUploadStatus("error");
    }
  };

  const pctFromEvent = (e) => {
    const rect = overlayRef.current.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
    return { x, y };
  };

  const onOverlayMouseDown = (e) => {
    if (e.target !== overlayRef.current) return; // clicked a field box, ignore
    const { x, y } = pctFromEvent(e);
    setDrawing({ x0: x, y0: y, x1: x, y1: y });
  };
  const onOverlayMouseMove = (e) => {
    if (!drawing) return;
    const { x, y } = pctFromEvent(e);
    setDrawing((d) => ({ ...d, x1: x, y1: y }));
  };
  const onOverlayMouseUp = () => {
    if (!drawing) return;
    const x = Math.min(drawing.x0, drawing.x1);
    const y = Math.min(drawing.y0, drawing.y1);
    const w = Math.abs(drawing.x1 - drawing.x0);
    const h = Math.abs(drawing.y1 - drawing.y0);
    setDrawing(null);
    if (w < 2 || h < 2) return;
    const newField = {
      id: uid(),
      label: `field_${fields.length + 1}`,
      x, y, w, h,
      fontSizePct: 3,
      color: "#16233A",
      align: "left",
      fontWeight: 600,
    };
    setFields((f) => [...f, newField]);
    setSelectedId(newField.id);
  };

  const updateField = (id, patch) => setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const deleteField = (id) => {
    setFields((fs) => fs.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const canSave = image && fields.length > 0 && templateName.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaveStatus("saving");
    try {
      const { error } = await supabase
        .from("templates")
        .insert({ name: templateName.trim(), image, fields });
      setSaveStatus(error ? "error" : "saved");
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
              Upload hasil export desain (flyer, banner) — PNG, JPG, atau PDF (halaman pertama otomatis dipakai). Setelah itu tandai area yang boleh diubah sales dengan klik-drag di atas gambar.
            </p>
          )}
        </div>

        {image && (
          <>
            <div>
              <div className="mono" style={{ fontSize: 11, letterSpacing: 1, color: "#6B7280", marginBottom: 6 }}>
                DAFTAR FIELD ({fields.length})
              </div>
              <div className="flex flex-col gap-1" style={{ maxHeight: 180, overflowY: "auto" }}>
                {fields.length === 0 && (
                  <p style={{ fontSize: 12, color: "#8A8577" }}>Belum ada field. Drag di atas gambar untuk membuat satu.</p>
                )}
                {fields.map((f, i) => (
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
      <div className="blueprint-bg flex-1 flex items-center justify-center p-8" style={{ overflow: "auto" }}>
        {!image ? (
          <div className="mono" style={{ color: "#9A9587", fontSize: 13, textAlign: "center" }}>
            [ belum ada gambar — upload desain di panel kiri ]
          </div>
        ) : (
          <div
            style={{ position: "relative", maxWidth: "100%", boxShadow: "0 4px 20px rgba(22,35,58,0.15)" }}
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
              {fields.map((f) => (
                <div
                  key={f.id}
                  className="field-box"
                  onMouseDown={(e) => { e.stopPropagation(); setSelectedId(f.id); }}
                  style={{
                    position: "absolute",
                    left: `${f.x}%`, top: `${f.y}%`, width: `${f.w}%`, height: `${f.h}%`,
                    border: `1.5px dashed ${selectedId === f.id ? TEAL_DARK : TEAL}`,
                    background: selectedId === f.id ? "rgba(15,110,106,0.14)" : "rgba(15,110,106,0.06)",
                    cursor: "pointer",
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      position: "absolute", top: -18, left: 0, fontSize: 10, background: TEAL_DARK, color: PAPER,
                      padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap",
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

function FillPage() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState(null);
  const [values, setValues] = useState({});
  const [downloadFormat, setDownloadFormat] = useState("png");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const previewImgRef = useRef(null);
  const measureCanvasRef = useRef(null);
  const [dispSize, setDispSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!previewImgRef.current || !selected) return;
    const el = previewImgRef.current;
    const update = () => setDispSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [selected]);

  const getPreviewFontPx = (f, text) => {
    if (!dispSize.h) return f.fontSizePct * 6.4; // fallback before image has measured size
    if (!measureCanvasRef.current) measureCanvasRef.current = document.createElement("canvas");
    const ctx = measureCanvasRef.current.getContext("2d");
    const baseFontPx = dispSize.h * (f.fontSizePct / 100);
    const safeWidth = dispSize.w * (f.w / 100) * 0.92;
    return fitFontSize(ctx, text || "", safeWidth, baseFontPx, f.fontWeight);
  };

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const { data, error } = await supabase
        .from("templates")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setTemplates(data || []);
    } catch (e) {
      setLoadError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  useEffect(() => {
    if (selected) {
      const init = {};
      selected.fields.forEach((f) => { init[f.id] = ""; });
      setValues(init);
    }
  }, [selected]);

  const deleteTemplate = async (id, e) => {
    e.stopPropagation();
    try {
      await supabase.from("templates").delete().eq("id", id);
      loadTemplates();
    } catch (err) { /* ignore */ }
  };

  const renderCanvas = () =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        selected.fields.forEach((f) => {
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
      img.src = selected.image;
    });

  const handleDownload = async () => {
    if (!selected || downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const canvas = await renderCanvas();
      const fileBase = (selected.name || "hasil").replace(/\s+/g, "_");
      if (downloadFormat === "png") {
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
        const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
        const jpegBytes = dataUrlToBytes(jpegDataUrl);
        const pdfBytes = buildPdfFromJpeg(jpegBytes, canvas.width, canvas.height);
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
            {templates.map((t) => (
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
                    <div className="mono" style={{ fontSize: 10, color: "#8A8577" }}>{t.fields.length} field</div>
                  </div>
                  <button
                    onClick={(e) => deleteTemplate(t.id, e)}
                    style={{ fontSize: 11, color: "#B0432E" }}
                    title="Hapus template"
                  >
                    Hapus
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex" style={{ minHeight: 580 }}>
      <div style={{ width: 280, borderRight: `1px solid ${LINE}`, background: "#FCFBF7" }} className="p-4 flex flex-col gap-3">
        <button onClick={() => setSelected(null)} className="mono" style={{ fontSize: 11, color: TEAL_DARK, textAlign: "left" }}>
          ← Pilih template lain
        </button>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{selected.name}</div>
        <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 10 }} className="flex flex-col gap-3">
          {selected.fields.map((f) => (
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
        <div style={{ marginTop: "auto" }} className="flex flex-col gap-2">
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
          <button
            onClick={handleDownload}
            disabled={downloading}
            style={{ padding: "10px 0", borderRadius: 6, fontWeight: 700, fontSize: 13, background: TEAL, color: PAPER, opacity: downloading ? 0.7 : 1 }}
          >
            {downloading ? "Memproses…" : `Unduh Hasil (${downloadFormat.toUpperCase()})`}
          </button>
          {downloadError && (
            <p style={{ fontSize: 11, color: "#B0432E" }}>{downloadError}</p>
          )}
        </div>
      </div>

      <div className="blueprint-bg flex-1 flex items-center justify-center p-8">
        <div style={{ position: "relative", maxWidth: 640, width: "100%", boxShadow: "0 4px 20px rgba(22,35,58,0.15)" }}>
          <img ref={previewImgRef} src={selected.image} alt={selected.name} style={{ display: "block", width: "100%" }} draggable={false} />
          {selected.fields.map((f) => (
            <div
              key={f.id}
              style={{
                position: "absolute",
                left: `${f.x}%`, top: `${f.y}%`, width: `${f.w}%`, height: `${f.h}%`,
                display: "flex", alignItems: "center",
                justifyContent: f.align === "center" ? "center" : f.align === "right" ? "flex-end" : "flex-start",
                fontSize: `${getPreviewFontPx(f, values[f.id] || f.label)}px`,
                color: f.color, fontWeight: f.fontWeight || 600,
                fontFamily: "'JetBrains Mono', monospace",
                overflow: "hidden", whiteSpace: "nowrap", pointerEvents: "none",
              }}
            >
              <span style={{ opacity: values[f.id] ? 1 : 0.35 }}>
                {values[f.id] || f.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}