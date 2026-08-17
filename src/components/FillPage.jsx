import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../supabaseClient";
import {
  buildMultiPagePdf,
  dataUrlToBytes,
  fetchTemplateById,
  fetchTemplates,
  fitFontSize,
  getTemplatePages,
  INK,
  LINE,
  PAPER,
  TEAL,
  TEAL_DARK,
  renderPageCanvas,
} from "../lib/templateUtils";
import { LabeledInput } from "./LabeledInput";

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
            left: `${f.x}%`,
            top: `${f.y}%`,
            width: `${f.w}%`,
            height: `${f.h}%`,
            display: "flex",
            alignItems: "center",
            justifyContent: f.align === "center" ? "center" : f.align === "right" ? "flex-end" : "flex-start",
            fontSize: `${getFontPx(f, values[f.id] || f.label)}px`,
            color: f.color,
            fontWeight: f.fontWeight || 600,
            fontFamily: "'JetBrains Mono', monospace",
            background: f.bgColor || "transparent",
            overflow: "hidden",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <span style={{ opacity: values[f.id] ? 1 : 0.35 }}>{values[f.id] || f.label}</span>
        </div>
      ))}
    </div>
  );
}

export function FillPage({ isEditor }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { id } = useParams();

  const { data: templates = [], isLoading: loading, isError: loadError, refetch: loadTemplates } = useQuery({
    queryKey: ["templates"],
    queryFn: fetchTemplates,
  });

  const {
    data: selectedTemplate,
    isLoading: selectedLoading,
    isError: selectedError,
    refetch: refetchSelected,
  } = useQuery({
    queryKey: ["template", id],
    queryFn: () => fetchTemplateById(id),
    enabled: !!id,
  });

  const [selected, setSelected] = useState(null);
  const [values, setValues] = useState({});
  const [downloadFormat, setDownloadFormat] = useState("png");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [previewFilter, setPreviewFilter] = useState("withFields");

  useEffect(() => {
    if (id && selectedTemplate) {
      setSelected(selectedTemplate);
    } else if (!id) {
      setSelected(null);
    }
  }, [id, selectedTemplate]);

  useEffect(() => {
    if (selected) {
      const init = {};
      selected.fields.forEach((f) => {
        init[f.id] = "";
      });
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
        pages.map((src, idx) => renderPageCanvas(src, selected.fields.filter((f) => (f.page || 0) === idx), values))
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
      selected.fields.forEach((f) => {
        fieldValuesByLabel[f.label] = values[f.id] || "";
      });
      supabase
        .from("download_logs")
        .insert({
          template_id: selected.id,
          template_name: selected.name,
          field_values: fieldValuesByLabel,
          format: isMultiPage ? "pdf" : downloadFormat,
        })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ["download_logs"] });
        });
    } catch (err) {
      setDownloadError("Gagal mengunduh: " + (err?.message || "terjadi kesalahan"));
    }
    setDownloading(false);
  };

  if (id && selectedLoading) {
    return <div className="p-8 mono" style={{ fontSize: 13, color: "#8A8577" }}>Memuat template berdasarkan ID…</div>;
  }

  if (id && selectedError) {
    return (
      <div className="p-8">
        <p style={{ fontSize: 13, color: "#B0432E", marginBottom: 8 }}>Template tidak ditemukan atau gagal dimuat.</p>
        <button onClick={() => refetchSelected()} className="mono" style={{ fontSize: 12, padding: "6px 12px", borderRadius: 6, background: TEAL, color: PAPER }}>
          Coba lagi
        </button>
      </div>
    );
  }

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
                  onClick={() => navigate(`/fill/${t.id}`)}
                  style={{
                    width: 200,
                    cursor: "pointer",
                    border: `1px solid ${LINE}`,
                    borderRadius: 8,
                    overflow: "hidden",
                    background: "#FCFBF7",
                  }}
                >
                  <img src={t.image} alt={t.name} style={{ width: "100%", height: 130, objectFit: "cover", display: "block" }} />
                  <div className="p-2 flex items-center justify-between">
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</div>
                      <div className="mono" style={{ fontSize: 10, color: "#8A8577" }}>
                        {pageCount > 1 ? `${pageCount} halaman · ` : ""}
                        {t.fields.length} field
                      </div>
                    </div>
                    {isEditor && (
                      <button onClick={(e) => deleteTemplate(t, e)} style={{ fontSize: 11, color: "#B0432E" }} title="Hapus template">
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
      <div className={`md:w-70 md:border-r border-r-[${LINE}] bg-[#FCFBF7] p-4 flex flex-col gap-3 md:max-h-screen md:pb-20 md:sticky top-0`}>
        <button onClick={() => navigate("/fill")} className="mono" style={{ fontSize: 11, color: TEAL_DARK, textAlign: "left" }}>
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
                  flex: 1,
                  padding: "5px 0",
                  fontSize: 10,
                  fontWeight: 700,
                  borderRadius: 4,
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
                  flex: 1,
                  padding: "5px 0",
                  fontSize: 10,
                  fontWeight: 700,
                  borderRadius: 4,
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
                    flex: 1,
                    padding: "5px 0",
                    fontSize: 11,
                    fontWeight: 700,
                    borderRadius: 4,
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
            style={{
              padding: "10px 0",
              borderRadius: 6,
              fontWeight: 700,
              fontSize: 13,
              background: TEAL,
              color: PAPER,
              opacity: downloading ? 0.7 : 1,
            }}
          >
            {downloading ? "Memproses…" : `Unduh Hasil (${isMultiPage ? "PDF" : downloadFormat.toUpperCase()})`}
          </button>
          {downloadError && <p style={{ fontSize: 11, color: "#B0432E" }}>{downloadError}</p>}
        </div>
      </div>

      <div className="blueprint-bg flex-1 flex p-8" style={{ overflow: "auto" }}>
        <div className="flex flex-col gap-6" style={{ width: "100%", maxWidth: 640, margin: "auto" }}>
          {visiblePageIndexes.map((idx) => (
            <div key={idx}>
              {isMultiPage && (
                <div className="mono" style={{ fontSize: 10, color: "#8A8577", marginBottom: 6 }}>
                  HALAMAN {idx + 1}
                  {!pagesWithFields.has(idx) && " · tanpa field"}
                </div>
              )}
              <PagePreview pageSrc={pages[idx]} pageFields={selected.fields.filter((f) => (f.page || 0) === idx)} values={values} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
