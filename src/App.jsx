import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { EditorPage } from "./components/EditorPage";
import { FillPage } from "./components/FillPage";
import { HistoryPage } from "./components/HistoryPage";
import { INK, LINE, PAPER, TEAL, isEditorUser } from "./lib/templateUtils";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

export default function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <TemplateEditorAppInner />
      </QueryClientProvider>
    </BrowserRouter>
  );
}

function TemplateEditorAppInner() {
  const isEditor = useState(() => isEditorUser())[0];
  const navigate = useNavigate();
  const location = useLocation();

  const activePath = location.pathname;
  const hasEditorRoute = isEditor && (activePath === "/editor" || activePath === "/history" || activePath.startsWith("/editor"));
  const activeMode = isEditor ? (activePath.startsWith("/fill") ? "fill" : activePath === "/history" ? "history" : "editor") : "fill";

  const topRoutes = [
    ...(isEditor ? [{ label: "01 · SUSUN TEMPLATE", path: "/editor" }] : []),
    { label: isEditor ? "02 · ISI DATA" : "ISI DATA", path: "/fill" },
    ...(isEditor ? [{ label: "03 · RIWAYAT", path: "/history" }] : []),
  ];

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

      <div style={{ borderBottom: `1px solid ${LINE}` }} className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-2">
          <div style={{ width: 10, height: 10, background: TEAL, transform: "rotate(45deg)" }} />
          <span className="mono" style={{ fontSize: 13, letterSpacing: 1, fontWeight: 700, textTransform: "uppercase" }}>
            Titik&nbsp;Edit
          </span>
        </div>
        <div className="flex gap-1" style={{ background: "#EFEBDF", padding: 4, borderRadius: 8 }}>
          {topRoutes.map((item) => {
            const isActive = activePath === item.path || (item.path === "/fill" && activePath.startsWith("/fill"));
            return (
              <button
                key={item.path}
                className="tag-btn mono"
                onClick={() => navigate(item.path)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  background: isActive ? INK : "transparent",
                  color: isActive ? PAPER : INK,
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <Routes>
        <Route path="/" element={<Navigate to={isEditor ? "/editor" : "/fill"} replace />} />
        {isEditor && <Route path="/editor" element={<EditorPage />} />}
        <Route path="/fill" element={<FillPage isEditor={isEditor} />} />
        <Route path="/fill/:id" element={<FillPage isEditor={isEditor} />} />
        {isEditor && <Route path="/history" element={<HistoryPage />} />}
        <Route path="*" element={<Navigate to={isEditor ? "/editor" : "/fill"} replace />} />
      </Routes>
    </div>
  );
}
