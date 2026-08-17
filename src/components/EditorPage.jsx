import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "../supabaseClient";
import {
  LINE,
  PAPER,
  TEAL,
  TEAL_DARK,
  INK,
  uid,
  fileToDataURL,
  pdfFileToImages,
  dataUrlToBlob,
} from "../lib/templateUtils";
import { LabeledInput } from "./LabeledInput";

export function EditorPage() {
  const [image, setImage] = useState(null);
  const [fields, setFields] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [templateName, setTemplateName] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [drawing, setDrawing] = useState(null);
  const [uploadStatus, setUploadStatus] = useState("");
  const [pdfPages, setPdfPages] = useState([]);
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
    } catch {
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
        setSelectedId(clickedFieldId);
        return;
      }
      w = 20;
      h = 8;
      x = Math.min(Math.max(drawing.x1 - w / 2, 0), 100 - w);
      y = Math.min(Math.max(drawing.y1 - h / 2, 0), 100 - h);
    }
    const newField = {
      id: uid(),
      label: `field_${fields.length + 1}`,
      x,
      y,
      w,
      h,
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
          const { error: upErr } = await supabase.storage.from("template-images").upload(path, blob, { contentType: blob.type, upsert: true });
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
    } catch {
      setSaveStatus("error");
    }
    setTimeout(() => setSaveStatus(""), 2500);
  };

  return (
    <div className="flex" style={{ minHeight: 580 }}>
      <div style={{ width: 300, borderRight: `1px solid ${LINE}`, background: "#FCFBF7" }} className="p-4 flex flex-col gap-4">
        <div>
          <div className="mono" style={{ fontSize: 11, letterSpacing: 1, color: "#6B7280", marginBottom: 6 }}>
            SUMBER GAMBAR
          </div>
          <label
            className="tag-btn"
            style={{
              display: "block",
              textAlign: "center",
              padding: "10px 12px",
              borderRadius: 6,
              border: `1.5px dashed ${TEAL}`,
              cursor: "pointer",
              fontSize: 13,
              color: TEAL_DARK,
              fontWeight: 600,
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
                      flexShrink: 0,
                      width: 52,
                      padding: 0,
                      borderRadius: 4,
                      overflow: "hidden",
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
                DAFTAR FIELD ({currentPageFields.length})
                {pdfPages.length > 1 && <span style={{ color: "#B5AF9C" }}> · total template: {fields.length}</span>}
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
                      textAlign: "left",
                      padding: "6px 8px",
                      borderRadius: 4,
                      fontSize: 12,
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
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      value={Math.round(selected.x * 10) / 10}
                      onChange={(e) => updateField(selected.id, { x: parseFloat(e.target.value) || 0 })}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                    />
                  </LabeledInput>
                  <LabeledInput label="Posisi Y (%)">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      value={Math.round(selected.y * 10) / 10}
                      onChange={(e) => updateField(selected.id, { y: parseFloat(e.target.value) || 0 })}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                    />
                  </LabeledInput>
                </div>
                <div className="flex gap-2">
                  <LabeledInput label="Lebar (%)">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={0.5}
                      value={Math.round(selected.w * 10) / 10}
                      onChange={(e) => updateField(selected.id, { w: parseFloat(e.target.value) || 1 })}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                    />
                  </LabeledInput>
                  <LabeledInput label="Tinggi (%)">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={0.5}
                      value={Math.round(selected.h * 10) / 10}
                      onChange={(e) => updateField(selected.id, { h: parseFloat(e.target.value) || 1 })}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 13 }}
                    />
                  </LabeledInput>
                </div>
                <div className="flex gap-2">
                  <LabeledInput label="Ukuran teks (% tinggi)">
                    <input
                      type="number"
                      min={1}
                      max={20}
                      step={0.5}
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
                          flex: 1,
                          padding: "5px 0",
                          fontSize: 11,
                          borderRadius: 4,
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
                        padding: "5px 10px",
                        fontSize: 11,
                        borderRadius: 4,
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
                <button onClick={() => deleteField(selected.id)} style={{ fontSize: 12, color: "#B0432E", textAlign: "left", padding: "4px 0" }}>
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
                  padding: "9px 0",
                  borderRadius: 6,
                  fontWeight: 700,
                  fontSize: 13,
                  letterSpacing: 0.3,
                  background: canSave ? TEAL : "#D8D3C4",
                  color: PAPER,
                  cursor: canSave ? "pointer" : "not-allowed",
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

      <div className="blueprint-bg flex-1 flex p-8" style={{ overflow: "auto" }}>
        {!image ? (
          <div className="mono" style={{ color: "#9A9587", fontSize: 13, textAlign: "center", margin: "auto" }}>
            [ belum ada gambar — upload desain di panel kiri ]
          </div>
        ) : (
          <div style={{ position: "relative", maxWidth: "100%", margin: "auto", boxShadow: "0 4px 20px rgba(22,35,58,0.15)" }}>
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
                    left: `${f.x}%`,
                    top: `${f.y}%`,
                    width: `${f.w}%`,
                    height: `${f.h}%`,
                    border: `1.5px dashed ${selectedId === f.id ? TEAL_DARK : TEAL}`,
                    background: f.bgColor ? f.bgColor : selectedId === f.id ? "rgba(15,110,106,0.14)" : "rgba(15,110,106,0.06)",
                    cursor: "pointer",
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      position: "absolute",
                      top: -18,
                      left: 0,
                      fontSize: 10,
                      background: TEAL_DARK,
                      color: PAPER,
                      padding: "1px 5px",
                      borderRadius: 3,
                      whiteSpace: "nowrap",
                      pointerEvents: "none",
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
