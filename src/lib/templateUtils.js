import { supabase } from "../supabaseClient";

export const INK = "#16233A";
export const PAPER = "#F7F5EF";
export const TEAL = "#0F6E6A";
export const TEAL_DARK = "#0B4F4C";
export const LINE = "#D8D3C4";

export const uid = () => Math.random().toString(36).slice(2, 9);

export async function fetchTemplates() {
  const { data, error } = await supabase.from("templates").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function fetchTemplateById(id) {
  const { data, error } = await supabase.from("templates").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

export async function fetchDownloadLogs() {
  const { data, error } = await supabase
    .from("download_logs")
    .select("*")
    .order("downloaded_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

export const ALLOWED_EDITOR_EMAILS = ["medirudiantoni@gmail.com"];

export function isEditorUser() {
  try {
    return ALLOWED_EDITOR_EMAILS.includes(localStorage.getItem("editor"));
  } catch {
    return false;
  }
}

export function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

export function loadScript(src, globalCheck) {
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

export async function pdfFileToImages(file, maxPages = 30) {
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

export function buildMultiPagePdf(pages) {
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
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function dataUrlToBlob(dataUrl) {
  const mimeMatch = dataUrl.match(/^data:(.*?);base64,/);
  const mime = mimeMatch ? mimeMatch[1] : "image/png";
  return new Blob([dataUrlToBytes(dataUrl)], { type: mime });
}

export function fitFontSize(ctx, text, maxWidthPx, baseFontPx, weight, minFontPx = 8) {
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

export function getTemplatePages(t) {
  return t.pages && t.pages.length ? t.pages : [t.image];
}

export function renderPageCanvas(imgSrc, pageFields, values) {
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
